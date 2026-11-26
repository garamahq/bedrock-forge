import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
  Optional,
} from "@nestjs/common";
import { JobExecutionStatus } from "@prisma/client";
import { ModuleRef } from "@nestjs/core";
import { getQueueToken } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { JOB_TYPES, QUEUES, QueueName } from "@bedrock-forge/shared";
import {
  JobExecutionsRepository,
  JobExecutionFilter,
  StalledExecutionCandidate,
} from "./job-executions.repository";
import { JobOrchestratorService } from "./job-orchestrator.service";
import { BackupsService } from "../backups/backups.service";
import { SystemBackupsService } from "../system-backups/system-backups.service";

const VALID_BACKUP_TYPES = new Set([
  "full",
  "db_only",
  "files_only",
  "incremental",
]);
const RETRYABLE_EXECUTION_STATUSES = new Set([
  "failed",
  "dead_letter",
  "discarded",
]);

function readPayloadRecord(payload: unknown): Record<string, unknown> {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }
  return {};
}

@Injectable()
export class JobExecutionsService {
  private readonly logger = new Logger(JobExecutionsService.name);

  constructor(
    private readonly repo: JobExecutionsRepository,
    private readonly orchestrator: JobOrchestratorService,
    private readonly moduleRef: ModuleRef,
    @Optional() private readonly backupsService?: BackupsService,
    @Optional() private readonly systemBackupsService?: SystemBackupsService,
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
    return this.repo.updateStatusByBullJobId(
      bullJobId,
      queueName,
      status,
      error,
    );
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

    if (!RETRYABLE_EXECUTION_STATUSES.has(jobExec.status)) {
      throw new BadRequestException(
        `Job execution ${id} has status '${jobExec.status}' and cannot be retried.`,
      );
    }

    const payload = readPayloadRecord(jobExec.payload);

    if (jobExec.queue_name === QUEUES.SYSTEM_BACKUPS) {
      if (
        jobExec.job_type &&
        jobExec.job_type !== JOB_TYPES.SYSTEM_BACKUP_CREATE
      ) {
        throw new BadRequestException(
          `System backup job type '${jobExec.job_type}' cannot be retried.`,
        );
      }
      if (!this.systemBackupsService) {
        throw new BadRequestException(
          "SystemBackupsService is unavailable for retry.",
        );
      }
      return this.systemBackupsService.enqueueCreate();
    }

    if (jobExec.queue_name === QUEUES.BACKUPS) {
      if (
        jobExec.job_type === JOB_TYPES.BACKUP_CREATE ||
        jobExec.job_type === JOB_TYPES.BACKUP_SCHEDULED ||
        (!jobExec.job_type && typeof payload.type === "string")
      ) {
        const environmentId =
          typeof payload.environmentId === "number" &&
          Number.isFinite(payload.environmentId)
            ? payload.environmentId
            : jobExec.environment_id
              ? Number(jobExec.environment_id)
              : null;
        const type =
          typeof payload.type === "string" && VALID_BACKUP_TYPES.has(payload.type)
            ? (payload.type as "full" | "db_only" | "files_only" | "incremental")
            : null;
        if (!environmentId || !type) {
          throw new BadRequestException(
            "Historical backup execution lacks required environmentId or valid backup type for retry.",
          );
        }
        if (!this.backupsService) {
          throw new BadRequestException(
            "BackupsService is unavailable for retry.",
          );
        }
        return this.backupsService.enqueueCreate({ environmentId, type });
      }

      if (jobExec.job_type === JOB_TYPES.BACKUP_RESTORE) {
        const backupId =
          typeof payload.backupId === "number" &&
          Number.isInteger(payload.backupId) &&
          payload.backupId > 0
            ? payload.backupId
            : null;
        const targetEnvironmentId =
          typeof payload.environmentId === "number" &&
          Number.isInteger(payload.environmentId) &&
          payload.environmentId > 0
            ? payload.environmentId
            : undefined;
        if (!backupId) {
          throw new BadRequestException(
            "Backup restore execution lacks a valid backupId and cannot be retried.",
          );
        }
        if (!this.backupsService) {
          throw new BadRequestException(
            "BackupsService is unavailable for retry.",
          );
        }
        return this.backupsService.enqueueRestore({
          backupId,
          targetEnvironmentId,
        });
      }

      if (jobExec.job_type === JOB_TYPES.BACKUP_DELETE_FILE) {
        if (
          typeof payload.filePath !== "string" ||
          !payload.filePath.trim()
        ) {
          throw new BadRequestException(
            "Backup delete execution lacks filePath and cannot be retried.",
          );
        }
      } else {
        throw new BadRequestException(
          `Cannot retry backup execution with unsupported job type: ${jobExec.job_type ?? "missing"}.`,
        );
      }
    }

    if (!jobExec.job_type) {
      throw new BadRequestException(
        `Cannot retry a job execution with no job type`,
      );
    }

    let queue: Queue;
    try {
      const token = getQueueToken(jobExec.queue_name);
      queue = this.moduleRef.get<Queue>(token, { strict: false });
    } catch {
      throw new BadRequestException(
        `Failed to resolve queue for name: ${jobExec.queue_name}`,
      );
    }

    if (!queue) {
      throw new BadRequestException(
        `Queue ${jobExec.queue_name} not available in system`,
      );
    }

    if (
      jobExec.job_type === JOB_TYPES.PROJECT_CREATE_BEDROCK &&
      jobExec.bull_job_id &&
      jobExec.bull_job_id !== "0" &&
      typeof queue.getJob === "function"
    ) {
      const existingJob = await queue.getJob(jobExec.bull_job_id).catch(() => null);
      if (existingJob && typeof existingJob.getState === "function") {
        const state = await existingJob.getState().catch(() => null);
        if (
          state &&
          ["waiting", "active", "delayed", "prioritized", "paused"].includes(state)
        ) {
          await this.repo.updateStatus(
            jobExec.id,
            state === "active" ? "active" : "queued",
          );
          return {
            jobExecutionId: Number(jobExec.id),
            jobId: existingJob.id,
            bullJobId: jobExec.bull_job_id,
          };
        }
      }
    }

    return this.orchestrator.enqueue({
      queue,
      queueName: jobExec.queue_name,
      jobType: jobExec.job_type,
      payload: jobExec.payload,
      serverId: jobExec.server_id ? Number(jobExec.server_id) : undefined,
      environmentId: jobExec.environment_id
        ? Number(jobExec.environment_id)
        : undefined,
    });
  }

