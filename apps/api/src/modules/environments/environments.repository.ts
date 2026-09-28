import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { EncryptionService } from "../../common/encryption/encryption.service";
import {
  CreateEnvironmentDto,
  UpdateEnvironmentDto,
  UpsertDbCredentialsDto,
} from "./dto/environment.dto";

@Injectable()
export class EnvironmentsRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly enc: EncryptionService,
  ) {}

  /** Check whether an environment row exists without fetching full data. */
  existsById(id: bigint): Promise<boolean> {
    return this.prisma.environment
      .findUnique({ where: { id }, select: { id: true } })
      .then((r) => r !== null);
  }

  /**
   * Check whether an environment is visible to a specific user.
   *
   * Staff roles (admin, manager, maintainer) can see environments.
   * Client-role users cannot access environments, projects, or servers.
   */
  async existsByIdForUser(
    envId: bigint,
    userId: bigint,
    roles: string[],
  ): Promise<boolean> {
    const isStaff =
      roles.includes("admin") ||
      roles.includes("manager") ||
      roles.includes("maintainer");

    if (!isStaff) {
      return false;
    }

    return this.existsById(envId);
  }

  findAll() {
    return this.prisma.environment.findMany({
      include: {
        project: { select: { id: true, name: true } },
        server: {
          select: { id: true, name: true, ip_address: true, status: true },
        },
      },
      orderBy: { created_at: "desc" },
    });
  }

  findByProject(projectId: bigint) {
    return this.prisma.environment.findMany({
      where: { project_id: projectId },
      include: {
        project: { select: { id: true, name: true } },
        server: {
          select: { id: true, name: true, ip_address: true, status: true },
        },
        job_executions: {
          where: { job_type: "project:create-bedrock" },
          orderBy: { created_at: "desc" },
          take: 1,
          select: {
            id: true,
            status: true,
            progress: true,
            last_error: true,
          },
        },
        environment_tags: { include: { tag: true } },
      },
      orderBy: { created_at: "asc" },
    });
  }

  findById(id: bigint) {
    return this.prisma.environment.findUnique({
      where: { id },
      include: {
        server: {
          select: { id: true, name: true, ip_address: true, status: true },
        },
      },
    });
  }

  create(projectId: bigint, dto: CreateEnvironmentDto) {
    return this.prisma.environment.create({
      data: {
        project_id: projectId,
        server_id: BigInt(dto.server_id),
        type: dto.type,
        url: dto.url,
        root_path: dto.root_path,
        backup_path: dto.backup_path ?? null,
        google_drive_folder_id: dto.google_drive_folder_id ?? null,
        protected_tables: dto.protected_tables ?? [],
        sql_protection_queries: dto.sql_protection_queries ?? [],
        protected_post_types: dto.protected_post_types ?? [],
      },
      include: {
        server: {
          select: { id: true, name: true, ip_address: true, status: true },
        },
      },
    });
  }

  update(id: bigint, dto: UpdateEnvironmentDto) {
    return this.prisma.environment.update({
      where: { id },
      data: {
        ...(dto.server_id !== undefined && {
          server_id: BigInt(dto.server_id),
        }),
        ...(dto.type !== undefined && { type: dto.type }),
        ...(dto.url !== undefined && { url: dto.url }),
        ...(dto.root_path !== undefined && { root_path: dto.root_path }),
        ...(dto.backup_path !== undefined && {
          backup_path: dto.backup_path,
        }),
        // Allow explicit null to clear the field
        ...(dto.google_drive_folder_id !== undefined && {
          google_drive_folder_id: dto.google_drive_folder_id || null,
        }),
        ...(dto.protected_tables !== undefined && {
          protected_tables: dto.protected_tables,
        }),
        ...(dto.sql_protection_queries !== undefined && {
          sql_protection_queries: dto.sql_protection_queries,
        }),
        ...(dto.protected_post_types !== undefined && {
          protected_post_types: dto.protected_post_types,
        }),
      },
      include: {
        server: {
          select: { id: true, name: true, ip_address: true, status: true },
        },
      },
    });
  }

  delete(id: bigint) {
    return this.prisma.environment.delete({ where: { id } });
  }

  /** Decrypt and return WP DB credentials for an environment, or null if none stored. */
  async getDbCredentials(envId: bigint): Promise<{
    dbName: string;
    dbUser: string;
    dbPassword: string;
    dbHost: string;
  } | null> {
    const row = await this.prisma.wpDbCredentials.findUnique({
      where: { environment_id: envId },
    });
    if (!row) return null;
    return {
      dbName: this.enc.decrypt(row.db_name_encrypted),
      dbUser: this.enc.decrypt(row.db_user_encrypted),
      dbPassword: this.enc.decrypt(row.db_password_encrypted),
      dbHost: this.enc.decrypt(row.db_host_encrypted),
    };
  }

  /** Encrypt and upsert WP DB credentials for an environment. */
  async upsertDbCredentials(envId: bigint, dto: UpsertDbCredentialsDto) {
    const data = {
      db_name_encrypted: this.enc.encrypt(dto.dbName),
      db_user_encrypted: this.enc.encrypt(dto.dbUser),
      db_password_encrypted: this.enc.encrypt(dto.dbPassword),
      db_host_encrypted: this.enc.encrypt(dto.dbHost),
    };
    await this.prisma.wpDbCredentials.upsert({
      where: { environment_id: envId },
      update: data,
      create: { environment_id: envId, ...data },
    });
    return {
      dbName: dto.dbName,
      dbUser: dto.dbUser,
      dbPassword: dto.dbPassword,
      dbHost: dto.dbHost,
    };
  }

  // ── Tags ──────────────────────────────────────────────────────────────────

  addTag(envId: bigint, tagId: bigint) {
    return this.prisma.environmentTag.create({
      data: { environment_id: envId, tag_id: tagId },
      include: { tag: true },
    });
  }

  removeTag(envId: bigint, tagId: bigint) {
    return this.prisma.environmentTag.delete({
      where: {
        environment_id_tag_id: { environment_id: envId, tag_id: tagId },
      },
    });
  }

  listTags(envId: bigint) {
    return this.prisma.environmentTag.findMany({
      where: { environment_id: envId },
      include: { tag: true },
    });
  }

  async findProjectWithHostingPackage(projectId: bigint) {
    return this.prisma.project.findUnique({
      where: { id: projectId },
      include: { hosting_package: true },
    });
  }

  async countEnvironmentsForProject(projectId: bigint): Promise<number> {
    return this.prisma.environment.count({
      where: { project_id: projectId },
    });
  }

  async createEnvironment(data: Prisma.EnvironmentUncheckedCreateInput) {
    return this.prisma.environment.create({
      data,
      include: {
        server: { select: { id: true, name: true, ip_address: true, status: true } },
      },
    });
  }

  async createJobExecution(data: Prisma.JobExecutionUncheckedCreateInput) {
    return this.prisma.jobExecution.create({ data });
  }

  async updateJobExecution(
    id: bigint,
    data: Prisma.JobExecutionUncheckedUpdateInput,
  ) {
    return this.prisma.jobExecution.update({
      where: { id },
      data,
    });
  }

  async getSchedulesForEnvironment(envId: bigint) {
    const [backupSchedules, pluginUpdateSchedules, monitors] = await Promise.all([
      this.prisma.backupSchedule.findMany({ where: { environment_id: envId } }),
      this.prisma.pluginUpdateSchedule.findMany({ where: { environment_id: envId } }),
      this.prisma.monitor.findMany({ where: { environment_id: envId } }),
    ]);
    return { backupSchedules, pluginUpdateSchedules, monitors };
  }

  async disableEnvironmentSchedules(envId: bigint) {
    return this.prisma.$transaction([
      this.prisma.monitor.updateMany({
        where: { environment_id: envId },
        data: { enabled: false },
      }),
      this.prisma.backupSchedule.updateMany({
        where: { environment_id: envId },
        data: { enabled: false },
      }),
      this.prisma.pluginUpdateSchedule.updateMany({
        where: { environment_id: envId },
        data: { enabled: false },
      }),
      this.prisma.cleanupSchedule.updateMany({
        where: { environment_id: envId },
        data: { enabled: false },
      }),
      this.prisma.securityScanSchedule.updateMany({
        where: { environment_id: envId },
        data: { enabled: false },
      }),
    ]);
  }

  async updateGitDeployment(
    envId: bigint,
    data: {
      git_current_commit?: string;
      git_last_deployed_at?: Date;
      git_remote_url?: string;
      git_branch?: string;
      deploy_webhook_token?: string;
    },
  ) {
    return this.prisma.environment.update({
      where: { id: envId },
      data,
    });
  }
}
