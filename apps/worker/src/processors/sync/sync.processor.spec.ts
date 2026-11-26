import { Test } from "@nestjs/testing";
import { getQueueToken } from "@nestjs/bullmq";
import { SyncProcessor } from "./sync.processor";
import { PrismaService } from "../../prisma/prisma.service";
import { SshKeyService } from "../../services/ssh-key.service";
import { RcloneService } from "../../services/rclone.service";
import { EncryptionService } from "../../encryption/encryption.service";
import { LayoutDetectorService } from "./services/layout-detector.service";
import { ProtectedCptService } from "./services/protected-cpt.service";
import { SyncDbService } from "./services/sync-db.service";
import { SyncFilesService } from "./services/sync-files.service";
import { QUEUES, JOB_TYPES } from "@bedrock-forge/shared";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePrisma() {
  return {
    jobExecution: {
      update: jest.fn().mockResolvedValue({}),
    },
    environment: {
      findUniqueOrThrow: jest.fn(),
    },
    appSetting: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
  };
}

function makeSshKey() {
  return {
    resolvePrivateKey: jest
      .fn()
      .mockResolvedValue("-----BEGIN PRIVATE KEY-----"),
    getSshConfig: jest.fn().mockImplementation(async (server: any) => ({
      host: server.ip_address,
      port: server.ssh_port,
      username: server.ssh_user,
      privateKey: "-----BEGIN PRIVATE KEY-----",
    })),
  };
}

function makeRclone() {
  return {
    writeConfig: jest.fn().mockResolvedValue(true),
    uploadFile: jest.fn().mockResolvedValue(undefined),
    downloadFile: jest.fn().mockResolvedValue(undefined),
  };
}

function makeEncryption() {
  return {
    decrypt: jest.fn().mockReturnValue("decrypted-value"),
    encrypt: jest.fn().mockReturnValue("encrypted-value"),
  };
}

function makeQueue() {
  return {
    add: jest.fn().mockResolvedValue({ id: "job-id" }),
    client: Promise.resolve({ get: jest.fn().mockResolvedValue(null) }),
  };
}