  async discard(id: number) {
    const jobExec = await this.repo.findById(id);
    if (!jobExec) {
      throw new NotFoundException(`Job execution ${id} not found`);
    }

    if (jobExec.status !== "queued") {
      throw new BadRequestException(
        "Only queued jobs can be removed. Finished job history is preserved.",
      );
    }
    if (!jobExec.bull_job_id) {
      throw new BadRequestException(
        "This queued job has no queue ID, so its state cannot be verified.",
      );
    }

    try {
      const queue = this.moduleRef.get<Queue>(
        getQueueToken(jobExec.queue_name),
        { strict: false },
      );
      if (!queue) {
        throw new BadRequestException(
          `Queue ${jobExec.queue_name} is unavailable; the job state cannot be verified.`,
        );
      }
      const bullJob = await queue.getJob(jobExec.bull_job_id);
      if (bullJob) {
        const state = await bullJob.getState();
        if (state === "active") {
          throw new BadRequestException(
            "This job is already running and cannot be removed from the queue.",
          );
        }
        if (["waiting", "delayed", "paused", "prioritized"].includes(state)) {
          await bullJob.remove();
        } else {
          throw new BadRequestException(
            `Queue job is already ${state}; refresh the activity log before acting.`,
          );
        }
      }
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      throw new BadRequestException(
        `Could not verify or remove the queued job: ${String(err)}`,
      );
    }

    return this.repo.updateStatus(
      BigInt(id),
      "discarded",
      "Removed from queue by operator",
    );
  }

  async recoveryPreview(queueName?: QueueName) {
    const cutoff = this.stalledCutoff();
    const [candidates, total] = await Promise.all([
      this.repo.findStalledCandidates(cutoff, queueName),
      this.repo.countStalledCandidates(cutoff, queueName),
    ]);
    const inspected = await Promise.all(
      candidates.map((candidate) => this.inspectCandidate(candidate)),
    );
    const repairable = inspected.filter((item) => item.repairStatus !== null);

    return {
      cutoff,
      total,
      inspected: inspected.length,
      repairable: repairable.length,
      held: inspected.length - repairable.length,
      hasMore: total > inspected.length,
      items: inspected,
    };
  }

  async recoverStalled(queueName?: QueueName) {
    const cutoff = this.stalledCutoff();
    const candidates = await this.repo.findStalledCandidates(cutoff, queueName);
    const inspected = await Promise.all(
      candidates.map((candidate) => this.inspectCandidate(candidate)),
    );
    let reconciled = 0;
    const summary: Record<string, { reconciled: number; held: number }> = {};

    for (const item of inspected) {
      const entry = (summary[item.queue_name] ??= { reconciled: 0, held: 0 });
      if (!item.repairStatus) {
        entry.held++;
        continue;
      }

      const updated = await this.repo.reconcileStalledCandidate(
        BigInt(item.id),
        cutoff,
        item.repairStatus,
        item.reason,
      );
      entry.reconciled += updated;
      reconciled += updated;
    }

    return {
      success: true,
      message: `${reconciled} stale job record(s) reconciled; active or unverified queue work was left untouched.`,
      reconciled,
      held: inspected.length - reconciled,
      summary,
    };
  }

  private stalledCutoff(): Date {
    return new Date(Date.now() - 5 * 60 * 1000);
  }

  private async inspectCandidate(candidate: StalledExecutionCandidate) {
    const base = {
      id: Number(candidate.id),
      queue_name: candidate.queue_name,
      status: candidate.status,
      created_at: candidate.created_at,
      repairStatus: null as "completed" | "failed" | null,
      reason: "",
    };

    if (!candidate.bull_job_id) {
      return {
        ...base,
        reason: "No queue job ID is recorded; queue state cannot be verified.",
      };
    }

    try {
      const queue = this.moduleRef.get<Queue>(
        getQueueToken(candidate.queue_name),
        { strict: false },
      );
      if (!queue) {
        return { ...base, reason: "Queue is not available in this process." };
      }
      const job = await queue.getJob(candidate.bull_job_id);
      if (!job) {
        return {
          ...base,
          repairStatus: "failed" as const,
          reason: "Queue job no longer exists.",
        };
      }

      const state = await job.getState();
      if (state === "completed" || state === "failed") {
        return {
          ...base,
          repairStatus: state,
          reason:
            state === "failed"
              ? job.failedReason || "Queue reports the job failed."
              : "Queue reports the job completed.",
        };
      }

      return {
        ...base,
        reason:
          state === "active"
            ? "Worker still owns this job; BullMQ will handle stalled-job recovery."
            : `Queue job is still ${state}.`,
      };
    } catch (error) {
      this.logger.warn(
        `Could not inspect queue job ${candidate.bull_job_id} on ${candidate.queue_name}: ${error}`,
      );
      return { ...base, reason: "Queue state could not be verified." };
    }
  }
}
