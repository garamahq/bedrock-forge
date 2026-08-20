import { Test } from "@nestjs/testing";
import { NotFoundException, BadRequestException } from "@nestjs/common";
import { getQueueToken } from "@nestjs/bullmq";
import { BackupsService } from "./backups.service";
import { BackupsRepository } from "./backups.repository";
import { QUEUES, JOB_TYPES } from "@bedrock-forge/shared";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRepo() {
  return {
    findByEnvironmentPaginated: jest.fn(),
    findById: jest.fn(),
    findEnvironment: jest.fn(),
    create: jest.fn(),
    updateStatus: jest.fn(),
    delete: jest.fn(),
    createJobExecution: jest.fn(),
    createJobExecutionAndBackup: jest.fn(),
    findJobExecutionById: jest.fn(),
    updateJobExecution: jest.fn(),
    cancelJobExecutionIfActive: jest.fn(),
    findJobExecutionLog: jest.fn(),
    hasActiveJob: jest.fn(),
  };
}

function makeQueue() {
  return {
    add: jest.fn(),
    client: Promise.resolve({ set: jest.fn() }),
  };
}

function makeBackup(
  overrides: Partial<{
    id: bigint;
    environment_id: bigint;
    file_path: string | null;
    status: string;
  }> = {},
) {
  return {
    id: BigInt(10),
    environment_id: BigInt(1),
    type: "full",
    status: "completed",
    file_path: "backups/site_prod_2026.tar.gz",
    size_bytes: BigInt(1024),
    created_at: new Date(),
    ...overrides,
  };
}

