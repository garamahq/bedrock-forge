import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import {
  CleanupSchedulesRepository,
  UpsertCleanupScheduleData,
} from "./cleanup-schedules.repository";
import { CLEANUP_FREQUENCIES } from "./dto/upsert-cleanup-schedule.dto";

@Injectable()
export class CleanupSchedulesService {
  private readonly logger = new Logger(CleanupSchedulesService.name);

  constructor(private readonly repo: CleanupSchedulesRepository) {}

  async findByEnvironment(envId: number) {
    const schedule = await this.repo.findByEnvironment(BigInt(envId));
    if (!schedule) return null;

    if (
      !(CLEANUP_FREQUENCIES as readonly string[]).includes(schedule.frequency)
    ) {
      const reason = `Unsupported schedule frequency '${schedule.frequency}'. Supported values: ${CLEANUP_FREQUENCIES.join(", ")}. This schedule will not run until updated.`;
      this.logger.warn(`CleanupSchedule for env ${envId}: ${reason}`);
      return { ...schedule, unsupported_frequency_reason: reason };
    }

    return schedule;
  }

  async upsert(envId: number, data: UpsertCleanupScheduleData) {
    return this.repo.upsert(BigInt(envId), data);
  }

  async delete(envId: number) {
    const existing = await this.repo.findByEnvironment(BigInt(envId));
    if (!existing)
      throw new NotFoundException(
        `No cleanup schedule for environment ${envId}`,
      );
    return this.repo.delete(BigInt(envId));
  }
}
