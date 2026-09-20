import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { createRemoteExecutor } from "@bedrock-forge/remote-executor";
import { QUEUES, JOB_TYPES } from "@bedrock-forge/shared";
import { WpActionsRepository } from "./wp-actions.repository";
import { ServersService } from "../servers/servers.service";
import { JobOrchestratorService } from "../job-executions/job-orchestrator.service";
import {
  WpFixActionDto,
  WpDebugModeDto,
  WpLogsQueryDto,
  WpMaintenanceModeDto,
} from "./dto/wp-actions.dto";
import { WpCliRunDto, WpSearchReplaceDto } from "./dto/wp-cli.dto";
import { readFileSync } from "fs";
import { join } from "path";

@Injectable()
export class WpActionsService {
  constructor(
    private readonly repo: WpActionsRepository,
    private readonly serversService: ServersService,
    private readonly jobOrchestrator: JobOrchestratorService,
    @InjectQueue(QUEUES.WP_ACTIONS) private readonly wpActionsQueue: Queue,
  ) {}

  // ─── Async job enqueue ────────────────────────────────────────────────────

  async enqueueFix(envId: number, dto: WpFixActionDto) {
    const env = await this.requireEnv(envId);
    const result = await this.jobOrchestrator.enqueue({
      queue: this.wpActionsQueue,
      queueName: QUEUES.WP_ACTIONS,
      jobType: JOB_TYPES.WP_FIX_ACTION,
      payload: { environmentId: envId, action: dto.action },
      environmentId: env.id,
    });
    return {
      jobExecutionId: result.jobExecutionId,
      bullJobId: result.bullJobId,
    };
  }

  async enqueueDebugMode(envId: number, dto: WpDebugModeDto) {
    const env = await this.requireEnv(envId);
    const result = await this.jobOrchestrator.enqueue({
      queue: this.wpActionsQueue,
      queueName: QUEUES.WP_ACTIONS,
      jobType: JOB_TYPES.WP_DEBUG_TOGGLE,
      payload: {
        environmentId: envId,
        enabled: dto.enabled,
        revertAfterMinutes: dto.revert_after_minutes,
      },
      environmentId: env.id,
    });
    return {
      jobExecutionId: result.jobExecutionId,
      bullJobId: result.bullJobId,
    };
  }

  async enqueueCleanup(envId: number, dryRun: boolean, keepRevisions?: number) {
    const env = await this.requireEnv(envId);
    const result = await this.jobOrchestrator.enqueue({
      queue: this.wpActionsQueue,
      queueName: QUEUES.WP_ACTIONS,
      jobType: JOB_TYPES.WP_CLEANUP,
      payload: { environmentId: envId, dryRun, keepRevisions },
      environmentId: env.id,
    });
    return {
      jobExecutionId: result.jobExecutionId,
      bullJobId: result.bullJobId,
    };
  }

  async enqueueCoreCheck(envId: number) {
    const env = await this.requireEnv(envId);
    const result = await this.jobOrchestrator.enqueue({
      queue: this.wpActionsQueue,
      queueName: QUEUES.WP_ACTIONS,
      jobType: JOB_TYPES.WP_CORE_CHECK,
      payload: { environmentId: envId },
      environmentId: env.id,
    });
    return {
      jobExecutionId: result.jobExecutionId,
      bullJobId: result.bullJobId,
    };
  }

  async enqueueCoreUpdate(envId: number) {
    const env = await this.requireEnv(envId);
    const result = await this.jobOrchestrator.enqueue({
      queue: this.wpActionsQueue,
      queueName: QUEUES.WP_ACTIONS,
      jobType: JOB_TYPES.WP_CORE_UPDATE,
      payload: { environmentId: envId },
      environmentId: env.id,
    });
    return {
      jobExecutionId: result.jobExecutionId,
      bullJobId: result.bullJobId,
    };
  }

  async enqueueMaintenanceMode(envId: number, dto: WpMaintenanceModeDto) {
    const env = await this.requireEnv(envId);
    const result = await this.jobOrchestrator.enqueue({
      queue: this.wpActionsQueue,
      queueName: QUEUES.WP_ACTIONS,
      jobType: JOB_TYPES.WP_MAINTENANCE_MODE,
      payload: {
        environmentId: envId,
        enabled: dto.enabled,
        revertAfterMinutes: dto.revert_after_minutes,
        message: dto.message,
      },
      environmentId: env.id,
    });
    return {
      jobExecutionId: result.jobExecutionId,
      bullJobId: result.bullJobId,
    };
  }

