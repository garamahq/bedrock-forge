import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { randomUUID } from "crypto";
import {
  QUEUES,
  JOB_TYPES,
  DEFAULT_JOB_OPTIONS,
  BACKUP_JOB_OPTIONS,
  PaginationQuery,
} from "@bedrock-forge/shared";
import { EnqueueBackupDto, RestoreBackupDto } from "./dto/backup.dto";
import { BackupsRepository } from "./backups.repository";
import { normalizePage, normalizePageSize } from "../../common/pagination";

const CANCELLABLE_BACKUP_JOB_TYPES = new Set<string>([
  JOB_TYPES.BACKUP_CREATE,
  JOB_TYPES.BACKUP_RESTORE,
  JOB_TYPES.BACKUP_SCHEDULED,
]);

const POST_MUTATION_RESTORE_STEP_MARKERS = [
  "Executing restore script",
  "backup.php restore execution",
  "Files + database restored",
  "Files restored",
  "Restore script completed",
  "Fixing ownership",
  "Running cross-environment URL search-replace",
  "URL search-replace",
  "Restore complete",
];

function hasTargetMutationStarted(executionLog: unknown): boolean {
  if (!Array.isArray(executionLog)) {
    return false;
  }
  return executionLog.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const step = (entry as { step?: unknown }).step;
    return (
      typeof step === "string" &&
      POST_MUTATION_RESTORE_STEP_MARKERS.some((marker) => step.includes(marker))
    );
  });
}

@Injectable()
export class BackupsService {
  constructor(
    private readonly repo: BackupsRepository,
    @InjectQueue(QUEUES.BACKUPS) private readonly backupsQueue: Queue,
  ) {}

  findByEnvironment(envId: number, query: PaginationQuery) {
    const page = normalizePage(query.page);
    const limit = normalizePageSize(query.limit);
    return this.repo.findByEnvironmentPaginated(BigInt(envId), page, limit);
  }

  async findOne(id: number) {
    const b = await this.repo.findById(BigInt(id));
    if (!b) throw new NotFoundException(`Backup ${id} not found`);
    return b;
  }

