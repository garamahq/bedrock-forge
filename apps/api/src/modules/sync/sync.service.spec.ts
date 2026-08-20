import { Test } from "@nestjs/testing";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { getQueueToken } from "@nestjs/bullmq";
import { SyncService } from "./sync.service";
import { SyncRepository } from "./sync.repository";
import { JobOrchestratorService } from "../job-executions/job-orchestrator.service";
import { QUEUES, JOB_TYPES, SYNC_JOB_OPTIONS } from "@bedrock-forge/shared";

function makeRepo() {
  return {
    findEnvironmentById: jest.fn(),
    hasActiveJob: jest.fn(),
    findJobExecutionById: jest.fn(),
    cancelJobExecutionIfActive: jest.fn(),
  };
}

function makeJobOrchestrator() {
  return {
    enqueue: jest.fn(),
  };
}

function makeQueue() {
  return {
    add: jest.fn(),
    client: Promise.resolve({ set: jest.fn() }),
  };
}

describe("SyncService", () => {
  let svc: SyncService;
  let repo: ReturnType<typeof makeRepo>;
  let orchestrator: ReturnType<typeof makeJobOrchestrator>;
  let queue: ReturnType<typeof makeQueue>;

  beforeEach(async () => {
    repo = makeRepo();
    repo.hasActiveJob.mockResolvedValue(false);
    orchestrator = makeJobOrchestrator();
    queue = makeQueue();

    const module = await Test.createTestingModule({
      providers: [
        SyncService,
        { provide: SyncRepository, useValue: repo },
        { provide: JobOrchestratorService, useValue: orchestrator },
        { provide: getQueueToken(QUEUES.SYNC), useValue: queue },
      ],
    }).compile();

    svc = module.get(SyncService);
  });

  describe("enqueueClone", () => {
    it("throws BadRequestException when target environment already has an active job", async () => {
      repo.hasActiveJob.mockResolvedValue(true);

      await expect(
        svc.enqueueClone({ sourceEnvironmentId: 1, targetEnvironmentId: 2 }),
      ).rejects.toThrow(BadRequestException);

      expect(repo.hasActiveJob).toHaveBeenCalledWith(BigInt(2));
      expect(orchestrator.enqueue).not.toHaveBeenCalled();
    });

    it("throws BadRequestException when target has no GDrive folder and skipSafetyBackup is false", async () => {
      repo.hasActiveJob.mockResolvedValue(false);
      repo.findEnvironmentById.mockResolvedValue({
        id: BigInt(2),
        google_drive_folder_id: null,
      });

      await expect(
        svc.enqueueClone({ sourceEnvironmentId: 1, targetEnvironmentId: 2 }),
      ).rejects.toThrow(BadRequestException);

      expect(repo.findEnvironmentById).toHaveBeenCalledWith(2);
      expect(orchestrator.enqueue).not.toHaveBeenCalled();
    });

    it("enqueues clone job when target is valid and has GDrive folder", async () => {
      repo.hasActiveJob.mockResolvedValue(false);
      repo.findEnvironmentById.mockResolvedValue({
        id: BigInt(2),
        google_drive_folder_id: "folder-xyz",
      });
      orchestrator.enqueue.mockResolvedValue({
        jobExecutionId: 10,
        jobId: "bull-clone-1",
      });

      const result = await svc.enqueueClone({
        sourceEnvironmentId: 1,
        targetEnvironmentId: 2,
      });

      expect(orchestrator.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          queue: queue,
          queueName: QUEUES.SYNC,
          jobType: JOB_TYPES.SYNC_CLONE,
          environmentId: 2,
          jobOptions: SYNC_JOB_OPTIONS,
        }),
      );
      expect(result).toEqual({ jobExecutionId: 10, jobId: "bull-clone-1" });
    });

    it("enqueues clone job when skipSafetyBackup is true even without GDrive folder", async () => {
      repo.hasActiveJob.mockResolvedValue(false);
      orchestrator.enqueue.mockResolvedValue({
        jobExecutionId: 11,
        jobId: "bull-clone-2",
      });

      const result = await svc.enqueueClone({
        sourceEnvironmentId: 1,
        targetEnvironmentId: 2,
        skipSafetyBackup: true,
      });

      expect(repo.findEnvironmentById).not.toHaveBeenCalled();
      expect(orchestrator.enqueue).toHaveBeenCalled();
      expect(result).toEqual({ jobExecutionId: 11, jobId: "bull-clone-2" });
    });
  });

  describe("enqueuePush", () => {
    it("throws BadRequestException when target environment already has an active job", async () => {
      repo.hasActiveJob.mockResolvedValue(true);

      await expect(
        svc.enqueuePush({
          sourceEnvironmentId: 1,
          targetEnvironmentId: 2,
          scope: "both",
        }),
      ).rejects.toThrow(BadRequestException);

      expect(repo.hasActiveJob).toHaveBeenCalledWith(BigInt(2));
      expect(orchestrator.enqueue).not.toHaveBeenCalled();
    });

    it("enqueues push job when no active job is running", async () => {
      repo.hasActiveJob.mockResolvedValue(false);
      orchestrator.enqueue.mockResolvedValue({
        jobExecutionId: 12,
        jobId: "bull-push-1",
      });

      const result = await svc.enqueuePush({
        sourceEnvironmentId: 1,
        targetEnvironmentId: 2,
        scope: "database",
      });

      expect(orchestrator.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          queue: queue,
          queueName: QUEUES.SYNC,
          jobType: JOB_TYPES.SYNC_PUSH,
          environmentId: 2,
          jobOptions: SYNC_JOB_OPTIONS,
        }),
      );
      expect(result).toEqual({ jobExecutionId: 12, jobId: "bull-push-1" });
    });
  });

  describe("cancelJobExecution", () => {
    it("throws NotFoundException when execution does not exist", async () => {
      repo.findJobExecutionById.mockResolvedValue(null);

      await expect(svc.cancelJobExecution(999)).rejects.toThrow(
        NotFoundException,
      );
    });

    it("throws BadRequestException when execution is not active", async () => {
      repo.findJobExecutionById.mockResolvedValue({
        id: BigInt(5),
        status: "completed",
      });

      await expect(svc.cancelJobExecution(5)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("sets Redis cancel token and calls cancelJobExecutionIfActive", async () => {
      const redisSet = jest.fn().mockResolvedValue("OK");
      (queue as any).client = Promise.resolve({ set: redisSet });

      repo.findJobExecutionById.mockResolvedValue({
        id: BigInt(5),
        status: "active",
        bull_job_id: "bull-exec-5",
      });
      repo.cancelJobExecutionIfActive.mockResolvedValue(true);

      const result = await svc.cancelJobExecution(5);

      expect(redisSet).toHaveBeenCalledWith(
        "forge:cancel:bull-exec-5",
        "1",
        "EX",
        3600,
      );
      expect(repo.cancelJobExecutionIfActive).toHaveBeenCalledWith(
        BigInt(5),
        "Cancelled by user",
      );
      expect(result).toEqual({ cancelled: true });
    });
  });
});