  // ─── Synchronous SSH calls ────────────────────────────────────────────────

  async getDebugStatus(envId: number) {
    const { executor, env } = await this.connectToEnv(envId);
    const scriptsPath = join(__dirname, "../../../../worker/scripts");
    const remoteScript = `/tmp/wp_debug_status_${Date.now()}.php`;
    await executor.pushFile({
      remotePath: remoteScript,
      content: readFileSync(join(scriptsPath, "wp-debug.php")),
    });
    try {
      const result = await executor.execute(
        `php ${remoteScript} --docroot=${shellQuote(env.root_path ?? "")} --action=status`,
        { timeout: 10_000 },
      );
      const parsed = safeJsonParse(result.stdout);
      return parsed ?? { success: false, error: result.stderr };
    } finally {
      await executor
        .execute(`rm -f ${remoteScript}`, { timeout: 5_000 })
        .catch(() => {});
    }
  }

  async getLogs(envId: number, query: WpLogsQueryDto) {
    const { executor, env } = await this.connectToEnv(envId);
    const scriptsPath = join(__dirname, "../../../../worker/scripts");
    const remoteScript = `/tmp/wp_logs_${Date.now()}.php`;
    await executor.pushFile({
      remotePath: remoteScript,
      content: readFileSync(join(scriptsPath, "wp-logs.php")),
    });
    try {
      const type = query.type ?? "debug";
      const lines = query.lines ?? 100;
      const result = await executor.execute(
        `php ${remoteScript} --docroot=${shellQuote(env.root_path ?? "")} --type=${shellQuote(type)} --lines=${lines}`,
        { timeout: 15_000 },
      );
      return (
        safeJsonParse(result.stdout) ?? { success: false, error: result.stderr }
      );
    } finally {
      await executor
        .execute(`rm -f ${remoteScript}`, { timeout: 5_000 })
        .catch(() => {});
    }
  }

  async getCron(envId: number) {
    const { executor, env } = await this.connectToEnv(envId);
    const scriptsPath = join(__dirname, "../../../../worker/scripts");
    const remoteScript = `/tmp/wp_cron_${Date.now()}.php`;
    await executor.pushFile({
      remotePath: remoteScript,
      content: readFileSync(join(scriptsPath, "wp-cron.php")),
    });
    try {
      const result = await executor.execute(
        `php ${remoteScript} --docroot=${shellQuote(env.root_path ?? "")}`,
        { timeout: 20_000 },
      );
      return (
        safeJsonParse(result.stdout) ?? { success: false, error: result.stderr }
      );
    } finally {
      await executor
        .execute(`rm -f ${remoteScript}`, { timeout: 5_000 })
        .catch(() => {});
    }
  }

  async getMaintenanceStatus(envId: number) {
    const { executor, env } = await this.connectToEnv(envId);
    const wpPath = await this.resolveWpPathForStatus(
      executor,
      env.root_path ?? "",
    );
    const cmd = `wp maintenance-mode status --skip-plugins --path=${shellQuote(wpPath)} --allow-root`;
    const result = await executor.execute(cmd, { timeout: 20_000 });
    const output = `${result.stdout}\n${result.stderr}`.trim();
    if (result.code === 0) {
      return {
        success: true,
        enabled: /active|enabled|on/i.test(output),
        output,
        source: "wp-cli",
      };
    }
    const fileCheck = await executor.execute(
      `test -f ${shellQuote(wpPath + "/.maintenance")} && echo active || echo inactive`,
      { timeout: 10_000 },
    );
    return {
      success: true,
      enabled: fileCheck.stdout.trim() === "active",
      output: output || fileCheck.stdout.trim(),
      source: "file",
    };
  }

