import { Test } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { createRemoteExecutor } from "@bedrock-forge/remote-executor";
import { EnvironmentsService } from "./environments.service";
import { EnvironmentsRepository } from "./environments.repository";
import { ServersService } from "../servers/servers.service";
import { MonitorsService } from "../monitors/monitors.service";
import { DomainsService } from "../domains/domains.service";
import { PrismaService } from "../../prisma/prisma.service";
import { BackupSchedulesService } from "../backups/backup-schedules.service";
import { PluginUpdateSchedulesService } from "../plugin-update-schedules/plugin-update-schedules.service";

jest.mock("@bedrock-forge/remote-executor", () => ({
  createRemoteExecutor: jest.fn(),
  credentialParser: {
    parse: jest.fn(),
    parseEnvFile: jest.fn(),
  },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRepo() {
  return {
    findAll: jest.fn(),
    findByProject: jest.fn(),
    findById: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    getDbCredentials: jest.fn(),
    upsertDbCredentials: jest.fn(),
    findProjectWithHostingPackage: jest.fn().mockResolvedValue(null),
    countEnvironmentsForProject: jest.fn().mockResolvedValue(0),
  };
}

function makeServersService() {
  return {
    getServerSshConfig: jest.fn(),
    scanProjects: jest.fn(),
  };
}

function makeMonitorsService() {
  return { create: jest.fn().mockResolvedValue({}) };
}

function makeDomainsService() {
  return { findOrCreate: jest.fn().mockResolvedValue({}) };
}

function makeEnv(
  overrides: Partial<{
    id: bigint;
    root_path: string;
    url: string;
  }> = {},
) {
  return {
    id: BigInt(1),
    type: "production",
    url: "https://example.com",
    root_path: "/var/www/html",
    project_id: BigInt(10),
    server_id: BigInt(5),
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("EnvironmentsService", () => {
  let svc: EnvironmentsService;
  let repo: ReturnType<typeof makeRepo>;
  let monitorsService: ReturnType<typeof makeMonitorsService>;
  let domainsService: ReturnType<typeof makeDomainsService>;
  let serversService: ReturnType<typeof makeServersService>;

  beforeEach(async () => {
    repo = makeRepo();
    serversService = makeServersService();
    monitorsService = makeMonitorsService();
    domainsService = makeDomainsService();

    const module = await Test.createTestingModule({
      providers: [
        EnvironmentsService,
        { provide: EnvironmentsRepository, useValue: repo },
        { provide: ServersService, useValue: serversService },
        { provide: MonitorsService, useValue: monitorsService },
        { provide: DomainsService, useValue: domainsService },
        {
          provide: PrismaService,
          useValue: {
            $transaction: jest.fn().mockImplementation((cb) => (typeof cb === "function" ? cb(this) : cb)),
            monitor: { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn() },
            backupSchedule: { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn() },
            pluginUpdateSchedule: { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn() },
            cleanupSchedule: { updateMany: jest.fn() },
            securityScanSchedule: { updateMany: jest.fn() },
            jobExecution: {
              create: jest.fn().mockResolvedValue({ id: BigInt(1) }),
              update: jest.fn().mockResolvedValue({}),
            },
          },
        },
        {
          provide: BackupSchedulesService,
          useValue: { removeRepeatableJob: jest.fn() },
        },
        {
          provide: PluginUpdateSchedulesService,
          useValue: { removeRepeatableJob: jest.fn() },
        },
        {
          provide: "BullQueue_projects",
          useValue: { add: jest.fn().mockResolvedValue({ id: "1" }) },
        },
      ],
    }).compile();

    svc = module.get(EnvironmentsService);
  });

  // ── findOne ──────────────────────────────────────────────────────────────

  describe("findOne", () => {
    it("returns the environment when found", async () => {
      const env = makeEnv();
      repo.findById.mockResolvedValue(env);
      const result = await svc.findOne(1);
      expect(result).toBe(env);
      expect(repo.findById).toHaveBeenCalledWith(BigInt(1));
    });

    it("throws NotFoundException when not found", async () => {
      repo.findById.mockResolvedValue(null);
      await expect(svc.findOne(99)).rejects.toThrow(NotFoundException);
    });
  });

  // ── create ───────────────────────────────────────────────────────────────

  describe("create", () => {
    const baseDto = {
      url: "https://mysite.com",
      type: "production" as const,
      root_path: "/var/www/html",
      server_id: 5,
    };

    it("auto-creates a monitor after creating the environment", async () => {
      const env = makeEnv({ id: BigInt(7) });
      repo.create.mockResolvedValue(env);

      await svc.create(10, baseDto);

      expect(monitorsService.create).toHaveBeenCalledWith(
        expect.objectContaining({ environment_id: 7, enabled: true }),
      );
    });

    it("auto-creates a domain record from the URL hostname", async () => {
      const env = makeEnv({ id: BigInt(7) });
      repo.create.mockResolvedValue(env);

      await svc.create(10, { ...baseDto, url: "https://mysite.com/wp-admin" });

      expect(domainsService.findOrCreate).toHaveBeenCalledWith("mysite.com");
    });

    it("stores DB credentials when provided", async () => {
      const env = makeEnv({ id: BigInt(7) });
      repo.create.mockResolvedValue(env);
      repo.upsertDbCredentials.mockResolvedValue({});

      const credentials = {
        dbName: "mydb",
        dbUser: "user",
        dbPassword: "pass",
        dbHost: "localhost",
      };
      await svc.create(10, { ...baseDto, db_credentials: credentials });

      expect(repo.upsertDbCredentials).toHaveBeenCalledWith(
        BigInt(7),
        credentials,
      );
    });

    it("still succeeds when monitor auto-creation fails", async () => {
      const env = makeEnv({ id: BigInt(7) });
      repo.create.mockResolvedValue(env);
      monitorsService.create.mockRejectedValue(
        new Error("Monitor quota exceeded"),
      );

      // Should not throw — error is swallowed with a warning
      await expect(svc.create(10, baseDto)).resolves.toBe(env);
    });

    it("still succeeds when domain auto-creation fails due to invalid URL", async () => {
      const env = makeEnv({ id: BigInt(8) });
      repo.create.mockResolvedValue(env);

      // Invalid URL — new URL() will throw
      await expect(
        svc.create(10, { ...baseDto, url: "not-a-url" }),
      ).resolves.toBe(env);
    });

    it("still succeeds when domain service throws", async () => {
      const env = makeEnv({ id: BigInt(8) });
      repo.create.mockResolvedValue(env);
      domainsService.findOrCreate.mockRejectedValue(
        new Error("Domain conflict"),
      );

      await expect(svc.create(10, baseDto)).resolves.toBe(env);
    });

    it("does not call upsertDbCredentials when dto has no db_credentials", async () => {
      const env = makeEnv({ id: BigInt(9) });
      repo.create.mockResolvedValue(env);

      await svc.create(10, baseDto);

      expect(repo.upsertDbCredentials).not.toHaveBeenCalled();
    });

    it("enforces hosting package limit by throwing BadRequestException if max_sites limit is reached", async () => {
      repo.findProjectWithHostingPackage.mockResolvedValue({
        id: BigInt(10),
        hosting_package: { max_sites: 2 },
      });
      repo.countEnvironmentsForProject.mockResolvedValue(2);

      await expect(svc.create(10, baseDto)).rejects.toThrow(
        "Environment quota reached. Your hosting package allows a maximum of 2 sites/environments for this project."
      );
      expect(repo.create).not.toHaveBeenCalled();
    });

    it("allows environment creation if max_sites limit is not reached", async () => {
      const env = makeEnv({ id: BigInt(7) });
      repo.create.mockResolvedValue(env);
      repo.findProjectWithHostingPackage.mockResolvedValue({
        id: BigInt(10),
        hosting_package: { max_sites: 2 },
      });
      repo.countEnvironmentsForProject.mockResolvedValue(1);

      const result = await svc.create(10, baseDto);
      expect(result).toBe(env);
      expect(repo.create).toHaveBeenCalled();
    });
  });

  // ── update ───────────────────────────────────────────────────────────────

  describe("update", () => {
    it("throws NotFoundException when environment not found", async () => {
      repo.findById.mockResolvedValue(null);
      await expect(svc.update(99, {} as any)).rejects.toThrow(
        NotFoundException,
      );
      expect(repo.update).not.toHaveBeenCalled();
    });

    it("calls repo.update after confirming existence", async () => {
      const env = makeEnv({ id: BigInt(1) });
      repo.findById.mockResolvedValue(env);
      repo.update.mockResolvedValue(env);

      await svc.update(1, { url: "https://updated.com" } as any);

      expect(repo.update).toHaveBeenCalledWith(BigInt(1), expect.any(Object));
    });
  });

  // ── remove ───────────────────────────────────────────────────────────────

  describe("remove", () => {
    it("throws NotFoundException when environment not found", async () => {
      repo.findById.mockResolvedValue(null);
      await expect(svc.remove(99)).rejects.toThrow(NotFoundException);
      expect(repo.delete).not.toHaveBeenCalled();
    });

    it("enqueues ENVIRONMENT_DECOMMISSION job and returns execution details", async () => {
      repo.findById.mockResolvedValue(makeEnv());

      const result = await svc.remove(1);

      expect(result).toEqual({
        environmentId: 1,
        jobExecutionId: 1,
        jobId: "1",
        message: expect.any(String),
      });
    });
  });

  // ── scanServerForNewEnv ──────────────────────────────────────────────────

  describe("scanServerForNewEnv", () => {
    it("marks sites already used in the project as alreadyInThisProject=true", async () => {
      repo.findByProject.mockResolvedValue([
        makeEnv({ root_path: "/existing/path" }),
      ]);
      serversService.scanProjects.mockResolvedValue([
        { serverId: 3, path: "/existing/path", name: "existing" },
        { serverId: 3, path: "/new/path", name: "new" },
      ]);

      const results = await svc.scanServerForNewEnv(1, 3);

      expect(results).toHaveLength(2);
      const existing = results.find((r) => r.path === "/existing/path");
      const newSite = results.find((r) => r.path === "/new/path");
      expect(existing?.alreadyInThisProject).toBe(true);
      expect(newSite?.alreadyInThisProject).toBe(false);
    });

    it("filters out results from other servers", async () => {
      repo.findByProject.mockResolvedValue([]);
      serversService.scanProjects.mockResolvedValue([
        { serverId: 3, path: "/on-server-3", name: "site-a" },
        { serverId: 99, path: "/on-other-server", name: "site-b" },
      ]);

      const results = await svc.scanServerForNewEnv(1, 3);

      expect(results).toHaveLength(1);
      expect(results[0].path).toBe("/on-server-3");
    });
  });

  describe("getWpUsers", () => {
    const creds = {
      dbHost: "localhost",
      dbUser: "wp_user",
      dbPassword: "secret",
      dbName: "wp_db",
    };

    function mockExecutor(
      implementation: (command: string) => Promise<{
        code: number;
        stdout: string;
        stderr: string;
      }>,
    ) {
      const executor = {
        execute: jest.fn(implementation),
        pushFile: jest.fn().mockResolvedValue(undefined),
      };
      (createRemoteExecutor as jest.Mock).mockReturnValue(executor);
      serversService.getServerSshConfig.mockResolvedValue({
        host: "127.0.0.1",
        port: 22,
        username: "root",
        privateKey: "key",
      });
      return executor;
    }

    beforeEach(() => {
      repo.findById.mockResolvedValue(
        makeEnv({ root_path: "/home/example.com/public_html" }),
      );
      repo.getDbCredentials.mockResolvedValue(creds);
    });

    it("runs the remote scanner with detected OpenLiteSpeed PHP", async () => {
      const executor = mockExecutor(async (command) => {
        if (command.includes("grep -oE")) {
          return {
            code: 0,
            stdout: "/usr/local/lsws/lsphp83/bin/php",
            stderr: "",
          };
        }
        if (command.includes("[ -x '/usr/local/lsws/lsphp83/bin/php' ]")) {
          return { code: 0, stdout: "yes", stderr: "" };
        }
        if (command.includes("base64 -d")) {
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command.includes("bf-wp-users")) {
          return {
            code: 0,
            stdout: JSON.stringify({
              users: [
                {
                  id: 1,
                  user_login: "admin",
                  user_email: "admin@example.com",
                  display_name: "Admin",
                  user_registered: "2026-01-01 00:00:00",
                  roles: ["administrator"],
                },
              ],
            }),
            stderr: "",
          };
        }
        return { code: 0, stdout: "", stderr: "" };
      });

      const result = await svc.getWpUsers(1);

      expect(result).toHaveLength(1);
      expect(
        executor.execute.mock.calls.some(([command]) =>
          command.startsWith(
            "'/usr/local/lsws/lsphp83/bin/php' '/tmp/bf-wp-users-",
          ),
        ),
      ).toBe(true);
    });

    it("falls back to PATH php when no OpenLiteSpeed PHP is detected", async () => {
      const executor = mockExecutor(async (command) => {
        if (
          command.includes("grep -oE") ||
          command.includes("ls /usr/local/lsws")
        ) {
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command.includes("base64 -d")) {
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command.includes("bf-wp-users")) {
          return { code: 0, stdout: JSON.stringify({ users: [] }), stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      });

      await svc.getWpUsers(1);

      expect(
        executor.execute.mock.calls.some(([command]) =>
          command.startsWith("php '/tmp/bf-wp-users-"),
        ),
      ).toBe(true);
    });

    it("throws a clear error when the scanner exits non-zero", async () => {
      mockExecutor(async (command) => {
        if (
          command.includes("grep -oE") ||
          command.includes("ls /usr/local/lsws")
        ) {
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command.includes("base64 -d")) {
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command.includes("bf-wp-users")) {
          return { code: 1, stdout: "", stderr: "PDO driver missing" };
        }
        return { code: 0, stdout: "", stderr: "" };
      });

      await expect(svc.getWpUsers(1)).rejects.toThrow(
        "wp-users scan failed: PDO driver missing",
      );
    });

    it("returns empty users array gracefully when script reports error", async () => {
      mockExecutor(async (command) => {
        if (
          command.includes("grep -oE") ||
          command.includes("ls /usr/local/lsws")
        ) {
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command.includes("base64 -d")) {
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command.includes("bf-wp-users")) {
          return {
            code: 0,
            stdout: JSON.stringify({
              users: [],
              error: "DB connection failed: Access denied",
            }),
            stderr: "",
          };
        }
        return { code: 0, stdout: "", stderr: "" };
      });

      const result = await svc.getWpUsers(1);
      expect(result).toEqual([]);
    });

    it("throws a clear error when the scanner returns invalid JSON", async () => {
      mockExecutor(async (command) => {
        if (
          command.includes("grep -oE") ||
          command.includes("ls /usr/local/lsws")
        ) {
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command.includes("base64 -d")) {
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command.includes("bf-wp-users")) {
          return { code: 0, stdout: "<br>warning", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      });

      await expect(svc.getWpUsers(1)).rejects.toThrow(
        "wp-users returned invalid JSON",
      );
    });
  });
});
