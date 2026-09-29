import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { Prisma, JobExecutionStatus } from "@prisma/client";

export interface JobExecutionFilter {
  job_id?: number;
  search?: string;
  queue_name?: string;
  job_type?: string;
  status?: JobExecutionStatus;
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
  job_type: string | null;
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

export interface StalledExecutionCandidate {
  id: bigint;
  queue_name: string;
  bull_job_id: string | null;
  status: string;
  created_at: Date;
}

@Injectable()
export class JobExecutionsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findPaginated(
    filter: JobExecutionFilter,
    page: number,
    limit: number,
  ): Promise<JobExecutionPage> {
    const where: Prisma.JobExecutionWhereInput = {};
    if (filter.job_id) where.id = BigInt(filter.job_id);

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

    const search = filter.search?.trim();
    if (search) {
      const contains = { contains: search, mode: "insensitive" as const };
      const searchPredicates: Prisma.JobExecutionWhereInput[] = [
        { queue_name: contains },
        { job_type: contains },
        { bull_job_id: contains },
        { last_error: contains },
        { environment: { is: { type: contains } } },
        { environment: { is: { url: contains } } },
        {
          environment: {
            is: {
              project: {
                is: {
                  name: contains,
                },
              },
            },
          },
        },
        {
          environment: {
            is: {
              project: {
                is: {
                  client: {
                    is: {
                      name: contains,
                    },
                  },
                },
              },
            },
          },
        },
      ];
      if (/^\d+$/.test(search)) {
        const maxBigIntId = "9223372036854775807";
        if (
          search.length < maxBigIntId.length ||
          (search.length === maxBigIntId.length && search <= maxBigIntId)
        ) {
          searchPredicates.push({ id: BigInt(search) });
        }
      }
      where.OR = searchPredicates;
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
          job_type: true,
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
        return monitor?.environment_id
          ? Number(monitor.environment_id)
          : undefined;
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
    payload: Prisma.InputJsonValue;
  }) {
    return this.prisma.jobExecution.create({ data });
  }

  async updateStatus(id: bigint, status: JobExecutionStatus, error?: string) {
    const isFinished =
      status === "completed" ||
      status === "failed" ||
      status === "dead_letter" ||
      status === "discarded";
    return this.prisma.jobExecution.update({
      where: { id },
      data: {
        status,
        last_error: error,
        ...(isFinished ? { completed_at: new Date() } : {}),
      },
    });
  }

  async updateStatusByBullJobId(
    bullJobId: string,
    queueName: string,
    status: JobExecutionStatus,
    error?: string,
  ) {
    const isFinished =
      status === "completed" ||
      status === "failed" ||
      status === "dead_letter" ||
      status === "discarded";
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

  async findStalledCandidates(
    cutoff: Date,
    queueName?: string,
  ): Promise<StalledExecutionCandidate[]> {
    return this.prisma.jobExecution.findMany({
      where: {
        status: { in: ["active", "queued"] },
        created_at: { lt: cutoff },
        ...(queueName ? { queue_name: queueName } : {}),
      },
      orderBy: { created_at: "asc" },
      take: 250,
      select: {
        id: true,
        queue_name: true,
        bull_job_id: true,
        status: true,
        created_at: true,
      },
    });
  }

  async countStalledCandidates(
    cutoff: Date,
    queueName?: string,
  ): Promise<number> {
    return this.prisma.jobExecution.count({
      where: {
        status: { in: ["active", "queued"] },
        created_at: { lt: cutoff },
        ...(queueName ? { queue_name: queueName } : {}),
      },
    });
  }

  async reconcileStalledCandidate(
    id: bigint,
    cutoff: Date,
    status: "completed" | "failed",
    reason?: string,
  ): Promise<number> {
    const result = await this.prisma.jobExecution.updateMany({
      where: {
        id,
        status: { in: ["active", "queued"] },
        created_at: { lt: cutoff },
      },
      data: {
        status,
        last_error:
          status === "failed" ? (reason ?? "Queue job is missing") : null,
        ...(status === "completed" ? { progress: 100 } : {}),
        completed_at: new Date(),
      },
    });
    return result.count;
  }
}
