import { Test } from "@nestjs/testing";
import { JOB_TYPES } from "@bedrock-forge/shared";
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
    stat: jest.fn().mockResolvedValue({ size: 2048 }),
  };
});

describe("SystemBackupProcessor config abort (#40) and scheduled retention (#28)", () => {
  let processor: SystemBackupProcessor;
  let prisma: {
    appSetting: { findUnique: jest.Mock };
    systemBackupSchedule: { findFirst: jest.Mock; update: jest.Mock };
    jobExecution: { create: jest.Mock; update: jest.Mock };
    systemBackup: {
      create: jest.Mock;
      update: jest.Mock;
      findMany: jest.Mock;
      deleteMany: jest.Mock;
    };
  };
  let rclone: {
    writeConfig: jest.Mock;
    upload: jest.Mock;
    deleteFile: jest.Mock;
  };
  const originalDbUrl = process.env.DATABASE_URL;

  beforeEach(async () => {
    process.env.DATABASE_URL = "postgresql://forge:secret@localhost:5432/bedrock_forge";
    mockExecFile.mockReset().mockResolvedValue({ stdout: "", stderr: "" });

    prisma = {
      appSetting: { findUnique: jest.fn() },
      systemBackupSchedule: {
        findFirst: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
      jobExecution: {
        create: jest.fn().mockResolvedValue({ id: BigInt(901) }),
        update: jest.fn().mockResolvedValue({}),
      },
      systemBackup: {
        create: jest.fn().mockResolvedValue({ id: BigInt(501) }),
        update: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };

    rclone = {
      writeConfig: jest.fn().mockResolvedValue(true),
      upload: jest.fn().mockResolvedValue("gdrive:folderABC123/sys.dump"),
      deleteFile: jest.fn().mockResolvedValue({ deleted: true, alreadyMissing: false }),
    };

    const module = await Test.createTestingModule({
      providers: [
        SystemBackupProcessor,
        { provide: PrismaService, useValue: prisma },
        { provide: RcloneService, useValue: rclone },
      ],
    }).compile();

    processor = module.get(SystemBackupProcessor);
  });

  afterAll(() => {
    process.env.DATABASE_URL = originalDbUrl;
  });

  it("aborts BEFORE rclone.upload and marks SystemBackup failed when writeConfig returns false (#40)", async () => {
    rclone.writeConfig.mockResolvedValue(false);

    await expect(
      processor.process({
        id: "sys-1",
        name: JOB_TYPES.SYSTEM_BACKUP_CREATE,
        data: { systemBackupId: 44, jobExecutionId: 88, folderId: "folderABC123" },
      } as never),
    ).rejects.toThrow(/rclone|google drive.*configured/i);

    expect(rclone.upload).not.toHaveBeenCalled();
    expect(prisma.systemBackup.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: BigInt(44) },
        data: expect.objectContaining({
          status: "failed",
          error_message: expect.stringMatching(/rclone|google drive/i),
        }),
      }),
    );
  });

  it("retention deletes Drive files for scheduled backups only, preserves manual backups, and keeps DB rows whose Drive delete fails (#28)", async () => {
    prisma.appSetting.findUnique.mockResolvedValue({
      key: "forge_system_backup_folder_id",
      value: "folderABC123",
    });
    prisma.systemBackupSchedule.findFirst.mockResolvedValue({
      id: BigInt(1),
      enabled: true,
      retention_count: 1,
      retention_days: 7,
    });

    // Only scheduled backups returned when filtered by jobExecution.job_type
    const oldOk = {
      id: BigInt(401),
      file_path: "gdrive:folderABC123/old_ok.dump",
      created_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
    };
    const oldDriveFail = {
      id: BigInt(402),
      file_path: "gdrive:folderABC123/old_fail.dump",
      created_at: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000),
    };
    prisma.systemBackup.findMany.mockResolvedValue([
      { id: BigInt(501), file_path: "gdrive:folderABC123/sys.dump", created_at: new Date() },
      oldOk,
      oldDriveFail,
    ]);

    rclone.deleteFile.mockImplementation(async (fp: string) => {
      if (fp.includes("old_fail.dump")) {
        throw new Error("Drive API 500 internal error");
      }
      return { deleted: true, alreadyMissing: false };
    });

    await processor.process({
      id: "sys-sched-1",
      name: JOB_TYPES.SYSTEM_BACKUP_SCHEDULED,
      data: { scheduleId: 1 },
    } as never);

    // Must filter strictly to SYSTEM_BACKUP_SCHEDULED so manual backups are excluded
    expect(prisma.systemBackup.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "completed",
          jobExecution: { is: { job_type: JOB_TYPES.SYSTEM_BACKUP_SCHEDULED } },
        }),
      }),
    );

    // Both stale scheduled files were attempted on Drive BEFORE DB deletion
    expect(rclone.deleteFile).toHaveBeenCalledWith(oldOk.file_path);
    expect(rclone.deleteFile).toHaveBeenCalledWith(oldDriveFail.file_path);

    // Only the successfully deleted Drive record is removed from DB
    expect(prisma.systemBackup.deleteMany).toHaveBeenCalledTimes(1);
    expect(prisma.systemBackup.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: [oldOk.id] } },
    });

    // Newly uploaded backup #501 remains completed (retention failure must not revert it to failed)
    expect(prisma.systemBackup.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: BigInt(501) },
        data: expect.objectContaining({ status: "completed" }),
      }),
    );
    expect(prisma.systemBackup.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: BigInt(501) },
        data: expect.objectContaining({ status: "failed" }),
      }),
    );
  });
});
