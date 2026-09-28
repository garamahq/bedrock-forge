import { Injectable } from "@nestjs/common";
import { isHttpStatusWorking } from "@bedrock-forge/shared";
import { PrismaService } from "../../prisma/prisma.service";

export interface AttentionItem {
  id: string;
  severity: "critical" | "warning" | "info";
  type: string;
  title: string;
  description: string;
  environmentId?: number;
  projectId?: number;
  projectName?: string;
  action: string;
  actionPayload: Record<string, unknown>;
}

@Injectable()
export class DashboardRepository {
  constructor(private readonly prisma: PrismaService) {}

  async getSummaryData() {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const jobSelect = {
      id: true,
      queue_name: true,
      job_type: true,
      status: true,
      progress: true,
      last_error: true,
      payload: true,
      created_at: true,
      environment: {
        select: {
          id: true,
          url: true,
          project: { select: { id: true, name: true } },
        },
      },
    } as const;

    const [
      projectTotal,
      serverTotal,
      clientTotal,
      monitors,
      recentJobs,
      domainsExpiringSoon,
      runningJobs,
      failedJobs24h,
    ] = await Promise.all([
      this.prisma.project.count({
        where: { status: { not: "archived" } },
      }),
      this.prisma.server.count(),
      this.prisma.client.count(),
      this.prisma.monitor.findMany({
        where: {
          environment: {
            project: {
              status: { not: "archived" },
            },
          },
        },
        select: { last_status: true, uptime_pct: true },
      }),
      this.prisma.jobExecution.findMany({
        take: 8,
        orderBy: { created_at: "desc" },
        where: {
          status: { notIn: ["active", "queued"] },
          OR: [
            { environment: null },
            {
              environment: {
                project: { status: { not: "archived" } },
              },
            },
          ],
        },
        select: {
          id: true,
          queue_name: true,
          job_type: true,
          status: true,
          progress: true,
          created_at: true,
          environment: { select: { url: true } },
        },
      }),
      this.prisma.domain.count({
        where: {
          expires_at: {
            gte: new Date(),
            lte: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          },
        },
      }),
      this.prisma.jobExecution.findMany({
        where: {
          status: { in: ["active", "queued"] },
          OR: [
            { environment: null },
            {
              environment: {
                project: { status: { not: "archived" } },
              },
            },
          ],
        },
        orderBy: { created_at: "desc" },
        select: jobSelect,
      }),
      this.prisma.jobExecution.findMany({
        where: {
          status: { in: ["failed", "dead_letter"] },
          created_at: { gte: since24h },
          OR: [
            { environment: null },
            {
              environment: {
                project: { status: { not: "archived" } },
              },
            },
          ],
        },
        orderBy: { created_at: "desc" },
        take: 20,
        select: jobSelect,
      }),
    ]);

    return {
      projectTotal,
      serverTotal,
      clientTotal,
      monitors,
      recentJobs,
      domainsExpiringSoon,
      runningJobs,
      failedJobs24h,
    };
  }

