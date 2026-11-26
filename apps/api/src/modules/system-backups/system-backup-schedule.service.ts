import { Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { QUEUES, JOB_TYPES } from "@bedrock-forge/shared";
import { SystemBackupsRepository } from "./system-backups.repository";
import { UpsertSystemBackupScheduleDto } from "./system-backup-schedule.dto";
import {
  removeBullScheduler,
  syncBullScheduler,
} from "../../common/utils/bullmq-scheduler.util";

@Injectable()
export class SystemBackupScheduleService {
  private readonly logger = new Logger(SystemBackupScheduleService.name);

  constructor(
    private readonly repo: SystemBackupsRepository,
    @InjectQueue(QUEUES.SYSTEM_BACKUPS) private readonly queue: Queue,
  ) {}

  findSchedule() {
    return this.repo.findSchedule();
  }

  async upsert(dto: UpsertSystemBackupScheduleDto) {
    const schedule = await this.repo.upsertSchedule({
      frequency: dto.frequency,
      hour: dto.hour,
      minute: dto.minute,
      day_of_week: dto.day_of_week ?? null,
      day_of_month: dto.day_of_month ?? null,
      enabled: dto.enabled,
      retention_count: dto.retention_count ?? null,
      retention_days: dto.retention_days ?? null,
    });

    await this.syncRepeatableJob(Number(schedule.id), dto);
    return schedule;
  }

  async remove() {
    const schedule = await this.repo.findSchedule();
    if (schedule) {
      await this.removeRepeatableJob(Number(schedule.id));
    }
    await this.repo.deleteSchedule();
  }

  // ── BullMQ repeatable job management ────────────────────────────────────

  private buildCronPattern(
    dto: Pick<
      UpsertSystemBackupScheduleDto,
      "frequency" | "hour" | "minute" | "day_of_week" | "day_of_month"
    >,
  ): string {
    switch (dto.frequency) {
      case "hourly":
        return `${dto.minute} * * * *`;
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
    return `system-backup-schedule-${scheduleId}`;
  }

  private async syncRepeatableJob(
    scheduleId: number,
    dto: UpsertSystemBackupScheduleDto,
  ) {
    const schedulerId = this.repeatableJobId(scheduleId);
    const pattern = this.buildCronPattern(dto);
    if (!dto.enabled) {
      await this.removeRepeatableJob(scheduleId);
      this.logger.log(
        `SystemBackupSchedule ${scheduleId} disabled — repeatable job removed`,
      );
      return;
    }

    this.logger.log(
      `Registering system-backup scheduler ${schedulerId} with cron ${pattern}`,
    );

    await syncBullScheduler({
      queue: this.queue,
      schedulerId,
      enabled: dto.enabled,
      pattern,
      jobName: JOB_TYPES.SYSTEM_BACKUP_SCHEDULED,
      data: { scheduleId },
      jobOpts: {
        removeOnComplete: 10,
        removeOnFail: 5,
      },
    });
  }

  private async removeRepeatableJob(scheduleId: number) {
    const schedulerId = this.repeatableJobId(scheduleId);
    await removeBullScheduler(this.queue, schedulerId);
  }
}
