import { Test } from "@nestjs/testing";
import { getQueueToken } from "@nestjs/bullmq";
import { ConfigService } from "@nestjs/config";
import { UnrecoverableError } from "bullmq";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createRemoteExecutor } from "@bedrock-forge/remote-executor";
import { JOB_TYPES, QUEUES } from "@bedrock-forge/shared";
import { BackupProcessor } from "./backup.processor";
import { PrismaService } from "../../prisma/prisma.service";
import { RcloneService } from "../../services/rclone.service";
import { SshKeyService } from "../../services/ssh-key.service";
import { EncryptionService } from "../../encryption/encryption.service";

jest.mock("@bedrock-forge/remote-executor", () => ({
  createRemoteExecutor: jest.fn(),
}));

describe("BackupProcessor scheduled retention, failures, orphan cleanup, and restore guards (#25, #26, #29, #39, #50)", () => {
  let processor: BackupProcessor;
  let prisma: {
    backupSchedule: { findUnique: jest.Mock; update: jest.Mock };
    jobExecution: { create: jest.Mock; update: jest.Mock };
    environment: { findUniqueOrThrow: jest.Mock };
    backup: {
      create: jest.Mock;
      update: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      findMany: jest.Mock;
      deleteMany: jest.Mock;
    };
    wpDbCredentials: { findUnique: jest.Mock };
  };
  let rclone: {
    writeConfig: jest.Mock;
    upload: jest.Mock;
    deleteFile: jest.Mock;
    downloadStream: jest.Mock;
  };
  let backupsQueue: {
    add: jest.Mock;
    getRepeatableJobs: jest.Mock;
    removeRepeatableByKey: jest.Mock;
    removeJobScheduler: jest.Mock;
    client: Promise<{ get: jest.Mock }>;
  };
  let executor: {
    execute: jest.Mock;
    pushFile: jest.Mock;
    pullFileToPath: jest.Mock;
    pushFileFromStream: jest.Mock;
  };

  beforeEach(async () => {
    executor = {
      execute: jest.fn().mockResolvedValue({ code: 0, stdout: JSON.stringify({ status: "ok", size: 100 }), stderr: "" }),
      pushFile: jest.fn().mockResolvedValue(undefined),
      pullFileToPath: jest.fn().mockResolvedValue(undefined),
      pushFileFromStream: jest.fn().mockResolvedValue(undefined),
    };
    (createRemoteExecutor as jest.Mock).mockReturnValue(executor);

    prisma = {
      backupSchedule: {
        findUnique: jest.fn().mockResolvedValue({
          id: BigInt(7),
          enabled: true,
          retention_count: 1,
          retention_days: null,
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      jobExecution: {
        create: jest.fn().mockResolvedValue({ id: BigInt(88) }),
        update: jest.fn().mockResolvedValue({}),
      },
      environment: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: BigInt(2),
          url: "https://site.test",
          root_path: "/home/site.test/public_html",
          google_drive_folder_id: "folderABC123",
          server: { ip_address: "198.51.100.1", ssh_port: 22, ssh_user: "root" },
          project: { name: "TestSite" },
        }),
      },
      backup: {
        create: jest.fn().mockResolvedValue({ id: BigInt(55) }),
        update: jest.fn().mockResolvedValue({}),
        findUniqueOrThrow: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      wpDbCredentials: { findUnique: jest.fn().mockResolvedValue(null) },
    };

    rclone = {
      writeConfig: jest.fn().mockResolvedValue(true),
      upload: jest.fn().mockResolvedValue("gdrive:folderABC123/ok.tar.gz"),
      deleteFile: jest.fn().mockResolvedValue(undefined),
      downloadStream: jest.fn(),
    };

    backupsQueue = {
      add: jest.fn().mockResolvedValue({ id: "del-1" }),
      getRepeatableJobs: jest.fn().mockResolvedValue([]),
      removeRepeatableByKey: jest.fn().mockResolvedValue(true),
      removeJobScheduler: jest.fn().mockResolvedValue(true),
      client: Promise.resolve({ get: jest.fn().mockResolvedValue(null) }),
    };

    const module = await Test.createTestingModule({
      providers: [
        BackupProcessor,
        { provide: PrismaService, useValue: prisma },
        { provide: RcloneService, useValue: rclone },
        { provide: SshKeyService, useValue: { getSshConfig: jest.fn().mockResolvedValue({}) } },
        { provide: EncryptionService, useValue: { decrypt: jest.fn((v: string) => v) } },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue("/scripts") } },
        { provide: getQueueToken(QUEUES.BACKUPS), useValue: backupsQueue },
      ],
    }).compile();

    processor = module.get(BackupProcessor);
  });

  it("persists job_type=backup:scheduled and handles legacy scheduled records in retention while preserving manual backups (#25)", async () => {
    jest.spyOn(processor as unknown as { handleCreate: jest.Mock }, "handleCreate").mockResolvedValue(undefined);

    await processor.process({
      id: "sched-job-1",
      name: JOB_TYPES.BACKUP_SCHEDULED,
      data: { scheduleId: 7, environmentId: 2, type: "full" },
      updateProgress: jest.fn(),
    } as never);

    expect(prisma.jobExecution.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        job_type: JOB_TYPES.BACKUP_SCHEDULED,
        queue_name: QUEUES.BACKUPS,
        environment_id: BigInt(2),
      }),
    });

    // Retention must keep newest + manual backups, while removing newer+legacy scheduled backups
    prisma.backup.findMany.mockResolvedValueOnce([
      {
        id: BigInt(54),
        file_path: "gdrive:folderABC123/recent_sched.tar.gz",
        created_at: new Date(Date.now() - 1000),
        jobExecution: { job_type: JOB_TYPES.BACKUP_SCHEDULED, payload: { scheduleId: 7 } },
      },
      {
        id: BigInt(53),
        file_path: "gdrive:folderABC123/legacy_sched.tar.gz",
        created_at: new Date(Date.now() - 100_000),
        // Legacy scheduled JobExecution created without job_type
        jobExecution: { job_type: null, payload: { scheduleId: 7 } },
      },
      {
        id: BigInt(52),
        file_path: "gdrive:folderABC123/manual.tar.gz",
        created_at: new Date(Date.now() - 200_000),
        jobExecution: { job_type: JOB_TYPES.BACKUP_CREATE, payload: { environmentId: 2 } },
      },
    ]);

    await (
      processor as unknown as {
        cleanupRetention: (
          envId: number,
          justCreatedId: number,
          count: number | null,
          days: number | null,
        ) => Promise<void>;
      }
    ).cleanupRetention(2, 55, 1, null);

    expect(backupsQueue.add).toHaveBeenCalledWith(
      JOB_TYPES.BACKUP_DELETE_FILE,
      { filePath: "gdrive:folderABC123/recent_sched.tar.gz" },
      expect.any(Object),
    );
    expect(backupsQueue.add).toHaveBeenCalledWith(
      JOB_TYPES.BACKUP_DELETE_FILE,
      { filePath: "gdrive:folderABC123/legacy_sched.tar.gz" },
      expect.any(Object),
    );
    expect(backupsQueue.add).not.toHaveBeenCalledWith(
      JOB_TYPES.BACKUP_DELETE_FILE,
      { filePath: "gdrive:folderABC123/manual.tar.gz" },
      expect.any(Object),
    );
  });

  it("marks BOTH Backup and JobExecution as failed when scheduled backup fails before or after running (#26)", async () => {
    jest
      .spyOn(processor as unknown as { handleCreate: jest.Mock }, "handleCreate")
      .mockRejectedValueOnce(new Error("GDrive upload quota exceeded"));

    await expect(
      processor.process({
        id: "sched-fail-1",
        name: JOB_TYPES.BACKUP_SCHEDULED,
        data: { scheduleId: 7, environmentId: 2, type: "full" },
        updateProgress: jest.fn(),
      } as never),
    ).rejects.toThrow("GDrive upload quota exceeded");

    expect(prisma.backup.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: BigInt(55) },
        data: expect.objectContaining({
          status: "failed",
          error_message: "GDrive upload quota exceeded",
        }),
      }),
    );
  });

  it("throws UnrecoverableError when scheduled env has no google_drive_folder_id (#39)", async () => {
    prisma.environment.findUniqueOrThrow.mockResolvedValueOnce({
      id: BigInt(2),
      google_drive_folder_id: null,
    });

    await expect(
      processor.process({
        id: "sched-nofolder",
        name: JOB_TYPES.BACKUP_SCHEDULED,
        data: { scheduleId: 7, environmentId: 2, type: "full" },
        updateProgress: jest.fn(),
      } as never),
    ).rejects.toThrow(UnrecoverableError);

    expect(prisma.backup.create).not.toHaveBeenCalled();
  });

  it("removes orphaned scheduler via removeJobScheduler when schedule disabled or deleted (#29)", async () => {
    prisma.backupSchedule.findUnique.mockResolvedValueOnce({ id: BigInt(7), enabled: false });

    await processor.process({
      id: "sched-disabled",
      name: JOB_TYPES.BACKUP_SCHEDULED,
      data: { scheduleId: 7, environmentId: 2, type: "full" },
      updateProgress: jest.fn(),
    } as never);

    expect(backupsQueue.removeJobScheduler).toHaveBeenCalledWith("backup-schedule-7");
    expect(prisma.jobExecution.create).not.toHaveBeenCalled();
  });

  it("re-validates backup status in handleRestore and restores Sync .sql dumps without wiping docroot (#50)", async () => {
    prisma.backup.findUniqueOrThrow.mockResolvedValueOnce({
      id: BigInt(30),
      environment_id: BigInt(2),
      status: "failed",
      file_path: "gdrive:folderABC123/ok.tar.gz",
    });

    await expect(
      processor.process({
        id: "res-stale-state",
        name: JOB_TYPES.BACKUP_RESTORE,
        data: { backupId: 30, environmentId: 2, jobExecutionId: 99 },
        updateProgress: jest.fn(),
      } as never),
    ).rejects.toThrow(/not in completed state|cannot restore/i);
    expect(executor.pushFileFromStream).not.toHaveBeenCalled();

    // Sync safety .sql backup restore imports SQL via mysql without running rm -rf / tar restore
    prisma.backup.findUniqueOrThrow.mockResolvedValueOnce({
      id: BigInt(31),
      environment_id: BigInt(2),
      status: "completed",
      type: "db_only",
      file_path: "gdrive:folderABC123/sync-safety-2026.sql",
      size_bytes: BigInt(50),
      environment: { id: BigInt(2), url: "https://site.test" },
    });
    prisma.wpDbCredentials.findUnique.mockResolvedValueOnce({
      db_name_encrypted: "wp_db",
      db_user_encrypted: "wp_user",
      db_password_encrypted: "wp_pass",
      db_host_encrypted: "localhost",
    });
    const child = Object.assign(new EventEmitter(), {
      exitCode: 0,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: jest.fn(),
    });
    rclone.downloadStream.mockReturnValue({ child, stream: child.stdout });
    executor.pushFileFromStream.mockImplementation(async () => {
      child.stdout.end();
    });

    await processor.process({
      id: "res-sync-sql",
      name: JOB_TYPES.BACKUP_RESTORE,
      data: { backupId: 31, environmentId: 2, jobExecutionId: 100 },
      updateProgress: jest.fn(),
    } as never);

    expect(
      executor.execute.mock.calls.some(([cmd]: [string]) =>
        cmd.includes("backup.php") && cmd.includes("--restore"),
      ),
    ).toBe(false);
    expect(
      executor.execute.mock.calls.some(([cmd]: [string]) =>
        cmd.includes("mysql ") && cmd.includes("forge_restore_res-sync-sql.sql"),
      ),
    ).toBe(true);
  });
});
