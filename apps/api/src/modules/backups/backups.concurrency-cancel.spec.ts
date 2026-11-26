import { Test } from "@nestjs/testing";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { getQueueToken } from "@nestjs/bullmq";
import { BackupsService } from "./backups.service";
import { BackupsRepository } from "./backups.repository";
import { PrismaService } from "../../prisma/prisma.service";
import { QUEUES, JOB_TYPES } from "@bedrock-forge/shared";

describe("Backups atomic concurrency lock & cancellation guards (#51, #30)", () => {
  describe("BackupsRepository atomic enqueue with PostgreSQL advisory lock (#51)", () => {
    it("acquires per-environment pg_advisory_xact_lock and rejects concurrent active job on same environment", async () => {
      const txActiveJobs: Array<{ environment_id: bigint; queue_name: string }> = [];
      let mutexChain = Promise.resolve();

      const prisma = {
        $transaction: jest.fn(async (fn: (tx: any) => Promise<any>) => {
          // Simulate Postgres pg_advisory_xact_lock serialization per tx
          let release!: () => void;
          const next = new Promise<void>((r) => {
            release = r;
          });
          const prev = mutexChain;
          mutexChain = next;
          await prev;

          const tx = {
            $executeRaw: jest.fn().mockResolvedValue(1),
            jobExecution: {
              findFirst: jest.fn(async ({ where }: any) => {
                const match = txActiveJobs.find(
                  (j) =>
                    j.environment_id === where.environment_id &&
                    where.queue_name.in.includes(j.queue_name),
                );
                return match ? { id: BigInt(1) } : null;
              }),
              create: jest.fn(async ({ data }: any) => {
                txActiveJobs.push({
                  environment_id: data.environment_id,
                  queue_name: data.queue_name,
                });
                return { id: BigInt(txActiveJobs.length), ...data };
              }),
            },
            backup: {
              create: jest.fn(async ({ data }: any) => ({
                id: BigInt(500 + txActiveJobs.length),
                ...data,
              })),
            },
          };

          try {
            return await fn(tx);
          } finally {
            release();
          }
        }),
      } as unknown as PrismaService;

      const repo = new BackupsRepository(prisma);

      const first = repo.createJobExecutionAndBackupIfIdle(
        {
          queue_name: QUEUES.BACKUPS,
          job_type: JOB_TYPES.BACKUP_CREATE,
          bull_job_id: "job-1",
          environment_id: BigInt(10),
        },
        {
          environment_id: BigInt(10),
          type: "full",
          status: "pending",
        },
      );

      const secondSameEnv = repo.createJobExecutionAndBackupIfIdle(
        {
          queue_name: QUEUES.BACKUPS,
          job_type: JOB_TYPES.BACKUP_CREATE,
          bull_job_id: "job-2",
          environment_id: BigInt(10),
        },
        {
          environment_id: BigInt(10),
          type: "full",
          status: "pending",
        },
      );

      const independentEnv = repo.createJobExecutionAndBackupIfIdle(
        {
          queue_name: QUEUES.BACKUPS,
          job_type: JOB_TYPES.BACKUP_CREATE,
          bull_job_id: "job-3",
          environment_id: BigInt(11),
        },
        {
          environment_id: BigInt(11),
          type: "full",
          status: "pending",
        },
      );

      const results = await Promise.all([first, secondSameEnv, independentEnv]);
      expect(results[0]).not.toBeNull();
      expect(results[1]).toBeNull(); // blocked atomically by lock + committed row from first!
      expect(results[2]).not.toBeNull(); // independent environment proceeds cleanly
    });
  });

  describe("BackupsService cancelJobExecution & conflict guards (#30, #51)", () => {
    let svc: BackupsService;
    let repo: Record<string, jest.Mock>;
    let queue: { add: jest.Mock; getJob: jest.Mock; client: Promise<{ set: jest.Mock }> };

    beforeEach(async () => {
      repo = {
        findEnvironment: jest.fn().mockResolvedValue({
          id: BigInt(10),
          google_drive_folder_id: "folder-1",
          project_id: BigInt(1),
        }),
        findById: jest.fn(),
        hasActiveJob: jest.fn().mockResolvedValue(false),
        createJobExecutionAndBackupIfIdle: jest.fn(),
        createJobExecutionIfIdle: jest.fn(),
        findJobExecutionById: jest.fn(),
        updateJobExecution: jest.fn().mockResolvedValue({}),
        updateStatus: jest.fn().mockResolvedValue({}),
        markCancellationRequestedIfActive: jest.fn().mockResolvedValue(true),
        cancelQueuedJobExecution: jest.fn().mockResolvedValue(true),
      };

      queue = {
        add: jest.fn().mockResolvedValue({ id: "bull-1" }),
        getJob: jest.fn().mockResolvedValue({ remove: jest.fn().mockResolvedValue(undefined) }),
        client: Promise.resolve({ set: jest.fn().mockResolvedValue("OK") }),
      };

      const mod = await Test.createTestingModule({
        providers: [
          BackupsService,
          { provide: BackupsRepository, useValue: repo },
          { provide: getQueueToken(QUEUES.BACKUPS), useValue: queue },
        ],
      }).compile();

      svc = mod.get(BackupsService);
    });

    it("throws ConflictException/BadRequestException when createJobExecutionAndBackupIfIdle returns null (race)", async () => {
      repo.createJobExecutionAndBackupIfIdle.mockResolvedValue(null);

      await expect(
        svc.enqueueCreate({ environmentId: 10, type: "full" }),
      ).rejects.toThrow(ConflictException);
      expect(queue.add).not.toHaveBeenCalled();
    });

    it("rejects cancelling non-backup job types (#30)", async () => {
      repo.findJobExecutionById.mockResolvedValue({
        id: BigInt(7),
        queue_name: QUEUES.SECURITY,
        job_type: JOB_TYPES.SECURITY_SERVER_SCAN,
        status: "active",
        bull_job_id: "sec-7",
      });

      await expect(svc.cancelJobExecution(7)).rejects.toThrow(
        BadRequestException,
      );
      expect(repo.markCancellationRequestedIfActive).not.toHaveBeenCalled();
    });

    it("rejects cancelling restore execution after target mutation has started (#30)", async () => {
      repo.findJobExecutionById.mockResolvedValue({
        id: BigInt(8),
        queue_name: QUEUES.BACKUPS,
        job_type: JOB_TYPES.BACKUP_RESTORE,
        status: "active",
        bull_job_id: "restore-8",
        execution_log: [
          { step: "Streaming archive to server", level: "info" },
          { step: "Executing restore script", level: "info" },
        ],
      });

      await expect(svc.cancelJobExecution(8)).rejects.toThrow(
        /mutation|cannot cancel/i,
      );
    });

    it("distinguishes active cancellation request from completed termination and keeps status active until worker stops (#30)", async () => {
      const redisSet = jest.fn().mockResolvedValue("OK");
      queue.client = Promise.resolve({ set: redisSet });
      repo.findJobExecutionById.mockResolvedValue({
        id: BigInt(9),
        queue_name: QUEUES.BACKUPS,
        job_type: JOB_TYPES.BACKUP_CREATE,
        status: "active",
        bull_job_id: "backup-9",
        execution_log: [{ step: "Pulling backup via SFTP", level: "info" }],
      });

      const res = await svc.cancelJobExecution(9);

      expect(redisSet).toHaveBeenCalledWith("forge:cancel:backup-9", "1", {
        EX: 3600,
      });
      expect(repo.markCancellationRequestedIfActive).toHaveBeenCalledWith(
        BigInt(9),
        expect.stringMatching(/Cancellation requested/i),
      );
      expect(res).toEqual({
        cancelled: true,
        terminated: false,
        status: "cancellation_requested",
      });
    });

    it("cancels a queued job immediately before worker execution starts (#30)", async () => {
      const removeMock = jest.fn().mockResolvedValue(undefined);
      queue.getJob.mockResolvedValue({
        getState: jest.fn().mockResolvedValue("waiting"),
        remove: removeMock,
      });
      repo.findJobExecutionById.mockResolvedValue({
        id: BigInt(12),
        queue_name: QUEUES.BACKUPS,
        job_type: JOB_TYPES.BACKUP_CREATE,
        status: "queued",
        bull_job_id: "backup-queued-12",
      });

      const res = await svc.cancelJobExecution(12);

      expect(removeMock).toHaveBeenCalled();
      expect(repo.cancelQueuedJobExecution).toHaveBeenCalledWith(
        BigInt(12),
        expect.stringMatching(/Cancelled by user/i),
      );
      expect(res).toEqual({
        cancelled: true,
        terminated: true,
        status: "failed",
      });
    });

    it("throws ConflictException when active job completes before cancellation mark applies (#30)", async () => {
      repo.findJobExecutionById.mockResolvedValue({
        id: BigInt(15),
        queue_name: QUEUES.BACKUPS,
        job_type: JOB_TYPES.BACKUP_CREATE,
        status: "active",
        bull_job_id: "backup-15",
      });
      repo.markCancellationRequestedIfActive.mockResolvedValueOnce(false);

      await expect(svc.cancelJobExecution(15)).rejects.toThrow(
        ConflictException,
      );
    });

    it("throws ConflictException on restore enqueue race (#51)", async () => {
      repo.findById.mockResolvedValue({
        id: BigInt(10),
        environment_id: BigInt(3),
      });
      repo.createJobExecutionIfIdle.mockResolvedValueOnce(null);

      await expect(svc.enqueueRestore({ backupId: 10 })).rejects.toThrow(
        ConflictException,
      );
      expect(queue.add).not.toHaveBeenCalled();
    });
  });
});
