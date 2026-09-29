import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { EncryptionService } from "../../common/encryption/encryption.service";
import { CreateServerDto, UpdateServerDto } from "./dto/server.dto";

@Injectable()
export class ServersRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly enc: EncryptionService,
  ) {}

  private encryptServer(data: Partial<CreateServerDto>) {
    const out: Record<string, unknown> = { ...data };
    if (data.ssh_private_key)
      out["ssh_private_key_encrypted"] = this.enc.encrypt(data.ssh_private_key);
    delete out["ssh_private_key"];
    if (data.ssh_user) out["ssh_user"] = data.ssh_user;
    return out;
  }

  async findAll(opts: { page?: number; limit?: number; search?: string } = {}) {
    const page = Math.max(1, opts.page ?? 1);
    const limit = Math.min(100, Math.max(1, opts.limit ?? 50));
    const search = opts.search?.trim();

    const where = search
      ? {
          OR: [
            { name: { contains: search, mode: "insensitive" as const } },
            { ip_address: { contains: search, mode: "insensitive" as const } },
            { provider: { contains: search, mode: "insensitive" as const } },
          ],
        }
      : undefined;

    const [items, total] = await Promise.all([
      this.prisma.server.findMany({
        where,
        orderBy: { name: "asc" },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          name: true,
          ip_address: true,
          ssh_port: true,
          ssh_user: true,
          provider: true,
          status: true,
          cyberpanel_version: true,
          host_key_fingerprint: true,
          created_at: true,
          updated_at: true,
        },
      }),
      this.prisma.server.count({ where }),
    ]);

    return { items, total, page, limit };
  }

  findById(id: bigint) {
    return this.prisma.server.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        ip_address: true,
        ssh_port: true,
        ssh_user: true,
        provider: true,
        status: true,
        cyberpanel_version: true,
        host_key_fingerprint: true,
        created_at: true,
        updated_at: true,
        environments: {
          orderBy: [{ project: { name: "asc" } }, { type: "asc" }],
          select: {
            id: true,
            type: true,
            url: true,
            root_path: true,
            google_drive_folder_id: true,
            project: {
              select: {
                id: true,
                name: true,
                client: { select: { id: true, name: true } },
              },
            },
          },
        },
        _count: { select: { environments: true } },
      },
    });
  }

  findByIdWithKey(id: bigint) {
    return this.prisma.server.findUnique({ where: { id } });
  }

  create(dto: CreateServerDto) {
    const data = this.encryptServer(dto);
    return this.prisma.server.create({ data: data as never });
  }

  update(id: bigint, dto: UpdateServerDto) {
    const data = this.encryptServer(dto);
    return this.prisma.server.update({ where: { id }, data: data as never });
  }

  delete(id: bigint) {
    return this.prisma.server.delete({ where: { id } });
  }

  updateStatus(id: bigint, status: "online" | "offline") {
    return this.prisma.server.update({
      where: { id },
      data: { status },
    });
  }

  updateCyberPanelVersion(id: bigint, version: string | null) {
    return this.prisma.server.update({
      where: { id },
      data: { cyberpanel_version: version },
    });
  }

  /**
   * For a given server, return which root_paths already have an Environment record.
   * Used to mark projects as already-imported during scan.
   */
  async findExistingEnvironmentPaths(
    serverId: bigint,
    paths: string[],
  ): Promise<{ root_path: string; project_id: bigint }[]> {
    if (paths.length === 0) return [];
    return this.prisma.environment.findMany({
      where: {
        server_id: serverId,
        root_path: { in: paths },
      },
      select: { root_path: true, project_id: true },
    });
  }

  countEnvironments(serverId: bigint) {
    return this.prisma.environment.count({
      where: { server_id: serverId },
    });
  }

  updateHostKeyFingerprint(id: bigint, fingerprint: string) {
    return this.prisma.server.update({
      where: { id },
      data: { host_key_fingerprint: fingerprint },
    });
  }

  async recordMetric(
    serverId: bigint,
    data: {
      cpu_usage?: number | null;
      memory_used_mb?: number | null;
      memory_total_mb?: number | null;
      disk_used_gb?: number | null;
      disk_total_gb?: number | null;
      uptime_seconds?: number | null;
      load_1m?: number | null;
      load_5m?: number | null;
      load_15m?: number | null;
      ping_ms?: number | null;
    },
  ) {
    return this.prisma.serverMetric.create({
      data: {
        server_id: serverId,
        cpu_usage: data.cpu_usage,
        memory_used_mb: data.memory_used_mb,
        memory_total_mb: data.memory_total_mb,
        disk_used_gb: data.disk_used_gb,
        disk_total_gb: data.disk_total_gb,
        uptime_seconds: data.uptime_seconds,
        load_1m: data.load_1m,
        load_5m: data.load_5m,
        load_15m: data.load_15m,
        ping_ms: data.ping_ms,
      },
    });
  }

  async getMetricsHistory(serverId: bigint, since: Date) {
    return this.prisma.serverMetric.findMany({
      where: {
        server_id: serverId,
        recorded_at: { gte: since },
      },
      orderBy: { recorded_at: "asc" },
      take: 200,
    });
  }

  async getLatestMetric(serverId: bigint) {
    return this.prisma.serverMetric.findFirst({
      where: { server_id: serverId },
      orderBy: { recorded_at: "desc" },
    });
  }
}
