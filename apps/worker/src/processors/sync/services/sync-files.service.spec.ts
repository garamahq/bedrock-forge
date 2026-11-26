import { SyncFilesService } from "./sync-files.service";
import { SshKeyService } from "../../../services/ssh-key.service";
import { StepTracker } from "../../../services/step-tracker";
import { JOB_TYPES } from "@bedrock-forge/shared";

describe("SyncFilesService", () => {
  let service: SyncFilesService;
  let sshKey: jest.Mocked<SshKeyService>;

  beforeEach(() => {
    sshKey = {
      resolvePrivateKey: jest
        .fn()
        .mockResolvedValue("-----BEGIN PRIVATE KEY-----"),
      getSshConfig: jest.fn().mockImplementation(async (server: any) => ({
        host: server.ip_address,
        port: server.ssh_port,
        username: server.ssh_user,
        privateKey: "-----BEGIN PRIVATE KEY-----",
      })),
    } as any;
    service = new SyncFilesService(sshKey);
  });

  describe("getProductionPromotionExcludes()", () => {
    it("preserves production robots policy and uploads during staging promotion", () => {
      expect(
        (service as any).getProductionPromotionExcludes(
          "staging",
          "production",
        ),
      ).toEqual([
        "robots.txt",
        "web/robots.txt",
        "wp-content/uploads/",
        "app/uploads/",
        "web/app/uploads/",
        "wp-content/plugins/wp-secure-guard/",
        "app/plugins/wp-secure-guard/",
        "web/app/plugins/wp-secure-guard/",
        "wp-content/mu-plugins/secure-guard-watchdog.php",
        "app/mu-plugins/secure-guard-watchdog.php",
        "web/app/mu-plugins/secure-guard-watchdog.php",
      ]);
    });

    it("does not apply production-only file protections to other sync directions", () => {
      expect(
        (service as any).getProductionPromotionExcludes(
          "production",
          "staging",
        ),
      ).toEqual([]);
      expect(
        (service as any).getProductionPromotionExcludes(
          "production",
          "production",
        ),
      ).toEqual([]);
      expect(
        (service as any).getProductionPromotionExcludes("staging", null),
      ).toContain("web/robots.txt");
    });
  });

  function makeJob(name: string, data: object) {
    return {
      id: "sync-job-001",
      name,
      data,
      updateProgress: jest.fn(),
    } as any;
  }

  describe("replaceUrlsInFiles()", () => {
    function makeExecutorForFiles({
      sedExitCode,
      grepCode = 1,
      grepOutput = "",
    }: {
      sedExitCode: number;
      grepCode?: number;
      grepOutput?: string;
    }) {
      return {
        execute: jest.fn().mockImplementation((cmd: string) => {
          if (cmd.includes("test -d"))
            return Promise.resolve({ code: 0, stdout: "ok", stderr: "" });
          if (cmd.includes("grep -nHF -m 1"))
            return Promise.resolve({
              code: grepCode,
              stdout: grepOutput,
              stderr: grepCode > 1 ? "grep failed" : "",
            });
          return Promise.resolve({
            code: sedExitCode,
            stdout: "",
            stderr: sedExitCode !== 0 ? "permission denied" : "",
          });
        }),
      };
    }

    it("resolves when all sed replacements succeed", async () => {
      const executor = makeExecutorForFiles({ sedExitCode: 0 });
      const tracker = { track: jest.fn().mockResolvedValue(undefined) } as any;

      await expect(
        service.replaceUrlsInFiles(
          "https://staging.example.com",
          "https://example.com",
          "/var/www/html/wp-content",
          executor as any,
          tracker,
          makeJob(JOB_TYPES.SYNC_CLONE, { jobExecutionId: 1 }),
        ),
      ).resolves.toBeUndefined();
    });

    it("throws when any sed replacement fails", async () => {
      const executor = makeExecutorForFiles({ sedExitCode: 1 });
      const tracker = { track: jest.fn().mockResolvedValue(undefined) } as any;

      await expect(
        service.replaceUrlsInFiles(
          "https://staging.example.com",
          "https://example.com",
          "/var/www/html/wp-content",
          executor as any,
          tracker,
          makeJob(JOB_TYPES.SYNC_CLONE, { jobExecutionId: 1 }),
        ),
      ).rejects.toThrow("File URL replacement failed");
    });

    it("throws when stale source URLs remain in text assets after sed", async () => {
      const executor = makeExecutorForFiles({
        sedExitCode: 0,
        grepCode: 0,
        grepOutput:
          "/var/www/html/wp-content/cache/file.css:12:https://staging.example.com/banner",
      });
      const tracker = { track: jest.fn().mockResolvedValue(undefined) } as any;

      await expect(
        service.replaceUrlsInFiles(
          "https://staging.example.com",
          "https://example.com",
          "/var/www/html/wp-content",
          executor as any,
          tracker,
          makeJob(JOB_TYPES.SYNC_CLONE, { jobExecutionId: 1 }),
        ),
      ).rejects.toThrow("File URL replacement did not complete");
    });
  });

  describe("pushFilesViaRsync()", () => {
    function makeRsyncArgs(result: {
      code: number;
      stdout?: string;
      stderr?: string;
    }) {
      const sourceExecutor = {
        pushFile: jest.fn().mockResolvedValue(undefined),
        execute: jest.fn().mockResolvedValue({
          code: result.code,
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
        }),
      };
      const tracker = {
        track: jest.fn().mockResolvedValue(undefined),
        trackCommand: jest.fn().mockResolvedValue(undefined),
      };
      return { sourceExecutor, tracker };
    }

    it("resolves cleanly when rsync exits with code 0", async () => {
      const { sourceExecutor, tracker } = makeRsyncArgs({
        code: 0,
        stdout: "rsync complete",
      });

      await expect(
        (service as any).pushFilesViaRsync(
          makeJob(JOB_TYPES.SYNC_CLONE, { jobExecutionId: 1 }),
          "/src/path",
          "/tgt/path",
          {
            server: {
              ip_address: "1.2.3.4",
              ssh_port: 22,
              ssh_user: "user",
              ssh_private_key_encrypted: null,
            },
          },
          sourceExecutor as any,
          tracker as any,
          [],
        ),
      ).resolves.toBeUndefined();

      expect(tracker.track).toHaveBeenLastCalledWith(
        expect.objectContaining({
          step: "File sync complete (rsync)",
          detail: "rsync complete",
        }),
      );
    });

    it("resolves with warning when rsync exits with code 23 due only to permission errors on root files", async () => {
      const { sourceExecutor, tracker } = makeRsyncArgs({
        code: 23,
        stderr:
          'rsync: chown "/tgt/path/wp-config.php" failed: Operation not permitted (1)\n' +
          "rsync error: some files/attrs were not transferred (see previous errors) (code 23) at main.c(1333) [sender=3.2.3]",
      });

      await expect(
        (service as any).pushFilesViaRsync(
          makeJob(JOB_TYPES.SYNC_CLONE, { jobExecutionId: 1 }),
          "/src/path",
          "/tgt/path",
          {
            server: {
              ip_address: "1.2.3.4",
              ssh_port: 22,
              ssh_user: "user",
              ssh_private_key_encrypted: null,
            },
          },
          sourceExecutor as any,
          tracker as any,
          [],
        ),
      ).resolves.toBeUndefined();

      expect(tracker.track).toHaveBeenLastCalledWith(
        expect.objectContaining({
          step: expect.stringContaining(
            "some attrs skipped (root-owned files)",
          ),
          level: "warn",
        }),
      );
    });

    it("throws error when rsync exits with code 23 but output contains non-permission failures", async () => {
      const { sourceExecutor, tracker } = makeRsyncArgs({
        code: 23,
        stderr:
          "rsync: read error: Connection reset by peer (104)\n" +
          "rsync error: some files/attrs were not transferred (see previous errors) (code 23) at main.c(1333) [sender=3.2.3]",
      });

      await expect(
        (service as any).pushFilesViaRsync(
          makeJob(JOB_TYPES.SYNC_CLONE, { jobExecutionId: 1 }),
          "/src/path",
          "/tgt/path",
          {
            server: {
              ip_address: "1.2.3.4",
              ssh_port: 22,
              ssh_user: "user",
              ssh_private_key_encrypted: null,
            },
          },
          sourceExecutor as any,
          tracker as any,
          [],
        ),
      ).rejects.toThrow("rsync failed (exit 23)");
    });

    it("throws error when rsync exits with any other non-zero code", async () => {
      const { sourceExecutor, tracker } = makeRsyncArgs({
        code: 12,
        stderr: "rsync: connection timed out",
      });

      await expect(
        (service as any).pushFilesViaRsync(
          makeJob(JOB_TYPES.SYNC_CLONE, { jobExecutionId: 1 }),
          "/src/path",
          "/tgt/path",
          {
            server: {
              ip_address: "1.2.3.4",
              ssh_port: 22,
              ssh_user: "user",
              ssh_private_key_encrypted: null,
            },
          },
          sourceExecutor as any,
          tracker as any,
          [],
        ),
      ).rejects.toThrow("rsync failed (exit 12): rsync: connection timed out");
    });

    it("omits --ignore-errors when --delete is used so sender I/O errors cannot wipe destination files (#84)", async () => {
      const { sourceExecutor, tracker } = makeRsyncArgs({
        code: 0,
        stdout: "done",
      });

      await (service as any).pushFilesViaRsync(
        makeJob(JOB_TYPES.SYNC_CLONE, { jobExecutionId: 1 }),
        "/src/path",
        "/tgt/path",
        {
          server: {
            ip_address: "1.2.3.4",
            ssh_port: 22,
            ssh_user: "user",
            ssh_private_key_encrypted: null,
          },
        },
        sourceExecutor as any,
        tracker as any,
        [],
      );

      const rsyncCall = sourceExecutor.execute.mock.calls.find(([cmd]: [string]) =>
        cmd.startsWith("rsync "),
      );
      expect(rsyncCall).toBeDefined();
      expect(rsyncCall[0]).toContain("--delete");
      expect(rsyncCall[0]).not.toContain("--ignore-errors");
    });

    it("fails exit 23 when file open/read fails even with 'Operation not permitted' or mixed attribute warnings (#87)", async () => {
      for (const stderr of [
        'rsync: send_files failed to open "/src/path/wp-content/secret.php": Operation not permitted (1)\nrsync error: some files/attrs were not transferred (code 23)',
        'rsync: chown "/tgt/path/wp-config.php" failed: Operation not permitted (1)\nrsync: send_files failed to open "/src/path/file.php": Permission denied (13)\nrsync error: some files/attrs were not transferred (code 23)',
      ]) {
        const { sourceExecutor, tracker } = makeRsyncArgs({
          code: 23,
          stderr,
        });

        await expect(
          (service as any).pushFilesViaRsync(
            makeJob(JOB_TYPES.SYNC_CLONE, { jobExecutionId: 1 }),
            "/src/path",
            "/tgt/path",
            {
              server: {
                ip_address: "1.2.3.4",
                ssh_port: 22,
                ssh_user: "user",
                ssh_private_key_encrypted: null,
              },
            },
            sourceExecutor as any,
            tracker as any,
            [],
          ),
        ).rejects.toThrow("rsync failed (exit 23)");
      }
    });
  });

  describe("missing source guard & tar fallback deletion parity (#85, #88)", () => {
    it("throws explicit error when source directory is missing instead of returning void (#85)", async () => {
      const sourceExecutor = {
        execute: jest.fn().mockResolvedValue({ code: 0, stdout: "missing", stderr: "" }),
      };
      const targetExecutor = { execute: jest.fn() };
      const tracker = { track: jest.fn().mockResolvedValue(undefined) };

      await expect(
        service.pushFiles(
          makeJob(JOB_TYPES.SYNC_PUSH, { jobExecutionId: 1 }),
          { root_path: "/missing/src" },
          {
            root_path: "/tgt",
            server: {
              ip_address: "1.2.3.4",
              ssh_port: 22,
              ssh_user: "user",
              name: "T",
              ssh_private_key_encrypted: null,
            },
          },
          sourceExecutor as any,
          targetExecutor as any,
          tracker as any,
        ),
      ).rejects.toThrow(/Source site directory not found/);
    });

    it("prunes stale non-excluded files in tar fallback while preserving excluded files (#88)", () => {
      const excludes = (service as any).buildFileSyncExcludes([
        "wp-content/uploads/2026/01/hero.jpg",
      ]);
      const archiveEntries = [
        "./index.php",
        "./wp-content/themes/app/style.css",
      ];
      const targetFiles = [
        "index.php",
        "wp-content/themes/app/style.css",
        "wp-content/plugins/removed-plugin/plugin.php",
        ".env",
        "wp-content/uploads/2026/01/hero.jpg",
        "wp-content/cache/page.html",
      ];

      const stale = (service as any).computeStaleTargetFiles(
        targetFiles,
        archiveEntries,
        excludes,
      );
      expect(stale).toEqual(["wp-content/plugins/removed-plugin/plugin.php"]);
    });

    it("executes tar relay deletion pruning against stale files without removing excluded paths (#88)", async () => {
      const pushedFiles: Array<{ remotePath: string; content: Buffer }> = [];
      const sourceExecutor = {
        pushFile: jest.fn().mockResolvedValue(undefined),
        execute: jest.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" }),
        pullFileToPath: jest.fn().mockImplementation(async (_r: string, localPath: string) => {
          const { writeFile } = require("fs/promises");
          await writeFile(localPath, Buffer.from("tar-bytes"));
        }),
      };
      const targetExecutor = {
        pushFile: jest.fn().mockImplementation(async (arg: { remotePath: string; content: Buffer }) => {
          pushedFiles.push(arg);
        }),
        pushFileFromStream: jest.fn().mockResolvedValue(undefined),
        execute: jest.fn().mockImplementation(async (cmd: string) => {
          if (cmd.startsWith("tar -tzf")) {
            return { code: 0, stdout: "./index.php\n", stderr: "" };
          }
          if (cmd.includes("find . -mindepth 1")) {
            return {
              code: 0,
              stdout:
                "index.php\n.env\nwp-content/uploads/2026/01/hero.jpg\nwp-content/plugins/removed/file.php\n",
              stderr: "",
            };
          }
          return { code: 0, stdout: "", stderr: "" };
        }),
      };
      const tracker = {
        track: jest.fn().mockResolvedValue(undefined),
        trackCommand: jest.fn().mockResolvedValue(undefined),
      };

      await (service as any).pushFilesViaTarRelay(
        makeJob(JOB_TYPES.SYNC_PUSH, { jobExecutionId: 9 }),
        "/src",
        "/tgt",
        sourceExecutor,
        targetExecutor,
        tracker,
        ["wp-content/uploads/2026/01/hero.jpg"],
      );

      const prunePush = pushedFiles.find((p) => p.remotePath.includes("forge_tar_prune_"));
      expect(prunePush).toBeDefined();
      expect(prunePush!.content.toString("utf8")).toBe(
        "wp-content/plugins/removed/file.php\n",
      );
      expect(
        targetExecutor.execute.mock.calls.some(([cmd]: [string]) =>
          cmd.includes("xargs -d '\\n' rm -f"),
        ),
      ).toBe(true);
    });
  });
});
