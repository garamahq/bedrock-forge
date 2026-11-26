import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { getQueueToken } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { QUEUES } from "@bedrock-forge/shared";
import { PrismaService } from "../prisma/prisma.service";

interface InspectedQueueState {
  queue: Queue;
  client: Awaited<Queue["client"]>;
  liveBullIds: Set<string>;
}

@Injectable()
export class QueueRecoveryService implements OnApplicationBootstrap {
  private readonly logger = new Logger(QueueRecoveryService.name);

  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly prisma: PrismaService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.recoverAllQueues();
  }

  async recoverAllQueues(): Promise<void> {
    this.logger.log("Running worker startup queue recovery check...");

    const inspectedQueues = new Map<string, InspectedQueueState>();
    const allQueueNames = Object.values(QUEUES);

    for (const queueName of allQueueNames) {
      try {
        const token = getQueueToken(queueName);
        const queue = this.moduleRef.get<Queue>(token, { strict: false });
        if (!queue) continue;

        const client = await queue.client;
        const activeJobs = await queue.getActive();
        const liveBullIds = new Set<string>();

        for (const job of activeJobs) {
          const lockKey = `bull:${queueName}:${job.id}:lock`;
          const hasLock = Boolean(await client.get(lockKey));
          if (hasLock) {
            if (job.id !== undefined) {
              liveBullIds.add(String(job.id));
            }
            continue;
          }

          this.logger.warn(
            `[${queueName}] Reclaiming orphaned active job ${job.id} on startup`,
          );
          await job
            .moveToFailed(
              new Error("Process interrupted — worker lock expired"),
              "0",
              true,
            )
            .catch(async () => {
              await job.remove().catch(() => {});
            });
        }

        inspectedQueues.set(queueName, { queue, client, liveBullIds });
      } catch (err) {
        // Temporary Redis / queue outage must NOT cause DB active jobs to be failed
        this.logger.debug(
          `[${queueName}] Startup queue recovery inspection aborted: ${err}`,
        );
      }
    }

    if (inspectedQueues.size === 0) {
      return;
    }

    // Reconcile only DB active executions whose queue was positively verified in Redis (#75).
    try {
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
      const candidates = await this.prisma.jobExecution.findMany({
        where: {
          status: "active",
          started_at: { lt: fiveMinutesAgo },
          queue_name: { in: Array.from(inspectedQueues.keys()) },
        },
        select: { id: true, queue_name: true, bull_job_id: true },
      });

      let failedCount = 0;
      for (const exec of candidates) {
        const queueState = inspectedQueues.get(exec.queue_name);
        if (!queueState) continue;

        const bullId = exec.bull_job_id;
        if (bullId && queueState.liveBullIds.has(bullId)) {
          // A live worker currently holds the BullMQ lock for this job.
          continue;
        }

        if (!bullId) {
          continue;
        }

        try {
          const bullJob = await queueState.queue.getJob(bullId);
          if (bullJob) {
            const state = await bullJob.getState();
            if (state === "active") {
              const lockKey = `bull:${exec.queue_name}:${bullId}:lock`;
              const hasLock = Boolean(await queueState.client.get(lockKey));
              if (hasLock) {
                continue;
              }
            } else if (
              state === "waiting" ||
              state === "delayed" ||
              state === "prioritized" ||
              state === "waiting-children"
            ) {
              continue;
            } else if (state === "completed") {
              await this.prisma.jobExecution.updateMany({
                where: { id: exec.id, status: "active" },
                data: {
                  status: "completed",
                  progress: 100,
                  completed_at: new Date(),
                },
              });
              continue;
            }
          }
        } catch (redisErr) {
          // Temporary Redis read error on per-job check is never proof of failure
          this.logger.debug(
            `[${exec.queue_name}] Skipping active job ${bullId} due to Redis read error: ${redisErr}`,
          );
          continue;
        }

        const reason = "Queue job lock is inactive or missing on worker recovery";
        const now = new Date();
        const updated = await this.prisma.$transaction(async (tx) => {
          const res = await tx.jobExecution.updateMany({
            where: { id: exec.id, status: "active" },
            data: {
              status: "failed",
              last_error: reason,
              completed_at: now,
            },
          });
          if (res.count > 0) {
            await tx.backup.updateMany({
              where: {
                job_execution_id: exec.id,
                status: { in: ["pending", "running"] },
              },
              data: {
                status: "failed",
                error_message: reason,
                completed_at: now,
              },
            });
            await tx.systemBackup.updateMany({
              where: {
                job_execution_id: exec.id,
                status: { in: ["pending", "running"] },
              },
              data: {
                status: "failed",
                error_message: reason,
                completed_at: now,
              },
            });
          }
          return res.count;
        });
        failedCount += updated;
      }

      if (failedCount > 0) {
        this.logger.log(
          `Marked ${failedCount} orphaned active job execution(s) as failed after Redis lock verification`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `Failed to reconcile orphaned active DB job executions: ${err}`,
      );
    }
  }
}
