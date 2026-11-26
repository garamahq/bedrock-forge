import { Test } from "@nestjs/testing";
import { getQueueToken } from "@nestjs/bullmq";
import { BackupProcessor } from "./backup.processor";
import { PrismaService } from "../../prisma/prisma.service";
import { RcloneService } from "../../services/rclone.service";
import { SshKeyService } from "../../services/ssh-key.service";
import { EncryptionService } from "../../encryption/encryption.service";
import { ConfigService } from "@nestjs/config";
import { QUEUES, JOB_TYPES } from "@bedrock-forge/shared";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePrisma() {
  return {
    jobExecution: {
      update: jest.fn().mockResolvedValue({}),
    },
    backup: {
      update: jest.fn().mockResolvedValue({}),
      create: jest.fn(),
      findUniqueOrThrow: jest.fn(),
    },
    backupSchedule: {
      findUniqueOrThrow: jest.fn(),
    },
    environment: {
      findUnique: jest.fn(),
    },
  };
}

function makeRclone() {
  return {
    writeConfig: jest.fn().mockResolvedValue(true),
    deleteFile: jest.fn().mockResolvedValue(undefined),
    uploadFile: jest.fn().mockResolvedValue(undefined),
    downloadFile: jest.fn().mockResolvedValue(undefined),
  };
}

function makeConfig() {
  return { get: jest.fn().mockReturnValue("/scripts") };
}

function makeSshKey() {
  return {
    resolvePrivateKey: jest.fn(),
    getSshConfig: jest.fn().mockImplementation(async (server: any) => ({
      host: server.ip_address,
      port: server.ssh_port,
      username: server.ssh_user,
      privateKey: "fake-key",
    })),
  };
}

function makeEncryption() {
  return { decrypt: jest.fn(), encrypt: jest.fn() };
}

function makeQueue() {
  return { add: jest.fn().mockResolvedValue({ id: "new-job-id" }) };
}

