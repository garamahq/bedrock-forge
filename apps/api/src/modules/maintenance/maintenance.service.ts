import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { readdir, rm, stat } from "fs/promises";
import { join } from "path";
import { MaintenanceRepository } from "./maintenance.repository";
import { CleanupSchedulesRepository } from "../cleanup-schedules/cleanup-schedules.repository";
import { WpActionsService } from "../wp-actions/wp-actions.service";
import { QUEUES } from "@bedrock-forge/shared";

const STAGING_DIR = "/tmp/forge-backups";
const ORPHAN_TTL_MS = 24 * 60 * 60 * 1_000;

/**
 * MaintenanceService runs background health tasks:
 * - Nightly (02:00 UTC): marks interrupted jobs as failed, purges expired refresh tokens
 * - Weekly (Sunday 03:00 UTC): deletes old audit logs, job executions, notification logs (> 90 days)
 * - Hourly (at :45): audits repeatable BullMQ jobs against DB and removes orphaned jobs
 *
 * Also:
 * - On startup: sweeps crash-orphaned backup staging directories
 * - Hourly: fires wp:cleanup jobs for environments with an active CleanupSchedule
 */
@Injectable()
export class MaintenanceService implements OnApplicationBootstrap {
  private readonly logger = new Logger(MaintenanceService.name);

  constructor(
    private readonly repo: MaintenanceRepository,
    private readonly cleanupRepo: CleanupSchedulesRepository,
    private readonly wpActions: WpActionsService,
    @InjectQueue(QUEUES.MONITORS) private readonly monitorsQueue: Queue,
    @InjectQueue(QUEUES.BACKUPS) private readonly backupsQueue: Queue,
    @InjectQueue(QUEUES.PLUGIN_UPDATES) private readonly pluginUpdatesQueue: Queue,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.recoverInterruptedJobs();
    await this.sweepOrphanedStagingDirs();
    await this.syncOrphanedRepeatableJobs();
  }

  private async recoverInterruptedJobs(): Promise<void> {
    try {
      const recovered = await this.repo.failInterruptedJobs();
      if (recovered.count > 0) {
        this.logger.warn(
          `Startup recovery: marked ${recovered.count} interrupted job(s) as failed`,
        );
      }
    } catch (e) {
      this.logger.error("Startup recovery failed", e);
    }
  }

  /**
   * Delete subdirectories under /tmp/forge-backups that are older than 24 hours.
   * These are left behind when the container crashes mid-backup before the
   * per-job cleanup runs.
   */
  private async sweepOrphanedStagingDirs(): Promise<void> {
    try {
      const cutoff = Date.now() - ORPHAN_TTL_MS;
      const entries = await readdir(STAGING_DIR, { withFileTypes: true }).catch(
        () => [],
      );
      let swept = 0;
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dirPath = join(STAGING_DIR, entry.name);
        const { mtimeMs } = await stat(dirPath);
        if (mtimeMs < cutoff) {
          await rm(dirPath, { recursive: true, force: true });
          swept++;
        }
      }
      if (swept > 0) {
        this.logger.warn(
          `Startup sweep: removed ${swept} orphaned backup staging dir(s) from ${STAGING_DIR}`,
        );
      }
    } catch (e) {
      this.logger.error("Staging directory sweep failed", e);
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async runCleanup(): Promise<void> {
    this.logger.log("Starting nightly maintenance cleanup");

    const now = new Date();
    const days90 = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1_000);
    const days180 = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1_000);

    const results = await Promise.allSettled([
      // Expired or revoked refresh tokens
      this.repo.deleteExpiredTokens(now),
      // Old notification logs
      this.repo.deleteOldNotificationLogs(days90),
      // Old audit logs
      this.repo.deleteOldAuditLogs(days180),
      // Completed / failed job executions — keep 90 days for debugging
      this.repo.deleteOldJobExecutions(days90),
      // In-app user notifications — unbounded without a TTL
      this.repo.deleteOldUserNotifications(days90),
      // Security scans older than 90 days
      this.repo.deleteOldSecurityScans(days90),
      // Lighthouse audits older than 90 days
      this.repo.deleteOldLighthouseAudits(days90),
    ]);

    const labels = [
      "refresh tokens",
      "notification logs",
      "audit logs",
      "job executions",
      "user notifications",
      "security scans",
      "lighthouse audits",
    ];
    results.forEach((r, i) => {
      if (r.status === "fulfilled") {
        this.logger.log(`Maintenance: deleted ${r.value.count} ${labels[i]}`);
      } else {
        this.logger.error(
          `Maintenance: failed to clean ${labels[i]}`,
          r.reason,
        );
      }
    });

