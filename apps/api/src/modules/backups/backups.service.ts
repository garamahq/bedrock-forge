import {
  Injectable,
  NotFoundException,
  BadRequestException,
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

  async enqueueCreate(dto: EnqueueBackupDto) {
    const env = await this.repo.findEnvironment(BigInt(dto.environmentId));
    if (!env) {
      throw new NotFoundException(`Environment ${dto.environmentId} not found`);
    }
    if (!env.google_drive_folder_id) {
      throw new BadRequestException(
        `Environment ${dto.environmentId} has no Google Drive folder ID configured.`,
      );
    }
    const hasActive = await this.repo.hasActiveJob(BigInt(dto.environmentId));
    if (hasActive) {
      throw new BadRequestException(
        `An active backup or restore job is already running for this environment.`,
      );
    }

    const bullJobId = randomUUID();
    // Atomically create both rows so a queue.add() failure leaves no orphans.
    const { exec, backup } = await this.repo.createJobExecutionAndBackup(
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
      await Promise.allSettled([
        this.repo.updateJobExecution(exec.id, {
          status: "failed",
          last_error: errMsg,
        }),
        this.repo.updateStatus(backup.id, {
          status: "failed",
          error_message: errMsg,
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

  async enqueueRestore(dto: RestoreBackupDto) {
    const backup = await this.findOne(dto.backupId);
    let targetEnvId = Number(backup.environment_id);

    if (dto.targetEnvironmentId) {
      const targetEnv = await this.repo.findEnvironment(BigInt(dto.targetEnvironmentId));
      if (!targetEnv) {
        throw new NotFoundException(`Target environment ${dto.targetEnvironmentId} not found`);
      }
      
      const backupEnv = await this.repo.findEnvironment(BigInt(backup.environment_id));
      if (!backupEnv || targetEnv.project_id !== backupEnv.project_id) {
        throw new BadRequestException(
          `Target environment ${dto.targetEnvironmentId} must belong to the same project as the backup's environment.`,
        );
      }
      
      targetEnvId = dto.targetEnvironmentId;
    }

    const hasActive = await this.repo.hasActiveJob(BigInt(targetEnvId));
    if (hasActive) {
      throw new BadRequestException(
        `An active backup or restore job is already running for the target environment.`,
      );
    }

    const bullJobId = randomUUID();
    const exec = await this.repo.createJobExecution({
      queue_name: QUEUES.BACKUPS,
      job_type: JOB_TYPES.BACKUP_RESTORE,
      bull_job_id: bullJobId,
      environment_id: BigInt(targetEnvId),
      payload: {
        backupId: dto.backupId,
        environmentId: targetEnvId,
      } as Record<string, number>,
    });
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

  async cancelJobExecution(id: number) {
    const exec = await this.repo.findJobExecutionById(BigInt(id));
    if (!exec) throw new NotFoundException(`JobExecution ${id} not found`);
    if (exec.status !== "active") {
      throw new BadRequestException(
        `Job execution ${id} is not active (status: ${exec.status})`,
      );
    }

    // Write a cancellation token into Redis — the worker checks this in
    // its progress callback and kills the rclone child process when found.
    const client = await this.backupsQueue.client;
    await client.set(`forge:cancel:${exec.bull_job_id}`, "1", "EX", 3600);

    // Optimistically mark as failed if still active; prevents overwriting completed status in a race.
    await this.repo.cancelJobExecutionIfActive(
      BigInt(id),
      "Cancelled by user",
    );

    return { cancelled: true };
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
