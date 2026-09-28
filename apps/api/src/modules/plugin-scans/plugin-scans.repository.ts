import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import {
  PluginInfoSchema,
  PluginScanOutputSchema,
  type PaginationQuery,
  type PluginInfo,
} from "@bedrock-forge/shared";

function parseStoredPlugins(value: unknown): PluginInfo[] | null {
  const output = PluginScanOutputSchema.safeParse(value);
  if (output.success) return output.data.plugins;
  const legacy = PluginInfoSchema.array().safeParse(value);
  return legacy.success ? legacy.data : null;
}

@Injectable()
export class PluginScansRepository {
  constructor(private readonly prisma: PrismaService) {}

  findByEnvironment(envId: bigint, query: PaginationQuery) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    return this.prisma
      .$transaction([
        this.prisma.pluginScan.findMany({
          where: { environment_id: envId },
          skip: (page - 1) * limit,
          take: limit,
          orderBy: { scanned_at: "desc" },
        }),
        this.prisma.pluginScan.count({ where: { environment_id: envId } }),
      ])
      .then(([items, total]) => ({ items, total, page, limit }));
  }

  findAllEnvironmentIds() {
    return this.prisma.environment.findMany({
      select: { id: true },
      orderBy: { created_at: "asc" },
    });
  }

  async getInventory() {
    const environments = await this.prisma.environment.findMany({
      include: {
        project: {
          select: {
            id: true,
            name: true,
            client: { select: { id: true, name: true } },
          },
        },
        server: { select: { id: true, name: true, ip_address: true } },
        plugin_scans: {
          orderBy: { scanned_at: "desc" },
          take: 1,
        },
      },
      orderBy: { created_at: "desc" },
    });

    const items: Array<Record<string, unknown>> = [];
    let environmentsScanned = 0;

    for (const environment of environments) {
      const latestScan = environment.plugin_scans[0];
      if (!latestScan) continue;
      environmentsScanned += 1;

      const plugins = parseStoredPlugins(latestScan.plugins);
      if (!plugins) continue;

      for (const plugin of plugins) {
        const version = plugin.version ? String(plugin.version) : null;
        const latestVersion =
          plugin.latest_version != null ? String(plugin.latest_version) : null;
        items.push({
          environment: {
            id: Number(environment.id),
            type: environment.type,
            url: environment.url,
          },
          project: {
            id: Number(environment.project.id),
            name: environment.project.name,
          },
          client: {
            id: Number(environment.project.client.id),
            name: environment.project.client.name,
          },
          server: {
            id: Number(environment.server.id),
            name: environment.server.name,
            ip_address: environment.server.ip_address,
          },
          scan_id: Number(latestScan.id),
          scanned_at: latestScan.scanned_at,
          slug: plugin.slug ?? "",
          name: plugin.name ?? plugin.slug ?? "",
          version,
          status: plugin.status ?? null,
          author: plugin.author ?? null,
          latest_version: latestVersion,
          update_available:
            plugin.update_available === true ||
            (!!version && !!latestVersion && version !== latestVersion),
          source: plugin.managed_by_monorepo
            ? "github"
            : plugin.managed_by_composer
              ? "composer"
              : "manual",
          composer_constraint: plugin.composer_constraint ?? null,
        });
      }
    }

    return {
      items,
      total: items.length,
      environments_scanned: environmentsScanned,
    };
  }

  createJobExecution(data: {
    environment_id: bigint;
    queue_name: string;
    job_type?: string;
    bull_job_id: string;
  }) {
    return this.prisma.jobExecution.create({ data });
  }

  findJobExecution(execId: bigint) {
    return this.prisma.jobExecution.findUnique({
      where: { id: execId },
      select: {
        id: true,
        status: true,
        progress: true,
        execution_log: true,
        started_at: true,
        completed_at: true,
        created_at: true,
        last_error: true,
      },
    });
  }

  // ─── EnvironmentCustomPlugin CRUD ─────────────────────────────────────────

  listEnvironmentCustomPlugins(envId: bigint) {
    return this.prisma.environmentCustomPlugin.findMany({
      where: { environment_id: envId },
      include: { custom_plugin: true },
      orderBy: { created_at: "asc" },
    });
  }

  findCustomPlugin(id: bigint) {
    return this.prisma.customPlugin.findUnique({ where: { id } });
  }

  upsertEnvironmentCustomPlugin(
    environmentId: bigint,
    customPluginId: bigint,
    data: {
      installed_version?: string | null;
      latest_version?: string | null;
      version_checked_at?: Date | null;
    },
  ) {
    return this.prisma.environmentCustomPlugin.upsert({
      where: {
        environment_id_custom_plugin_id: {
          environment_id: environmentId,
          custom_plugin_id: customPluginId,
        },
      },
      update: data,
      create: {
        environment_id: environmentId,
        custom_plugin_id: customPluginId,
        ...data,
      },
    });
  }

  updateEnvironmentCustomPlugin(
    environmentId: bigint,
    customPluginId: bigint,
    data: {
      installed_version?: string | null;
      latest_version?: string | null;
      version_checked_at?: Date | null;
    },
  ) {
    return this.prisma.environmentCustomPlugin.update({
      where: {
        environment_id_custom_plugin_id: {
          environment_id: environmentId,
          custom_plugin_id: customPluginId,
        },
      },
      data,
    });
  }

  deleteEnvironmentCustomPlugin(environmentId: bigint, customPluginId: bigint) {
    return this.prisma.environmentCustomPlugin.delete({
      where: {
        environment_id_custom_plugin_id: {
          environment_id: environmentId,
          custom_plugin_id: customPluginId,
        },
      },
    });
  }
}
