import { Injectable, NotFoundException, BadRequestException, Logger } from "@nestjs/common";
import { JobExecutionStatus } from "@prisma/client";
import { ModuleRef } from "@nestjs/core";
import { getQueueToken } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { QUEUES } from "@bedrock-forge/shared";
import {
  JobExecutionsRepository,
  JobExecutionFilter,
} from "./job-executions.repository";
import { JobOrchestratorService } from "./job-orchestrator.service";

@Injectable()
export class JobExecutionsService {
  private readonly logger = new Logger(JobExecutionsService.name);

  constructor(
    private readonly repo: JobExecutionsRepository,
    private readonly orchestrator: JobOrchestratorService,
    private readonly moduleRef: ModuleRef,
  ) {}

  list(filter: JobExecutionFilter, page: number, limit: number) {
    return this.repo.findPaginated(filter, page, limit);
  }

  findOne(id: number) {
    return this.repo.findById(id);
  }

  findLog(id: number) {
    return this.repo.findLog(id);
  }

  findEnvIdByBullJobId(bullJobId: string, queueName?: string) {
    return this.repo.findEnvIdByBullJobId(bullJobId, queueName);
  }

  updateStatusByBullJobId(
    bullJobId: string,
    queueName: string,
    status: JobExecutionStatus,
    error?: string,
  ) {
    return this.repo.updateStatusByBullJobId(bullJobId, queueName, status, error);
  }

  updateProgressByBullJobId(
    bullJobId: string,
    queueName: string,
    progress: number,
  ) {
    return this.repo.updateProgressByBullJobId(bullJobId, queueName, progress);
  }

  async retry(id: number) {
    const jobExec = await this.repo.findById(id);
    if (!jobExec) {
      throw new NotFoundException(`Job execution ${id} not found`);
    }

    let queue: Queue;
    try {
      const token = getQueueToken(jobExec.queue_name);
      queue = this.moduleRef.get<Queue>(token, { strict: false });
    } catch (err) {
      throw new BadRequestException(
        `Failed to resolve queue for name: ${jobExec.queue_name}`,
      );
    }

    if (!queue) {
      throw new BadRequestException(
        `Queue ${jobExec.queue_name} not available in system`,
      );
    }

    if (!jobExec.job_type) {
      throw new BadRequestException(`Cannot retry a job execution with no job type`);
    }

    return this.orchestrator.enqueue({
      queue,
      queueName: jobExec.queue_name,
      jobType: jobExec.job_type,
      payload: jobExec.payload,
      serverId: jobExec.server_id ? Number(jobExec.server_id) : undefined,
      environmentId: jobExec.environment_id ? Number(jobExec.environment_id) : undefined,
    });
  }

  async discard(id: number) {
    const jobExec = await this.repo.findById(id);
    if (!jobExec) {
      throw new NotFoundException(`Job execution ${id} not found`);
    }

    // Attempt to remove / fail the active or waiting job in BullMQ Redis
    try {
      const token = getQueueToken(jobExec.queue_name);
      const queue = this.moduleRef.get<Queue>(token, { strict: false });
      if (queue && jobExec.bull_job_id) {
        const bullJob = await queue.getJob(jobExec.bull_job_id);
        if (bullJob) {
          await bullJob.moveToFailed(new Error("Discarded by operator"), "0", true).catch(async () => {
            await bullJob.remove().catch(() => {});
          });
        }
      }
    } catch (err) {
      this.logger.debug(`Could not remove bull job ${jobExec.bull_job_id} from queue: ${err}`);
    }

    return this.repo.updateStatus(
      BigInt(id),
      "failed",
      "Discarded by operator",
    );
  }

  async recoverStalled(queueName?: string) {
    const targetQueues = queueName ? [queueName] : Object.values(QUEUES);
    const summary: Record<string, { reclaimed: number; cleaned: number }> = {};

    for (const qName of targetQueues) {
      try {
        const token = getQueueToken(qName);
        const queue = this.moduleRef.get<Queue>(token, { strict: false });
        if (!queue) continue;

        let reclaimed = 0;
        const activeJobs = await queue.getActive();
        const client = await queue.client;

        for (const job of activeJobs) {
          try {
            const lockKey = `bull:${qName}:${job.id}:lock`;
            const hasLock = await client.exists(lockKey);
            if (!hasLock) {
              await job.moveToFailed(
                new Error("Stalled active job recovered by operator"),
                "0",
                true,
              ).catch(async () => {
                await job.remove().catch(() => {});
              });
              reclaimed++;
            }
          } catch (jobErr) {
            this.logger.debug(`Error checking active job ${job.id} on ${qName}: ${jobErr}`);
          }
        }

        const cleaned = await queue.clean(0, 0, "active");
        summary[qName] = {
          reclaimed,
          cleaned: Array.isArray(cleaned) ? cleaned.length : 0,
        };
      } catch (err) {
        this.logger.warn(`Failed to recover queue ${qName}: ${err}`);
      }
    }

    // Also update any database records in 'active' or 'queued' older than 5 minutes
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const dbCleaned = await this.repo.markStalledAsFailed(
      fiveMinutesAgo,
      "Recovered / marked failed by operator",
    );

    return {
      success: true,
      message: "Queues inspected and recovered successfully",
      dbCleaned,
      summary,
    };
  }
}
