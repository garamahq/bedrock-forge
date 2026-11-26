import { BadRequestException } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { Queue } from "bullmq";
import { JobExecutionsRepository } from "./job-executions.repository";
import { JobExecutionsService } from "./job-executions.service";
import { JobOrchestratorService } from "./job-orchestrator.service";

function makeExecution(status: string, bull_job_id: string | null) {
  return {
    id: 14n,
    queue_name: "backups",
    status,
    bull_job_id,
  } as unknown as Awaited<ReturnType<JobExecutionsRepository["findById"]>>;
}

describe("JobExecutionsService", () => {
  let repo: jest.Mocked<JobExecutionsRepository>;
  let getQueue: jest.Mock;
  let service: JobExecutionsService;

  beforeEach(() => {
    repo = {
      findStalledCandidates: jest.fn(),
      countStalledCandidates: jest.fn(),
      reconcileStalledCandidate: jest.fn(),
      findById: jest.fn(),
      updateStatus: jest.fn(),
    } as unknown as jest.Mocked<JobExecutionsRepository>;
    getQueue = jest.fn();
    service = new JobExecutionsService(
      repo,
      {} as JobOrchestratorService,
      { get: getQueue } as unknown as ModuleRef,
    );
  });

  it("holds active BullMQ work during recovery preview", async () => {
    repo.findStalledCandidates.mockResolvedValue([
      {
        id: 14n,
        queue_name: "backups",
        bull_job_id: "backup-14",
        status: "active",
        created_at: new Date("2026-09-29T00:00:00.000Z"),
      },
    ]);
    repo.countStalledCandidates.mockResolvedValue(1);
    const queue = {
      getJob: jest.fn().mockResolvedValue({
        getState: jest.fn().mockResolvedValue("active"),
      }),
    } as unknown as Queue;
    getQueue.mockReturnValue(queue);

    const preview = await service.recoveryPreview();

    expect(preview).toMatchObject({
      total: 1,
      inspected: 1,
      repairable: 0,
      held: 1,
      items: [
        expect.objectContaining({
          id: 14,
          repairStatus: null,
          reason: expect.stringContaining("Worker still owns this job"),
        }),
      ],
    });
    expect(repo.reconcileStalledCandidate).not.toHaveBeenCalled();
  });

  it("holds an execution record when the queue job ID is missing", async () => {
    repo.findStalledCandidates.mockResolvedValue([
      {
        id: 14n,
        queue_name: "backups",
        bull_job_id: null,
        status: "active",
        created_at: new Date("2026-09-29T00:00:00.000Z"),
      },
    ]);

    const result = await service.recoverStalled();

    expect(result).toMatchObject({ reconciled: 0, held: 1 });
    expect(repo.reconcileStalledCandidate).not.toHaveBeenCalled();
    expect(getQueue).not.toHaveBeenCalled();
  });

  it("reconciles an execution record after BullMQ confirms the job is missing", async () => {
    repo.findStalledCandidates.mockResolvedValue([
      {
        id: 14n,
        queue_name: "backups",
        bull_job_id: "backup-14",
        status: "active",
        created_at: new Date("2026-09-29T00:00:00.000Z"),
      },
    ]);
    repo.reconcileStalledCandidate.mockResolvedValue(1);
    getQueue.mockReturnValue({ getJob: jest.fn().mockResolvedValue(null) });

    const result = await service.recoverStalled();

    expect(result.reconciled).toBe(1);
    expect(repo.reconcileStalledCandidate).toHaveBeenCalledWith(
      14n,
      expect.any(Date),
      "failed",
      "Queue job no longer exists.",
    );
  });

  it("does not discard an active job", async () => {
    repo.findById.mockResolvedValue(makeExecution("active", "backup-14"));

    await expect(service.discard(14)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(getQueue).not.toHaveBeenCalled();
    expect(repo.updateStatus).not.toHaveBeenCalled();
  });

  it("preserves failed job history instead of discarding it", async () => {
    repo.findById.mockResolvedValue(makeExecution("failed", "backup-14"));

    await expect(service.discard(14)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(getQueue).not.toHaveBeenCalled();
    expect(repo.updateStatus).not.toHaveBeenCalled();
  });

  it("removes a queued BullMQ job and marks its history discarded", async () => {
    repo.findById.mockResolvedValue(makeExecution("queued", "backup-14"));
    const remove = jest.fn().mockResolvedValue(undefined);
    getQueue.mockReturnValue({
      getJob: jest.fn().mockResolvedValue({
        getState: jest.fn().mockResolvedValue("waiting"),
        remove,
      }),
    });

    await service.discard(14);

    expect(remove).toHaveBeenCalledTimes(1);
    expect(repo.updateStatus).toHaveBeenCalledWith(
      14n,
      "discarded",
      "Removed from queue by operator",
    );
  });

  describe("retry (#48)", () => {
    it("rejects retrying active, queued, or completed executions before touching queues", async () => {
      repo.findById.mockResolvedValue({
        id: 21n,
        queue_name: "backups",
        job_type: "backup:create",
        status: "active",
        payload: { environmentId: 3, type: "full" },
      } as never);

      await expect(service.retry(21)).rejects.toBeInstanceOf(BadRequestException);
    });

    it("routes manual and historical scheduled backup retries through BackupsService.enqueueCreate", async () => {
      const backupsService = {
        enqueueCreate: jest.fn().mockResolvedValue({
          jobExecutionId: 99,
          bullJobId: "new-bull-id",
          backupId: 55,
        }),
        enqueueRestore: jest.fn(),
      };
      const systemBackupsService = { enqueueCreate: jest.fn() };
      const svcWithDeps = new JobExecutionsService(
        repo,
        { enqueue: jest.fn() } as unknown as JobOrchestratorService,
        { get: getQueue } as unknown as ModuleRef,
        backupsService as never,
        systemBackupsService as never,
      );

      // Failed manual backup
      repo.findById.mockResolvedValueOnce({
        id: 31n,
        queue_name: "backups",
        job_type: "backup:create",
        status: "failed",
        environment_id: 7n,
        payload: { environmentId: 7, type: "db_only" },
      } as never);
      await expect(svcWithDeps.retry(31)).resolves.toMatchObject({
        jobExecutionId: 99,
        backupId: 55,
      });
      expect(backupsService.enqueueCreate).toHaveBeenCalledWith({
        environmentId: 7,
        type: "db_only",
      });

      // Historical scheduled backup missing job_type
      repo.findById.mockResolvedValueOnce({
        id: 32n,
        queue_name: "backups",
        job_type: null,
        status: "failed",
        environment_id: 8n,
        payload: { scheduleId: 2, environmentId: 8, type: "full" },
      } as never);
      await svcWithDeps.retry(32);
      expect(backupsService.enqueueCreate).toHaveBeenLastCalledWith({
        environmentId: 8,
        type: "full",
      });
    });

    it("routes system backup retries with empty payload through SystemBackupsService.enqueueCreate", async () => {
      const systemBackupsService = {
        enqueueCreate: jest.fn().mockResolvedValue({
          systemBackupId: 12,
          jobExecutionId: 88,
          bullJobId: "sys-bull-id",
        }),
      };
      const svcWithDeps = new JobExecutionsService(
        repo,
        { enqueue: jest.fn() } as unknown as JobOrchestratorService,
        { get: getQueue } as unknown as ModuleRef,
        { enqueueCreate: jest.fn(), enqueueRestore: jest.fn() } as never,
        systemBackupsService as never,
      );

      repo.findById.mockResolvedValue({
        id: 41n,
        queue_name: "system-backups",
        job_type: "system-backup:create",
        status: "failed",
        payload: {},
      } as never);

      await expect(svcWithDeps.retry(41)).resolves.toMatchObject({
        systemBackupId: 12,
        jobExecutionId: 88,
      });
      expect(systemBackupsService.enqueueCreate).toHaveBeenCalledTimes(1);
    });

    it("rejects non-retryable backup restore payloads lacking backupId (#48)", async () => {
      const backupsService = { enqueueCreate: jest.fn(), enqueueRestore: jest.fn() };
      const svcWithDeps = new JobExecutionsService(
        repo,
        { enqueue: jest.fn() } as unknown as JobOrchestratorService,
        { get: getQueue } as unknown as ModuleRef,
        backupsService as never,
        { enqueueCreate: jest.fn() } as never,
      );

      repo.findById.mockResolvedValue({
        id: 51n,
        queue_name: "backups",
        job_type: "backup:restore",
        status: "failed",
        payload: {},
      } as never);

      await expect(svcWithDeps.retry(51)).rejects.toBeInstanceOf(BadRequestException);
      expect(backupsService.enqueueRestore).not.toHaveBeenCalled();
    });

    it("resumes live PROJECT_CREATE_BEDROCK queue job without duplicating provisioning (#109)", async () => {
      const orchestratorEnqueue = jest.fn();
      const getJob = jest.fn().mockResolvedValue({
        id: "pre-uuid-99",
        getState: jest.fn().mockResolvedValue("waiting"),
      });
      getQueue.mockReturnValue({ getJob });
      repo.findById.mockResolvedValue({
        id: 61n,
        queue_name: "projects",
        job_type: "project:create-bedrock",
        status: "failed",
        bull_job_id: "pre-uuid-99",
        payload: { environmentId: 12 },
      } as never);

      const svcWithOrchestrator = new JobExecutionsService(
        repo,
        { enqueue: orchestratorEnqueue } as unknown as JobOrchestratorService,
        { get: getQueue } as unknown as ModuleRef,
      );

      const res = await svcWithOrchestrator.retry(61);
      expect(res).toEqual({
        jobExecutionId: 61,
        jobId: "pre-uuid-99",
        bullJobId: "pre-uuid-99",
      });
      expect(orchestratorEnqueue).not.toHaveBeenCalled();
      expect(repo.updateStatus).toHaveBeenCalledWith(61n, "queued");
    });
  });
});
