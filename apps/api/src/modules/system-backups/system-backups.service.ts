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
  normalizeGoogleDriveFolderId,
} from "@bedrock-forge/shared";
import { SystemBackupsRepository } from "./system-backups.repository";
import { SettingsService } from "../settings/settings.service";
import { normalizePage, normalizePageSize } from "../../common/pagination";

@Injectable()
export class SystemBackupsService {
  constructor(
    private readonly repo: SystemBackupsRepository,
    private readonly settings: SettingsService,
    @InjectQueue(QUEUES.SYSTEM_BACKUPS) private readonly queue: Queue,
  ) {}

  async list(page = 1, limit = 20) {
    return this.repo.findAllPaginated(
      normalizePage(page),
      normalizePageSize(limit),
    );
  }

  async findOne(id: number) {
    const b = await this.repo.findById(BigInt(id));
    if (!b) throw new NotFoundException(`SystemBackup ${id} not found`);
    return b;
  }

  async enqueueCreate() {
    const folderResult = await this.settings.get(
      "forge_system_backup_folder_id",
    );
    const rawFolderId = folderResult?.value;
    if (!rawFolderId) {
      throw new BadRequestException(
        "System backup Google Drive folder ID is not configured. Set it in Settings → System Backup.",
      );
    }
    let folderId: string;
    try {
      folderId = normalizeGoogleDriveFolderId(rawFolderId);
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error
          ? err.message
          : "System backup Google Drive folder ID is invalid.",
      );
    }

    const gdriveConfigured = await this.settings.hasEncrypted(
      "rclone_gdrive_config",
    );
    if (!gdriveConfigured) {
      throw new BadRequestException(
        "Google Drive is not configured. Set up Google Drive credentials in Settings first.",
      );
    }

    const bullJobId = randomUUID();
    const exec = await this.repo.createJobExecution({
      queue_name: QUEUES.SYSTEM_BACKUPS,
      job_type: JOB_TYPES.SYSTEM_BACKUP_CREATE,
      bull_job_id: bullJobId,
      payload: {} as Record<string, string | number>,
    });

    const backup = await this.repo.create({
      job_execution_id: exec.id,
      status: "pending",
    });

    let job;
    try {
      job = await this.queue.add(
        JOB_TYPES.SYSTEM_BACKUP_CREATE,
        {
          systemBackupId: Number(backup.id),
          jobExecutionId: Number(exec.id),
          folderId,
        },
        { ...DEFAULT_JOB_OPTIONS, jobId: bullJobId, attempts: 1 },
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await Promise.all([
        this.repo.update(backup.id, {
          status: "failed",
          error_message: errMsg,
        }),
        this.repo.updateJobExecution(exec.id, {
          status: "failed",
          last_error: errMsg,
        }),
      ]);
      throw err;
    }

    return {
      systemBackupId: Number(backup.id),
      jobExecutionId: Number(exec.id),
      bullJobId: job.id,
    };
  }
}
