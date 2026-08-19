import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { Job } from "bullmq";
import { join } from "path";
import { PrismaService } from "../../prisma/prisma.service";
import { SshKeyService } from "../../services/ssh-key.service";
import { StepTracker } from "../../services/step-tracker";
import { createRemoteExecutor } from "@bedrock-forge/remote-executor";
import { QUEUES, JOB_TYPES, DEFAULT_JOB_OPTIONS } from "@bedrock-forge/shared";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "crypto";
import {
  shellQuote,
  pushRemoteScript,
  WpCliBuilder,
} from "../../utils/processor-utils";

export function parseWpVersion(stdout: string): string {
  // Strip ANSI color escape codes
  const cleaned = stdout.replace(/\x1b\[[0-9;]*m/g, "").trim();
  const versionLines = cleaned.split("\n").map((l) => l.trim()).filter(Boolean);

  // Check for $wp_version = '6.5.2'; format from version.php
  for (const line of versionLines) {
    const phpMatch = line.match(/\$wp_version\s*=\s*['"]([^'"]+)['"]/);
    if (phpMatch) return phpMatch[1].trim();
  }

  // Check for clean semantic version lines
  const matched = versionLines.find((l) =>
    /^\d+\.\d+(?:\.\d+)?(?:-[a-zA-Z0-9.-]+)?$/.test(l),
  );
  if (matched) return matched;

  // Search inside lines for semver pattern (e.g. "WordPress 6.4.3 is installed" or composer version)
  for (const line of versionLines) {
    const semverMatch = line.match(/\b(\d+\.\d+(?:\.\d+)?(?:-[a-zA-Z0-9.-]+)?)\b/);
    if (semverMatch && !line.toLowerCase().includes("php") && !line.toLowerCase().includes("mysql")) {
      return semverMatch[1];
    }
  }

  return versionLines[versionLines.length - 1] || "";
}

export function parseWpUpdatesJson(stdout: string): unknown[] {
  const stdoutTrimmed = stdout.trim();
  const jsonStartIndex = stdoutTrimmed.indexOf("[");
  const jsonEndIndex = stdoutTrimmed.lastIndexOf("]");
  if (
    jsonStartIndex !== -1 &&
    jsonEndIndex !== -1 &&
    jsonEndIndex > jsonStartIndex
  ) {
    const jsonContent = stdoutTrimmed.substring(
      jsonStartIndex,
      jsonEndIndex + 1,
    );
    return JSON.parse(jsonContent) as unknown[];
  }
  return JSON.parse(stdoutTrimmed) as unknown[];
}

export interface WpFixActionPayload {
  environmentId: number;
  jobExecutionId: number;
  action:
    | "flush_rewrite"
    | "clear_cache"
    | "fix_permissions"
    | "disable_plugins"
    | "enable_plugins";
}

export interface WpDebugTogglePayload {
  environmentId: number;
  jobExecutionId: number;
  enabled: boolean;
  revertAfterMinutes?: number;
}

export interface WpCleanupPayload {
  environmentId: number;
  jobExecutionId: number;
  dryRun?: boolean;
  keepRevisions?: number;
}

export interface WpLogsPayload {
  environmentId: number;
  jobExecutionId: number;
  type: "debug" | "php" | "nginx" | "apache";
  lines?: number;
}

export interface WpCronPayload {
  environmentId: number;
  jobExecutionId: number;
}

export interface WpCoreCheckPayload {
  environmentId: number;
  jobExecutionId: number;
}

export interface WpCoreUpdatePayload {
  environmentId: number;
  jobExecutionId: number;
}

export interface WpMaintenanceModePayload {
  environmentId: number;
  jobExecutionId: number;
  enabled: boolean;
  revertAfterMinutes?: number;
  message?: string;
}

@Processor(QUEUES.WP_ACTIONS, { concurrency: 2 })
export class WpActionsProcessor extends WorkerHost {
  private readonly logger = new Logger(WpActionsProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly sshKey: SshKeyService,
  ) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case JOB_TYPES.WP_FIX_ACTION:
        return this.processFixAction(job);
      case JOB_TYPES.WP_DEBUG_TOGGLE:
        return this.processDebugToggle(job);
      case JOB_TYPES.WP_DEBUG_REVERT:
        return this.processDebugRevert(job);
      case JOB_TYPES.WP_LOGS_FETCH:
        return this.processLogsFetch(job);
      case JOB_TYPES.WP_CRON_LIST:
        return this.processCronList(job);
      case JOB_TYPES.WP_CLEANUP:
        return this.processCleanup(job);
      case JOB_TYPES.WP_CORE_CHECK:
        return this.processCoreCheck(job);
      case JOB_TYPES.WP_CORE_UPDATE:
        return this.processCoreUpdate(job);
      case JOB_TYPES.WP_MAINTENANCE_MODE:
        return this.processMaintenanceMode(job);
      default:
        throw new Error(`Unknown wp-actions job type: ${job.name}`);
    }
  }

  private async processFixAction(job: Job): Promise<unknown> {
    const { environmentId, jobExecutionId, action } =
      job.data as WpFixActionPayload;
    const tracker = await StepTracker.start(
      this.prisma,
      jobExecutionId,
      this.logger,
      job,
    );
    try {
      await tracker.track({
        step: `WP action: ${action}`,
        level: "info",
        detail: `env=${environmentId}`,
      });
      const { executor, env } = await this.connectToEnv(environmentId, tracker);
      await job.updateProgress(20);
      const scriptsPath = this.config.get<string>("scriptsPath")!;
      const remoteScript = `/tmp/wp_actions_${job.id}.php`;
      await pushRemoteScript(
        executor,
        join(scriptsPath, "wp-actions.php"),
        remoteScript,
      );
      await job.updateProgress(40);
      const wpPath = await this.resolveWpPath(executor, env.root_path ?? "");
      const wpCli = await WpCliBuilder.create(executor, wpPath);
      const phpCmd = wpCli.lsphpBin ? shellQuote(wpCli.lsphpBin) : "php";
      const envPrefix = wpCli.lsphpBin
        ? `env WP_CLI_PHP=${shellQuote(wpCli.lsphpBin)}`
        : "";
      const cmd =
        [envPrefix, phpCmd, shellQuote(remoteScript)]
          .filter(Boolean)
          .join(" ") +
        ` --docroot=${shellQuote(env.root_path ?? "")} --wp-path=${shellQuote(wpPath)} --action=${shellQuote(action)}`;
      const t0 = Date.now();
      let result;
      try {
        result = await executor.execute(cmd, { timeout: 60_000 });
      } finally {
        await executor
          .execute(`rm -f ${shellQuote(remoteScript)}`, { timeout: 5_000 })
          .catch(() => {});
      }
      const parsed = safeJsonParse(result.stdout);
      await tracker.trackCommand(
        "wp-actions.php",
        cmd,
        result,
        Date.now() - t0,
      );
      if (result.code !== 0) {
        throw new Error(
          `wp-actions.php failed (exit ${result.code}): ${result.stderr || result.stdout}`,
        );
      }
      await job.updateProgress(100);
      await tracker.complete({ executionLog: parsed ?? {} });
      return parsed;
    } catch (err: unknown) {
      await tracker.fail(err, `wp:fix-action(${action})`);
      throw err;
    }
  }

  private async processDebugToggle(job: Job): Promise<unknown> {
    const { environmentId, jobExecutionId, enabled, revertAfterMinutes } =
      job.data as WpDebugTogglePayload;
    const tracker = await StepTracker.start(
      this.prisma,
      jobExecutionId,
      this.logger,
      job,
    );
    try {
      await tracker.track({
        step: `WP Debug: ${enabled ? "enable" : "disable"}`,
        level: "info",
      });
      const { executor, env } = await this.connectToEnv(environmentId, tracker);
      await job.updateProgress(20);
      const scriptsPath = this.config.get<string>("scriptsPath")!;
      const remoteScript = `/tmp/wp_debug_${job.id}.php`;
      await pushRemoteScript(
        executor,
        join(scriptsPath, "wp-debug.php"),
        remoteScript,
      );
      const actionArg = enabled ? "enable" : "disable";
      const cmd = `php ${shellQuote(remoteScript)} --docroot=${shellQuote(env.root_path ?? "")} --action=${actionArg}`;
      let result;
      try {
        result = await executor.execute(cmd, { timeout: 30_000 });
      } finally {
        await executor
          .execute(`rm -f ${shellQuote(remoteScript)}`, { timeout: 5_000 })
          .catch(() => {});
      }
      const parsed = safeJsonParse(result.stdout);
      await tracker.trackCommand("wp-debug.php", cmd, result, 0);
      if (enabled && revertAfterMinutes && revertAfterMinutes > 0) {
        const { Queue } = await import("bullmq");
        const redisUrl = this.config.get<string>("redis.url")!;
        const wpActionsQueue = new Queue(QUEUES.WP_ACTIONS, {
          connection: { url: redisUrl },
        });
        const revertExec = await this.prisma.jobExecution.create({
          data: {
            queue_name: QUEUES.WP_ACTIONS,
            job_type: JOB_TYPES.WP_DEBUG_REVERT,
            bull_job_id: randomUUID(),
            environment_id: BigInt(environmentId),
            status: "queued",
            payload: {
              environmentId,
              scheduledAt: new Date().toISOString(),
            } as object,
          },
        });
        await wpActionsQueue.add(
          JOB_TYPES.WP_DEBUG_REVERT,
          {
            environmentId,
            jobExecutionId: Number(revertExec.id),
            enabled: false,
          },
          { ...DEFAULT_JOB_OPTIONS, delay: revertAfterMinutes * 60 * 1000 },
        );
        await wpActionsQueue.close();
        await tracker.track({
          step: `Auto-revert scheduled in ${revertAfterMinutes}m`,
          level: "info",
        });
      }
      await job.updateProgress(100);
      await tracker.complete({ executionLog: parsed ?? {} });
      return parsed;
    } catch (err: unknown) {
      await tracker.fail(err, "wp:debug-toggle");
      throw err;
    }
  }

  private async processDebugRevert(job: Job): Promise<unknown> {
    return this.processDebugToggle(job);
  }

  private async processLogsFetch(job: Job): Promise<unknown> {
    const { environmentId, jobExecutionId, type, lines } =
      job.data as WpLogsPayload;
    const tracker = await StepTracker.start(
      this.prisma,
      jobExecutionId,
      this.logger,
      job,
    );
    try {
      await tracker.track({ step: `WP Logs: ${type}`, level: "info" });
      const { executor, env } = await this.connectToEnv(environmentId, tracker);
      await job.updateProgress(20);
      const scriptsPath = this.config.get<string>("scriptsPath")!;
      const remoteScript = `/tmp/wp_logs_${job.id}.php`;
      await pushRemoteScript(
        executor,
        join(scriptsPath, "wp-logs.php"),
        remoteScript,
      );
      const linesArg = lines ?? 100;
      const cmd = `php ${shellQuote(remoteScript)} --docroot=${shellQuote(env.root_path ?? "")} --type=${shellQuote(type)} --lines=${linesArg}`;
      let result;
      try {
        result = await executor.execute(cmd, { timeout: 30_000 });
      } finally {
        await executor
          .execute(`rm -f ${shellQuote(remoteScript)}`, { timeout: 5_000 })
          .catch(() => {});
      }
      const parsed = safeJsonParse(result.stdout);
      await job.updateProgress(100);
      await tracker.complete({ executionLog: parsed ?? {} });
      return parsed;
    } catch (err: unknown) {
      await tracker.fail(err, "wp:logs-fetch");
      throw err;
    }
  }

  private async processCronList(job: Job): Promise<unknown> {
    const { environmentId, jobExecutionId } = job.data as WpCronPayload;
    const tracker = await StepTracker.start(
      this.prisma,
      jobExecutionId,
      this.logger,
      job,
    );
    try {
      await tracker.track({ step: "WP Cron: list", level: "info" });
      const { executor, env } = await this.connectToEnv(environmentId, tracker);
      await job.updateProgress(20);
      const scriptsPath = this.config.get<string>("scriptsPath")!;
      const remoteScript = `/tmp/wp_cron_${job.id}.php`;
      await pushRemoteScript(
        executor,
        join(scriptsPath, "wp-cron.php"),
        remoteScript,
      );
      const cmd = `php ${shellQuote(remoteScript)} --docroot=${shellQuote(env.root_path ?? "")}`;
      let result;
      try {
        result = await executor.execute(cmd, { timeout: 30_000 });
      } finally {
        await executor
          .execute(`rm -f ${shellQuote(remoteScript)}`, { timeout: 5_000 })
          .catch(() => {});
      }
      const parsed = safeJsonParse(result.stdout);
      await job.updateProgress(100);
      await tracker.complete({ executionLog: parsed ?? {} });
      return parsed;
    } catch (err: unknown) {
      await tracker.fail(err, "wp:cron-list");
      throw err;
    }
  }

  private async processCleanup(job: Job): Promise<unknown> {
    const { environmentId, jobExecutionId, dryRun, keepRevisions } =
      job.data as WpCleanupPayload;
    const tracker = await StepTracker.start(
      this.prisma,
      jobExecutionId,
      this.logger,
      job,
    );
    try {
      await tracker.track({
        step: `WP Cleanup (dry=${dryRun ?? false})`,
        level: "info",
      });
      const { executor, env } = await this.connectToEnv(environmentId, tracker);
      await job.updateProgress(20);
      const scriptsPath = this.config.get<string>("scriptsPath")!;
      const remoteScript = `/tmp/wp_cleanup_${job.id}.php`;
      await pushRemoteScript(
        executor,
        join(scriptsPath, "wp-cleanup.php"),
        remoteScript,
      );
      const dryRunArg = dryRun ? " --dry-run" : "";
      const keepRevisionsArg =
        keepRevisions != null ? ` --keep-revisions=${keepRevisions}` : "";
      const cmd = `php ${shellQuote(remoteScript)} --docroot=${shellQuote(env.root_path ?? "")}${dryRunArg}${keepRevisionsArg}`;
      const t0 = Date.now();
      let result;
      try {
        result = await executor.execute(cmd, { timeout: 120_000 });
      } finally {
        await executor
          .execute(`rm -f ${shellQuote(remoteScript)}`, { timeout: 5_000 })
          .catch(() => {});
      }
      const parsed = safeJsonParse(result.stdout);
      await tracker.trackCommand(
        "wp-cleanup.php",
        cmd,
        result,
        Date.now() - t0,
      );
      await job.updateProgress(100);
      await tracker.complete({ executionLog: parsed ?? {} });
      return parsed;
    } catch (err: unknown) {
      await tracker.fail(err, "wp:cleanup");
      throw err;
    }
  }

  private async processCoreCheck(job: Job): Promise<unknown> {
    const { environmentId, jobExecutionId } = job.data as WpCoreCheckPayload;
    const tracker = await StepTracker.start(
      this.prisma,
      jobExecutionId,
      this.logger,
      job,
    );
    try {
      await tracker.track({
        step: "WP Core: check version",
        level: "info",
        detail: `env=${environmentId}`,
      });
      const { executor, env } = await this.connectToEnv(environmentId, tracker);
      await job.updateProgress(20);
      const wpPath = await this.resolveWpPath(executor, env.root_path ?? "");
      const wpCli = await WpCliBuilder.create(executor, wpPath);

      let currentVersion = "";
      const versionResult = await executor.execute(
        wpCli.buildCommand("core version --skip-plugins"),
        { timeout: 30_000 },
      );

      if (versionResult.code === 0 && versionResult.stdout.trim()) {
        currentVersion = parseWpVersion(versionResult.stdout);
      }

      // Fallback: Check version directly from filesystem if WP-CLI failed or returned empty
      if (!currentVersion) {
        const rootPath = env.root_path ?? "";
        const versionFiles = [
          `${wpPath}/wp-includes/version.php`,
          `${rootPath}/web/wp/wp-includes/version.php`,
          `${rootPath}/wp-includes/version.php`,
        ];
        for (const vf of versionFiles) {
          const catRes = await executor.execute(`grep -s "wp_version = " ${shellQuote(vf)} || true`);
          if (catRes.stdout.trim()) {
            currentVersion = parseWpVersion(catRes.stdout);
            if (currentVersion) break;
          }
        }

        // Check composer.lock for roots/wordpress or johnpbloch/wordpress-core
        if (!currentVersion) {
          const compLockRes = await executor.execute(
            `grep -A 3 -B 1 '"name": "roots/wordpress"' ${shellQuote(rootPath + "/composer.lock")} 2>/dev/null || grep -A 3 -B 1 '"name": "johnpbloch/wordpress-core"' ${shellQuote(rootPath + "/composer.lock")} 2>/dev/null || true`
          );
          if (compLockRes.stdout.trim()) {
            const compMatch = compLockRes.stdout.match(/"version":\s*"([^"]+)"/);
            if (compMatch) {
              currentVersion = parseWpVersion(compMatch[1]);
            }
          }
        }
      }

      if (!currentVersion) {
        throw new Error(
          `wp core version failed: unable to detect installed WordPress version (exit ${versionResult.code}): ${versionResult.stderr || "version.php not found"}`,
        );
      }

      let updates: unknown[] = [];
      try {
        const checkResult = await executor.execute(
          wpCli.buildCommand("core check-update --format=json --skip-plugins"),
          { timeout: 30_000 },
        );
        updates = parseWpUpdatesJson(checkResult.stdout) as unknown[];
      } catch {
        // Assume up-to-date or no updates reachable
        updates = [];
      }

      const result = { current_version: currentVersion, updates };
      await job.updateProgress(100);
      await tracker.complete({ executionLog: result as object });
      await tracker.track({
        step: "WP Core check complete",
        level: "info",
        detail: `version=${currentVersion} updates=${updates.length}`,
      });
      return result;
    } catch (err: unknown) {
      await tracker.fail(err, "wp:core-check");
      throw err;
    }
  }

  private async processCoreUpdate(job: Job): Promise<unknown> {
    const { environmentId, jobExecutionId } = job.data as WpCoreUpdatePayload;
    const tracker = await StepTracker.start(
      this.prisma,
      jobExecutionId,
      this.logger,
      job,
    );
    try {
      await tracker.track({
        step: "WP Core: update",
        level: "info",
        detail: `env=${environmentId}`,
      });
      const { executor, env } = await this.connectToEnv(environmentId, tracker);
      await job.updateProgress(20);
      const wpPath = await this.resolveWpPath(executor, env.root_path ?? "");
      const wpCli = await WpCliBuilder.create(executor, wpPath);
      // Step 1: Update core files
      const updateCmd = wpCli.buildCommand("core update --skip-plugins");
      const t0 = Date.now();
      const updateResult = await executor.execute(updateCmd, {
        timeout: 5 * 60_000,
      });
      await tracker.trackCommand(
        "wp core update",
        updateCmd,
        updateResult,
        Date.now() - t0,
      );
      if (updateResult.code !== 0) {
        throw new Error(
          `wp core update failed (exit ${updateResult.code}): ${updateResult.stderr}`,
        );
      }
      await job.updateProgress(70);
      // Step 2: Run DB schema upgrades
      const dbUpdateCmd = wpCli.buildCommand("core update-db --skip-plugins");
      const t1 = Date.now();
      const dbUpdateResult = await executor.execute(dbUpdateCmd, {
        timeout: 60_000,
      });
      await tracker.trackCommand(
        "wp core update-db",
        dbUpdateCmd,
        dbUpdateResult,
        Date.now() - t1,
      );
      if (dbUpdateResult.code !== 0) {
        throw new Error(
          `wp core update-db failed (exit ${dbUpdateResult.code}): ${dbUpdateResult.stderr}`,
        );
      }
      // Fetch the final version
      const versionResult = await executor.execute(
        wpCli.buildCommand("core version --skip-plugins"),
        { timeout: 15_000 },
      );
      if (versionResult.code !== 0) {
        throw new Error(
          `wp core version failed (exit ${versionResult.code}): ${versionResult.stderr}`,
        );
      }
      const newVersion = parseWpVersion(versionResult.stdout);
      const result = {
        updated: true,
        new_version: newVersion,
        update_output: updateResult.stdout,
        db_update_output: dbUpdateResult.stdout,
      };
      await job.updateProgress(100);
      await tracker.complete({ executionLog: result as object });
      await tracker.track({
        step: "WP Core update complete",
        level: "info",
        detail: `version=${newVersion}`,
      });
      return result;
    } catch (err: unknown) {
      await tracker.fail(err, "wp:core-update");
      throw err;
    }
  }

  private async processMaintenanceMode(job: Job): Promise<unknown> {
    const {
      environmentId,
      jobExecutionId,
      enabled,
      revertAfterMinutes,
      message,
    } = job.data as WpMaintenanceModePayload;
    const tracker = await StepTracker.start(
      this.prisma,
      jobExecutionId,
      this.logger,
      job,
    );
    try {
      await tracker.track({
        step: `WP Maintenance: ${enabled ? "enable" : "disable"}`,
        level: "info",
        detail: `env=${environmentId}`,
      });
      const { executor, env } = await this.connectToEnv(environmentId, tracker);
      await job.updateProgress(20);
      const wpPath = await this.resolveWpPath(executor, env.root_path ?? "");
      const wpCli = await WpCliBuilder.create(executor, wpPath);
      const action = enabled ? "activate" : "deactivate";
      const wpCmd = wpCli.buildCommand(
        `maintenance-mode ${action} --skip-plugins`,
      );
      const t0 = Date.now();
      const wpResult = await executor.execute(wpCmd, { timeout: 30_000 });
      await tracker.trackCommand(
        `wp maintenance-mode ${action}`,
        wpCmd,
        wpResult,
        Date.now() - t0,
      );

      let source = "wp-cli";
      if (wpResult.code !== 0) {
        source = "file";
        const maintenancePath = `${wpPath}/.maintenance`;
        const fallbackCmd = enabled
          ? `printf '%s\\n' ${shellQuote(
              `<?php $upgrading = time();`,
            )} > ${shellQuote(maintenancePath)}`
          : `rm -f ${shellQuote(maintenancePath)}`;
        const fallback = await executor.execute(fallbackCmd, {
          timeout: 20_000,
        });
        await tracker.trackCommand(
          `maintenance fallback ${enabled ? "enable" : "disable"}`,
          fallbackCmd,
          fallback,
          0,
        );
        if (fallback.code !== 0) {
          throw new Error(
            `maintenance fallback failed (exit ${fallback.code}): ${fallback.stderr}`,
          );
        }
      }

      if (enabled && revertAfterMinutes && revertAfterMinutes > 0) {
        const { Queue } = await import("bullmq");
        const redisUrl = this.config.get<string>("redis.url")!;
        const wpActionsQueue = new Queue(QUEUES.WP_ACTIONS, {
          connection: { url: redisUrl },
        });
        const revertExec = await this.prisma.jobExecution.create({
          data: {
            queue_name: QUEUES.WP_ACTIONS,
            job_type: JOB_TYPES.WP_MAINTENANCE_MODE,
            bull_job_id: randomUUID(),
            environment_id: BigInt(environmentId),
            status: "queued",
            payload: {
              environmentId,
              enabled: false,
              scheduledAt: new Date().toISOString(),
            } as object,
          },
        });
        await wpActionsQueue.add(
          JOB_TYPES.WP_MAINTENANCE_MODE,
          {
            environmentId,
            jobExecutionId: Number(revertExec.id),
            enabled: false,
          },
          { ...DEFAULT_JOB_OPTIONS, delay: revertAfterMinutes * 60 * 1000 },
        );
        await wpActionsQueue.close();
        await tracker.track({
          step: `Maintenance auto-disable scheduled in ${revertAfterMinutes}m`,
          level: "info",
        });
      }

      const result = { success: true, enabled, source };
      await job.updateProgress(100);
      await tracker.complete({ executionLog: result });
      return result;
    } catch (err: unknown) {
      await tracker.fail(err, "wp:maintenance-mode");
      throw err;
    }
  }

  private async resolveWpPath(
    executor: Awaited<
      ReturnType<
        typeof import("@bedrock-forge/remote-executor").createRemoteExecutor
      >
    >,
    rootPath: string,
  ): Promise<string> {
    const bedrockCheck = await executor.execute(
      `[ -d ${shellQuote(rootPath + "/web/wp")} ] && echo bedrock || echo standard`,
      { timeout: 10_000 },
    );
    return bedrockCheck.stdout.trim() === "bedrock"
      ? `${rootPath}/web/wp`
      : rootPath;
  }

  private async connectToEnv(environmentId: number, tracker: StepTracker) {
    const env = await this.prisma.environment.findUniqueOrThrow({
      where: { id: BigInt(environmentId) },
      include: { server: true },
    });
    await tracker.track({
      step: "Connecting to server",
      level: "info",
      detail: env.server.ip_address,
    });
    const executor = createRemoteExecutor(
      await this.sshKey.getSshConfig(env.server),
    );
    return { executor, env };
  }
}

function safeJsonParse(str: string): unknown {
  try {
    return JSON.parse(str.trim());
  } catch {
    return null;
  }
}

export function sanitizeMaintenanceMessage(msg: string): string {
  return msg
    .replace(/<\?(php|=)?/gi, "")
    .replace(/\?>/g, "")
    .replace(/<\/?script>/gi, "")
    .replace(/\/\*/g, "")
    .replace(/\*\//g, "")
    .replace(/<[^>]*>/g, ""); // Strip HTML tags
}
