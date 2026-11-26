import { Test } from "@nestjs/testing";
import { getQueueToken } from "@nestjs/bullmq";
import { ConfigService } from "@nestjs/config";
import { JOB_TYPES, QUEUES } from "@bedrock-forge/shared";
import { BackupProcessor } from "./backup.processor";
import { PrismaService } from "../../prisma/prisma.service";
import { RcloneService } from "../../services/rclone.service";
import { SshKeyService } from "../../services/ssh-key.service";
import { EncryptionService } from "../../encryption/encryption.service";

describe("BackupProcessor deferred Drive deletion and retryable handleDelete (#27)", () => {
  let processor: BackupProcessor;
  let prisma: {
    backup: {
      findMany: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
      delete: jest.Mock;
      deleteMany: jest.Mock;
    };
  };
  let rclone: {
    writeConfig: jest.Mock;
    deleteFile: jest.Mock;
  };
  let queue: { add: jest.Mock };

  beforeEach(async () => {
    prisma = {
      backup: {
        findMany: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        delete: jest.fn().mockResolvedValue({}),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    rclone = {
      writeConfig: jest.fn().mockResolvedValue(true),
      deleteFile: jest.fn().mockResolvedValue({ deleted: true, alreadyMissing: false }),
    };
    queue = { add: jest.fn().mockResolvedValue({ id: "del-job" }) };

    const module = await Test.createTestingModule({
      providers: [
        BackupProcessor,
        { provide: PrismaService, useValue: prisma },
        { provide: RcloneService, useValue: rclone },
        { provide: SshKeyService, useValue: {} },
        { provide: EncryptionService, useValue: {} },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue("/scripts") } },
        { provide: getQueueToken(QUEUES.BACKUPS), useValue: queue },
      ],
    }).compile();

    processor = module.get(BackupProcessor);
  });

  it("throws when rclone config is missing so BullMQ retries instead of dropping Drive deletion (#27)", async () => {
    rclone.writeConfig.mockResolvedValue(false);

    await expect(
      processor.process({
        id: "del-1",
        name: JOB_TYPES.BACKUP_DELETE_FILE,
        attemptsMade: 0,
        opts: { attempts: 5 },
        data: { filePath: "gdrive:folder123/old.tar.gz", backupId: 55 },
      } as never),
    ).rejects.toThrow(/rclone|config/i);

    expect(rclone.deleteFile).not.toHaveBeenCalled();
    expect(prisma.backup.delete).not.toHaveBeenCalled();
    expect(prisma.backup.deleteMany).not.toHaveBeenCalled();
  });

  it("throws on transient storage failure, preserving backup reference across retries, and records terminal error (#27)", async () => {
    rclone.deleteFile.mockRejectedValue(new Error("429 Too Many Requests"));

    await expect(
      processor.process({
        id: "del-2",
        name: JOB_TYPES.BACKUP_DELETE_FILE,
        attemptsMade: 4, // final (5th) attempt when opts.attempts = 5
        opts: { attempts: 5 },
        data: { filePath: "gdrive:folder123/old.tar.gz", backupId: 77 },
      } as never),
    ).rejects.toThrow("429 Too Many Requests");

    expect(prisma.backup.delete).not.toHaveBeenCalled();
    expect(prisma.backup.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: BigInt(77) },
        data: expect.objectContaining({
          error_message: expect.stringContaining("429 Too Many Requests"),
        }),
      }),
    );
  });

  it("deletes Backup row only AFTER rclone confirms deletion or alreadyMissing=true (#27)", async () => {
    rclone.deleteFile.mockResolvedValueOnce({ deleted: false, alreadyMissing: true });

    await processor.process({
      id: "del-3",
      name: JOB_TYPES.BACKUP_DELETE_FILE,
      attemptsMade: 0,
      opts: { attempts: 5 },
      data: { filePath: "gdrive:folder123/gone.tar.gz", backupId: 88 },
    } as never);

    expect(prisma.backup.delete).toHaveBeenCalledWith({ where: { id: BigInt(88) } });
  });

  it("retention cleanup marks file-backed backups as deleting instead of deleting DB records prematurely (#27)", async () => {
    prisma.backup.findMany.mockResolvedValue([
      { id: BigInt(11), file_path: "gdrive:folder123/old1.tar.gz", created_at: new Date(1000) },
      { id: BigInt(12), file_path: null, created_at: new Date(1000) },
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
    ).cleanupRetention(1, 99, 1, null);

    // Backup with Drive file stays in DB in 'deleting' state until worker confirms deletion
    expect(prisma.backup.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [BigInt(11)] } },
      data: { status: "deleting", error_message: null },
    });
    expect(queue.add).toHaveBeenCalledWith(
      JOB_TYPES.BACKUP_DELETE_FILE,
      { filePath: "gdrive:folder123/old1.tar.gz", backupId: 11 },
      expect.objectContaining({ attempts: 5 }),
    );
    // Only orphan DB row without file_path is deleted immediately
    expect(prisma.backup.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: [BigInt(12)] } },
    });
  });
});