  async getHealthScores() {
    const now = new Date();
    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const envSelect = {
      id: true,
      type: true,
      url: true,
      project: { select: { id: true, name: true } },
      monitors: { select: { last_status: true, uptime_pct: true }, take: 1 },
      backups: {
        where: { status: "completed" as const },
        orderBy: { created_at: "desc" as const },
        take: 1,
        select: { created_at: true },
      },
      plugin_scans: {
        orderBy: { scanned_at: "desc" as const },
        take: 1,
        select: { scanned_at: true },
      },
    } as const;

    const [environments, failedJobCounts, allDomains] = await Promise.all([
      this.prisma.environment.findMany({
        where: {
          project: {
            status: { not: "archived" },
          },
        },
        select: envSelect,
      }),
      this.prisma.jobExecution.groupBy({
        by: ["environment_id"],
        where: {
          status: { in: ["failed", "dead_letter"] },
          created_at: { gte: since7d },
          environment_id: { not: null },
          environment: {
            project: {
              status: { not: "archived" },
            },
          },
        },
        _count: { id: true },
      }),
      this.prisma.domain.findMany({
        where: { expires_at: { not: null } },
        select: { name: true, expires_at: true },
      }),
    ]);

    const failureMap = new Map(
      failedJobCounts.map((f) => [String(f.environment_id), f._count.id]),
    );
    const domainMap = new Map(
      allDomains.map((d) => [d.name.toLowerCase(), d.expires_at!]),
    );

    return environments.map((env) => {
      const monitor = env.monitors[0] ?? null;
      const latestBackup = env.backups[0] ?? null;
      const latestScan = env.plugin_scans[0] ?? null;
      const failureCount = failureMap.get(String(env.id)) ?? 0;

      let domainExpiresAt: Date | null = null;
      try {
        const hostname = new URL(env.url).hostname.replace(/^www\./, "");
        domainExpiresAt = domainMap.get(hostname) ?? null;
      } catch {
        /* invalid URL */
      }

      // Backup recency (0-25)
      let backupRecency = 0;
      if (latestBackup) {
        const daysAgo =
          (now.getTime() - new Date(latestBackup.created_at).getTime()) /
          86_400_000;
        backupRecency =
          daysAgo <= 1 ? 25 : daysAgo <= 3 ? 20 : daysAgo <= 7 ? 10 : 0;
      }

      // Uptime % (0-25)
      let uptimeScore = 0;
      if (monitor) {
        const pct = parseFloat(String(monitor.uptime_pct ?? 100));
        uptimeScore =
          pct >= 99.9
            ? 25
            : pct >= 99
              ? 20
              : pct >= 95
                ? 15
                : pct >= 90
                  ? 5
                  : 0;
      }

      // Domain expiry (0-20) — 20 when not tracked (assume ok)
      let domainScore = 20;
      if (domainExpiresAt) {
        const daysUntil =
          (domainExpiresAt.getTime() - now.getTime()) / 86_400_000;
        domainScore =
          daysUntil > 60 ? 20 : daysUntil > 30 ? 15 : daysUntil > 14 ? 5 : 0;
      }

      // Plugin scan freshness (0-15)
      let pluginScanScore = 0;
      if (latestScan) {
        const daysAgo =
          (now.getTime() - new Date(latestScan.scanned_at).getTime()) /
          86_400_000;
        pluginScanScore = daysAgo <= 7 ? 15 : daysAgo <= 30 ? 10 : 0;
      }

      // Job failure rate (0-15)
      const failureScore = failureCount === 0 ? 15 : failureCount <= 2 ? 8 : 0;

      const score =
        backupRecency +
        uptimeScore +
        domainScore +
        pluginScanScore +
        failureScore;

      return {
        environmentId: Number(env.id),
        projectId: Number(env.project.id),
        projectName: env.project.name,
        envType: env.type,
        url: env.url,
        score,
        breakdown: {
          backupRecency,
          uptimePct: uptimeScore,
          domainExpiry: domainScore,
          pluginScanFreshness: pluginScanScore,
          jobFailureRate: failureScore,
        },
      };
    });
  }

