import { Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue, Job } from "bullmq";
import { PrismaService } from "../../../prisma/prisma.service";
import { SshKeyService } from "../../../services/ssh-key.service";
import { createRemoteExecutor } from "@bedrock-forge/remote-executor";
import { QUEUES, JOB_TYPES } from "@bedrock-forge/shared";
import type {
  SecurityServerScanPayload,
  SecurityEnvironmentScanPayload,
  SecurityScanType,
  SecurityScanSummary,
} from "@bedrock-forge/shared";
import { calculateScore, buildSummary } from "../scoring";
import {
  runSshAudit,
  runServerHardening,
  runMalwareScan,
  runSystemAudit,
  runProcessAudit,
  runNetworkAudit,
  runFirewallAudit,
  runFail2BanAudit,
  runServiceAudit,
  runFilesystemAudit,
  runCronAudit,
  runUserAudit,
  runCyberPanelAudit,
  runPhpAudit,
  runSecurityToolsAudit,
} from "../server-checks";
import {
  runWpAudit,
  runProjectMalware,
  runBackdoorSearch,
  runPluginAudit,
} from "../environment-checks";
import { StepTracker } from "../../../services/step-tracker";
import { FindingDeduplicationService } from "./finding-deduplication.service";
import { SecurityIncidentCorrelationService } from "./security-incident-correlation.service";
import { SecurityAlertRuleEngineService } from "./security-alert-rule-engine.service";

@Injectable()
export class SecurityScanRunnerService {
  private readonly logger = new Logger(SecurityScanRunnerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sshKey: SshKeyService,
    private readonly findingDedup: FindingDeduplicationService,
    private readonly incidentCorrelation: SecurityIncidentCorrelationService,
    private readonly alertRuleEngine: SecurityAlertRuleEngineService,
    @InjectQueue(QUEUES.NOTIFICATIONS)
    private readonly notificationsQueue: Queue,
  ) {}

