import { Logger } from "@nestjs/common";
import { JOB_TYPES, QUEUES } from "@bedrock-forge/shared";
import { StepTracker } from "../services/step-tracker";
import { runPreflightSafetyBackup } from "./preflight-backup";

describe("runPreflightSafetyBackup queue-wait vs execution timeout separation (#38)", () => {
  function makeTracker(prisma: { jobExecution: { update: jest.Mock } }) {
    return new StepTracker(prisma as never, BigInt(100), new Logger("Test"), "parent-job-1");
  }

  it("distinguishes queue wait time from execution duration when another env occupies the backup queue", async () => {
    let nowMs = 0;
    const stepMs = 5 * 60_000; // 5 minutes per poll tick via synthetic clock
    let pollIdx = 0;

    // 4 ticks queued (20 min waiting behind another env) + 3 ticks active (15 min executing) -> succeeds!
    const states = [
      { status: "queued" },
      { status: "queued" },
      { status: "queued" },
      { status: "queued" },
      { status: "active" },
      { status: "active" },
      { status: "active" },
      { status: "completed" },
    ];

    const prisma = {
      jobExecution: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: BigInt(501) }),
        update: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockImplementation(async () => states[Math.min(pollIdx++, states.length - 1)]),
      },
      backup: {
        create: jest.fn().mockResolvedValue({ id: BigInt(601) }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const mockJob = {
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const backupQueue = {
      add: jest.fn().mockResolvedValue({ id: "safety-job-1" }),
      getJob: jest.fn().mockResolvedValue(mockJob),
    };

    const result = await runPreflightSafetyBackup({
      prisma: prisma as never,
      backupQueue: backupQueue as never,
      environmentId: 12,
      tracker: makeTracker(prisma),
      queueWaitTimeoutMs: 25 * 60_000,
      executionTimeoutMs: 20 * 60_000,
      pollIntervalMs: stepMs,
      now: () => nowMs,
      sleep: async (ms: number) => {
        nowMs += ms;
      },
    });

    expect(result).toEqual({
      jobExecutionId: BigInt(501),
      backupId: BigInt(601),
    });
    expect(backupQueue.add).toHaveBeenCalledWith(
      JOB_TYPES.BACKUP_CREATE,
      expect.objectContaining({
        environmentId: 12,
        type: "db_only",
        jobExecutionId: 501,
        backupId: 601,
      }),
      expect.objectContaining({ priority: 1 }),
    );
    expect(mockJob.remove).not.toHaveBeenCalled();
  });

  it("cancels queued BullMQ job and marks safety backup failed if queue wait times out before execution starts", async () => {
    let nowMs = 0;
    const stepMs = 5 * 60_000;

    const prisma = {
      jobExecution: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: BigInt(502) }),
        update: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue({ status: "queued" }),
      },
      backup: {
        create: jest.fn().mockResolvedValue({ id: BigInt(602) }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const mockJob = {
      getState: jest.fn().mockResolvedValue("waiting"),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const backupQueue = {
      add: jest.fn().mockResolvedValue({ id: "safety-job-2" }),
      getJob: jest.fn().mockResolvedValue(mockJob),
    };

    await expect(
      runPreflightSafetyBackup({
        prisma: prisma as never,
        backupQueue: backupQueue as never,
        environmentId: 12,
        tracker: makeTracker(prisma),
        queueWaitTimeoutMs: 15 * 60_000,
        executionTimeoutMs: 20 * 60_000,
        pollIntervalMs: stepMs,
        now: () => nowMs,
        sleep: async (ms: number) => {
          nowMs += ms;
        },
      }),
    ).rejects.toThrow(/waiting in backup queue/i);

    expect(mockJob.remove).toHaveBeenCalled();
    expect(prisma.jobExecution.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: BigInt(502) },
        data: expect.objectContaining({
          status: "failed",
          last_error: expect.stringMatching(/queue wait/i),
        }),
      }),
    );
    expect(prisma.backup.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: BigInt(602) },
        data: expect.objectContaining({ status: "failed" }),
      }),
    );
  });

  it("rejects conflicting active backup or restore on the same environment", async () => {
    const prisma = {
      jobExecution: {
        findFirst: jest.fn().mockResolvedValue({
          id: BigInt(99),
          job_type: JOB_TYPES.BACKUP_RESTORE,
          status: "active",
        }),
        create: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn(),
      },
      backup: { create: jest.fn(), update: jest.fn() },
    };

    await expect(
      runPreflightSafetyBackup({
        prisma: prisma as never,
        backupQueue: { add: jest.fn(), getJob: jest.fn() } as never,
        environmentId: 12,
        tracker: makeTracker(prisma),
      }),
    ).rejects.toThrow(/active.*restore|already running/i);

    expect(prisma.jobExecution.create).not.toHaveBeenCalled();
    expect(prisma.jobExecution.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          environment_id: BigInt(12),
          queue_name: QUEUES.BACKUPS,
        }),
      }),
    );
  });
});
