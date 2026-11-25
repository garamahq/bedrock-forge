import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";

@Injectable()
export class MaintenanceWindowsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(filters: {
    resource_type?: string;
    resource_id?: number;
    page: number;
    limit: number;
  }) {
    const where: Prisma.MaintenanceWindowWhereInput = {};

    if (filters.resource_type) {
      where.resource_type = filters.resource_type;
    }
    if (filters.resource_id) {
      where.resource_id = BigInt(filters.resource_id);
    }

    const [data, total] = await Promise.all([
      this.prisma.maintenanceWindow.findMany({
        where,
        orderBy: { starts_at: "desc" },
        skip: (filters.page - 1) * filters.limit,
        take: filters.limit,
        include: {
          server: { select: { id: true, name: true } },
          environment: { select: { id: true, type: true, url: true } },
          created_by: { select: { id: true, name: true, email: true } },
        },
      }),
      this.prisma.maintenanceWindow.count({ where }),
    ]);

    return { data, total };
  }

  findById(id: number) {
    return this.prisma.maintenanceWindow.findUnique({
      where: { id: BigInt(id) },
      include: {
        server: { select: { id: true, name: true } },
        environment: { select: { id: true, type: true, url: true } },
        created_by: { select: { id: true, name: true, email: true } },
      },
    });
  }

  create(data: {
    resource_type: "server" | "environment" | "project";
    resource_id: number;
    reason?: string;
    starts_at: Date;
    ends_at: Date;
    created_by_id?: number;
  }) {
    const server_id = data.resource_type === "server" ? BigInt(data.resource_id) : undefined;
    const environment_id = data.resource_type === "environment" ? BigInt(data.resource_id) : undefined;

    return this.prisma.maintenanceWindow.create({
      data: {
        resource_type: data.resource_type,
        resource_id: BigInt(data.resource_id),
        server_id,
        environment_id,
        reason: data.reason,
        starts_at: data.starts_at,
        ends_at: data.ends_at,
        created_by_id: data.created_by_id ? BigInt(data.created_by_id) : undefined,
      },
      include: {
        server: { select: { id: true, name: true } },
        environment: { select: { id: true, type: true, url: true } },
        created_by: { select: { id: true, name: true, email: true } },
      },
    });
  }

  delete(id: number) {
    return this.prisma.maintenanceWindow.delete({
      where: { id: BigInt(id) },
    });
  }

  async isServerUnderMaintenance(serverId: number, at: Date = new Date()): Promise<boolean> {
    const count = await this.prisma.maintenanceWindow.count({
      where: {
        resource_type: "server",
        resource_id: BigInt(serverId),
        starts_at: { lte: at },
        ends_at: { gte: at },
      },
    });
    return count > 0;
  }

  async isEnvironmentUnderMaintenance(
    environmentId: number,
    at: Date = new Date(),
  ): Promise<boolean> {
    // An environment is under maintenance if there is an active window
    // targeting this environment directly, its parent server, or its parent project (#100).
    const envWindowCount = await this.prisma.maintenanceWindow.count({
      where: {
        resource_type: "environment",
        resource_id: BigInt(environmentId),
        starts_at: { lte: at },
        ends_at: { gte: at },
      },
    });
    if (envWindowCount > 0) return true;

    const env = await this.prisma.environment.findUnique({
      where: { id: BigInt(environmentId) },
      select: { server_id: true, project_id: true },
    });
    if (!env) return false;

    const parentFilters: Prisma.MaintenanceWindowWhereInput[] = [];
    if (env.server_id !== null && env.server_id !== undefined) {
      parentFilters.push({
        resource_type: "server",
        resource_id: env.server_id,
      });
    }
    if (env.project_id !== null && env.project_id !== undefined) {
      parentFilters.push({
        resource_type: "project",
        resource_id: env.project_id,
      });
    }
    if (parentFilters.length === 0) return false;

    const parentCount = await this.prisma.maintenanceWindow.count({
      where: {
        OR: parentFilters,
        starts_at: { lte: at },
        ends_at: { gte: at },
      },
    });
    return parentCount > 0;
  }
}