function makeJob(name: string, data: object) {
  return { id: "job-001", name, data, updateProgress: jest.fn() } as any;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("BackupProcessor", () => {
  let processor: BackupProcessor;
  let prisma: ReturnType<typeof makePrisma>;
  let rclone: ReturnType<typeof makeRclone>;
  let queue: ReturnType<typeof makeQueue>;

  beforeEach(async () => {
    prisma = makePrisma();
    rclone = makeRclone();
    queue = makeQueue();

    const module = await Test.createTestingModule({
      providers: [
        BackupProcessor,
        { provide: PrismaService, useValue: prisma },
        { provide: RcloneService, useValue: rclone },
        { provide: ConfigService, useValue: makeConfig() },
        { provide: SshKeyService, useValue: makeSshKey() },
        { provide: EncryptionService, useValue: makeEncryption() },
        { provide: getQueueToken(QUEUES.BACKUPS), useValue: queue },
      ],
    }).compile();

    processor = module.get(BackupProcessor);
  });

  // ── Job routing ───────────────────────────────────────────────────────────

  describe("process() routing", () => {
    it("routes backup:delete-file to handleDelete without touching jobExecution", async () => {
      const handleDelete = jest
        .spyOn(processor as any, "handleDelete")
        .mockResolvedValue(undefined);

      const job = makeJob(JOB_TYPES.BACKUP_DELETE_FILE, {
        filePath: "backups/old.tar.gz",
      });
      await processor.process(job);

      expect(handleDelete).toHaveBeenCalledWith("backups/old.tar.gz");
      expect(prisma.jobExecution.update).not.toHaveBeenCalled();
    });

    it("routes backup:scheduled to handleScheduled", async () => {
      const handleScheduled = jest
        .spyOn(processor as any, "handleScheduled")
        .mockResolvedValue(undefined);

      const job = makeJob(JOB_TYPES.BACKUP_SCHEDULED, {
        scheduleId: 5,
        environmentId: 1,
        type: "full",
      });
      await processor.process(job);

      expect(handleScheduled).toHaveBeenCalledWith(job, 5, 1, "full");
    });

    it("routes backup:create to handleCreate", async () => {
      const handleCreate = jest
        .spyOn(processor as any, "handleCreate")
        .mockResolvedValue(undefined);

      const job = makeJob(JOB_TYPES.BACKUP_CREATE, {
        environmentId: 2,
        type: "db_only",
        jobExecutionId: 10,
        backupId: 20,
      });
      await processor.process(job);

      expect(handleCreate).toHaveBeenCalledWith(job, 2, "db_only", 10, 20);
    });

    it("routes backup:restore to handleRestore", async () => {
      const handleRestore = jest
        .spyOn(processor as any, "handleRestore")
        .mockResolvedValue(undefined);

      const job = makeJob(JOB_TYPES.BACKUP_RESTORE, {
        backupId: 7,
        environmentId: 3,
        jobExecutionId: 15,
      });
      await processor.process(job);

      expect(handleRestore).toHaveBeenCalledWith(job, 7, 3, 15);
    });
  });

  // ── Error handling ────────────────────────────────────────────────────────

  describe("process() error handling", () => {
    it("marks backup as failed when handleCreate throws", async () => {
      jest
        .spyOn(processor as any, "handleCreate")
        .mockRejectedValue(new Error("SSH connection refused"));

      const job = makeJob(JOB_TYPES.BACKUP_CREATE, {
        environmentId: 2,
        type: "full",
        jobExecutionId: 10,
        backupId: 20,
      });

      await expect(processor.process(job)).rejects.toThrow(
        "SSH connection refused",
      );

      // Backup row must be marked failed
      expect(prisma.backup.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: BigInt(20) },
          data: expect.objectContaining({
            status: "failed",
            error_message: "SSH connection refused",
          }),
        }),
      );
    });

    it("does NOT update backup row on restore failures (no backupId write on restore path)", async () => {
      jest
        .spyOn(processor as any, "handleRestore")
        .mockRejectedValue(new Error("Download failed"));

      const job = makeJob(JOB_TYPES.BACKUP_RESTORE, {
        backupId: 7,
        environmentId: 3,
        jobExecutionId: 15,
      });

      await expect(processor.process(job)).rejects.toThrow();

      // isRestore=true so the backup update branch (guarded by !isRestore)
      // must NOT be called with a 'failed' status
      const backupFailedUpdates = (
        prisma.backup.update as jest.Mock
      ).mock.calls.filter((call: [any]) => call[0]?.data?.status === "failed");
      expect(backupFailedUpdates).toHaveLength(0);
    });
  });

  // ── handleDelete ─────────────────────────────────────────────────────────

  describe("handleDelete", () => {
    it("calls rclone.deleteFile with the given path", async () => {
      (rclone as any).deleteFile = jest.fn().mockResolvedValue(undefined);
      const job = makeJob(JOB_TYPES.BACKUP_DELETE_FILE, {
        filePath: "backups/old.tar.gz",
      });
      await processor.process(job);
      // handleDelete is called — verify via the delete mock
      expect((rclone as any).deleteFile).toHaveBeenCalledWith(
        "backups/old.tar.gz",
      );
    });
  });

  describe("scheduled job_type persistence (#48)", () => {
    it("records job_type=backup:scheduled on scheduled JobExecution rows", async () => {
      (prisma as any).backupSchedule.findUnique = jest.fn().mockResolvedValue({
        id: BigInt(4),
        enabled: true,
        retention_count: null,
        retention_days: null,
      });
      (prisma as any).jobExecution.create = jest.fn().mockResolvedValue({ id: BigInt(90) });
      (prisma as any).environment.findUniqueOrThrow = jest.fn().mockResolvedValue({
        id: BigInt(5),
        google_drive_folder_id: null,
      });

      const job = makeJob(JOB_TYPES.BACKUP_SCHEDULED, {
        scheduleId: 4,
        environmentId: 5,
        type: "full",
      });
      await processor.process(job);

      expect((prisma as any).jobExecution.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            job_type: JOB_TYPES.BACKUP_SCHEDULED,
          }),
        }),
      );
    });

    it("schedules GDrive cleanup if Step F backup update hits P2025 missing row (#49)", async () => {
      const path = require("path");
      const { writeFile } = require("fs/promises");
      (processor as any).config = {
        get: jest.fn().mockReturnValue(path.resolve(__dirname, "../../../scripts")),
      };
      const p2025 = Object.assign(new Error("Record to update not found"), {
        code: "P2025",
      });
      prisma.backup.update
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(p2025);
      (prisma as any).wpDbCredentials = { findUnique: jest.fn().mockResolvedValue(null) };
      prisma.environment.findUnique = jest.fn();
      (prisma.environment as any).findUniqueOrThrow = jest.fn().mockResolvedValue({
        id: BigInt(1),
        google_drive_folder_id: "folder-1",
        root_path: "/home/site/public_html",
        type: "production",
        project: { name: "Site A" },
        server: { ip_address: "192.0.2.1", ssh_port: 22, ssh_user: "root" },
      });
      const rcloneAny = rclone as unknown as { upload: jest.Mock };
      rcloneAny.upload = jest.fn().mockResolvedValue("gdrive:folder-1/site.tar.gz");

      const remoteExec = require("@bedrock-forge/remote-executor");
      jest.spyOn(remoteExec, "createRemoteExecutor").mockReturnValue({
        execute: jest.fn().mockImplementation(async (cmd: string) => {
          if (cmd.startsWith("stat -c%s")) return { code: 0, stdout: "4\n", stderr: "" };
          return {
            code: 0,
            stdout: JSON.stringify({ size: 4, filename: "site.tar.gz" }),
            stderr: "",
          };
        }),
        pushFile: jest.fn().mockResolvedValue(undefined),
        pullFileToPath: jest.fn().mockImplementation(async (_r: string, localPath: string) => {
          await writeFile(localPath, "arch");
        }),
      });

      const job = makeJob(JOB_TYPES.BACKUP_CREATE, {
        environmentId: 1,
        type: "full",
        jobExecutionId: 10,
        backupId: 20,
      });

      try {
        await expect(processor.process(job)).rejects.toThrow("Record to update not found");
      } finally {
        jest.restoreAllMocks();
      }

      expect(queue.add).toHaveBeenCalledWith(
        JOB_TYPES.BACKUP_DELETE_FILE,
        { filePath: "gdrive:folder-1/site.tar.gz" },
        expect.any(Object),
      );
    });
  });
});