  async enqueueCreate(dto: EnqueueBackupDto): Promise<{
    jobExecutionId: number;
    bullJobId: string | undefined;
    backupId: number;
  }> {
    const env = await this.repo.findEnvironment(BigInt(dto.environmentId));
    if (!env) {
      throw new NotFoundException(`Environment ${dto.environmentId} not found`);
    }
    if (!env.google_drive_folder_id) {
      throw new BadRequestException(
        `Environment ${dto.environmentId} has no Google Drive folder ID configured.`,
      );
    }

    const bullJobId = randomUUID();
    // Acquire advisory lock and atomically check + create both rows so
    // concurrent create/restore/sync requests cannot race past hasActiveJob.
    const created = await this.repo.createJobExecutionAndBackupIfIdle(
      {
        queue_name: QUEUES.BACKUPS,
        job_type: JOB_TYPES.BACKUP_CREATE,
        bull_job_id: bullJobId,
        environment_id: BigInt(dto.environmentId),
        payload: { environmentId: dto.environmentId, type: dto.type } as Record<
          string,
          string | number
        >,
      },
      {
        environment_id: BigInt(dto.environmentId),
        type: dto.type as "full" | "db_only" | "files_only",
        status: "pending",
      },
    );
    if (!created) {
      throw new ConflictException(
        `An active backup, restore, or sync job is already running or queued for this environment.`,
      );
    }
    const { exec, backup } = created;
    let job;
    try {
      job = await this.backupsQueue.add(
        JOB_TYPES.BACKUP_CREATE,
        {
          environmentId: dto.environmentId,
          type: dto.type,
          jobExecutionId: Number(exec.id),
          backupId: Number(backup.id),
        },
        { ...BACKUP_JOB_OPTIONS, jobId: bullJobId },
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const now = new Date();
      await Promise.allSettled([
        this.repo.updateJobExecution(exec.id, {
          status: "failed",
          last_error: errMsg,
          completed_at: now,
        }),
        this.repo.updateStatus(backup.id, {
          status: "failed",
          error_message: errMsg,
          completed_at: now,
        }),
      ]);
      throw err;
    }
    return {
      jobExecutionId: Number(exec.id),
      bullJobId: job.id,
      backupId: Number(backup.id),
    };
  }

  async enqueueRestore(dto: RestoreBackupDto): Promise<{
    jobExecutionId: bigint;
    bullJobId: string | undefined;
  }> {
    const backup = await this.findOne(dto.backupId);
    let targetEnvId = Number(backup.environment_id);

    if (dto.targetEnvironmentId) {
      const targetEnv = await this.repo.findEnvironment(
        BigInt(dto.targetEnvironmentId),
      );
      if (!targetEnv) {
        throw new NotFoundException(
          `Target environment ${dto.targetEnvironmentId} not found`,
        );
      }

      const backupEnv = await this.repo.findEnvironment(
        BigInt(backup.environment_id),
      );
      if (!backupEnv || targetEnv.project_id !== backupEnv.project_id) {
        throw new BadRequestException(
          `Target environment ${dto.targetEnvironmentId} must belong to the same project as the backup's environment.`,
        );
      }

      targetEnvId = dto.targetEnvironmentId;
    }

    const bullJobId = randomUUID();
    const exec = await this.repo.createJobExecutionIfIdle({
      queue_name: QUEUES.BACKUPS,
      job_type: JOB_TYPES.BACKUP_RESTORE,
      bull_job_id: bullJobId,
      environment_id: BigInt(targetEnvId),
      payload: {
        backupId: dto.backupId,
        environmentId: targetEnvId,
      } as Record<string, number>,
    });
    if (!exec) {
      throw new ConflictException(
        `An active backup, restore, or sync job is already running or queued for the target environment.`,
      );
    }
    let job;
    try {
      job = await this.backupsQueue.add(
        JOB_TYPES.BACKUP_RESTORE,
        {
          backupId: dto.backupId,
          environmentId: targetEnvId,
          jobExecutionId: Number(exec.id),
        },
        { ...BACKUP_JOB_OPTIONS, jobId: bullJobId },
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.repo.updateJobExecution(exec.id, {
        status: "failed",
        last_error: errMsg,
        completed_at: new Date(),
      });
      throw err;
    }
    return { jobExecutionId: exec.id, bullJobId: job.id };
  }

  async findJobExecution(id: number) {
    const exec = await this.repo.findJobExecutionById(BigInt(id));
    if (!exec) throw new NotFoundException(`JobExecution ${id} not found`);
    return exec;
  }

  async findJobExecutionLog(id: number) {
    const exec = await this.repo.findJobExecutionLog(BigInt(id));
    if (!exec) throw new NotFoundException(`JobExecution ${id} not found`);
    return exec;
  }

  async cancelJobExecution(id: number): Promise<{
    cancelled: boolean;
    terminated: boolean;
    status: "cancellation_requested" | "failed";
  }> {
    const exec = await this.repo.findJobExecutionById(BigInt(id));
    if (!exec) throw new NotFoundException(`JobExecution ${id} not found`);

    if (
      exec.queue_name !== QUEUES.BACKUPS ||
      !exec.job_type ||
      !CANCELLABLE_BACKUP_JOB_TYPES.has(exec.job_type)
    ) {
      throw new BadRequestException(
        `Job execution ${id} (queue=${exec.queue_name}, type=${exec.job_type ?? "unknown"}) is not a cancellable backup job.`,
      );
    }

    if (exec.status !== "active" && exec.status !== "queued") {
      throw new BadRequestException(
        `Job execution ${id} is not active or queued (status: ${exec.status})`,
      );
    }

    // Handle queued (not yet picked up by a worker) jobs: try removing directly
    // from BullMQ and failing immediately unless it already moved to active.
    let effectiveStatus: string = exec.status;
    if (effectiveStatus === "queued") {
      const bullJob = await this.backupsQueue.getJob?.(exec.bull_job_id);
      const state = bullJob ? await bullJob.getState?.() : null;
      if (state === "active") {
        effectiveStatus = "active";
      } else {
        await bullJob?.remove?.().catch(() => undefined);
        const cancelled = await this.repo.cancelQueuedJobExecution(
          BigInt(id),
          "Cancelled by user before start",
        );
        if (!cancelled) {
          throw new ConflictException(
            `Job execution ${id} transitioned state before queued cancellation could be applied.`,
          );
        }
        return { cancelled: true, terminated: true, status: "failed" };
      }
    }

    if (
      exec.job_type === JOB_TYPES.BACKUP_RESTORE &&
      hasTargetMutationStarted(exec.execution_log)
    ) {
      throw new BadRequestException(
        `Cannot cancel restore execution ${id} after target mutation has started.`,
      );
    }

    // Write a cancellation token into Redis — the worker checks this before and
    // during processing and throws UnrecoverableError when observed.
    const client = await this.backupsQueue.client;
    await client.set(`forge:cancel:${exec.bull_job_id}`, "1", { EX: 3600 });

    // Record the cancellation request while leaving status='active' until the
    // worker confirms termination. Status guard prevents overwriting terminal rows.
    const marked = await this.repo.markCancellationRequestedIfActive(
      BigInt(id),
      "Cancellation requested by user",
    );
    if (!marked) {
      throw new ConflictException(
        `Job execution ${id} completed or failed before cancellation could be recorded.`,
      );
    }

    return {
      cancelled: true,
      terminated: false,
      status: "cancellation_requested",
    };
  }

  async remove(id: number) {
    const backup = await this.findOne(id);
    // Enqueue async GDrive file deletion before removing the DB record
    if (backup.file_path) {
      await this.backupsQueue.add(
        JOB_TYPES.BACKUP_DELETE_FILE,
        { filePath: backup.file_path },
        { ...DEFAULT_JOB_OPTIONS, attempts: 5 },
      );
    }
    return this.repo.delete(BigInt(id));
  }
}
