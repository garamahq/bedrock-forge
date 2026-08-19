import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../../prisma/prisma.service";
import { SshKeyService } from "../../../services/ssh-key.service";
import { createRemoteExecutor } from "@bedrock-forge/remote-executor";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { QUEUES, SecurityFinding } from "@bedrock-forge/shared";
import { makeFinding } from "../scoring";
import { FindingDeduplicationService } from "./finding-deduplication.service";
import { SecurityAlertRuleEngineService } from "./security-alert-rule-engine.service";
import { SecurityIncidentCorrelationService } from "./security-incident-correlation.service";

@Injectable()
export class SecurityAgentlessWatcherService {
  private readonly logger = new Logger(SecurityAgentlessWatcherService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sshKey: SshKeyService,
    private readonly findingDedup: FindingDeduplicationService,
    private readonly alertRuleEngine: SecurityAlertRuleEngineService,
    private readonly incidentCorrelation: SecurityIncidentCorrelationService,
    @InjectQueue(QUEUES.NOTIFICATIONS) private readonly notifQueue: Queue,
  ) {}

  /**
   * Evaluates all servers for watcher health or executes agentless polling.
   */
  async checkServersWatcherHealth() {
    this.logger.debug("Checking server security watcher health and agentless polling...");

    const servers = await this.prisma.server.findMany({
      where: { status: "online" },
    });

    for (const server of servers) {
      try {
        await this.pollServer(server);
      } catch (err: any) {
        this.logger.warn(`Failed watcher check on server ${server.id}: ${err.message}`);
      }
    }
  }

  private async pollServer(server: any) {
    const serverId = Number(server.id);

    // Rapid agentless check
    const sshConfig = await this.sshKey.getSshConfig(server);
    const exec = createRemoteExecutor(sshConfig);

    const findings: SecurityFinding[] = [];

    // 1. Rapid check: Failed SSH logins in last 10m
    const { stdout: authLog } = await exec.execute(
      `journalctl -u ssh -u sshd --since "10 min ago" 2>/dev/null | grep -i "Failed password" | wc -l || true`,
      { timeout: 10_000 },
    );
    const failedLogins = parseInt(authLog.trim(), 10) || 0;
    if (failedLogins >= 20) {
      findings.push(
        makeFinding(
          "high",
          "FAILED_LOGINS",
          `High volume of failed SSH logins detected (${failedLogins} in last 10m)`,
          `Possible active brute-force attack underway on ${server.name}.`,
          { metadata: { count: failedLogins } },
        ),
      );
    }

    // 2. Rapid check: Rogue processes running in /tmp
    const { stdout: tmpProcs } = await exec.execute(
      `ls -l /proc/[0-9]*/exe 2>/dev/null | grep -E "/tmp|/var/tmp|/dev/shm" | awk '{print $NF}' || true`,
      { timeout: 10_000 },
    );
    const tmpExecutables = tmpProcs
      .trim()
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    if (tmpExecutables.length > 0) {
      findings.push(
        makeFinding(
          "critical",
          "PROCESS_ANOMALY",
          `Suspicious process running from temporary directory: ${tmpExecutables[0]}`,
          `Processes executing out of /tmp or /dev/shm are standard indicators of dropped malware or botnet miners.`,
          {
            remediation: `Inspect and terminate PID executing from /tmp`,
            resource: tmpExecutables[0],
            remediation_available: true,
            remediation_type: "QUARANTINE_FILE",
          },
        ),
      );
    }

    // Upsert any findings detected during rapid watcher poll
    if (findings.length > 0) {
      await this.findingDedup.upsertFindings({
        serverId,
        findings,
        scannerVersion: "watcher-1.0",
      });

      await this.alertRuleEngine.evaluateFindings(serverId, undefined, findings);
      await this.incidentCorrelation.correlateServerIncidents(serverId);
    }
  }
}