  async getAttentionItems(): Promise<AttentionItem[]> {
    const now = new Date();
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const since48h = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const in7d = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const in14d = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

    const envSelect = {
      id: true,
      type: true,
      url: true,
      project: { select: { id: true, name: true } },
    } as const;

    const [
      failedBackupJobs,
      failedSyncJobs,
      monitorsDown,
      expiringCritical,
      expiringWarning,
      envsStaleBackup,
      envsStaleScan,
      envsNoSchedule,
      envsNoMonitor,
      envsNoSecuritySchedule,
    ] = await Promise.all([
      this.prisma.jobExecution.findMany({
        where: {
          queue_name: "backups",
          status: { in: ["failed", "dead_letter"] },
          created_at: { gte: since24h },
          environment: {
            project: { status: { not: "archived" } },
          },
        },
        select: {
          id: true,
          last_error: true,
          environment: { select: envSelect },
        },
        take: 10,
        orderBy: { created_at: "desc" },
      }),
      this.prisma.jobExecution.findMany({
        where: {
          queue_name: "sync",
          status: { in: ["failed", "dead_letter"] },
          created_at: { gte: since24h },
          environment: {
            project: { status: { not: "archived" } },
          },
        },
        select: {
          id: true,
          last_error: true,
          environment: { select: envSelect },
        },
        take: 10,
        orderBy: { created_at: "desc" },
      }),
      this.prisma.monitor.findMany({
        where: {
          enabled: true,
          last_status: { not: null },
          environment: {
            project: { status: { not: "archived" } },
          },
        },
        select: {
          id: true,
          last_status: true,
          environment: { select: envSelect },
        },
      }),
      this.prisma.domain.findMany({
        where: { expires_at: { gte: now, lte: in7d } },
        select: { name: true, expires_at: true },
      }),
      this.prisma.domain.findMany({
        where: { expires_at: { gt: in7d, lte: in14d } },
        select: { name: true, expires_at: true },
      }),
      this.prisma.environment.findMany({
        where: {
          project: { status: { not: "archived" } },
          backups: {
            none: { status: "completed", completed_at: { gte: since48h } },
          },
        },
        select: {
          ...envSelect,
          backups: {
            where: { status: "completed" },
            orderBy: { completed_at: "desc" },
            take: 1,
            select: { completed_at: true, created_at: true },
          },
        },
        take: 20,
      }),
      this.prisma.environment.findMany({
        where: {
          project: { status: { not: "archived" } },
          OR: [
            { plugin_scans: { none: {} } },
            {
              plugin_scans: {
                some: { scanned_at: { lt: since30d } },
                none: { scanned_at: { gte: since30d } },
              },
            },
          ],
        },
        select: {
          ...envSelect,
          plugin_scans: {
            orderBy: { scanned_at: "desc" },
            take: 1,
            select: { scanned_at: true },
          },
        },
        take: 20,
      }),
      this.prisma.environment.findMany({
        where: {
          project: { status: { not: "archived" } },
          backup_schedule: null,
        },
        select: envSelect,
        take: 20,
      }),
      this.prisma.environment.findMany({
        where: {
          project: { status: { not: "archived" } },
          monitors: { none: {} },
        },
        select: envSelect,
        take: 20,
      }),
      this.prisma.environment.findMany({
        where: {
          project: { status: { not: "archived" } },
          security_scan_schedules: null,
        },
        select: envSelect,
        take: 20,
      }),
    ]);

    const items: AttentionItem[] = [];

    for (const job of failedBackupJobs) {
      if (!job.environment) continue;
      items.push({
        id: `backup_failed_${job.id}`,
        severity: "critical",
        type: "backup_failed",
        title: "Backup failed",
        description: job.last_error?.slice(0, 100) ?? "Backup job failed",
        environmentId: Number(job.environment.id),
        projectId: Number(job.environment.project.id),
        projectName: job.environment.project.name,
        action: "retry-backup",
        actionPayload: { environmentId: Number(job.environment.id) },
      });
    }

    for (const monitor of monitorsDown.filter(
      (m) => !isHttpStatusWorking(m.last_status),
    )) {
      items.push({
        id: `monitor_down_${monitor.id}`,
        severity: "critical",
        type: "monitor_down",
        title: "Site is down",
        description: `${monitor.environment.url} — HTTP ${monitor.last_status}`,
        environmentId: Number(monitor.environment.id),
        projectId: Number(monitor.environment.project.id),
        projectName: monitor.environment.project.name,
        action: "open-monitor",
        actionPayload: { environmentId: Number(monitor.environment.id) },
      });
    }

    for (const domain of expiringCritical) {
      const days = Math.ceil(
        (domain.expires_at!.getTime() - now.getTime()) / 86_400_000,
      );
      items.push({
        id: `domain_critical_${domain.name}`,
        severity: "critical",
        type: "domain_expiring",
        title: "Domain expiring soon",
        description: `${domain.name} expires in ${days} day${days !== 1 ? "s" : ""}`,
        action: "open-domain",
        actionPayload: { domainName: domain.name },
      });
    }

    for (const job of failedSyncJobs) {
      if (!job.environment) continue;
      items.push({
        id: `sync_failed_${job.id}`,
        severity: "warning",
        type: "sync_failed",
        title: "Sync failed",
        description: job.last_error?.slice(0, 100) ?? "Sync job failed",
        environmentId: Number(job.environment.id),
        projectId: Number(job.environment.project.id),
        projectName: job.environment.project.name,
        action: "open-activity",
        actionPayload: {},
      });
    }

    for (const env of envsStaleBackup.slice(0, 10)) {
      const latestBackup = env.backups[0];
      const lastBackup = latestBackup?.completed_at ?? latestBackup?.created_at;
      const ageHours = lastBackup
        ? Math.floor((now.getTime() - lastBackup.getTime()) / 3_600_000)
        : null;
      const freshness =
        ageHours === null
          ? "No successful backup has been recorded."
          : ageHours < 48
            ? `Last successful backup was ${ageHours} hour${ageHours === 1 ? "" : "s"} ago.`
            : `Last successful backup was ${Math.floor(ageHours / 24)} days ago.`;
      items.push({
        id: `backup_overdue_${env.id}`,
        severity: "warning",
        type: "backup_overdue",
        title: "Backup overdue",
        description: `${env.url} — ${freshness}`,
        environmentId: Number(env.id),
        projectId: Number(env.project.id),
        projectName: env.project.name,
        action: "trigger-backup",
        actionPayload: { environmentId: Number(env.id) },
      });
    }

    for (const domain of expiringWarning) {
      const days = Math.ceil(
        (domain.expires_at!.getTime() - now.getTime()) / 86_400_000,
      );
      items.push({
        id: `domain_warning_${domain.name}`,
        severity: "warning",
        type: "domain_warning",
        title: "Domain expiring soon",
        description: `${domain.name} expires in ${days} days`,
        action: "open-domain",
        actionPayload: { domainName: domain.name },
      });
    }

    for (const env of envsStaleScan.slice(0, 10)) {
      const lastScan = env.plugin_scans[0]?.scanned_at;
      const freshness = lastScan
        ? `Last plugin scan was ${Math.floor((now.getTime() - lastScan.getTime()) / 86_400_000)} days ago.`
        : "No plugin scan has been recorded.";
      items.push({
        id: `plugin_scan_stale_${env.id}`,
        severity: "warning",
        type: "plugin_scan_stale",
        title: "Plugin scan stale",
        description: `${env.url} — ${freshness}`,
        environmentId: Number(env.id),
        projectId: Number(env.project.id),
        projectName: env.project.name,
        action: "trigger-scan",
        actionPayload: { environmentId: Number(env.id) },
      });
    }

    for (const env of envsNoSchedule.slice(0, 10)) {
      items.push({
        id: `no_backup_schedule_${env.id}`,
        severity: "info",
        type: "no_backup_schedule",
        title: "No backup schedule",
        description: `${env.url} has no automated backup schedule`,
        environmentId: Number(env.id),
        projectId: Number(env.project.id),
        projectName: env.project.name,
        action: "open-project",
        actionPayload: { projectId: Number(env.project.id) },
      });
    }

    for (const env of envsNoMonitor.slice(0, 10)) {
      items.push({
        id: `no_monitor_${env.id}`,
        severity: "info",
        type: "no_monitor",
        title: "No monitor configured",
        description: `${env.url} has no uptime monitor`,
        environmentId: Number(env.id),
        projectId: Number(env.project.id),
        projectName: env.project.name,
        action: "open-monitors",
        actionPayload: { environmentId: Number(env.id) },
      });
    }

    for (const env of envsNoSecuritySchedule.slice(0, 10)) {
      items.push({
        id: `no_security_schedule_${env.id}`,
        severity: "info",
        type: "no_security_schedule",
        title: "No security scan schedule",
        description: `${env.url} has no automated security scan schedule`,
        environmentId: Number(env.id),
        projectId: Number(env.project.id),
        projectName: env.project.name,
        action: "open-project-security",
        actionPayload: { projectId: Number(env.project.id) },
      });
    }

    const order: Record<string, number> = { critical: 0, warning: 1, info: 2 };
    items.sort((a, b) => order[a.severity] - order[b.severity]);
    return items;
  }

