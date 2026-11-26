import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { QUEUES } from "@bedrock-forge/shared";

export interface CreateBackupData {
  environment_id: bigint;
  job_execution_id?: bigint;
  type: "full" | "db_only" | "files_only" | "incremental";
  status: "pending" | "running" | "completed" | "failed";
  file_path?: string;
  size_bytes?: bigint;
  error_message?: string;
  started_at?: Date;
  completed_at?: Date;
}

export interface UpdateJobExecutionData {
  status?: "queued" | "active" | "completed" | "failed" | "dead_letter";
  last_error?: string;
  started_at?: Date;
  completed_at?: Date;
  progress?: number;
}

/**
 * BackupsRepository
 *
 * Sole owner of all Prisma operations for the backups domain.
 * No business logic lives here — only query construction and data mapping.
 */
@Injectable()
export class BackupsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByEnvironmentPaginated(envId: bigint, page: number, limit: number) {
    const skip = (page - 1) * limit;
    const [items, total] = await this.prisma.$transaction([
      this.prisma.backup.findMany({
        where: { environment_id: envId },
        skip,
        take: limit,
        orderBy: { created_at: "desc" },
        include: {
          environment: {
            select: {
              id: true,
              project: { select: { id: true, name: true } },
            },
          },
          jobExecution: {
            select: {
              id: true,
              bull_job_id: true,
              status: true,
              progress: true,
              last_error: true,
              started_at: true,
              completed_at: true,
              execution_log: true,
            },
          },
        },
      }),
      this.prisma.backup.count({ where: { environment_id: envId } }),
    ]);
    return { items, total, page, limit };
  }

  findById(id: bigint) {
    return this.prisma.backup.findUnique({
      where: { id },
      include: { environment: { include: { server: true } } },
    });
  }

  create(data: CreateBackupData) {
    return this.prisma.backup.create({ data });
  }

  updateStatus(
    id: bigint,
    data: {
      status?: "pending" | "running" | "completed" | "failed";
      file_path?: string;
      size_bytes?: bigint;
      error_message?: string;
      started_at?: Date;
      completed_at?: Date;
    },
  ) {
    return this.prisma.backup.update({ where: { id }, data });
  }

  delete(id: bigint) {
    return this.prisma.backup.delete({ where: { id } });
  }

  createJobExecution(data: {
    queue_name: string;
    job_type?: string;
    bull_job_id: string;
    environment_id: bigint;
    payload?: Prisma.InputJsonObject;
  }) {
    return this.prisma.jobExecution.create({ data });
  }

  /**
   * Atomically create both a JobExecution and a Backup row in a single
   * interactive transaction.  If either insert fails the whole operation
   * rolls back, preventing orphaned records in pending state.
   */
  async createJobExecutionAndBackup(
    execData: {
      queue_name: string;
      job_type?: string;
      bull_job_id: string;
      environment_id: bigint;
      payload?: Prisma.InputJsonObject;
    },
    backupData: {
      environment_id: bigint;
      type: "full" | "db_only" | "files_only" | "incremental";
      status: "pending" | "running" | "completed" | "failed";
    },
  ) {
    return this.prisma.$transaction(async (tx) => {
      const exec = await tx.jobExecution.create({ data: execData });
      const backup = await tx.backup.create({
        data: { ...backupData, job_execution_id: exec.id },
      });
      return { exec, backup };
    });
  }

  /**
   * Acquire a PostgreSQL transaction-scoped advisory lock keyed by environmentId,
   * verify no active or queued BACKUPS / SYNC job exists for the environment,
   * and atomically insert JobExecution + Backup rows.
   *
   * Returns null if another job is already queued or active for this environment.
   */
  async createJobExecutionAndBackupIfIdle(
    execData: {
      queue_name: string;
      job_type?: string;
      bull_job_id: string;
      environment_id: bigint;
      payload?: Prisma.InputJsonObject;
    },
    backupData: {
      environment_id: bigint;
      type: "full" | "db_only" | "files_only" | "incremental";
      status: "pending" | "running" | "completed" | "failed";
    },
  ): Promise<{
    exec: Awaited<ReturnType<PrismaService["jobExecution"]["create"]>>;
    backup: Awaited<ReturnType<PrismaService["backup"]["create"]>>;
  } | null> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${execData.environment_id})`;

      const existing = await tx.jobExecution.findFirst({
        where: {
          environment_id: execData.environment_id,
          queue_name: { in: [QUEUES.BACKUPS, QUEUES.SYNC] },
          status: { in: ["queued", "active"] },
        },
        select: { id: true },
      });
      if (existing) {
        return null;
      }

      const exec = await tx.jobExecution.create({ data: execData });
      const backup = await tx.backup.create({
        data: { ...backupData, job_execution_id: exec.id },
      });
      return { exec, backup };
    });
  }

  /**
   * Acquire a PostgreSQL transaction-scoped advisory lock keyed by environmentId,
   * verify no active or queued BACKUPS / SYNC job exists for the environment,
   * and atomically insert a JobExecution row (used by restore enqueue).
   */
  async createJobExecutionIfIdle(execData: {
    queue_name: string;
    job_type?: string;
    bull_job_id: string;
    environment_id: bigint;
    payload?: Prisma.InputJsonObject;
  }): Promise<Awaited<
    ReturnType<PrismaService["jobExecution"]["create"]>
  > | null> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${execData.environment_id})`;

      const existing = await tx.jobExecution.findFirst({
        where: {
          environment_id: execData.environment_id,
          queue_name: { in: [QUEUES.BACKUPS, QUEUES.SYNC] },
          status: { in: ["queued", "active"] },
        },
        select: { id: true },
      });
      if (existing) {
        return null;
      }

      return tx.jobExecution.create({ data: execData });
    });
  }

  findJobExecutionById(id: bigint) {
    return this.prisma.jobExecution.findUnique({ where: { id } });
  }

  updateJobExecution(id: bigint, data: UpdateJobExecutionData) {
    return this.prisma.jobExecution.update({ where: { id }, data });
  }

  findJobExecutionLog(id: bigint) {
    return this.prisma.jobExecution.findUnique({
      where: { id },
      select: { id: true, status: true, execution_log: true },
    });
  }

  /**
   * Return only the fields needed to validate a backup can be enqueued.
   * Kept minimal to avoid over-fetching.
   */
  findEnvironment(envId: bigint) {
    return this.prisma.environment.findUnique({
      where: { id: envId },
      select: { id: true, google_drive_folder_id: true, project_id: true },
    });
  }

  async cancelJobExecutionIfActive(
    id: bigint,
    error: string,
  ): Promise<boolean> {
    const result = await this.prisma.jobExecution.updateMany({
      where: { id, status: "active" },
      data: {
        status: "failed",
        last_error: error,
        completed_at: new Date(),
      },
    });
    return result.count > 0;
  }

  /**
   * Record that a user requested cancellation while keeping the execution
   * status as 'active' until the worker actually acknowledges the signal and stops.
   * Uses a status guard so terminal executions are never overwritten.
   */
  async markCancellationRequestedIfActive(
    id: bigint,
    message: string,
  ): Promise<boolean> {
    const result = await this.prisma.jobExecution.updateMany({
      where: { id, status: "active" },
      data: { last_error: message },
    });
    return result.count > 0;
  }

  /**
   * Immediately mark a queued (not yet started) JobExecution and any linked
   * pending Backup row as failed inside a transaction.
   */
  async cancelQueuedJobExecution(id: bigint, error: string): Promise<boolean> {
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const result = await tx.jobExecution.updateMany({
        where: { id, status: "queued" },
        data: {
          status: "failed",
          last_error: error,
          completed_at: now,
        },
      });
      if (result.count === 0) {
        return false;
      }
      await tx.backup.updateMany({
        where: { job_execution_id: id, status: "pending" },
        data: {
          status: "failed",
          error_message: error,
          completed_at: now,
        },
      });
      return true;
    });
  }

  hasActiveJob(envId: bigint): Promise<boolean> {
    return this.prisma.jobExecution
      .findFirst({
        where: {
          environment_id: envId,
          queue_name: { in: [QUEUES.BACKUPS, QUEUES.SYNC] },
          status: { in: ["queued", "active"] },
        },
        select: { id: true },
      })
      .then((r) => r !== null);
  }
}