    await this.syncOrphanedRepeatableJobs();
  }

  /**
   * Runs every hour. For each enabled CleanupSchedule whose frequency/hour/day
   * matches now (and whose last_run_at is far enough in the past), dispatches
   * a wp:cleanup job and records the run timestamp.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async runCleanupSchedules(): Promise<void> {
    const schedules = await this.cleanupRepo.findAllEnabled();
    if (schedules.length === 0) return;

    const now = new Date();
    for (const schedule of schedules) {
      if (!this.shouldFire(schedule, now)) continue;
      const envId = Number(schedule.environment_id);
      try {
        await this.wpActions.enqueueCleanup(
          envId,
          false,
          schedule.keep_revisions,
        );
        await this.cleanupRepo.updateLastRun(schedule.environment_id, now);
        this.logger.log(
          `CleanupSchedule: dispatched wp:cleanup for env ${envId} (keep_revisions=${schedule.keep_revisions})`,
        );
      } catch (e) {
        this.logger.error(
          `CleanupSchedule: failed to dispatch for env ${envId}`,
          e,
        );
      }
    }
  }

  /**
   * Audit/cleanup utility that identifies and removes repeatable jobs in BullMQ
   * that do not exist or are marked as disabled in the database.
   */
  async syncOrphanedRepeatableJobs(): Promise<void> {
    this.logger.log("Starting audit/cleanup of repeatable jobs");

    // 1. Monitors Queue
    try {
      const repeatableMonitors = await this.monitorsQueue.getRepeatableJobs();
      for (const rj of repeatableMonitors) {
        if (!rj.id) continue;
        const match = rj.id.match(/^monitor-(\d+)$/);
        if (!match) continue;
        const monitorId = BigInt(match[1]);

        const dbMonitor = await this.repo.findMonitor(monitorId);

        if (!dbMonitor || !dbMonitor.enabled) {
          this.logger.warn(
            `Orphaned repeatable job found for monitor ${monitorId} (db: ${
              dbMonitor ? "disabled" : "missing"
            }). Removing repeatable job key: ${rj.key}`,
          );
          await this.monitorsQueue.removeRepeatableByKey(rj.key);
        }
      }
    } catch (err) {
      this.logger.error("Failed to audit repeatable monitors", err);
    }

    // 2. Backups Queue
    try {
      const repeatableBackups = await this.backupsQueue.getRepeatableJobs();
      for (const rj of repeatableBackups) {
        if (!rj.id) continue;
        const match = rj.id.match(/^backup-schedule-(\d+)$/);
        if (!match) continue;
        const scheduleId = BigInt(match[1]);

        const dbSchedule = await this.repo.findBackupSchedule(scheduleId);

        if (!dbSchedule || !dbSchedule.enabled) {
          this.logger.warn(
            `Orphaned repeatable job found for backup schedule ${scheduleId} (db: ${
              dbSchedule ? "disabled" : "missing"
            }). Removing repeatable job key: ${rj.key}`,
          );
          await this.backupsQueue.removeRepeatableByKey(rj.key);
        }
      }
    } catch (err) {
      this.logger.error("Failed to audit repeatable backups", err);
    }

    // 3. Plugin Updates Queue
    try {
      const repeatablePlugins = await this.pluginUpdatesQueue.getRepeatableJobs();
      for (const rj of repeatablePlugins) {
        if (!rj.id) continue;
        const match = rj.id.match(/^plugin-update-schedule-(\d+)$/);
        if (!match) continue;
        const scheduleId = BigInt(match[1]);

        const dbSchedule = await this.repo.findPluginUpdateSchedule(scheduleId);

        if (!dbSchedule || !dbSchedule.enabled) {
          this.logger.warn(
            `Orphaned repeatable job found for plugin update schedule ${scheduleId} (db: ${
              dbSchedule ? "disabled" : "missing"
            }). Removing repeatable job key: ${rj.key}`,
          );
          await this.pluginUpdatesQueue.removeRepeatableByKey(rj.key);
        }
      }
    } catch (err) {
      this.logger.error("Failed to audit repeatable plugin updates", err);
    }

    this.logger.log("Completed audit/cleanup of repeatable jobs");
  }

  private shouldFire(
    schedule: {
      frequency: string;
      hour: number;
      minute: number;
      day_of_week: number | null;
      day_of_month: number | null;
      last_run_at: Date | null;
    },
    now: Date,
  ): boolean {
    if (schedule.hour !== now.getUTCHours()) return false;
    if (schedule.minute !== now.getUTCMinutes()) return false;

    const elapsed = schedule.last_run_at
      ? now.getTime() - schedule.last_run_at.getTime()
      : Infinity;

    switch (schedule.frequency) {
      case "daily":
        return elapsed >= 20 * 60 * 60 * 1_000;
      case "weekly":
        if (
          schedule.day_of_week !== null &&
          schedule.day_of_week !== now.getUTCDay()
        )
          return false;
        return elapsed >= 6 * 24 * 60 * 60 * 1_000;
      case "monthly":
        if (
          schedule.day_of_month !== null &&
          schedule.day_of_month !== now.getUTCDate()
        )
          return false;
        return elapsed >= 28 * 24 * 60 * 60 * 1_000;
      default:
        return false;
    }
  }
}
