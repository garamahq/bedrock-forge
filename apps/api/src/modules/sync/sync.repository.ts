import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { QUEUES } from "@bedrock-forge/shared";

@Injectable()
export class SyncRepository {
  constructor(private readonly prisma: PrismaService) {}

  findEnvironmentById(id: number) {
    return this.prisma.environment.findUniqueOrThrow({
      where: { id: BigInt(id) },
      select: {
        id: true,
        type: true,
        url: true,
        root_path: true,
        google_drive_folder_id: true,
        server: {
          select: {
            id: true,
            name: true,
            ip_address: true,
            ssh_port: true,
            ssh_user: true,
          },
        },
        project: { select: { id: true, name: true } },
      },
    });
  }

  hasActiveJob(envId: bigint): Promise<boolean> {
    return this.prisma.jobExecution
      .findFirst({
        where: {
          environment_id: envId,
          queue_name: { in: [QUEUES.SYNC, QUEUES.BACKUPS] },
          status: { in: ["queued", "active"] },
        },
        select: { id: true },
      })
      .then((r) => r !== null);
  }

  createJobExecution(data: {
    queue_name: string;
    job_type?: string;
    bull_job_id: string;
    environment_id: bigint;
  }) {
    return this.prisma.jobExecution.create({ data });
  }

  findJobExecutionById(id: bigint) {
    return this.prisma.jobExecution.findUnique({ where: { id } });
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
}