  async get24hSummary() {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [
      backupsSucceeded,
      backupsFailed,
      monitorDownCount,
      monitorLogs,
      syncOperations,
      pluginUpdates,
    ] = await Promise.all([
      this.prisma.backup.count({
        where: {
          status: "completed",
          created_at: { gte: since24h },
          environment: {
            project: { status: { not: "archived" } },
          },
        },
      }),
      this.prisma.backup.count({
        where: {
          status: "failed",
          created_at: { gte: since24h },
          environment: {
            project: { status: { not: "archived" } },
          },
        },
      }),
      this.prisma.monitorLog.count({
        where: {
          event_type: "down",
          occurred_at: { gte: since24h },
          monitor: {
            environment: {
              project: { status: { not: "archived" } },
            },
          },
        },
      }),
      this.prisma.monitorLog.findMany({
        where: {
          event_type: "down",
          occurred_at: { gte: since24h },
          monitor: {
            environment: {
              project: { status: { not: "archived" } },
            },
          },
        },
        select: { duration_seconds: true },
      }),
      this.prisma.jobExecution.count({
        where: {
          queue_name: "sync",
          status: "completed",
          created_at: { gte: since24h },
          environment: {
            project: { status: { not: "archived" } },
          },
        },
      }),
      this.prisma.jobExecution.count({
        where: {
          queue_name: "plugin-updates",
          status: "completed",
          created_at: { gte: since24h },
          environment: {
            project: { status: { not: "archived" } },
          },
        },
      }),
    ]);

    const monitorDownMinutesTotal = Math.round(
      monitorLogs.reduce((sum, l) => sum + (l.duration_seconds ?? 0), 0) / 60,
    );

    return {
      backupsSucceeded,
      backupsFailed,
      monitorDownEvents: monitorDownCount,
      monitorDownMinutesTotal,
      syncOperations,
      pluginUpdates,
    };
  }
}
