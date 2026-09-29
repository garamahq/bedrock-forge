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
});
