import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";

const LIGHTHOUSE_AUDIT_INCLUDE = {
  environment: {
    select: {
      id: true,
      type: true,
      url: true,
      project: { select: { id: true, name: true } },
    },
  },
} as const;

type LighthouseAuditWithEnvironment = Prisma.LighthouseAuditGetPayload<{
  include: typeof LIGHTHOUSE_AUDIT_INCLUDE;
}>;

@Injectable()
export class LighthouseRepository {
  constructor(private readonly prisma: PrismaService) {}

  findEnvironment(id: bigint) {
    return this.prisma.environment.findUnique({
      where: { id },
      include: {
        project: { select: { id: true, name: true } },
        monitors: { select: { id: true }, take: 1 },
      },
    });
  }

  async findLatest() {
    const rows = await this.prisma.lighthouseAudit.findMany({
      orderBy: { created_at: "desc" },
      distinct: ["environment_id", "strategy"],
      include: LIGHTHOUSE_AUDIT_INCLUDE,
    });
    return rows.map((row) => this.serializeAudit(row));
  }

  async findHistory(environmentId?: number, page = 1, limit = 10) {
    const where = environmentId ? { environment_id: BigInt(environmentId) } : {};
    const total = await this.prisma.lighthouseAudit.count({ where });
    const skip = (page - 1) * limit;
    const rows = await this.prisma.lighthouseAudit.findMany({
      where,
      orderBy: { created_at: "desc" },
      skip,
      take: limit,
      include: LIGHTHOUSE_AUDIT_INCLUDE,
    });
    return {
      items: rows.map((row) => this.serializeAudit(row)),
      total,
    };
  }

  async findById(id: bigint) {
    const row = await this.prisma.lighthouseAudit.findUnique({
      where: { id },
      include: LIGHTHOUSE_AUDIT_INCLUDE,
    });
    return row ? this.serializeAudit(row) : null;
  }

  async findRunning(environmentId: bigint, strategy: "mobile" | "desktop") {
    const row = await this.prisma.lighthouseAudit.findFirst({
      where: {
        environment_id: environmentId,
        strategy,
        status: { in: ["queued", "running"] },
      },
      orderBy: { created_at: "desc" },
      include: LIGHTHOUSE_AUDIT_INCLUDE,
    });
    return row ? this.serializeAudit(row) : null;
  }

  createJobExecution(data: {
    queue_name: string;
    job_type: string;
    environment_id: bigint;
    status: "queued";
    payload: Prisma.InputJsonValue;
  }) {
    return this.prisma.jobExecution.create({
      data: { ...data, bull_job_id: "" },
    });
  }

  updateJobExecutionBullId(id: bigint, bullJobId: string) {
    return this.prisma.jobExecution.update({
      where: { id },
      data: { bull_job_id: bullJobId },
    });
  }

  createAudit(data: {
    environment_id: bigint;
    monitor_id?: bigint | null;
    job_execution_id: bigint;
    url: string;
    strategy: "mobile" | "desktop";
  }) {
    return this.prisma.lighthouseAudit.create({
      data: {
        environment_id: data.environment_id,
        monitor_id: data.monitor_id ?? null,
        job_execution_id: data.job_execution_id,
        url: data.url,
        strategy: data.strategy,
        status: "queued",
      },
    });
  }

  private serializeAudit(row: LighthouseAuditWithEnvironment) {
    return {
      ...row,
      id: Number(row.id),
      environment_id: Number(row.environment_id),
      monitor_id: row.monitor_id === null ? null : Number(row.monitor_id),
      job_execution_id:
        row.job_execution_id === null ? null : Number(row.job_execution_id),
      cls: row.cls === null ? null : Number(row.cls),
      environment: row.environment
        ? {
            ...row.environment,
            id: Number(row.environment.id),
            project: row.environment.project
              ? {
                  ...row.environment.project,
                  id: Number(row.environment.project.id),
                }
              : null,
          }
        : null,
    };
  }
}
