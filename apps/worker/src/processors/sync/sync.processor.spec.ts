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
});
