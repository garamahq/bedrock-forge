import { Test } from "@nestjs/testing";
import { getQueueToken } from "@nestjs/bullmq";
import { UnrecoverableError } from "bullmq";
import { JOB_TYPES, QUEUES } from "@bedrock-forge/shared";
import { SystemBackupProcessor } from "./system-backup.processor";
import { PrismaService } from "../../prisma/prisma.service";
import { RcloneService } from "../../services/rclone.service";

const mockExecFile = jest.fn();

jest.mock("child_process", () => {
  const actual = jest.requireActual("child_process");
  return {
    ...actual,
    execFile: (...args: unknown[]) => {
      const cb = args[args.length - 1];
      if (typeof cb === "function") {
        mockExecFile(...args.slice(0, -1))
          .then((res: unknown) => cb(null, res))
          .catch((err: unknown) => cb(err));
        return {} as never;
      }
      return mockExecFile(...args);
    },
  };
});

jest.mock("fs/promises", () => {
  const actual = jest.requireActual("fs/promises");
  return {
    ...actual,
    stat: jest.fn().mockResolvedValue({ size: 4096 }),
  };
});

describe("SystemBackupProcessor schedule matching, missing folder failure, and retention decoupling (#29, #39, #41)", () => {
  let processor: SystemBackupProcessor;
  let prisma: {
    systemBackupSchedule: { findUnique: jest.Mock; update: jest.Mock };
    appSetting: { findUnique: jest.Mock };
    jobExecution: { create: jest.Mock; update: jest.Mock };
    systemBackup: { create: jest.Mock; update: jest.Mock };
  };
  let rclone: {
    writeConfig: jest.Mock;
    upload: jest.Mock;
  };
  let sysQueue: {
    removeJobScheduler: jest.Mock;
    getRepeatableJobs: jest.Mock;
    removeRepeatableByKey: jest.Mock;
  };
  const origDb = process.env.DATABASE_URL;

  beforeEach(async () => {
    process.env.DATABASE_URL = "postgresql://forge:pw@localhost:5432/forge";
    mockExecFile.mockReset().mockResolvedValue({ stdout: "", stderr: "" });

    prisma = {
      systemBackupSchedule: {
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
      appSetting: { findUnique: jest.fn() },
      jobExecution: {
        create: jest.fn().mockResolvedValue({ id: BigInt(10) }),
        update: jest.fn().mockResolvedValue({}),
      },
      systemBackup: {
        create: jest.fn().mockResolvedValue({ id: BigInt(20) }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    rclone = {
      writeConfig: jest.fn().mockResolvedValue(true),
      upload: jest.fn().mockResolvedValue("gdrive:folder1/sys.dump"),
    };
    sysQueue = {
      removeJobScheduler: jest.fn().mockResolvedValue(true),
      getRepeatableJobs: jest.fn().mockResolvedValue([]),
      removeRepeatableByKey: jest.fn(),
    };

    const module = await Test.createTestingModule({
      providers: [
        SystemBackupProcessor,
        { provide: PrismaService, useValue: prisma },
        { provide: RcloneService, useValue: rclone },
        { provide: getQueueToken(QUEUES.SYSTEM_BACKUPS), useValue: sysQueue },
      ],
    }).compile();

    processor = module.get(SystemBackupProcessor);
  });

  afterAll(() => {
    process.env.DATABASE_URL = origDb;
  });

  it("matches exact scheduleId, skips disabled/deleted schedule, and removes orphaned scheduler (#29)", async () => {
    prisma.systemBackupSchedule.findUnique.mockResolvedValue({
      id: BigInt(3),
      enabled: false,
    });

    await processor.process({
      id: "sys-orphan",
      name: JOB_TYPES.SYSTEM_BACKUP_SCHEDULED,
      data: { scheduleId: 3 },
    } as never);

    expect(prisma.systemBackupSchedule.findUnique).toHaveBeenCalledWith({
      where: { id: BigInt(3) },
    });
    expect(sysQueue.removeJobScheduler).toHaveBeenCalledWith("system-backup-schedule-3");
    expect(prisma.systemBackup.create).not.toHaveBeenCalled();
  });

  it("records failed JobExecution and throws UnrecoverableError when system backup folder is missing (#39)", async () => {
    prisma.systemBackupSchedule.findUnique.mockResolvedValue({
      id: BigInt(1),
      enabled: true,
      retention_count: null,
      retention_days: null,
    });
    prisma.appSetting.findUnique.mockResolvedValue(null);

    await expect(
      processor.process({
        id: "sys-nofolder",
        name: JOB_TYPES.SYSTEM_BACKUP_SCHEDULED,
        data: { scheduleId: 1 },
      } as never),
    ).rejects.toThrow(UnrecoverableError);

    expect(prisma.jobExecution.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: "failed",
        last_error: expect.stringMatching(/folder id/i),
      }),
    });
  });

  it("keeps uploaded SystemBackup completed when last_run_at update throws, while failing when upload fails (#41)", async () => {
    prisma.systemBackupSchedule.findUnique.mockResolvedValue({
      id: BigInt(1),
      enabled: true,
      retention_count: null,
      retention_days: null,
    });
    prisma.appSetting.findUnique.mockResolvedValue({
      key: "forge_system_backup_folder_id",
      value: "folder1",
    });
    prisma.systemBackupSchedule.update.mockRejectedValueOnce(
      new Error("DB lock updating last_run_at"),
    );

    await processor.process({
      id: "sys-maint-err",
      name: JOB_TYPES.SYSTEM_BACKUP_SCHEDULED,
      data: { scheduleId: 1 },
    } as never);

    expect(prisma.systemBackup.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: BigInt(20) },
        data: expect.objectContaining({
          status: "completed",
          file_path: "gdrive:folder1/sys.dump",
        }),
      }),
    );
    expect(prisma.systemBackup.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: BigInt(20) },
        data: expect.objectContaining({ status: "failed" }),
      }),
    );

    // Distinct upload failure must mark SystemBackup failed
    rclone.upload.mockRejectedValueOnce(new Error("Drive quota exceeded"));
    await expect(
      processor.process({
        id: "sys-upload-err",
        name: JOB_TYPES.SYSTEM_BACKUP_SCHEDULED,
        data: { scheduleId: 1 },
      } as never),
    ).rejects.toThrow("Drive quota exceeded");
    expect(prisma.systemBackup.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "failed",
          error_message: "Drive quota exceeded",
        }),
      }),
    );
  });
});