  async processServerScan(job: Job) {
    const { serverId, scanTypes, jobExecutionId, scanIds } =
      job.data as SecurityServerScanPayload & { scheduleId?: number };

    const tracker = await StepTracker.start(
      this.prisma,
      jobExecutionId,
      this.logger,
      job,
    );

    try {
      const server = await this.prisma.server.findUnique({
        where: { id: BigInt(serverId) },
      });
      if (!server) {
        throw new Error(`Server ${serverId} not found`);
      }

      let remoteExecutor: ReturnType<typeof createRemoteExecutor>;
      try {
        remoteExecutor = createRemoteExecutor(
          await this.sshKey.getSshConfig(server),
        );
      } catch (err) {
        for (const scanId of scanIds ?? []) {
          await this.prisma.securityScan.update({
            where: { id: BigInt(scanId) },
            data: { status: "failed", error: "SSH key unavailable" },
          });
        }
        throw new Error(
          `SSH key resolution failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      for (let i = 0; i < scanTypes.length; i++) {
        const scanType = scanTypes[i] as SecurityScanType;
        const scanId = scanIds?.[i];

        await tracker.track({ step: `Running ${scanType}`, level: "info" });

        if (scanId) {
          await this.prisma.securityScan.update({
            where: { id: BigInt(scanId) },
            data: { status: "running", started_at: new Date() },
          });
        }

        try {
          const findings = await this.runServerCheck(scanType, remoteExecutor);
          const score = calculateScore(findings);
          const summary = buildSummary(findings);

          if (scanId) {
            await this.prisma.securityScan.update({
              where: { id: BigInt(scanId) },
              data: {
                status: "completed",
                score,
                summary: summary as any,
                findings: findings as unknown as Parameters<
                  typeof this.prisma.securityScan.update
                >[0]["data"]["findings"],
                completed_at: new Date(),
              },
            });

            await this.findingDedup.upsertFindings({
              serverId,
              scanId,
              findings,
              scannerVersion: "1.0.0",
            });
          }

          await this.alertRuleEngine.evaluateFindings(
            serverId,
            undefined,
            findings,
          );

          this.logger.log(
            `[Server ${serverId}] ${scanType} completed — score: ${score}, findings: ${findings.length}`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.error(`[Server ${serverId}] ${scanType} failed: ${msg}`);
          if (scanId) {
            await this.prisma.securityScan.update({
              where: { id: BigInt(scanId) },
              data: { status: "failed", error: msg, completed_at: new Date() },
            });
          }
        }

        await job.updateProgress(
          Math.round(((i + 1) / scanTypes.length) * 100),
        );
      }

      await this.incidentCorrelation.correlateServerIncidents(serverId);
      await tracker.complete();

      const scheduleId = (job.data as { scheduleId?: number }).scheduleId;
      if (scheduleId && scanIds?.length) {
        await this.maybeNotify("server", serverId, scanIds);
      }
    } catch (err: unknown) {
      await tracker.fail(err, "Server scan");
      throw err;
    }
  }

  async processEnvironmentScan(job: Job) {
    const { environmentId, scanTypes, jobExecutionId, scanIds } =
      job.data as SecurityEnvironmentScanPayload & { scheduleId?: number };

    const tracker = await StepTracker.start(
      this.prisma,
      jobExecutionId,
      this.logger,
      job,
    );

    try {
      const environment = await this.prisma.environment.findUnique({
        where: { id: BigInt(environmentId) },
        include: { server: true },
      });
      if (!environment) {
        throw new Error(`Environment ${environmentId} not found`);
      }

      let remoteExecutor: ReturnType<typeof createRemoteExecutor>;
      try {
        remoteExecutor = createRemoteExecutor(
          await this.sshKey.getSshConfig(environment.server),
        );
      } catch (err) {
        for (const scanId of scanIds ?? []) {
          await this.prisma.securityScan.update({
            where: { id: BigInt(scanId) },
            data: { status: "failed", error: "SSH key unavailable" },
          });
        }
        throw new Error(
          `SSH key resolution failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      for (let i = 0; i < scanTypes.length; i++) {
        const scanType = scanTypes[i] as SecurityScanType;
        const scanId = scanIds?.[i];

        await tracker.track({ step: `Running ${scanType}`, level: "info" });

        if (scanId) {
          await this.prisma.securityScan.update({
            where: { id: BigInt(scanId) },
            data: { status: "running", started_at: new Date() },
          });
        }

        try {
          const findings = await this.runEnvironmentCheck(
            scanType,
            remoteExecutor,
            environment.root_path,
          );
          const score = calculateScore(findings);
          const summary = buildSummary(findings);

          if (scanId) {
            await this.prisma.securityScan.update({
              where: { id: BigInt(scanId) },
              data: {
                status: "completed",
                score,
                summary: summary as any,
                findings: findings as unknown as Parameters<
                  typeof this.prisma.securityScan.update
                >[0]["data"]["findings"],
                completed_at: new Date(),
              },
            });

            await this.findingDedup.upsertFindings({
              environmentId,
              scanId,
              findings,
              scannerVersion: "1.0.0",
            });
          }

          await this.alertRuleEngine.evaluateFindings(
            undefined,
            environmentId,
            findings,
          );

          this.logger.log(
            `[Env ${environmentId}] ${scanType} completed — score: ${score}, findings: ${findings.length}`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.error(
            `[Env ${environmentId}] ${scanType} failed: ${msg}`,
          );
          if (scanId) {
            await this.prisma.securityScan.update({
              where: { id: BigInt(scanId) },
              data: { status: "failed", error: msg, completed_at: new Date() },
            });
          }
        }

        await job.updateProgress(
          Math.round(((i + 1) / scanTypes.length) * 100),
        );
      }

      await tracker.complete();

      const scheduleId = (job.data as { scheduleId?: number }).scheduleId;
      if (scheduleId && scanIds?.length) {
        await this.maybeNotify("environment", environmentId, scanIds);
      }
    } catch (err: unknown) {
      await tracker.fail(err, "Environment scan");
      throw err;
    }
  }

  private async runServerCheck(
    scanType: SecurityScanType,
    executor: ReturnType<typeof createRemoteExecutor>,
  ) {
    switch (scanType) {
      case "SSH_AUDIT":
        return runSshAudit(executor);
      case "SERVER_HARDENING":
        return runServerHardening(executor);
      case "MALWARE_SCAN":
        return runMalwareScan(executor);
      case "SYSTEM_AUDIT": {
        const results = await Promise.all([
          runSystemAudit(executor),
          runCronAudit(executor),
          runUserAudit(executor),
        ]);
        return results.flat();
      }
      case "PROCESS_AUDIT":
        return runProcessAudit(executor);
      case "NETWORK_AUDIT": {
        const results = await Promise.all([
          runNetworkAudit(executor),
          runFirewallAudit(executor),
          runFail2BanAudit(executor),
        ]);
        return results.flat();
      }
      case "FILESYSTEM_AUDIT":
        return runFilesystemAudit(executor);
      case "SERVICE_AUDIT": {
        const results = await Promise.all([
          runServiceAudit(executor),
          runSecurityToolsAudit(executor),
        ]);
        return results.flat();
      }
      case "CYBERPANEL_AUDIT":
        return runCyberPanelAudit(executor);
      case "PHP_AUDIT":
        return runPhpAudit(executor);
      default:
        return [];
    }
  }

  private async runEnvironmentCheck(
    scanType: SecurityScanType,
    executor: ReturnType<typeof createRemoteExecutor>,
    rootPath: string,
  ) {
    switch (scanType) {
      case "WP_AUDIT":
        return runWpAudit(executor, rootPath);
      case "PROJECT_MALWARE":
        return runProjectMalware(executor, rootPath);
      case "BACKDOOR_SEARCH":
        return runBackdoorSearch(executor, rootPath);
      case "PLUGIN_AUDIT":
        return runPluginAudit(executor, rootPath);
      default:
        return [];
    }
  }

  private async maybeNotify(
    type: "server" | "environment",
    id: number,
    scanIds: number[],
  ) {
    try {
      const schedule = await this.prisma.securityScanSchedule.findUnique({
        where:
          type === "server"
            ? { server_id: BigInt(id) }
            : { environment_id: BigInt(id) },
      });
      if (!schedule || !schedule.notify_enabled) return;

      const scans = await this.prisma.securityScan.findMany({
        where: { id: { in: scanIds.map(BigInt) }, status: "completed" },
        select: { summary: true, score: true },
      });

      const agg: SecurityScanSummary = {
        critical: 0,
        high: 0,
        medium: 0,
        low: 0,
        info: 0,
      };
      let minScore = 100;
      for (const scan of scans) {
        const s = scan.summary as SecurityScanSummary | null;
        if (s) {
          agg.critical += s.critical ?? 0;
          agg.high += s.high ?? 0;
          agg.medium += s.medium ?? 0;
          agg.low += s.low ?? 0;
          agg.info += s.info ?? 0;
        }
        if (scan.score !== null && scan.score < minScore) minScore = scan.score;
      }

      const severityOrder: Array<keyof SecurityScanSummary> = [
        "info",
        "low",
        "medium",
        "high",
        "critical",
        "info", // Safe fallback
      ];
      const thresholdIdx = severityOrder.indexOf(
        schedule.notify_threshold as keyof SecurityScanSummary,
      );
      const shouldNotify =
        thresholdIdx !== -1 &&
        severityOrder.slice(thresholdIdx).some((sev) => agg[sev] > 0);

      if (!shouldNotify) return;

      const eventType =
        agg.critical > 0
          ? "security.critical_found"
          : agg.high > 0
            ? "security.high_found"
            : "security.scan_completed";

      await this.notificationsQueue.add(
        JOB_TYPES.NOTIFICATION_SEND,
        {
          eventType,
          payload:
            type === "server"
              ? { serverId: id, score: minScore, summary: agg }
              : { environmentId: id, score: minScore, summary: agg },
        },
        { removeOnComplete: 100, removeOnFail: 100 },
      );
    } catch (err) {
      this.logger.error(
        `Failed to dispatch security notification for ${type} ${id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
