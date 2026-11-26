import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";

export interface CreateSystemBackupData {
  job_execution_id?: bigint;
  status: "pending" | "running" | "completed" | "failed" | "deleting";
}

export interface UpdateSystemBackupData {
  status?: "pending" | "running" | "completed" | "failed" | "deleting";
  file_path?: string;
  size_bytes?: bigint;
  error_message?: string;
  started_at?: Date;
  completed_at?: Date;
}

export interface UpsertScheduleData {
  frequency: string;
  hour: number;
  minute: number;
  day_of_week?: number | null;
  day_of_month?: number | null;
  enabled: boolean;
  retention_count?: number | null;
  retention_days?: number | null;
}

/**
 * SystemBackupsRepository
 *
 * Sole owner of all Prisma operations for the system-backups domain.
 */
@Injectable()
export class SystemBackupsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findAllPaginated(page: number, limit: number) {
    const skip = (page - 1) * limit;
    const [items, total] = await this.prisma.$transaction([
      this.prisma.systemBackup.findMany({
        skip,
        take: limit,
        orderBy: { created_at: "desc" },
        include: {
          jobExecution: {
            select: {
              id: true,
              status: true,
              progress: true,
              last_error: true,
              started_at: true,
              completed_at: true,
            },
          },
        },
      }),
      this.prisma.systemBackup.count(),
    ]);
    return { items, total, page, limit };
  }

  findById(id: bigint) {
    return this.prisma.systemBackup.findUnique({ where: { id } });
  }

  create(data: CreateSystemBackupData) {
    return this.prisma.systemBackup.create({ data });
  }

  update(id: bigint, data: UpdateSystemBackupData) {
    return this.prisma.systemBackup.update({ where: { id }, data });
  }

  createJobExecution(data: {
    queue_name: string;
    job_type: string;
    bull_job_id: string;
    payload: Record<string, string | number>;
  }) {
    return this.prisma.jobExecution.create({ data });
  }

  updateJobExecution(
    id: bigint,
    data: {
      status?: "queued" | "active" | "completed" | "failed" | "dead_letter";
      last_error?: string;
      completed_at?: Date;
    },
  ) {
    return this.prisma.jobExecution.update({ where: { id }, data });
  }

  // ── Schedule CRUD ────────────────────────────────────────────────────────

  /** Returns the single system-backup schedule row, or null. */
  findSchedule() {
    return this.prisma.systemBackupSchedule.findFirst();
  }

  /** Upsert the single-row system backup schedule. */
  async upsertSchedule(data: UpsertScheduleData) {
    const existing = await this.prisma.systemBackupSchedule.findFirst();
    if (existing) {
      return this.prisma.systemBackupSchedule.update({
        where: { id: existing.id },
        data,
      });
    }
    return this.prisma.systemBackupSchedule.create({ data });
  }

  /** Delete the system backup schedule row (if it exists). */
  async deleteSchedule() {
    const existing = await this.prisma.systemBackupSchedule.findFirst();
    if (!existing) return;
    await this.prisma.systemBackupSchedule.delete({
      where: { id: existing.id },
    });
  }

  /** Stamp `last_run_at` after a scheduled backup completes. */
  async updateScheduleLastRun(scheduleId: bigint) {
    return this.prisma.systemBackupSchedule.update({
      where: { id: scheduleId },
      data: { last_run_at: new Date() },
    });
  }
}
