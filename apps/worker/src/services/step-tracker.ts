import { Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import type { ExecuteResult } from "@bedrock-forge/remote-executor";

/** Shape of a single step entry stored in JobExecution.execution_log */
export interface ExecutionLogEntry {
  ts: string; // ISO 8601 timestamp
  step: string; // Human-readable label
  level: "info" | "warn" | "error";
  detail?: string; // Extra context (e.g. file paths, size)
  command?: string; // SSH command with secrets masked
  stdout?: string; // Truncated stdout (≤ 500 chars)
  stderr?: string; // Truncated stderr (≤ 500 chars)
  exitCode?: number; // Process exit code
  durationMs?: number; // Wall-clock elapsed time in ms
}

const MAX_OUTPUT_LENGTH = 500;
const SECRET_PATTERNS = [
  // MYSQL_PWD='...' or MYSQL_PWD="..."
  /MYSQL_PWD='[^']*'/g,
  /MYSQL_PWD="[^"]*"/g,
  /--github-token=(?:'[^']*'|"[^"]*"|\S+)/g,
];

function maskSecrets(command: string): string {
  let masked = command;
  for (const pattern of SECRET_PATTERNS) {
    masked = masked.replace(pattern, (match) =>
      match.startsWith("--github-token=")
        ? "--github-token='***'"
        : "MYSQL_PWD='***'",
    );
  }
  return masked;
}

function truncate(s: string): string {
  if (s.length <= MAX_OUTPUT_LENGTH) return s;
  return (
    s.slice(0, MAX_OUTPUT_LENGTH) + `… [+${s.length - MAX_OUTPUT_LENGTH} chars]`
  );
}

/**
 * StepTracker
 *
 * Accumulates structured execution log entries in memory and persists them
 * to JobExecution.execution_log after each step. Designed to be instantiated
 * once per job processor invocation.
 *
 * Every track() call also logs via the provided Logger so the console output
 * remains in sync with the persisted log.
 */
export class StepTracker {
  private entries: ExecutionLogEntry[] = [];
  private readonly jobId: string | number;
  private readonly job: {
    id?: string | number;
    updateProgress?: (val: number | any) => Promise<any>;
  } | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobExecutionId: bigint,
    private readonly logger: Logger,
    jobOrId:
      | string
      | number
      | {
          id?: string | number;
          updateProgress?: (val: number | any) => Promise<any>;
        },
  ) {
    if (jobOrId && typeof jobOrId === "object") {
      this.job = jobOrId;
      this.jobId = jobOrId.id ?? "";
    } else {
      this.job = null;
      this.jobId = jobOrId ?? "";
    }
  }

  /**
   * Static start helper: instantiates StepTracker and updates JobExecution status to active
   */
  static async start(
    prisma: PrismaService,
    jobExecutionId: bigint | number,
    logger: Logger,
    jobOrId:
      | string
      | number
      | {
          id?: string | number;
          updateProgress?: (val: number | any) => Promise<any>;
        },
  ): Promise<StepTracker> {
    const tracker = new StepTracker(
      prisma,
      BigInt(jobExecutionId),
      logger,
      jobOrId,
    );
    await prisma.jobExecution.update({
      where: { id: BigInt(jobExecutionId) },
      data: { status: "active", started_at: new Date() },
    });
    return tracker;
  }

  /** Log a generic step (info, warn, or error). */
  async track(entry: Omit<ExecutionLogEntry, "ts">): Promise<void> {
    const full: ExecutionLogEntry = { ts: new Date().toISOString(), ...entry };
    this.entries.push(full);

    const logLine = `[${this.jobId}] [${full.level.toUpperCase()}] ${full.step}${full.detail ? ` — ${full.detail}` : ""}`;
    // For error-level commands also emit stderr to the NestJS console so
    // the failure reason is visible without opening the UI log panel.
    const stderrSuffix =
      full.level === "error" && full.stderr ? `\n  stderr: ${full.stderr}` : "";
    const exitSuffix =
      full.level === "error" && full.exitCode !== undefined
        ? ` (exit ${full.exitCode})`
        : "";

    if (full.level === "error")
      this.logger.error(logLine + exitSuffix + stderrSuffix);
    else if (full.level === "warn") this.logger.warn(logLine);
    else this.logger.log(logLine);

    await this.flush();
  }

  /**
   * Log a remote SSH command result with timing information.
   * Automatically masks secrets in the command string.
   */
  async trackCommand(
    step: string,
    command: string,
    result: ExecuteResult,
    durationMs: number = 0,
  ): Promise<void> {
    const level = result.code !== 0 ? "error" : "info";
    await this.track({
      step,
      level,
      command: maskSecrets(command),
      stdout: result.stdout ? truncate(result.stdout) : undefined,
      stderr: result.stderr ? truncate(result.stderr) : undefined,
      exitCode: result.code,
      durationMs,
    });
  }

  /** Persist the current entries array to the database. Fire-and-forget safe. */
  async flush(): Promise<void> {
    await this.prisma.jobExecution
      .update({
        where: { id: this.jobExecutionId },
        data: { execution_log: this.entries as object[] },
      })
      .catch((err) =>
        this.logger.error(
          `[${this.jobId}] StepTracker flush failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
  }

  /**
   * Complete helper: marks the JobExecution status as completed, sets completed_at, updates progress, and writes execution log.
   */
  async complete(data?: {
    progress?: number;
    executionLog?: any;
  }): Promise<void> {
    await this.prisma.jobExecution.update({
      where: { id: this.jobExecutionId },
      data: {
        status: "completed",
        completed_at: new Date(),
        progress: data?.progress ?? 100,
        execution_log:
          data?.executionLog !== undefined
            ? data.executionLog
            : (this.entries as object[]),
      },
    });
  }

  /**
   * Fail helper: marks the JobExecution status as failed, updates last_error and completed_at, and logs the error.
   */
  async fail(err: unknown, stepLabel?: string): Promise<void> {
    const msg = err instanceof Error ? err.message : String(err);
    this.logger.error(
      `[${this.jobId}] Job failed${stepLabel ? ` (${stepLabel})` : ""}: ${msg}`,
    );
    await this.track({
      step: `${stepLabel || "Job"} failed`,
      level: "error",
      detail: msg,
    }).catch(() => {});
    await this.prisma.jobExecution
      .update({
        where: { id: this.jobExecutionId },
        data: { status: "failed", last_error: msg, completed_at: new Date() },
      })
      .catch(() => {});
  }

  /**
   * Checks the queue's Redis client for the cancellation key (forge:cancel:${jobId})
   */
  async isCancelled(queue: { client: Promise<any> }): Promise<boolean> {
    if (!this.jobId) return false;
    const redis = await queue.client;
    return (await redis.get(`forge:cancel:${this.jobId}`)) === "1";
  }

  /** Return a snapshot of all entries (for inspection / test assertions). */
  getEntries(): ExecutionLogEntry[] {
    return [...this.entries];
  }
}
