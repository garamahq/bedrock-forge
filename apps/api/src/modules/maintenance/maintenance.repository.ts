import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";

@Injectable()
export class MaintenanceRepository {
  constructor(private readonly prisma: PrismaService) {}

  async failInterruptedJobs(): Promise<{ count: number }> {
    return this.prisma.jobExecution.updateMany({
      where: { status: "active" },
      data: {
        status: "failed",
        last_error: "Process interrupted — forge was restarted",
        completed_at: new Date(),
      },
    });
  }

  async deleteExpiredTokens(now: Date): Promise<{ count: number }> {
    return this.prisma.refreshToken.deleteMany({
      where: {
        OR: [{ expires_at: { lt: now } }, { revoked_at: { not: null } }],
      },
    });
  }

  async deleteOldNotificationLogs(cutoff: Date): Promise<{ count: number }> {
    return this.prisma.notificationLog.deleteMany({
      where: { created_at: { lt: cutoff } },
    });
  }

  async deleteOldAuditLogs(cutoff: Date): Promise<{ count: number }> {
    return this.prisma.auditLog.deleteMany({
      where: { created_at: { lt: cutoff } },
    });
  }

  async deleteOldJobExecutions(cutoff: Date): Promise<{ count: number }> {
    return this.prisma.jobExecution.deleteMany({
      where: {
        status: { in: ["completed", "failed", "dead_letter"] },
        completed_at: { lt: cutoff },
      },
    });
  }

  async deleteOldUserNotifications(cutoff: Date): Promise<{ count: number }> {
    return this.prisma.userNotification.deleteMany({
      where: { created_at: { lt: cutoff } },
    });
  }

  async deleteOldSecurityScans(cutoff: Date): Promise<{ count: number }> {
    return this.prisma.securityScan.deleteMany({
      where: {
        created_at: { lt: cutoff },
        status: { in: ["completed", "failed", "pending"] },
      },
    });
  }

  async deleteOldLighthouseAudits(cutoff: Date): Promise<{ count: number }> {
    return this.prisma.lighthouseAudit.deleteMany({
      where: {
        created_at: { lt: cutoff },
        status: { in: ["completed", "failed", "queued"] },
      },
    });
  }

  async findMonitor(id: bigint) {
    return this.prisma.monitor.findUnique({ where: { id } });
  }

  async findBackupSchedule(id: bigint) {
    return this.prisma.backupSchedule.findUnique({ where: { id } });
  }

  async findPluginUpdateSchedule(id: bigint) {
    return this.prisma.pluginUpdateSchedule.findUnique({ where: { id } });
  }
}
