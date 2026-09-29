import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../../prisma/prisma.service";

/**
 * How far back we keep operational audit data.
 * Any completed record older than this threshold is eligible for purge.
 */
const RETENTION_MONTHS = 6;

function sixMonthsAgo(): Date {
  const d = new Date();
  d.setMonth(d.getMonth() - RETENTION_MONTHS);
  return d;
}

/**
 * SecurityDataRetentionService
 *
 * Runs once per night (wired via security processor scheduler tick).
 * Deletes old completed/failed operational records to keep the database lean:
 *
 *   - job_executions      → completed | failed | dead_letter | discarded > 6 months
 *   - security_scans      → completed | failed               > 6 months
 *   - plugin_scans        → all                              > 6 months
 *   - theme_scans         → all                              > 6 months
 *   - lighthouse_audits   → all                              > 6 months
 *   - monitor_results     → all                              > 6 months
 *   - monitor_logs        → all                              > 6 months
 *   - system_backups      → completed | failed               > 6 months
 *
 * Only terminal-state records are removed — queued/active/running rows
 * are always preserved regardless of age.
 */
@Injectable()
export class SecurityDataRetentionService {
  private readonly logger = new Logger(SecurityDataRetentionService.name);

  constructor(private readonly prisma: PrismaService) {}

  async runRetentionPurge(): Promise<void> {
    const cutoff = sixMonthsAgo();
    this.logger.log(
      `[Retention] Starting data retention purge — cutoff: ${cutoff.toISOString()}`,
    );

    const results = await Promise.allSettled([
      this.purgeJobExecutions(cutoff),
      this.purgeSecurityScans(cutoff),
      this.purgePluginScans(cutoff),
      this.purgeThemeScans(cutoff),
      this.purgeLighthouseAudits(cutoff),
      this.purgeMonitorResults(cutoff),
      this.purgeMonitorLogs(cutoff),
      this.purgeSystemBackups(cutoff),
      this.purgeAuditLogs(cutoff),
      this.purgeNotificationLogs(cutoff),
      this.purgeUserNotifications(cutoff),
    ]);

    let totalDeleted = 0;
    for (const result of results) {
      if (result.status === "fulfilled") {
        totalDeleted += result.value;
      } else {
        this.logger.error(
          `[Retention] Purge task failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
        );
      }
    }

    this.logger.log(
      `[Retention] Purge complete — ${totalDeleted} record(s) deleted across all tables`,
    );
  }

  // ─── Individual table purges ────────────────────────────────────────────────

  private async purgeJobExecutions(cutoff: Date): Promise<number> {
    const { count } = await this.prisma.jobExecution.deleteMany({
      where: {
        status: { in: ["completed", "failed", "dead_letter", "discarded"] },
        completed_at: { lt: cutoff },
      },
    });
    if (count > 0) {
      this.logger.log(`[Retention] job_executions: deleted ${count} row(s)`);
    }
    return count;
  }

  private async purgeSecurityScans(cutoff: Date): Promise<number> {
    const { count } = await this.prisma.securityScan.deleteMany({
      where: {
        status: { in: ["completed", "failed"] },
        completed_at: { lt: cutoff },
      },
    });
    if (count > 0) {
      this.logger.log(`[Retention] security_scans: deleted ${count} row(s)`);
    }
    return count;
  }

  private async purgePluginScans(cutoff: Date): Promise<number> {
    const { count } = await this.prisma.pluginScan.deleteMany({
      where: {
        created_at: { lt: cutoff },
      },
    });
    if (count > 0) {
      this.logger.log(`[Retention] plugin_scans: deleted ${count} row(s)`);
    }
    return count;
  }

  private async purgeThemeScans(cutoff: Date): Promise<number> {
    const { count } = await this.prisma.themeScan.deleteMany({
      where: {
        created_at: { lt: cutoff },
      },
    });
    if (count > 0) {
      this.logger.log(`[Retention] theme_scans: deleted ${count} row(s)`);
    }
    return count;
  }

  private async purgeLighthouseAudits(cutoff: Date): Promise<number> {
    const { count } = await this.prisma.lighthouseAudit.deleteMany({
      where: {
        created_at: { lt: cutoff },
      },
    });
    if (count > 0) {
      this.logger.log(`[Retention] lighthouse_audits: deleted ${count} row(s)`);
    }
    return count;
  }

  private async purgeMonitorResults(cutoff: Date): Promise<number> {
    const { count } = await this.prisma.monitorResult.deleteMany({
      where: {
        checked_at: { lt: cutoff },
      },
    });
    if (count > 0) {
      this.logger.log(`[Retention] monitor_results: deleted ${count} row(s)`);
    }
    return count;
  }

  private async purgeMonitorLogs(cutoff: Date): Promise<number> {
    const { count } = await this.prisma.monitorLog.deleteMany({
      where: {
        occurred_at: { lt: cutoff },
      },
    });
    if (count > 0) {
      this.logger.log(`[Retention] monitor_logs: deleted ${count} row(s)`);
    }
    return count;
  }

  private async purgeSystemBackups(cutoff: Date): Promise<number> {
    const { count } = await this.prisma.systemBackup.deleteMany({
      where: {
        status: { in: ["completed", "failed"] },
        completed_at: { lt: cutoff },
      },
    });
    if (count > 0) {
      this.logger.log(`[Retention] system_backups: deleted ${count} row(s)`);
    }
    return count;
  }

  private async purgeAuditLogs(cutoff: Date): Promise<number> {
    const { count } = await this.prisma.auditLog.deleteMany({
      where: {
        created_at: { lt: cutoff },
      },
    });
    if (count > 0) {
      this.logger.log(`[Retention] audit_logs: deleted ${count} row(s)`);
    }
    return count;
  }

  private async purgeNotificationLogs(cutoff: Date): Promise<number> {
    const { count } = await this.prisma.notificationLog.deleteMany({
      where: {
        created_at: { lt: cutoff },
      },
    });
    if (count > 0) {
      this.logger.log(`[Retention] notification_logs: deleted ${count} row(s)`);
    }
    return count;
  }

  private async purgeUserNotifications(cutoff: Date): Promise<number> {
    const { count } = await this.prisma.userNotification.deleteMany({
      where: {
        created_at: { lt: cutoff },
      },
    });
    if (count > 0) {
      this.logger.log(
        `[Retention] user_notifications: deleted ${count} row(s)`,
      );
    }
    return count;
  }
}
