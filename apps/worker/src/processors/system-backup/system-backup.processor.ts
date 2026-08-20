import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { Job } from "bullmq";
import { execFile } from "child_process";
import { promisify } from "util";
import { mkdir, stat, rm, writeFile } from "fs/promises";
import { join } from "path";
import { QUEUES, JOB_TYPES } from "@bedrock-forge/shared";
import { PrismaService } from "../../prisma/prisma.service";
import { RcloneService } from "../../services/rclone.service";

const execFileAsync = promisify(execFile);

const STAGING_DIR = "/tmp/forge-system-backups";

/** Format a Date as YYYY-MM-DD_HH-mm-ss for use in filenames. */
function formatTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

/**
 * SystemBackupProcessor
 *
 * Handles:
 *   - system-backup:create  — manual trigger (folderId provided in job data)
 *   - system-backup:scheduled — repeatable scheduled backup (fetches folderId + applies retention)
 */
@Processor(QUEUES.SYSTEM_BACKUPS, {
  concurrency: 1,
  lockDuration: 60_000,
  stalledInterval: 15_000,
  maxStalledCount: 1,
})
export class SystemBackupProcessor extends WorkerHost {
  private readonly logger = new Logger(SystemBackupProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rclone: RcloneService,
  ) {
    super();
  }

  async process(job: Job) {
    switch (job.name) {
      case JOB_TYPES.SYSTEM_BACKUP_CREATE:
        return this.processCreate(job);
      case JOB_TYPES.SYSTEM_BACKUP_SCHEDULED:
        return this.processScheduled(job);
      default:
        this.logger.warn(`Unknown job type: ${job.name}`);
    }
  }

  // ── Manual backup (pre-created SystemBackup + JobExecution in service) ────

  private async processCreate(job: Job) {
    const { systemBackupId, jobExecutionId, folderId } = job.data as {
      systemBackupId: number;
      jobExecutionId: number;
      folderId: string;
    };

    const startedAt = new Date();

    await Promise.all([
      this.prisma.systemBackup.update({
        where: { id: BigInt(systemBackupId) },
        data: { status: "running", started_at: startedAt },
      }),
      this.prisma.jobExecution.update({
        where: { id: BigInt(jobExecutionId) },
        data: { status: "active", started_at: startedAt },
      }),
    ]);

    let tmpPath: string | null = null;

    try {
      const remotePath = await this.runBackup(startedAt, folderId, (p) => {
        tmpPath = p;
      });

      const sizeBytes = tmpPath ? await this.getFileSize(tmpPath) : undefined;
      const completedAt = new Date();

      await Promise.all([
        this.prisma.systemBackup.update({
          where: { id: BigInt(systemBackupId) },
          data: {
            status: "completed",
            file_path: remotePath,
            size_bytes: sizeBytes,
            completed_at: completedAt,
          },
        }),
        this.prisma.jobExecution.update({
          where: { id: BigInt(jobExecutionId) },
          data: {
            status: "completed",
            progress: 100,
            completed_at: completedAt,
          },
        }),
      ]);

      this.logger.log(
        `[SystemBackup #${systemBackupId}] ✓ Completed → ${remotePath}`,
      );
    } catch (err) {
      await this.markFailed(
        BigInt(systemBackupId),
        BigInt(jobExecutionId),
        err,
      );
      throw err;
    } finally {
      if (tmpPath) await rm(tmpPath, { force: true }).catch(() => undefined);
    }
  }

  // ── Scheduled backup (self-contained: creates own records) ──────────────

  private async processScheduled(job: Job) {
    const { scheduleId } = job.data as { scheduleId: number };

    // Fetch the schedule row for retention settings
    const schedule = await this.prisma.systemBackupSchedule.findFirst();

    // Look up the Google Drive folder ID from app settings
    const setting = await this.prisma.appSetting.findUnique({
      where: { key: "forge_system_backup_folder_id" },
    });
    const folderId = setting?.value;
    if (!folderId) {
      this.logger.error(
        `[SystemBackupSchedule #${scheduleId}] No GDrive folder ID configured — skipping`,
      );
      return;
    }

    const startedAt = new Date();

    // Create job execution + backup records
    const exec = await this.prisma.jobExecution.create({
      data: {
        queue_name: QUEUES.SYSTEM_BACKUPS,
        job_type: JOB_TYPES.SYSTEM_BACKUP_SCHEDULED,
        bull_job_id: job.id ?? "",
        payload: { scheduleId } as Record<string, string | number>,
        status: "active",
        started_at: startedAt,
      },
    });

    const backup = await this.prisma.systemBackup.create({
      data: {
        job_execution_id: exec.id,
        status: "running",
        started_at: startedAt,
      },
    });

    let tmpPath: string | null = null;

    try {
      const remotePath = await this.runBackup(startedAt, folderId, (p) => {
        tmpPath = p;
      });

      const sizeBytes = tmpPath ? await this.getFileSize(tmpPath) : undefined;
      const completedAt = new Date();

      await Promise.all([
        this.prisma.systemBackup.update({
          where: { id: backup.id },
          data: {
            status: "completed",
            file_path: remotePath,
            size_bytes: sizeBytes,
            completed_at: completedAt,
          },
        }),
        this.prisma.jobExecution.update({
          where: { id: exec.id },
          data: {
            status: "completed",
            progress: 100,
            completed_at: completedAt,
          },
        }),
      ]);

      // Stamp last_run_at on the schedule
      if (schedule) {
        await this.prisma.systemBackupSchedule.update({
          where: { id: schedule.id },
          data: { last_run_at: completedAt },
        });
      }

      this.logger.log(
        `[SystemBackupSchedule #${scheduleId}] ✓ Completed → ${remotePath}`,
      );

      // Apply retention policy
      if (schedule) {
        await this.applyRetention(
          schedule.retention_count,
          schedule.retention_days,
        );
      }
    } catch (err) {
      await this.markFailed(backup.id, exec.id, err);
      throw err;
    } finally {
      if (tmpPath) await rm(tmpPath, { force: true }).catch(() => undefined);
    }
  }

