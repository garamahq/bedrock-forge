import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { getQueueToken } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { QUEUES } from "@bedrock-forge/shared";
import { PrismaService } from "../prisma/prisma.service";

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

    const allQueueNames = Object.values(QUEUES);
    for (const queueName of allQueueNames) {
      try {
        const token = getQueueToken(queueName);
        const queue = this.moduleRef.get<Queue>(token, { strict: false });
        if (!queue) continue;

        // Inspect and clean any dead active jobs from previous worker instances
        const activeJobs = await queue.getActive();
        for (const job of activeJobs) {
          try {
            // Check if job lock still exists in Redis
            const lockKey = `bull:${queueName}:${job.id}:lock`;
            // BullMQ client access
            const client = await queue.client;
            const hasLock = Boolean(await client.get(lockKey));
            if (!hasLock) {
              this.logger.warn(
                `[${queueName}] Reclaiming orphaned active job ${job.id} on startup`,
              );
              await job
                .moveToFailed(
                  new Error("Process interrupted — forge was restarted"),
                  "0",
                  true,
                )
                .catch(async () => {
                  await job.remove().catch(() => {});
                });
            }
          } catch (jobErr) {
            this.logger.debug(
              `[${queueName}] Failed to inspect active job ${job.id}: ${jobErr}`,
            );
          }
        }
      } catch (err) {
        this.logger.debug(
          `[${queueName}] Startup queue recovery check error: ${err}`,
        );
      }
    }

    // Clean up any stale active records in PostgreSQL left behind before startup
    try {
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
      const stale = await this.prisma.jobExecution.updateMany({
        where: {
          status: "active",
          started_at: { lt: fiveMinutesAgo },
        },
        data: {
          status: "failed",
          last_error: "Process interrupted — forge was restarted",
          completed_at: new Date(),
        },
      });
      if (stale.count > 0) {
        this.logger.log(
          `Marked ${stale.count} stale active job executions as failed in database`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `Failed to clean stale active DB job executions: ${err}`,
      );
    }
  }
}