  async runCli(envId: number, dto: WpCliRunDto) {
    const { executor, env } = await this.connectToEnv(envId);
    const wpPath = await this.resolveWpPathForStatus(
      executor,
      env.root_path ?? "",
    );

    // Normalize command: if user typed "wp cache flush", strip leading "wp "
    let cleanCmd = dto.command.trim();
    if (cleanCmd.startsWith("wp ")) {
      cleanCmd = cleanCmd.slice(3).trim();
    }

    // Disallow dangerous or shell escape tokens
    if (/[;&|`$<>]/.test(cleanCmd) || /\beval-file\b/i.test(cleanCmd)) {
      throw new BadRequestException(
        "Command contains forbidden tokens or operations.",
      );
    }

    const start = Date.now();
    const cmd = `wp ${cleanCmd} --path=${shellQuote(wpPath)} --allow-root`;
    const result = await executor.execute(cmd, { timeout: 35_000 });
    const durationMs = Date.now() - start;

    return {
      command: `wp ${cleanCmd}`,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.code,
      durationMs,
    };
  }

  async runSearchReplace(envId: number, dto: WpSearchReplaceDto) {
    const { executor, env } = await this.connectToEnv(envId);
    const wpPath = await this.resolveWpPathForStatus(
      executor,
      env.root_path ?? "",
    );

    const parts = [
      "wp",
      "search-replace",
      shellQuote(dto.search),
      shellQuote(dto.replace),
    ];

    if (dto.tables?.trim()) {
      const tablesList = dto.tables
        .trim()
        .split(/\s+/)
        .map((t) => shellQuote(t))
        .join(" ");
      parts.push(tablesList);
    }

    if (dto.dry_run ?? true) {
      parts.push("--dry-run");
    }

    if (dto.skip_transients ?? true) {
      parts.push("--skip-transients");
    }

    parts.push("--report");
    parts.push(`--path=${shellQuote(wpPath)}`);
    parts.push("--allow-root");

    const start = Date.now();
    const cmd = parts.join(" ");
    const result = await executor.execute(cmd, { timeout: 60_000 });
    const durationMs = Date.now() - start;

    return {
      command: `wp search-replace ${dto.search} ${dto.replace} ${dto.dry_run ?? true ? "(dry-run)" : ""}`,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.code,
      durationMs,
      dryRun: dto.dry_run ?? true,
    };
  }

  async exportDb(envId: number) {
    const { executor, env } = await this.connectToEnv(envId);
    const wpPath = await this.resolveWpPathForStatus(
      executor,
      env.root_path ?? "",
    );

    const baseBackupDir = env.backup_path || `${env.root_path}/.forge-backups`;
    const snapshotDir = `${baseBackupDir}/db-snapshots`;
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `db-snapshot-${timestamp}.sql`;
    const targetPath = `${snapshotDir}/${filename}`;

    const start = Date.now();
    const cmd = `mkdir -p ${shellQuote(snapshotDir)} && wp db export ${shellQuote(targetPath)} --path=${shellQuote(wpPath)} --allow-root`;
    const result = await executor.execute(cmd, { timeout: 60_000 });
    const durationMs = Date.now() - start;

    if (result.code !== 0) {
      throw new BadRequestException(result.stderr || "Database export failed");
    }

    const statResult = await executor.execute(
      `stat -c '%s' ${shellQuote(targetPath)} 2>/dev/null || echo 0`,
    );
    const sizeBytes = parseInt(statResult.stdout.trim(), 10) || 0;

    return {
      success: true,
      filename,
      path: targetPath,
      sizeBytes,
      durationMs,
    };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private async requireEnv(envId: number) {
    const env = await this.repo.findEnvironment(BigInt(envId));
    if (!env) throw new NotFoundException(`Environment ${envId} not found`);
    if (!env.root_path)
      throw new BadRequestException(
        `Environment ${envId} has no root_path configured`,
      );
    return env;
  }

  private async connectToEnv(envId: number) {
    const env = await this.repo.findEnvironment(BigInt(envId));
    if (!env) throw new NotFoundException(`Environment ${envId} not found`);
    if (!env.server)
      throw new BadRequestException(
        `Environment ${envId} has no associated server`,
      );
    const sshConfig = await this.serversService.getServerSshConfig(
      Number(env.server.id),
    );
    const executor = createRemoteExecutor(sshConfig);
    return { executor, env };
  }

  private async resolveWpPathForStatus(
    executor: Awaited<ReturnType<typeof createRemoteExecutor>>,
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
}

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function safeJsonParse(str: string): unknown {
  try {
    return JSON.parse(str.trim());
  } catch {
    return null;
  }
}
