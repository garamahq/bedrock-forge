import { QUEUES } from "@bedrock-forge/shared";
import { QueueRecoveryService } from "./queue-recovery.service";

describe("QueueRecoveryService (#75)", () => {
  it("keeps active jobs older than 5 minutes alive when owned by another live worker", async () => {
    const queues = new Map<string, unknown>([
      [
        `BullQueue_${QUEUES.BACKUPS}`,
        {
          getActive: jest.fn().mockResolvedValue([
            {
              id: "live-long-job",
              moveToFailed: jest.fn(),
              remove: jest.fn(),
            },
          ]),
          getJob: jest.fn().mockResolvedValue({
            id: "live-long-job",
            getState: jest.fn().mockResolvedValue("active"),
          }),
          client: Promise.resolve({
            get: jest.fn().mockResolvedValue("worker-2-lock-token"),
          }),
        },
      ],
    ]);

    const prisma = {
      jobExecution: {
        findMany: jest.fn().mockImplementation(async ({ where }: { where: { queue_name: unknown } }) => {
          const q = where?.queue_name as { in?: string[] } | string | undefined;
          const includesBackups =
            q === QUEUES.BACKUPS || (typeof q === "object" && q?.in?.includes(QUEUES.BACKUPS));
          if (!includesBackups) return [];
          return [
            {
              id: 501n,
              queue_name: QUEUES.BACKUPS,
              bull_job_id: "live-long-job",
              status: "active",
              started_at: new Date(Date.now() - 25 * 60 * 1000), // 25m old!
            },
          ];
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      backup: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      systemBackup: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      $transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
        cb({
          jobExecution: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
          backup: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
          systemBackup: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
        }),
      ),
    };

    const service = new QueueRecoveryService(
      { get: jest.fn((token: string) => queues.get(token)) } as never,
      prisma as never,
    );

    await service.recoverAllQueues();

    expect(prisma.jobExecution.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "failed" }),
      }),
    );
  });

  it("marks truly orphaned active jobs failed only with missing-lock/missing-job evidence and fails linked pending backups", async () => {
    const moveToFailed = jest.fn().mockResolvedValue(undefined);
    const queues = new Map<string, unknown>([
      [
        `BullQueue_${QUEUES.BACKUPS}`,
        {
          getActive: jest.fn().mockResolvedValue([
            {
              id: "orphan-unlocked-job",
              moveToFailed,
              remove: jest.fn(),
            },
          ]),
          getJob: jest.fn().mockResolvedValue(null),
          client: Promise.resolve({
            get: jest.fn().mockResolvedValue(null),
          }),
        },
      ],
    ]);

    const txJobUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const txBackupUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const txSysUpdateMany = jest.fn().mockResolvedValue({ count: 0 });
    const prisma = {
      jobExecution: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 601n,
            queue_name: QUEUES.BACKUPS,
            bull_job_id: "orphan-unlocked-job",
            status: "active",
            started_at: new Date(Date.now() - 10 * 60 * 1000),
          },
        ]),
        updateMany: jest.fn(),
      },
      backup: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      systemBackup: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      $transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
        cb({
          jobExecution: { updateMany: txJobUpdateMany },
          backup: { updateMany: txBackupUpdateMany },
          systemBackup: { updateMany: txSysUpdateMany },
        }),
      ),
    };

    const service = new QueueRecoveryService(
      { get: jest.fn((token: string) => queues.get(token)) } as never,
      prisma as never,
    );

    await service.recoverAllQueues();

    expect(moveToFailed).toHaveBeenCalledTimes(1);
    expect(txJobUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 601n, status: "active" }),
        data: expect.objectContaining({ status: "failed" }),
      }),
    );
    expect(txBackupUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ job_execution_id: 601n }),
        data: expect.objectContaining({ status: "failed" }),
      }),
    );
  });

  it("does NOT mark active DB jobs failed when Redis inspection suffers a temporary disconnection", async () => {
    const queues = new Map<string, unknown>([
      [
        `BullQueue_${QUEUES.BACKUPS}`,
        {
          getActive: jest.fn().mockRejectedValue(new Error("Redis ECONNREFUSED")),
          getJob: jest.fn().mockRejectedValue(new Error("Redis ECONNREFUSED")),
          get client() {
            return Promise.reject(new Error("Redis ECONNREFUSED"));
          },
        },
      ],
    ]);

    const txJobUpdateMany = jest.fn();
    const prisma = {
      jobExecution: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 701n,
            queue_name: QUEUES.BACKUPS,
            bull_job_id: "job-during-outage",
            status: "active",
            started_at: new Date(Date.now() - 60 * 60 * 1000),
          },
        ]),
        updateMany: jest.fn(),
      },
      backup: { updateMany: jest.fn() },
      systemBackup: { updateMany: jest.fn() },
      $transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
        cb({
          jobExecution: { updateMany: txJobUpdateMany },
          backup: { updateMany: jest.fn() },
          systemBackup: { updateMany: jest.fn() },
        }),
      ),
    };

    const service = new QueueRecoveryService(
      { get: jest.fn((token: string) => queues.get(token)) } as never,
      prisma as never,
    );

    await service.recoverAllQueues();

    expect(prisma.jobExecution.updateMany).not.toHaveBeenCalled();
    expect(txJobUpdateMany).not.toHaveBeenCalled();
  });
});