function makeEnv(
  overrides: Partial<{ id: bigint; google_drive_folder_id: string | null; project_id: bigint }> = {},
) {
  return {
    id: BigInt(1),
    google_drive_folder_id: "gdrive-folder-abc",
    project_id: BigInt(1),
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("BackupsService", () => {
  let svc: BackupsService;
  let repo: ReturnType<typeof makeRepo>;
  let queue: ReturnType<typeof makeQueue>;

  beforeEach(async () => {
    repo = makeRepo();
    repo.hasActiveJob.mockResolvedValue(false);
    queue = makeQueue();

    const module = await Test.createTestingModule({
      providers: [
        BackupsService,
        { provide: BackupsRepository, useValue: repo },
        { provide: getQueueToken(QUEUES.BACKUPS), useValue: queue },
      ],
    }).compile();

    svc = module.get(BackupsService);
  });

  // ── findOne ──────────────────────────────────────────────────────────────

  describe("findOne", () => {
    it("returns the backup when found", async () => {
      const backup = makeBackup();
      repo.findById.mockResolvedValue(backup);
      const result = await svc.findOne(10);
      expect(result).toBe(backup);
      expect(repo.findById).toHaveBeenCalledWith(BigInt(10));
    });

    it("throws NotFoundException when not found", async () => {
      repo.findById.mockResolvedValue(null);
      await expect(svc.findOne(99)).rejects.toThrow(NotFoundException);
    });
  });

  // ── enqueueCreate ────────────────────────────────────────────────────────

  describe("enqueueCreate", () => {
    it("throws NotFoundException when environment does not exist", async () => {
      repo.findEnvironment.mockResolvedValue(null);
      await expect(
        svc.enqueueCreate({ environmentId: 5, type: "full" }),
      ).rejects.toThrow(NotFoundException);
      expect(repo.createJobExecutionAndBackup).not.toHaveBeenCalled();
    });

    it("throws BadRequestException when environment has no GDrive folder", async () => {
      repo.findEnvironment.mockResolvedValue(
        makeEnv({ google_drive_folder_id: null }),
      );
      await expect(
        svc.enqueueCreate({ environmentId: 1, type: "full" }),
      ).rejects.toThrow(BadRequestException);
      expect(repo.createJobExecutionAndBackup).not.toHaveBeenCalled();
    });

    it("throws BadRequestException when there is already an active job for the environment", async () => {
      repo.findEnvironment.mockResolvedValue(makeEnv());
      repo.hasActiveJob.mockResolvedValue(true);
      await expect(
        svc.enqueueCreate({ environmentId: 1, type: "full" }),
      ).rejects.toThrow(BadRequestException);
      expect(repo.createJobExecutionAndBackup).not.toHaveBeenCalled();
    });

    it("creates job execution, backup row, and enqueues job on success", async () => {
      repo.findEnvironment.mockResolvedValue(makeEnv());
      repo.createJobExecutionAndBackup.mockResolvedValue({
        exec: { id: BigInt(55) },
        backup: { id: BigInt(20) },
      });
      queue.add.mockResolvedValue({ id: "bull-uuid-123" });

      const result = await svc.enqueueCreate({
        environmentId: 1,
        type: "db_only",
      });

      expect(repo.createJobExecutionAndBackup).toHaveBeenCalledWith(
        expect.objectContaining({
          queue_name: QUEUES.BACKUPS,
          job_type: JOB_TYPES.BACKUP_CREATE,
          environment_id: BigInt(1),
        }),
        expect.objectContaining({
          environment_id: BigInt(1),
          type: "db_only",
          status: "pending",
        }),
      );
      expect(queue.add).toHaveBeenCalledWith(
        JOB_TYPES.BACKUP_CREATE,
        expect.objectContaining({ environmentId: 1, type: "db_only" }),
        expect.any(Object),
      );
      expect(result).toEqual({
        jobExecutionId: 55,
        bullJobId: "bull-uuid-123",
        backupId: 20,
      });
    });
  });

  // ── enqueueRestore ───────────────────────────────────────────────────────

  describe("enqueueRestore", () => {
    it("throws NotFoundException when backup does not exist", async () => {
      repo.findById.mockResolvedValue(null);
      await expect(svc.enqueueRestore({ backupId: 777 })).rejects.toThrow(
        NotFoundException,
      );
      expect(queue.add).not.toHaveBeenCalled();
    });

    it("throws NotFoundException when target environment does not exist", async () => {
      const backup = makeBackup({ id: BigInt(10), environment_id: BigInt(3) });
      repo.findById.mockResolvedValue(backup);
      repo.findEnvironment.mockResolvedValue(null); // targetEnv not found
      await expect(
        svc.enqueueRestore({ backupId: 10, targetEnvironmentId: 99 }),
      ).rejects.toThrow(NotFoundException);
      expect(queue.add).not.toHaveBeenCalled();
    });

    it("throws BadRequestException when target environment belongs to a different project", async () => {
      const backup = makeBackup({ id: BigInt(10), environment_id: BigInt(3) });
      repo.findById.mockResolvedValue(backup);
      // Mock findEnvironment for target environment (returns project_id 2)
      // and mock findEnvironment for backup environment (returns project_id 1)
      repo.findEnvironment
        .mockResolvedValueOnce(makeEnv({ id: BigInt(99), project_id: BigInt(2) }))
        .mockResolvedValueOnce(makeEnv({ id: BigInt(3), project_id: BigInt(1) }));

      await expect(
        svc.enqueueRestore({ backupId: 10, targetEnvironmentId: 99 }),
      ).rejects.toThrow(BadRequestException);
      expect(queue.add).not.toHaveBeenCalled();
    });

    it("throws BadRequestException when target environment has an active job", async () => {
      const backup = makeBackup({ id: BigInt(10), environment_id: BigInt(3) });
      repo.findById.mockResolvedValue(backup);
      repo.hasActiveJob.mockResolvedValue(true);

      await expect(svc.enqueueRestore({ backupId: 10 })).rejects.toThrow(
        BadRequestException,
      );
      expect(queue.add).not.toHaveBeenCalled();
    });

    it("creates job execution and enqueues restore job", async () => {
      const backup = makeBackup({ id: BigInt(10), environment_id: BigInt(3) });
      repo.findById.mockResolvedValue(backup);
      repo.createJobExecution.mockResolvedValue({ id: BigInt(66) });
      queue.add.mockResolvedValue({ id: "bull-restore-456" });

      const result = await svc.enqueueRestore({ backupId: 10 });

      expect(repo.createJobExecution).toHaveBeenCalledWith(
        expect.objectContaining({
          queue_name: QUEUES.BACKUPS,
          job_type: JOB_TYPES.BACKUP_RESTORE,
          environment_id: BigInt(3),
        }),
      );
      expect(queue.add).toHaveBeenCalledWith(
        JOB_TYPES.BACKUP_RESTORE,
        expect.objectContaining({ backupId: 10, environmentId: 3 }),
        expect.any(Object),
      );
      expect(result).toEqual({
        jobExecutionId: BigInt(66),
        bullJobId: "bull-restore-456",
      });
    });
  });

  // ── remove ───────────────────────────────────────────────────────────────

  describe("remove", () => {
    it("enqueues GDrive file deletion when backup has file_path", async () => {
      const backup = makeBackup({ file_path: "backups/mysite.tar.gz" });
      repo.findById.mockResolvedValue(backup);
      repo.delete.mockResolvedValue(backup);
      queue.add.mockResolvedValue({ id: "del-job" });

      await svc.remove(10);

      expect(queue.add).toHaveBeenCalledWith(
        JOB_TYPES.BACKUP_DELETE_FILE,
        { filePath: "backups/mysite.tar.gz" },
        expect.any(Object),
      );
      expect(repo.delete).toHaveBeenCalledWith(BigInt(10));
    });

    it("does not enqueue GDrive deletion when backup has no file_path", async () => {
      const backup = makeBackup({ file_path: null });
      repo.findById.mockResolvedValue(backup);
      repo.delete.mockResolvedValue(backup);

      await svc.remove(10);

      expect(queue.add).not.toHaveBeenCalled();
      expect(repo.delete).toHaveBeenCalledWith(BigInt(10));
    });

    it("throws NotFoundException when backup does not exist", async () => {
      repo.findById.mockResolvedValue(null);
      await expect(svc.remove(404)).rejects.toThrow(NotFoundException);
      expect(repo.delete).not.toHaveBeenCalled();
    });
  });

  // ── cancelJobExecution ───────────────────────────────────────────────────

  describe("cancelJobExecution", () => {
    it("throws NotFoundException when execution not found", async () => {
      repo.findJobExecutionById.mockResolvedValue(null);
      await expect(svc.cancelJobExecution(999)).rejects.toThrow(
        NotFoundException,
      );
    });

    it("throws BadRequestException when execution is not active", async () => {
      repo.findJobExecutionById.mockResolvedValue({
        id: BigInt(1),
        status: "completed",
        bull_job_id: "some-id",
      });
      await expect(svc.cancelJobExecution(1)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("sets Redis cancellation key and marks execution as failed", async () => {
      const redisSet = jest.fn().mockResolvedValue("OK");
      (queue as any).client = Promise.resolve({ set: redisSet });

      repo.findJobExecutionById.mockResolvedValue({
        id: BigInt(1),
        status: "active",
        bull_job_id: "some-bull-id",
      });
      repo.cancelJobExecutionIfActive.mockResolvedValue(true);

      const result = await svc.cancelJobExecution(1);

      expect(redisSet).toHaveBeenCalledWith(
        "forge:cancel:some-bull-id",
        "1",
        "EX",
        3600,
      );
      expect(repo.cancelJobExecutionIfActive).toHaveBeenCalledWith(
        BigInt(1),
        "Cancelled by user",
      );
      expect(result).toEqual({ cancelled: true });
    });
  });

  // ── findByEnvironment ────────────────────────────────────────────────────

  describe("findByEnvironment", () => {
    it("passes env ID as BigInt and applies defaults", () => {
      repo.findByEnvironmentPaginated.mockResolvedValue({
        items: [],
        total: 0,
      });
      svc.findByEnvironment(7, { page: 2, limit: 10 });
      expect(repo.findByEnvironmentPaginated).toHaveBeenCalledWith(
        BigInt(7),
        2,
        10,
      );
    });

    it("uses default pagination when query omits page/limit", () => {
      repo.findByEnvironmentPaginated.mockResolvedValue({
        items: [],
        total: 0,
      });
      svc.findByEnvironment(3, { page: 1, limit: 20 });
      expect(repo.findByEnvironmentPaginated).toHaveBeenCalledWith(
        BigInt(3),
        1,
        20,
      );
    });
  });
});
