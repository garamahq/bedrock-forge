import { Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { PrismaService } from "../../prisma/prisma.service";
import { QUEUES, JOB_TYPES } from "@bedrock-forge/shared";

interface ScannedFinding {
  severity: string;
  title: string;
  resource?: string;
}

type SecurityAttack =
  | {
      type: "batch_pattern";
      signature: string;
      targets: string[];
      title: string;
      count: number;
    }
  | { type: "mass_infection"; criticalCount: number; targetCount: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isScannedFinding(value: unknown): value is ScannedFinding {
  return (
    isRecord(value) &&
    typeof value.severity === "string" &&
    typeof value.title === "string" &&
    (value.resource === undefined || typeof value.resource === "string")
  );
}

@Injectable()
export class SecurityAttackWatcherService {
  private readonly logger = new Logger(SecurityAttackWatcherService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUES.NOTIFICATIONS)
    private readonly notificationsQueue: Queue,
  ) {}

  async processAttackWatcher() {
    this.logger.debug("Running security attack watcher...");
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1_000);

    // 1. Find all completed scans in the last 5 minutes
    const recentScans = await this.prisma.securityScan.findMany({
      where: {
        completed_at: { gte: fiveMinutesAgo },
        status: "completed",
      },
      include: { environment: { include: { project: true } }, server: true },
    });

    if (recentScans.length === 0) return;

    // 2. Identify "Attack" patterns: same backdoor or mass findings
    const findingsBySignature = new Map<
      string,
      Array<{ env?: string; server?: string; title: string }>
    >();
    let totalCritical = 0;

    for (const scan of recentScans) {
      const findings: ScannedFinding[] = [];
      if (Array.isArray(scan.findings)) {
        for (const candidate of scan.findings as unknown[]) {
          if (isScannedFinding(candidate)) findings.push(candidate);
        }
      }
      for (const f of findings) {
        if (f.severity === "critical" || f.severity === "high") {
          if (f.severity === "critical") totalCritical++;

          // Signature is title + resource (e.g. path)
          const sig = `${f.title}:${f.resource || "global"}`;
          const list = findingsBySignature.get(sig) || [];
          list.push({
            env: scan.environment?.project?.name
              ? `${scan.environment.project.name} (${scan.environment.type})`
              : undefined,
            server: scan.server?.name ?? undefined,
            title: f.title,
          });
          findingsBySignature.set(sig, list);
        }
      }
    }

    // 3. Detect "Batch Attack": same signature on multiple targets
    const attacks: SecurityAttack[] = [];
    for (const [sig, targets] of findingsBySignature.entries()) {
      if (targets.length >= 2) {
        attacks.push({
          type: "batch_pattern",
          signature: sig,
          targets: Array.from(
            new Set(
              targets
                .map((target) => target.env || target.server)
                .filter((target): target is string => target !== undefined),
            ),
          ),
          title: targets[0].title,
          count: targets.length,
        });
      }
    }

    // 4. Also detect "Mass Infection": spike in critical findings
    if (totalCritical >= 5) {
      attacks.push({
        type: "mass_infection",
        criticalCount: totalCritical,
        targetCount: new Set(
          recentScans.map((s) => s.environment_id || s.server_id),
        ).size,
      });
    }

    if (attacks.length > 0) {
      this.logger.warn(
        `🚨 Security Attack Detected! ${attacks.length} attack pattern(s) identified.`,
      );
      await this.notificationsQueue.add(
        JOB_TYPES.NOTIFICATION_SEND,
        {
          eventType: "security.attack_detected",
          payload: {
            timestamp: new Date().toISOString(),
            attacks,
          },
        },
        { removeOnComplete: 100, removeOnFail: 100 },
      );
    }
  }
}
