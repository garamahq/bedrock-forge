import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { JobExecutionStatus } from "@prisma/client";

export interface JobExecutionFilter {
  queue_name?: string;
  job_type?: string;
  status?: string;
  environment_id?: number;
  environment_ids?: number[];
  date_from?: Date;
  date_to?: Date;
}

export interface JobExecutionPage {
  data: JobExecutionRow[];
  total: number;
  page: number;
  limit: number;
}

export interface JobExecutionRow {
  id: number;
  queue_name: string;
  status: string;
  progress: number | null;
  last_error: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  environment: {
    id: number;
    type: string;
    url: string | null;
    project: {
      id: number;
      name: string;
      client: { id: number; name: string };
    };
  } | null;
}

@Injectable()
export class JobExecutionsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findPaginated(
    filter: JobExecutionFilter,
    page: number,
    limit: number,
  ): Promise<JobExecutionPage> {
    const where: Record<string, unknown> = {};

    if (filter.queue_name) where.queue_name = filter.queue_name;
    if (filter.job_type) where.job_type = filter.job_type;
    if (filter.status) where.status = filter.status;
    if (filter.environment_ids && filter.environment_ids.length > 0) {
      where.environment_id = {
        in: filter.environment_ids.map((id) => BigInt(id)),
      };
    } else if (filter.environment_id) {
      where.environment_id = BigInt(filter.environment_id);
    }
    if (filter.date_from || filter.date_to) {
      where.created_at = {
        ...(filter.date_from ? { gte: filter.date_from } : {}),
        ...(filter.date_to ? { lte: filter.date_to } : {}),
      };
    }

    const [total, rows] = await Promise.all([
      this.prisma.jobExecution.count({ where }),
      this.prisma.jobExecution.findMany({
        where,
        orderBy: { created_at: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          queue_name: true,
          bull_job_id: true,
          status: true,
          progress: true,
          last_error: true,
          started_at: true,
          completed_at: true,
          created_at: true,
          environment: {
            select: {
              id: true,
              type: true,
              url: true,
              project: {
                select: {
                  id: true,
                  name: true,
                  client: { select: { id: true, name: true } },
                },
              },
            },
          },
        },
      }),
    ]);

    return {
      data: rows.map((r) => ({
        ...r,
        id: Number(r.id),
        environment: r.environment
          ? {
              ...r.environment,
              id: Number(r.environment.id),
              project: {
                ...r.environment.project,
                id: Number(r.environment.project.id),
                client: {
                  ...r.environment.project.client,
                  id: Number(r.environment.project.client.id),
                },
              },
            }
          : null,
      })),
      total,
      page,
      limit,
    };
  }

  async findById(id: number) {
    return this.prisma.jobExecution.findUniqueOrThrow({
      where: { id: BigInt(id) },
      include: {
        environment: {
          include: {
            project: { include: { client: true } },
          },
        },
      },
    });
  }

  async findLog(id: number) {
    return this.prisma.jobExecution.findUniqueOrThrow({
      where: { id: BigInt(id) },
      select: {
        id: true,
        status: true,
        progress: true,
        execution_log: true,
        last_error: true,
        started_at: true,
        completed_at: true,
        created_at: true,
      },
    });
  }

  /**
   * Resolve the environment_id for a given bull_job_id.
   * Optionally filter by queue_name (e.g. 'monitors') to avoid false positives.
   */
  async findEnvIdByBullJobId(
    bullJobId: string,
    queueName?: string,
  ): Promise<number | undefined> {
    try {
      const match = bullJobId.match(/(?:manual-)?monitor-(\d+)/);
      if (match) {
        const monitorId = BigInt(match[1]);
        const monitor = await this.prisma.monitor.findUnique({
          where: { id: monitorId },
          select: { environment_id: true },
        });
        return monitor?.environment_id ? Number(monitor.environment_id) : undefined;
      }

      const exec = await this.prisma.jobExecution.findFirst({
        where: {
          bull_job_id: bullJobId,
          ...(queueName ? { queue_name: queueName } : {}),
        },
        select: { environment_id: true },
        orderBy: { created_at: "desc" },
      });
      return exec?.environment_id ? Number(exec.environment_id) : undefined;
    } catch {
      return undefined;
    }
  }

  async create(data: {
    queue_name: string;
    bull_job_id: string;
    job_type: string;
    status: JobExecutionStatus;
    server_id: bigint | null;
    environment_id: bigint | null;
    payload: any;
  }) {
    return this.prisma.jobExecution.create({ data });
  }

  async updateStatus(id: bigint, status: JobExecutionStatus, error?: string) {
    return this.prisma.jobExecution.update({
      where: { id },
      data: {
        status,
        last_error: error,
      },
    });
  }

  async updateStatusByBullJobId(
    bullJobId: string,
    queueName: string,
    status: JobExecutionStatus,
    error?: string,
  ) {
    const isFinished = status === "completed" || status === "failed";
    await this.prisma.jobExecution.updateMany({
      where: {
        bull_job_id: bullJobId,
        queue_name: queueName,
      },
      data: {
        status,
        last_error: error || null,
        ...(status === "completed" ? { progress: 100 } : {}),
        ...(isFinished ? { completed_at: new Date() } : {}),
      },
    });
  }

  async updateProgressByBullJobId(
    bullJobId: string,
    queueName: string,
    progress: number,
  ) {
    await this.prisma.jobExecution.updateMany({
      where: {
        bull_job_id: bullJobId,
        queue_name: queueName,
      },
      data: {
        progress,
      },
    });
  }

  async markStalledAsFailed(cutoff: Date, reason: string): Promise<number> {
    const res = await this.prisma.jobExecution.updateMany({
      where: {
        status: { in: ["active", "queued"] },
        created_at: { lt: cutoff },
      },
      data: {
        status: "failed",
        last_error: reason,
        completed_at: new Date(),
      },
    });
    return res.count;
  }
}
