import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { QUEUES, JOB_TYPES, SYNC_JOB_OPTIONS } from "@bedrock-forge/shared";
import { SyncCloneDto, SyncPushDto } from "./dto/sync.dto";
import { SyncRepository } from "./sync.repository";
import { JobOrchestratorService } from "../job-executions/job-orchestrator.service";

@Injectable()
export class SyncService {
  constructor(
    private readonly repo: SyncRepository,
    private readonly jobOrchestrator: JobOrchestratorService,
    @InjectQueue(QUEUES.SYNC) private readonly queue: Queue,
  ) {}

  async enqueueClone(dto: SyncCloneDto) {
    const hasActive = await this.repo.hasActiveJob(
      BigInt(dto.targetEnvironmentId),
    );
    if (hasActive) {
      throw new BadRequestException(
        "An active sync or backup job is already running for the target environment.",
      );
    }

    // Validate target environment has a Google Drive folder configured.
    // Sync overwrites the target DB; a safety backup to GDrive is mandatory.
    // skipSafetyBackup bypasses this check — the user explicitly accepts the risk.
    if (!dto.skipSafetyBackup) {
      const targetEnv = await this.repo.findEnvironmentById(
        dto.targetEnvironmentId,
      );
      if (!targetEnv.google_drive_folder_id) {
        throw new BadRequestException(
          "Target environment has no Google Drive folder configured. " +
            "A safety backup is required before sync. " +
            "Set a Google Drive folder on the target environment first.",
        );
      }
    }

    return this.jobOrchestrator.enqueue({
      queue: this.queue,
      queueName: QUEUES.SYNC,
      jobType: JOB_TYPES.SYNC_CLONE,
      payload: dto,
      environmentId: dto.targetEnvironmentId,
      jobOptions: SYNC_JOB_OPTIONS,
    });
  }

  async enqueuePush(dto: SyncPushDto) {
    const hasActive = await this.repo.hasActiveJob(
      BigInt(dto.targetEnvironmentId),
    );
    if (hasActive) {
      throw new BadRequestException(
        "An active sync or backup job is already running for the target environment.",
      );
    }

    return this.jobOrchestrator.enqueue({
      queue: this.queue,
      queueName: QUEUES.SYNC,
      jobType: JOB_TYPES.SYNC_PUSH,
      payload: dto,
      environmentId: dto.targetEnvironmentId,
      jobOptions: SYNC_JOB_OPTIONS,
    });
  }

  async cancelJobExecution(id: number) {
    const exec = await this.repo.findJobExecutionById(BigInt(id));
    if (!exec) throw new NotFoundException(`JobExecution ${id} not found`);
    if (exec.status !== "active") {
      throw new BadRequestException(
        `Job execution ${id} is not active (status: ${exec.status})`,
      );
    }

    const client = await this.queue.client;
    await client.set(`forge:cancel:${exec.bull_job_id}`, "1", { EX: 3600 });

    // Optimistically mark as failed if still active; prevents overwriting completed status in a race.
    await this.repo.cancelJobExecutionIfActive(BigInt(id), "Cancelled by user");

    return { cancelled: true };
  }
}