function makeJob(name: string, data: object) {
  return {
    id: "sync-job-001",
    name,
    data,
    updateProgress: jest.fn(),
  } as any;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("SyncProcessor", () => {
  let processor: SyncProcessor;
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(async () => {
    prisma = makePrisma();

    const module = await Test.createTestingModule({
      providers: [
        SyncProcessor,
        { provide: PrismaService, useValue: prisma },
        { provide: SshKeyService, useValue: makeSshKey() },
        { provide: RcloneService, useValue: makeRclone() },
        { provide: EncryptionService, useValue: makeEncryption() },
        { provide: getQueueToken(QUEUES.SYNC), useValue: makeQueue() },
        {
          provide: LayoutDetectorService,
          useValue: { detectWpLayout: jest.fn() },
        },
        {
          provide: ProtectedCptService,
          useValue: {
            backupProtectedPostTypes: jest.fn(),
            restoreProtectedPostTypes: jest.fn(),
            buildProtectedUploadFileExcludes: jest.fn(),
            collectProtectedPostTypeUploadPaths: jest.fn(),
          },
        },
        {
          provide: SyncDbService,
          useValue: {
            resolveCredentials: jest.fn(),
            resolveWpUrl: jest.fn(),
            createSafetyBackup: jest.fn(),
            normalizeProtectedTables: jest.fn(),
            trackProtectedTablePresence: jest.fn(),
            executeSqlProtectionQueries: jest.fn(),
            runUrlSearchReplace: jest.fn(),
            validateUrlReplacement: jest.fn(),
            flushWordPressCaches: jest.fn(),
            ensureTargetEnvironmentConfig: jest.fn(),
          },
        },
        {
          provide: SyncFilesService,
          useValue: {
            pushFiles: jest.fn(),
            replaceUrlsInFiles: jest.fn(),
          },
        },
      ],
    }).compile();

    processor = module.get(SyncProcessor);
  });

  // ── process() routing ────────────────────────────────────────────────────

  describe("process() routing", () => {
    it("always marks jobExecution active on start", async () => {
      const processClone = jest
        .spyOn(processor as any, "processClone")
        .mockResolvedValue(undefined);

      const job = makeJob(JOB_TYPES.SYNC_CLONE, {
        jobExecutionId: 42,
        sourceEnvironmentId: 1,
        targetEnvironmentId: 2,
      });
      await processor.process(job);

      expect(prisma.jobExecution.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: BigInt(42) },
          data: expect.objectContaining({ status: "active" }),
        }),
      );
      expect(processClone).toHaveBeenCalledWith(job, expect.any(Object));
    });

    it("routes sync:clone to processClone", async () => {
      const processClone = jest
        .spyOn(processor as any, "processClone")
        .mockResolvedValue(undefined);
      const processPush = jest
        .spyOn(processor as any, "processPush")
        .mockResolvedValue(undefined);

      const job = makeJob(JOB_TYPES.SYNC_CLONE, { jobExecutionId: 1 });
      await processor.process(job);

      expect(processClone).toHaveBeenCalledTimes(1);
      expect(processPush).not.toHaveBeenCalled();
    });

    it("routes sync:push to processPush", async () => {
      const processClone = jest
        .spyOn(processor as any, "processClone")
        .mockResolvedValue(undefined);
      const processPush = jest
        .spyOn(processor as any, "processPush")
        .mockResolvedValue(undefined);

      const job = makeJob(JOB_TYPES.SYNC_PUSH, { jobExecutionId: 2 });
      await processor.process(job);

      expect(processPush).toHaveBeenCalledTimes(1);
      expect(processClone).not.toHaveBeenCalled();
    });

    it("marks jobExecution completed when processClone succeeds", async () => {
      jest.spyOn(processor as any, "processClone").mockResolvedValue(undefined);

      const job = makeJob(JOB_TYPES.SYNC_CLONE, { jobExecutionId: 10 });
      await processor.process(job);

      const completedUpdate = (
        prisma.jobExecution.update as jest.Mock
      ).mock.calls.find((c: [any]) => c[0].data.status === "completed");
      expect(completedUpdate).toBeDefined();
      expect(completedUpdate[0].where.id).toEqual(BigInt(10));
    });
  });

  // ── Error handling ────────────────────────────────────────────────────────

  describe("process() error handling", () => {
    it("marks jobExecution as failed when processClone throws", async () => {
      jest
        .spyOn(processor as any, "processClone")
        .mockRejectedValue(new Error("DB connection refused"));

      const job = makeJob(JOB_TYPES.SYNC_CLONE, { jobExecutionId: 15 });

      await expect(processor.process(job)).rejects.toThrow(
        "DB connection refused",
      );

      const failedUpdate = (
        prisma.jobExecution.update as jest.Mock
      ).mock.calls.find((c: [any]) => c[0].data.status === "failed");
      expect(failedUpdate).toBeDefined();
      expect(failedUpdate[0].data.last_error).toBe("DB connection refused");
      expect(failedUpdate[0].where.id).toEqual(BigInt(15));
    });

    it("marks jobExecution as failed when processPush throws", async () => {
      jest
        .spyOn(processor as any, "processPush")
        .mockRejectedValue(new Error("rsync failed"));

      const job = makeJob(JOB_TYPES.SYNC_PUSH, { jobExecutionId: 20 });

      await expect(processor.process(job)).rejects.toThrow("rsync failed");

      const failedUpdate = (
        prisma.jobExecution.update as jest.Mock
      ).mock.calls.find((c: [any]) => c[0].data.status === "failed");
      expect(failedUpdate).toBeDefined();
      expect(failedUpdate[0].data.last_error).toBe("rsync failed");
    });

    it("rethrows the original error after marking as failed", async () => {
      const originalError = new Error("SFTP timeout");
      jest
        .spyOn(processor as any, "processClone")
        .mockRejectedValue(originalError);

      const job = makeJob(JOB_TYPES.SYNC_CLONE, { jobExecutionId: 5 });

      await expect(processor.process(job)).rejects.toBe(originalError);
    });
  });

  describe("sync safeguards (#82, #83, #85)", () => {
    it("rejects replayed clone or push payloads with identical source and target IDs before DB or SSH access (#82)", async () => {
      const cloneJob = makeJob(JOB_TYPES.SYNC_CLONE, {
        sourceEnvironmentId: 9,
        targetEnvironmentId: 9,
        jobExecutionId: 30,
      });
      await expect(processor.process(cloneJob)).rejects.toThrow();
      expect(prisma.environment.findUniqueOrThrow).not.toHaveBeenCalled();

      const pushJob = makeJob(JOB_TYPES.SYNC_PUSH, {
        sourceEnvironmentId: 9,
        targetEnvironmentId: 9,
        scope: "both",
        jobExecutionId: 31,
      });
      await expect(processor.process(pushJob)).rejects.toThrow();
      expect(prisma.environment.findUniqueOrThrow).not.toHaveBeenCalled();
    });

    it("aborts files push on staging when protected upload enumeration fails, while preserving production promotion fallback (#83)", async () => {
      const mockExecutor = {
        execute: jest.fn().mockResolvedValue({ code: 0, stdout: "ok", stderr: "" }),
        pushFile: jest.fn().mockResolvedValue(undefined),
      };
      const execSpy = jest
        .spyOn(require("@bedrock-forge/remote-executor"), "createRemoteExecutor")
        .mockReturnValue(mockExecutor);
      try {
        const module = await Test.createTestingModule({
          providers: [
            SyncProcessor,
            { provide: PrismaService, useValue: prisma },
            { provide: SshKeyService, useValue: makeSshKey() },
            { provide: RcloneService, useValue: makeRclone() },
            { provide: EncryptionService, useValue: makeEncryption() },
            { provide: getQueueToken(QUEUES.SYNC), useValue: makeQueue() },
            {
              provide: LayoutDetectorService,
              useValue: {
                detectWpLayout: jest.fn().mockResolvedValue({
                  isBedrock: false,
                  corePath: "/var/www",
                  contentPath: "/var/www/wp-content",
                }),
              },
            },
            {
              provide: ProtectedCptService,
              useValue: {
                collectProtectedPostTypeUploadPaths: jest
                  .fn()
                  .mockRejectedValue(new Error("MySQL query failed")),
                buildProtectedUploadFileExcludes: jest.fn().mockReturnValue([]),
              },
            },
            {
              provide: SyncDbService,
              useValue: {
                resolveCredentials: jest.fn().mockResolvedValue({
                  dbHost: "localhost",
                  dbUser: "u",
                  dbPassword: "p",
                  dbName: "db",
                }),
                resolveWpUrl: jest.fn().mockResolvedValue("https://env.test"),
                ensureTargetEnvironmentConfig: jest.fn().mockResolvedValue(undefined),
                flushWordPressCaches: jest.fn().mockResolvedValue(undefined),
              },
            },
            {
              provide: SyncFilesService,
              useValue: {
                assertSourceDirectoryExists: jest.fn().mockResolvedValue(undefined),
                pushFiles: jest.fn().mockResolvedValue(undefined),
                hasBroadUploadsProtection: jest
                  .fn()
                  .mockImplementation(
                    (srcType?: string, tgtType?: string) =>
                      tgtType === "production" && srcType !== "production",
                  ),
                replaceUrlsInFiles: jest.fn().mockResolvedValue(undefined),
              },
            },
          ],
        }).compile();

        const guardedProcessor = module.get(SyncProcessor);
        const syncFilesMock = module.get(SyncFilesService);

        const server = {
          id: BigInt(1),
          name: "S1",
          ip_address: "198.51.100.1",
          ssh_port: 22,
          ssh_user: "root",
          ssh_private_key_encrypted: "enc",
        };
        prisma.environment.findUniqueOrThrow
          .mockResolvedValueOnce({
            id: BigInt(1),
            type: "production",
            root_path: "/src",
            server,
            project: { name: "P" },
          })
          .mockResolvedValueOnce({
            id: BigInt(2),
            type: "staging",
            root_path: "/tgt",
            protected_post_types: ["course"],
            server,
            project: { name: "P" },
          });

        await expect(
          guardedProcessor.process(
            makeJob(JOB_TYPES.SYNC_PUSH, {
              sourceEnvironmentId: 1,
              targetEnvironmentId: 2,
              scope: "files",
              jobExecutionId: 44,
            }),
          ),
        ).rejects.toThrow(/MySQL query failed/);
        expect(syncFilesMock.pushFiles).not.toHaveBeenCalled();

        // Staging -> Production promotion already excludes all uploads/ broadly
        prisma.environment.findUniqueOrThrow
          .mockResolvedValueOnce({
            id: BigInt(2),
            type: "staging",
            root_path: "/src",
            server,
            project: { name: "P" },
          })
          .mockResolvedValueOnce({
            id: BigInt(1),
            type: "production",
            root_path: "/tgt",
            protected_post_types: ["course"],
            server,
            project: { name: "P" },
          });

        await guardedProcessor.process(
          makeJob(JOB_TYPES.SYNC_PUSH, {
            sourceEnvironmentId: 2,
            targetEnvironmentId: 1,
            scope: "files",
            jobExecutionId: 45,
          }),
        );
        expect(syncFilesMock.pushFiles).toHaveBeenCalledTimes(1);
      } finally {
        execSpy.mockRestore();
      }
    });

    it("fails push(scope='both') before mutating target DB when source directory is missing (#85)", async () => {
      const syncDbMock = {
        createSafetyBackup: jest.fn().mockResolvedValue(undefined),
        resolveCredentials: jest.fn().mockResolvedValue({
          dbHost: "localhost",
          dbUser: "u",
          dbPassword: "p",
          dbName: "db",
        }),
      };
      const syncFilesMock = {
        assertSourceDirectoryExists: jest
          .fn()
          .mockRejectedValue(new Error("Source site directory not found: /missing")),
        pushFiles: jest.fn(),
        hasBroadUploadsProtection: jest.fn().mockReturnValue(false),
      };

      const module = await Test.createTestingModule({
        providers: [
          SyncProcessor,
          { provide: PrismaService, useValue: prisma },
          { provide: SshKeyService, useValue: makeSshKey() },
          { provide: RcloneService, useValue: makeRclone() },
          { provide: EncryptionService, useValue: makeEncryption() },
          { provide: getQueueToken(QUEUES.SYNC), useValue: makeQueue() },
          {
            provide: LayoutDetectorService,
            useValue: {
              detectWpLayout: jest.fn().mockResolvedValue({
                isBedrock: false,
                corePath: "/var/www",
                contentPath: "/var/www/wp-content",
              }),
            },
          },
          { provide: ProtectedCptService, useValue: {} },
          { provide: SyncDbService, useValue: syncDbMock },
          { provide: SyncFilesService, useValue: syncFilesMock },
        ],
      }).compile();

      const guardedProcessor = module.get(SyncProcessor);
      const server = {
        id: BigInt(1),
        name: "S1",
        ip_address: "198.51.100.1",
        ssh_port: 22,
        ssh_user: "root",
        ssh_private_key_encrypted: "enc",
      };
      prisma.environment.findUniqueOrThrow
        .mockResolvedValueOnce({
          id: BigInt(1),
          type: "staging",
          root_path: "/missing",
          server,
          project: { name: "P" },
        })
        .mockResolvedValueOnce({
          id: BigInt(2),
          type: "production",
          root_path: "/tgt",
          server,
          project: { name: "P" },
        });

      await expect(
        guardedProcessor.process(
          makeJob(JOB_TYPES.SYNC_PUSH, {
            sourceEnvironmentId: 1,
            targetEnvironmentId: 2,
            scope: "both",
            jobExecutionId: 46,
            skipSafetyBackup: true,
          }),
        ),
      ).rejects.toThrow(/Source site directory not found/);
      expect(syncDbMock.createSafetyBackup).not.toHaveBeenCalled();
    });
  });
});
