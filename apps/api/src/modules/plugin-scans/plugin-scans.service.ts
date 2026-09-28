import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { PluginScansRepository } from "./plugin-scans.repository";
import { QUEUES, JOB_TYPES, PaginationQuery } from "@bedrock-forge/shared";
import { GithubService } from "../custom-plugins/github.service";
import { JobOrchestratorService } from "../job-executions/job-orchestrator.service";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

@Injectable()
export class PluginScansService {
  constructor(
    private readonly repo: PluginScansRepository,
    private readonly jobOrchestrator: JobOrchestratorService,
    @InjectQueue(QUEUES.PLUGIN_SCANS) private readonly queue: Queue,
    @InjectQueue(QUEUES.CUSTOM_PLUGINS)
    private readonly customQueue: Queue,
    private readonly github: GithubService,
  ) {}

  findByEnvironment(envId: number, query: PaginationQuery) {
    return this.repo.findByEnvironment(BigInt(envId), query);
  }

  getInventory() {
    return this.repo.getInventory();
  }

  async enqueueScan(environmentId: number) {
    const result = await this.jobOrchestrator.enqueue({
      queue: this.queue,
      queueName: QUEUES.PLUGIN_SCANS,
      jobType: JOB_TYPES.PLUGIN_SCAN_RUN,
      payload: { environmentId },
      environmentId,
    });
    return {
      jobExecutionId: result.jobExecutionId,
      bullJobId: result.bullJobId,
    };
  }

  async enqueueBulkScan() {
    const environments = await this.repo.findAllEnvironmentIds();
    const queued = [];
    for (const environment of environments) {
      queued.push(await this.enqueueScan(Number(environment.id)));
    }
    return {
      count: queued.length,
      jobs: queued,
    };
  }

  async enqueuePluginManage(
    environmentId: number,
    action:
      | "add"
      | "remove"
      | "update"
      | "update-all"
      | "activate"
      | "deactivate"
      | "delete"
      | "migrate-to-composer",
    slug?: string,
    version?: string,
    skipSafetyBackup?: boolean,
    workflow?: "composer" | "manual",
  ) {
    const result = await this.jobOrchestrator.enqueue({
      queue: this.queue,
      queueName: QUEUES.PLUGIN_SCANS,
      jobType: JOB_TYPES.PLUGIN_MANAGE,
      payload: {
        environmentId,
        action,
        slug,
        version,
        workflow,
        skipSafetyBackup: skipSafetyBackup ?? true,
      },
      environmentId,
    });
    return {
      jobExecutionId: result.jobExecutionId,
      bullJobId: result.bullJobId,
    };
  }

  async searchWpOrg(query: string) {
    if (!query || !query.trim()) {
      return [];
    }
    try {
      const res = await fetch(
        `https://api.wordpress.org/plugins/info/1.2/?action=query_plugins&request[search]=${encodeURIComponent(query)}&request[per_page]=15`,
      );
      if (!res.ok) {
        throw new Error(`WordPress.org API returned status ${res.status}`);
      }
      const data: unknown = await res.json();
      const plugins = isRecord(data) && Array.isArray(data.plugins)
        ? (data.plugins as unknown[])
        : [];
      return plugins.filter(isRecord).map((plugin) => ({
        name: typeof plugin.name === "string" ? plugin.name : "",
        slug: typeof plugin.slug === "string" ? plugin.slug : "",
        version: typeof plugin.version === "string" ? plugin.version : "",
        author:
          typeof plugin.author === "string"
            ? plugin.author.replace(/<[^>]*>/g, "")
            : "",
        short_description:
          typeof plugin.short_description === "string"
            ? plugin.short_description
            : "",
        homepage: typeof plugin.homepage === "string" ? plugin.homepage : "",
      }));
    } catch (err) {
      return [];
    }
  }

  async enqueueConstraintChange(
    environmentId: number,
    slug: string,
    constraint: string,
  ) {
    const result = await this.jobOrchestrator.enqueue({
      queue: this.queue,
      queueName: QUEUES.PLUGIN_SCANS,
      jobType: JOB_TYPES.PLUGIN_MANAGE,
      payload: {
        environmentId,
        action: "change-constraint",
        slug,
        constraint,
      },
      environmentId,
    });
    return {
      jobExecutionId: result.jobExecutionId,
      bullJobId: result.bullJobId,
    };
  }

  async enqueueComposerRead(environmentId: number) {
    const result = await this.jobOrchestrator.enqueue({
      queue: this.queue,
      queueName: QUEUES.PLUGIN_SCANS,
      jobType: JOB_TYPES.PLUGIN_MANAGE,
      payload: { environmentId, action: "read" },
      environmentId,
    });
    return {
      jobExecutionId: result.jobExecutionId,
      bullJobId: result.bullJobId,
    };
  }

  async findExecution(execId: number) {
    return this.repo.findJobExecution(BigInt(execId));
  }

  // ─── Custom GitHub plugin methods ────────────────────────────────────────

  listEnvironmentCustomPlugins(envId: number) {
    return this.repo.listEnvironmentCustomPlugins(BigInt(envId));
  }

  async enqueueCustomPluginManage(
    environmentId: number,
    customPluginId: number,
    action: "add" | "remove" | "update",
  ) {
    const plugin = await this.repo.findCustomPlugin(BigInt(customPluginId));
    if (!plugin) {
      throw new NotFoundException(`Custom plugin ${customPluginId} not found`);
    }

    const result = await this.jobOrchestrator.enqueue({
      queue: this.customQueue,
      queueName: QUEUES.CUSTOM_PLUGINS,
      jobType: JOB_TYPES.CUSTOM_PLUGIN_MANAGE,
      payload: {
        environmentId,
        action,
        customPluginId,
        slug: plugin.slug,
        repoUrl: plugin.repo_url,
        repoPath: plugin.repo_path,
        type: plugin.type,
      },
      environmentId,
    });

    return {
      jobExecutionId: result.jobExecutionId,
      bullJobId: result.bullJobId,
    };
  }

  async checkCustomPluginVersions(envId: number) {
    const installed = await this.repo.listEnvironmentCustomPlugins(
      BigInt(envId),
    );

    const results = await Promise.all(
      installed.map(async (entry) => {
        const latestVersion = await this.github.getLatestTag(
          entry.custom_plugin.repo_url,
          entry.custom_plugin.repo_path,
          entry.custom_plugin.type,
          entry.custom_plugin.slug,
        );
        if (latestVersion !== null) {
          await this.repo.updateEnvironmentCustomPlugin(
            entry.environment_id,
            entry.custom_plugin_id,
            { latest_version: latestVersion, version_checked_at: new Date() },
          );
        }
        return {
          slug: entry.custom_plugin.slug,
          installed_version: entry.installed_version,
          latest_version: latestVersion ?? entry.latest_version,
        };
      }),
    );

    return results;
  }
}