  // ── Shared backup logic ────────────────────────────────────────────────────

  /**
   * Runs pg_dump + rclone upload.
   * `onTmpPath` is called with the local path so callers can clean up.
   * Returns the remote path (gdrive:{folderId}/{filename}).
   */
  private async runBackup(
    startedAt: Date,
    folderId: string,
    onTmpPath: (p: string) => void,
  ): Promise<string> {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) throw new Error("DATABASE_URL is not set in environment");

    const parsed = new URL(dbUrl);
    const dbHost = parsed.hostname;
    const dbPort = parsed.port || "5432";
    const dbName = parsed.pathname.slice(1);
    const dbUser = parsed.username;
    const dbPassword = decodeURIComponent(parsed.password);

    await mkdir(STAGING_DIR, { recursive: true });
    const timestamp = formatTimestamp(startedAt);
    const filename = `forge-system-${timestamp}.dump`;
    const tmpPath = join(STAGING_DIR, filename);
    onTmpPath(tmpPath);

    this.logger.log(`Running pg_dump → ${tmpPath}`);

    const pgpassFilename = `.${filename}.pgpass`;
    const pgpassPath = join(STAGING_DIR, pgpassFilename);
    const pgpassContent = `${dbHost}:${dbPort}:${dbName}:${dbUser}:${dbPassword}\n`;
    await writeFile(pgpassPath, pgpassContent, { mode: 0o600 });

    try {
      await execFileAsync(
        "pg_dump",
        [
          "-h",
          dbHost,
          "-p",
          dbPort,
          "-U",
          dbUser,
          "-d",
          dbName,
          "-Fc",
          "-f",
          tmpPath,
        ],
        { env: { ...process.env, PGPASSFILE: pgpassPath } },
      );
    } finally {
      await rm(pgpassPath, { force: true }).catch(() => undefined);
    }

    this.logger.log(`Uploading to GDrive folder ${folderId}`);
    await this.rclone.writeConfig();
    return this.rclone.upload(tmpPath, folderId, filename);
  }

  private async getFileSize(tmpPath: string): Promise<bigint | undefined> {
    try {
      const s = await stat(tmpPath);
      return BigInt(s.size);
    } catch {
      return undefined;
    }
  }

  private async markFailed(backupId: bigint, execId: bigint, err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    this.logger.error(`System backup failed: ${errorMessage}`);
    const completedAt = new Date();
    await Promise.allSettled([
      this.prisma.systemBackup.update({
        where: { id: backupId },
        data: {
          status: "failed",
          error_message: errorMessage,
          completed_at: completedAt,
        },
      }),
      this.prisma.jobExecution.update({
        where: { id: execId },
        data: {
          status: "failed",
          last_error: errorMessage,
          completed_at: completedAt,
        },
      }),
    ]);
  }

  private async applyRetention(
    retentionCount: number | null,
    retentionDays: number | null,
  ) {
    if (retentionCount) {
      // Keep the N most recent completed backups; delete the rest
      const completed = await this.prisma.systemBackup.findMany({
        where: { status: "completed" },
        orderBy: { created_at: "desc" },
        select: { id: true },
      });
      if (completed.length > retentionCount) {
        const toDelete = completed.slice(retentionCount).map((b) => b.id);
        await this.prisma.systemBackup.deleteMany({
          where: { id: { in: toDelete } },
        });
        this.logger.log(
          `Retention: deleted ${toDelete.length} old system backup(s)`,
        );
      }
    }

    if (retentionDays) {
      const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
      const { count } = await this.prisma.systemBackup.deleteMany({
        where: { status: "completed", created_at: { lt: cutoff } },
      });
      if (count) {
        this.logger.log(
          `Retention: deleted ${count} system backup(s) older than ${retentionDays} days`,
        );
      }
    }
  }
}
