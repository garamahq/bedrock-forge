import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { QUEUES, JOB_TYPES } from "@bedrock-forge/shared";
import { BackupSchedulesRepository } from "./backup-schedules.repository";
import { UpsertBackupScheduleDto } from "./dto/backup-schedule.dto";
import { EnvironmentsService } from "../environments/environments.service";
import {
  removeBullScheduler,
  syncBullScheduler,
} from "../../common/utils/bullmq-scheduler.util";

@Injectable()
export class BackupSchedulesService {
  private readonly logger = new Logger(BackupSchedulesService.name);

  constructor(
    private readonly repo: BackupSchedulesRepository,
    @Inject(forwardRef(() => EnvironmentsService))
    private readonly envService: EnvironmentsService,
    @InjectQueue(QUEUES.BACKUPS) private readonly backupsQueue: Queue,
  ) {}

  async findByEnvironment(envId: number) {
    return this.repo.findByEnvironment(BigInt(envId));
  }

  async upsert(envId: number, dto: UpsertBackupScheduleDto) {
    // Ensure the environment exists
    const exists = await this.envService.existsById(BigInt(envId));
    if (!exists) throw new NotFoundException(`Environment ${envId} not found`);

    const schedule = await this.repo.upsert(BigInt(envId), {
      type: dto.type,
      frequency: dto.frequency,
      hour: dto.hour,
      minute: dto.minute,
      day_of_week: dto.day_of_week ?? null,
      day_of_month: dto.day_of_month ?? null,
      enabled: dto.enabled,
      retention_count: dto.retention_count ?? null,
      retention_days: dto.retention_days ?? null,
    });

    // Sync the BullMQ repeatable job
    await this.syncRepeatableJob(Number(schedule.id), envId, dto);

    return schedule;
  }

  async remove(envId: number) {
    const schedule = await this.repo.findByEnvironment(BigInt(envId));
    if (schedule) {
      await this.removeRepeatableJob(Number(schedule.id));
    }
    await this.repo.delete(BigInt(envId));
  }

  // ── BullMQ repeatable job management ────────────────────────────────────

  private buildCronPattern(
    dto: Pick<
      UpsertBackupScheduleDto,
      "frequency" | "hour" | "minute" | "day_of_week" | "day_of_month"
    >,
  ): string {
    switch (dto.frequency) {
      case "daily":
        return `${dto.minute} ${dto.hour} * * *`;
      case "weekly":
        return `${dto.minute} ${dto.hour} * * ${dto.day_of_week ?? 0}`;
      case "monthly":
        return `${dto.minute} ${dto.hour} ${dto.day_of_month ?? 1} * *`;
      default:
        throw new Error(`Unknown frequency: ${dto.frequency}`);
    }
  }

  private repeatableJobId(scheduleId: number): string {
    return `backup-schedule-${scheduleId}`;
  }

  private async syncRepeatableJob(
    scheduleId: number,
    envId: number,
    dto: UpsertBackupScheduleDto,
  ) {
    const schedulerId = this.repeatableJobId(scheduleId);
    const pattern = this.buildCronPattern(dto);
    if (!dto.enabled) {
      await this.removeRepeatableJob(scheduleId);
      this.logger.log(
        `Schedule ${scheduleId} disabled — repeatable job removed`,
      );
      return;
    }

    this.logger.log(
      `Registering scheduler ${schedulerId} with cron ${pattern} for env ${envId}`,
    );

    await syncBullScheduler({
      queue: this.backupsQueue,
      schedulerId,
      enabled: dto.enabled,
      pattern,
      jobName: JOB_TYPES.BACKUP_SCHEDULED,
      data: {
        scheduleId,
        environmentId: envId,
        type: dto.type,
      },
      jobOpts: {
        removeOnComplete: 10,
        removeOnFail: 5,
      },
    });
  }

  async removeRepeatableJob(scheduleId: number) {
    const schedulerId = this.repeatableJobId(scheduleId);
    await removeBullScheduler(this.backupsQueue, schedulerId);
  }
}
