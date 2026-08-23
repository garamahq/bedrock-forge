import { SyncDbService } from "./sync-db.service";
import { PrismaService } from "../../../prisma/prisma.service";
import { RcloneService } from "../../../services/rclone.service";
import { StepTracker } from "../../../services/step-tracker";
import { JOB_TYPES } from "@bedrock-forge/shared";

describe("SyncDbService", () => {
  let service: SyncDbService;
  let prisma: any;
  let rclone: any;
  let encryption: any;

  beforeEach(() => {
    prisma = {
      backup: {
        create: jest.fn().mockResolvedValue({}),
      },
      wpDbCredentials: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
    };
    rclone = {
      writeConfig: jest.fn().mockResolvedValue(true),
      upload: jest.fn().mockResolvedValue("/gdrive/path/file.sql"),
    };
    encryption = {
      decrypt: jest.fn().mockImplementation((v) => v),
      encrypt: jest.fn().mockImplementation((v) => v),
    };
    service = new SyncDbService(
      prisma as PrismaService,
      rclone as RcloneService,
      encryption as any,
    );
  });

  function makeJob(name: string, data: object) {
    return {
      id: "sync-job-001",
      name,
      data,
      updateProgress: jest.fn(),
    } as any;
  }

  function makeTracker() {
    return {
      track: jest.fn().mockResolvedValue(undefined),
      trackCommand: jest.fn().mockResolvedValue(undefined),
    } as unknown as StepTracker;
  }

  describe("validateUrlReplacement()", () => {
    function makeExecutor({
      optionsOutput = "",
      postsOutput = "",
      postmetaOutput = "",
      queryCode = 0,
    }: {
      optionsOutput?: string;
      postsOutput?: string;
      postmetaOutput?: string;
      queryCode?: number;
    } = {}) {
      return {
        pushFile: jest.fn().mockResolvedValue(undefined),
        execute: jest.fn().mockImplementation((cmd: string) => {
          if (cmd.includes("chmod") || cmd.includes("rm -f"))
            return Promise.resolve({ code: 0, stdout: "", stderr: "" });
          if (cmd.includes("information_schema"))
            return Promise.resolve({ code: 0, stdout: "wp_", stderr: "" });
          if (cmd.includes("FROM `wp_options`"))
            return Promise.resolve({
              code: queryCode,
              stdout: optionsOutput,
              stderr: "",
            });
          if (cmd.includes("FROM `wp_posts`"))
            return Promise.resolve({
              code: queryCode,
              stdout: postsOutput,
              stderr: "",
            });
          if (cmd.includes("FROM `wp_postmeta`"))
            return Promise.resolve({
              code: queryCode,
              stdout: postmetaOutput,
              stderr: "",
            });
          return Promise.resolve({ code: 0, stdout: "", stderr: "" });
        }),
      };
    }

    const creds = {
      dbHost: "localhost",
      dbUser: "user",
      dbPassword: "pass",
      dbName: "testdb",
    };
    const sourceUrl = "https://staging.example.com";
    const targetUrl = "https://example.com";

    it("resolves cleanly when options, posts, and postmeta do not contain the source URL", async () => {
      const executor = makeExecutor();
      const tracker = makeTracker();

      await expect(
        service.validateUrlReplacement(
          executor as any,
          creds,
          sourceUrl,
          targetUrl,
          tracker,
        ),
      ).resolves.toBeUndefined();

      expect(tracker.track).toHaveBeenCalledWith(
        expect.objectContaining({
          step: expect.stringContaining("no stale source URLs remain"),
        }),
      );
    });

    it("throws when options still contain the source URL", async () => {
      const executor = makeExecutor({
        optionsOutput:
          "options\tsiteurl\thttps://staging.example.com\noptions\thome\thttps://example.com",
      });
      const tracker = makeTracker();

      await expect(
        service.validateUrlReplacement(
          executor as any,
          creds,
          sourceUrl,
          targetUrl,
          tracker,
        ),
      ).rejects.toThrow("URL replacement did not complete");
    });

    it("throws when posts still contain the source URL", async () => {
      const executor = makeExecutor({
        postsOutput:
          'posts\t42:page\t<a href="https://staging.example.com/foo">Button</a>',
      });
      const tracker = makeTracker();

      await expect(
        service.validateUrlReplacement(
          executor as any,
          creds,
          sourceUrl,
          targetUrl,
          tracker,
        ),
      ).rejects.toThrow("URL replacement did not complete");
    });

    it("throws when postmeta still contains the source URL", async () => {
      const executor = makeExecutor({
        postmetaOutput:
          'postmeta\t42:_elementor_data\t{"link":"https://staging.example.com/product"}',
      });
      const tracker = makeTracker();

      await expect(
        service.validateUrlReplacement(
          executor as any,
          creds,
          sourceUrl,
          targetUrl,
          tracker,
        ),
      ).rejects.toThrow("URL replacement did not complete");
    });

    it("logs a warning (does not throw) when the DB query itself fails", async () => {
      const executor = makeExecutor({ queryCode: 1 });
      const tracker = makeTracker();

      await expect(
        service.validateUrlReplacement(
          executor as any,
          creds,
          sourceUrl,
          targetUrl,
          tracker,
        ),
      ).resolves.toBeUndefined();
    });

    it("passes validation when only elementor_log (non-functional log option) contains the source URL", async () => {
      const executor = makeExecutor({ optionsOutput: "" });
      const tracker = makeTracker();

      await expect(
        service.validateUrlReplacement(
          executor as any,
          creds,
          sourceUrl,
          targetUrl,
          tracker,
        ),
      ).resolves.toBeUndefined();

      const sqlCall = (executor.execute as jest.Mock).mock.calls.find(
        ([cmd]: [string]) =>
          cmd.includes("FROM `wp_options`") && cmd.includes("NOT IN"),
      );
      expect(sqlCall).toBeDefined();
      expect(sqlCall![0]).toContain("elementor_log");
      expect(sqlCall![0]).toContain("_transient_");
    });

    it("skips validation probes for protected core tables", async () => {
      const executor = makeExecutor({
        postsOutput:
          'posts\t42:page\t<a href="https://staging.example.com/foo">Button</a>',
      });
      const tracker = makeTracker();

      await expect(
        service.validateUrlReplacement(
          executor as any,
          creds,
          sourceUrl,
          targetUrl,
          tracker,
          ["wp_posts"],
        ),
      ).resolves.toBeUndefined();

      expect(
        (executor.execute as jest.Mock).mock.calls.some(([cmd]: [string]) =>
          cmd.includes("FROM `wp_posts`"),
        ),
      ).toBe(false);
    });
  });

  describe("flushWordPressCaches() fallback cleanup", () => {
    const creds = {
      dbHost: "localhost",
      dbUser: "user",
      dbPassword: "pass",
      dbName: "testdb",
    };
    const layout = {
      corePath: "/var/www/html/web/wp",
      contentPath: "/var/www/html/web/app",
      isBedrock: true,
    };

    it("removes LiteSpeed-style cache directories when WP-CLI is unavailable", async () => {
      const executor = {
        pushFile: jest.fn().mockResolvedValue(undefined),
        execute: jest.fn().mockImplementation((cmd: string) => {
          if (cmd.includes("wp cache flush")) {
            return Promise.resolve({
              code: 1,
              stdout: "",
              stderr: "missing mysqli",
            });
          }
          if (cmd.includes("information_schema"))
            return Promise.resolve({ code: 0, stdout: "wp_", stderr: "" });
          return Promise.resolve({ code: 0, stdout: "", stderr: "" });
        }),
      };
      const tracker = makeTracker();

      await expect(
        service.flushWordPressCaches(
          executor as any,
          creds,
          layout,
          tracker,
          "Push",
          false,
        ),
      ).resolves.toBeUndefined();

      expect(
        (executor.execute as jest.Mock).mock.calls.some(([cmd]) =>
          String(cmd).includes("/litespeed"),
        ),
      ).toBe(true);
    });

    it("calls lsphp phar directly when LiteSpeed PHP binary and wp path are detected", async () => {
      const executor = {
        pushFile: jest.fn().mockResolvedValue(undefined),
        execute: jest.fn().mockImplementation((cmd: string) => {
          if (cmd.includes("plugin is-active elementor"))
            return Promise.resolve({
              code: 1,
              stdout: "",
              stderr: "Plugin is not active.",
            });
          if (cmd.includes("stat -c"))
            return Promise.resolve({
              code: 0,
              stdout: "siteowner",
              stderr: "",
            });
          if (cmd.includes("lsws/lsphp"))
            return Promise.resolve({
              code: 0,
              stdout: "/usr/local/lsws/lsphp81/bin/php",
              stderr: "",
            });
          if (cmd.includes("which wp"))
            return Promise.resolve({
              code: 0,
              stdout: "/usr/local/bin/wp",
              stderr: "",
            });
          return Promise.resolve({ code: 0, stdout: "", stderr: "" });
        }),
      };
      const tracker = makeTracker();

      await service.flushWordPressCaches(
        executor as any,
        creds,
        layout,
        tracker,
        "Push",
        false,
      );

      const calls = (executor.execute as jest.Mock).mock.calls.map(([c]) =>
        String(c),
      );
      const wpCacheFlushCall = calls.find((c) => c.includes("cache flush"));
      expect(wpCacheFlushCall).toBeDefined();
      expect(wpCacheFlushCall).toContain("lsphp81/bin/php");
      expect(wpCacheFlushCall).toContain("/usr/local/bin/wp");
      expect(wpCacheFlushCall).not.toContain("env WP_CLI_PHP=");
    });

    it("skips Elementor CSS flush when Elementor is not active", async () => {
      const executor = {
        pushFile: jest.fn().mockResolvedValue(undefined),
        execute: jest.fn().mockImplementation((cmd: string) => {
          if (cmd.includes("plugin is-active elementor"))
            return Promise.resolve({
              code: 1,
              stdout: "",
              stderr: "Plugin is not active.",
            });
          if (cmd.includes("stat -c"))
            return Promise.resolve({
              code: 0,
              stdout: "siteowner",
              stderr: "",
            });
          if (cmd.includes("lsws/lsphp"))
            return Promise.resolve({
              code: 0,
              stdout: "/usr/local/lsws/lsphp81/bin/php",
              stderr: "",
            });
          if (cmd.includes("which wp"))
            return Promise.resolve({
              code: 0,
              stdout: "/usr/local/bin/wp",
              stderr: "",
            });
          return Promise.resolve({ code: 0, stdout: "", stderr: "" });
        }),
      };
      const tracker = makeTracker();

      await service.flushWordPressCaches(
        executor as any,
        creds,
        layout,
        tracker,
        "Clone",
        false,
      );

      const calls = (executor.execute as jest.Mock).mock.calls.map(([cmd]) =>
        String(cmd),
      );
      expect(calls.some((cmd) => cmd.includes("elementor flush-css"))).toBe(
        false,
      );
      expect(tracker.track).toHaveBeenCalledWith(
        expect.objectContaining({
          step: "Clone: Elementor CSS flush skipped",
          level: "info",
        }),
      );
    });

    it("resets Elementor CSS cache when active Elementor CLI flush fails", async () => {
      const executor = {
        pushFile: jest.fn().mockResolvedValue(undefined),
        execute: jest.fn().mockImplementation((cmd: string) => {
          if (cmd.includes("plugin is-active elementor"))
            return Promise.resolve({ code: 0, stdout: "", stderr: "" });
          if (cmd.includes("elementor flush-css"))
            return Promise.resolve({
              code: 1,
              stdout: "",
              stderr: "Elementor CLI failed",
            });
          if (cmd.includes("stat -c"))
            return Promise.resolve({
              code: 0,
              stdout: "siteowner",
              stderr: "",
            });
          if (cmd.includes("lsws/lsphp"))
            return Promise.resolve({
              code: 0,
              stdout: "/usr/local/lsws/lsphp81/bin/php",
              stderr: "",
            });
          if (cmd.includes("which wp"))
            return Promise.resolve({
              code: 0,
              stdout: "/usr/local/bin/wp",
              stderr: "",
            });
          return Promise.resolve({ code: 0, stdout: "", stderr: "" });
        }),
      };
      const tracker = makeTracker();

      await service.flushWordPressCaches(
        executor as any,
        creds,
        layout,
        tracker,
        "Clone",
        false,
      );

      const calls = (executor.execute as jest.Mock).mock.calls.map(([cmd]) =>
        String(cmd),
      );
      expect(calls.some((cmd) => cmd.includes("elementor flush-css"))).toBe(
        true,
      );
      expect(calls.some((cmd) => cmd.includes("/uploads/elementor/css"))).toBe(
        true,
      );
      expect(tracker.track).toHaveBeenCalledWith(
        expect.objectContaining({
          step: "Clone: Elementor CSS cache reset for auto-regeneration",
          level: "warn",
        }),
      );
    });
  });

  describe("runUrlSearchReplace() WP-CLI partial-success guard", () => {
    const creds = {
      dbHost: "localhost",
      dbUser: "u",
      dbPassword: "p",
      dbName: "db",
    };

    it("falls through to PHP/SQL when WP-CLI succeeds for pair 0 but fails for pair 1", async () => {
      let wpCliCallCount = 0;
      const phpCalls: string[] = [];

      const executor = {
        pushFile: jest.fn().mockResolvedValue(undefined),
        execute: jest.fn().mockImplementation((cmd: string) => {
          if (cmd.includes("stat ") || cmd.includes("id ")) {
            return Promise.resolve({ code: 1, stdout: "", stderr: "" });
          }
          if (cmd.includes("search-replace") && !cmd.includes("forge_sr_")) {
            wpCliCallCount++;
            const succeeds = wpCliCallCount % 2 === 1;
            return Promise.resolve({
              code: succeeds ? 0 : 1,
              stdout: "Done",
              stderr: "",
            });
          }
          if (cmd.includes("php ") && cmd.includes("forge_sr_")) {
            phpCalls.push(cmd);
            return Promise.resolve({
              code: 0,
              stdout: JSON.stringify({
                tables_scanned: 5,
                rows_affected: 2,
                errors: [],
              }),
              stderr: "",
            });
          }
          if (cmd.includes("information_schema") || cmd.includes("%options")) {
            return Promise.resolve({ code: 0, stdout: "wp_", stderr: "" });
          }
          if (cmd.includes("chmod") || cmd.includes("rm -f")) {
            return Promise.resolve({ code: 0, stdout: "", stderr: "" });
          }
          return Promise.resolve({ code: 0, stdout: "", stderr: "" });
        }),
      };

      const tracker = makeTracker();

      const originalReadFile = require("fs/promises").readFile;
      jest
        .spyOn(require("fs/promises"), "readFile")
        .mockResolvedValue(
          Buffer.from(
            '<?php echo json_encode(["tables_scanned"=>1,"rows_affected"=>1,"errors"=>[]]);',
          ),
        );

      try {
        await service.runUrlSearchReplace(
          "https://staging.example.com",
          "https://example.com",
          executor as any,
          creds,
          "/var/www/html",
          tracker,
          makeJob(JOB_TYPES.SYNC_CLONE, { jobExecutionId: 1 }),
          "sync",
          ["wp_posts", "wp_ct_registrations"],
        );
      } finally {
        jest.spyOn(require("fs/promises"), "readFile").mockRestore();
      }

      expect(phpCalls.length).toBeGreaterThan(0);
      expect(phpCalls[0]).toContain(
        "--skip-tables='wp_posts,wp_ct_registrations'",
      );
    });

    it("adds protected tables to successful WP-CLI search-replace commands", async () => {
      const executor = {
        pushFile: jest.fn().mockResolvedValue(undefined),
        execute: jest.fn().mockImplementation((cmd: string) => {
          if (cmd.includes("stat ") || cmd.includes("id ")) {
            return Promise.resolve({ code: 1, stdout: "", stderr: "" });
          }
          if (cmd.includes("search-replace") && !cmd.includes("forge_sr_")) {
            return Promise.resolve({ code: 0, stdout: "Done", stderr: "" });
          }
          return Promise.resolve({ code: 0, stdout: "", stderr: "" });
        }),
      };
      const tracker = makeTracker();

      await service.runUrlSearchReplace(
        "https://staging.example.com",
        "https://example.com",
        executor as any,
        creds,
        "/var/www/html",
        tracker,
        makeJob(JOB_TYPES.SYNC_CLONE, { jobExecutionId: 1 }),
        "sync",
        ["wp_posts", "wp_ct_registrations"],
      );

      const commands = (executor.execute as jest.Mock).mock.calls
        .map(([cmd]) => String(cmd))
        .join("\n");
      expect(commands).toContain("search-replace");
      expect(commands).toContain(
        "--skip-tables='wp_posts,wp_ct_registrations'",
      );
    });

    it("does not generate SQL fallback updates for protected core tables", async () => {
      let pushedSql = "";
      const executor = {
        pushFile: jest.fn().mockImplementation(({ remotePath, content }) => {
          if (remotePath.endsWith(".sql")) {
            pushedSql = Buffer.isBuffer(content)
              ? content.toString("utf8")
              : String(content);
          }
          return Promise.resolve(undefined);
        }),
        execute: jest.fn().mockImplementation((cmd: string) => {
          if (cmd.includes("stat ") || cmd.includes("id ")) {
            return Promise.resolve({ code: 1, stdout: "", stderr: "" });
          }
          if (cmd.includes("search-replace") && !cmd.includes("forge_sr_")) {
            return Promise.resolve({
              code: 1,
              stdout: "",
              stderr: "wp failed",
            });
          }
          if (cmd.includes("information_schema") || cmd.includes("%options")) {
            return Promise.resolve({ code: 0, stdout: "wp_", stderr: "" });
          }
          if (cmd.includes("php ") && cmd.includes("forge_sr_")) {
            return Promise.resolve({
              code: 1,
              stdout: "",
              stderr: "php failed",
            });
          }
          return Promise.resolve({ code: 0, stdout: "", stderr: "" });
        }),
      };
      const tracker = makeTracker();

      jest
        .spyOn(require("fs/promises"), "readFile")
        .mockResolvedValue(Buffer.from('<?php echo "fail";'));

      try {
        await service.runUrlSearchReplace(
          "https://staging.example.com",
          "https://example.com",
          executor as any,
          creds,
          "/var/www/html",
          tracker,
          makeJob(JOB_TYPES.SYNC_CLONE, { jobExecutionId: 1 }),
          "sync",
          ["wp_posts"],
        );
      } finally {
        jest.spyOn(require("fs/promises"), "readFile").mockRestore();
      }

      expect(pushedSql).toContain("UPDATE `wp_options`");
      expect(pushedSql).not.toContain("UPDATE `wp_posts`");
    });
  });

  describe("ensureTargetEnvironmentConfig()", () => {
    const creds = {
      dbHost: "localhost",
      dbUser: "ct_target",
      dbPassword: "target_password_123",
      dbName: "ct_target_db",
    };

    it("creates fresh .env with target credentials, prefix, URLs, and 8 salts when missing on Bedrock", async () => {
      let pushedEnvContent = "";
      const executor = {
        execute: jest.fn().mockImplementation((cmd: string) => {
          if (cmd.includes("test -f") && cmd.includes(".env")) {
            return Promise.resolve({ code: 1, stdout: "missing", stderr: "" });
          }
          return Promise.resolve({ code: 0, stdout: "", stderr: "" });
        }),
        pushFile: jest.fn().mockImplementation(({ remotePath, content }) => {
          if (remotePath.endsWith(".env")) {
            pushedEnvContent = Buffer.isBuffer(content)
              ? content.toString("utf8")
              : String(content);
          }
          return Promise.resolve(undefined);
        }),
      };
      const tracker = makeTracker();

      await service.ensureTargetEnvironmentConfig(
        executor as any,
        {
          id: BigInt(1),
          root_path: "/home/target/public_html",
          url: "https://target.com",
          type: "production",
        },
        {
          corePath: "/home/target/public_html/web/wp",
          contentPath: "/home/target/public_html/web/app",
          isBedrock: true,
        },
        creds,
        "https://target.com",
        tracker,
        "wp_custom_",
      );

      expect(pushedEnvContent).toContain("DB_NAME='ct_target_db'");
      expect(pushedEnvContent).toContain("DB_USER='ct_target'");
      expect(pushedEnvContent).toContain("DB_PASSWORD='target_password_123'");
      expect(pushedEnvContent).toContain("DB_HOST='localhost'");
      expect(pushedEnvContent).toContain("DB_PREFIX='wp_custom_'");
      expect(pushedEnvContent).toContain("WP_ENV='production'");
      expect(pushedEnvContent).toContain("WP_HOME='https://target.com'");
      expect(pushedEnvContent).toContain("WP_SITEURL=${WP_HOME}/wp");
      expect(pushedEnvContent).toContain("AUTH_KEY=");
      expect(pushedEnvContent).toContain("SECURE_AUTH_KEY=");
      expect(pushedEnvContent).toContain("NONCE_SALT=");
    });

    it("updates existing .env with target DB credentials while preserving custom keys and existing salts", async () => {
      const existingEnv = [
        "DB_NAME='old_db'",
        "DB_USER='old_user'",
        "DB_PASSWORD='old_pass'",
        "DB_HOST='127.0.0.1'",
        "CUSTOM_API_KEY='secret_12345'",
        "AUTH_KEY='existing_auth_salt_val'",
      ].join("\n");

      let pushedEnvContent = "";
      const executor = {
        execute: jest.fn().mockImplementation((cmd: string) => {
          if (cmd.includes("test -f") && cmd.includes(".env")) {
            return Promise.resolve({ code: 0, stdout: "exists", stderr: "" });
          }
          return Promise.resolve({ code: 0, stdout: "", stderr: "" });
        }),
        pullFile: jest.fn().mockResolvedValue(Buffer.from(existingEnv)),
        pushFile: jest.fn().mockImplementation(({ remotePath, content }) => {
          if (remotePath.endsWith(".env")) {
            pushedEnvContent = Buffer.isBuffer(content)
              ? content.toString("utf8")
              : String(content);
          }
          return Promise.resolve(undefined);
        }),
      };
      const tracker = makeTracker();

      await service.ensureTargetEnvironmentConfig(
        executor as any,
        {
          id: BigInt(2),
          root_path: "/home/target/public_html",
          url: "https://target.com",
          type: "production",
        },
        {
          corePath: "/home/target/public_html/web/wp",
          contentPath: "/home/target/public_html/web/app",
          isBedrock: true,
        },
        creds,
        "https://target.com",
        tracker,
      );

      expect(pushedEnvContent).toContain("DB_NAME='ct_target_db'");
      expect(pushedEnvContent).toContain("DB_USER='ct_target'");
      expect(pushedEnvContent).toContain("DB_PASSWORD='target_password_123'");
      expect(pushedEnvContent).toContain("CUSTOM_API_KEY='secret_12345'");
      expect(pushedEnvContent).toContain("AUTH_KEY='existing_auth_salt_val'");
      expect(pushedEnvContent).toContain("SECURE_AUTH_KEY=");
    });

    it("updates existing wp-config.php with target credentials on Standard WP", async () => {
      const existingConfig = [
        "<?php",
        "define('DB_NAME', 'old_db');",
        "define('DB_USER', 'old_user');",
        "define('DB_PASSWORD', 'old_pass');",
        "define('DB_HOST', 'localhost');",
        "$table_prefix = 'wp_';",
      ].join("\n");

      let pushedConfig = "";
      const executor = {
        execute: jest.fn().mockImplementation((cmd: string) => {
          if (cmd.includes("test -f") && cmd.includes("wp-config.php")) {
            return Promise.resolve({ code: 0, stdout: "exists", stderr: "" });
          }
          if (cmd.includes("application.php")) {
            return Promise.resolve({ code: 1, stdout: "no", stderr: "" });
          }
          return Promise.resolve({ code: 0, stdout: "", stderr: "" });
        }),
        pullFile: jest.fn().mockResolvedValue(Buffer.from(existingConfig)),
        pushFile: jest.fn().mockImplementation(({ remotePath, content }) => {
          pushedConfig = Buffer.isBuffer(content)
            ? content.toString("utf8")
            : String(content);
          return Promise.resolve(undefined);
        }),
      };
      const tracker = makeTracker();

      await service.ensureTargetEnvironmentConfig(
        executor as any,
        {
          id: BigInt(3),
          root_path: "/var/www/html",
          url: "https://standard-target.com",
          type: "production",
        },
        {
          corePath: "/var/www/html",
          contentPath: "/var/www/html/wp-content",
          isBedrock: false,
        },
        creds,
        "https://standard-target.com",
        tracker,
        "wp_new_",
      );

      expect(pushedConfig).toContain("define('DB_NAME', 'ct_target_db');");
      expect(pushedConfig).toContain("define('DB_USER', 'ct_target');");
      expect(pushedConfig).toContain(
        "define('DB_PASSWORD', 'target_password_123');",
      );
      expect(pushedConfig).toContain("$table_prefix = 'wp_new_';");
    });
  });
});
