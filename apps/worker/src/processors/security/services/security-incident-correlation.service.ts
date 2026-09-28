import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../../prisma/prisma.service";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { QUEUES, SecurityFindingCategory } from "@bedrock-forge/shared";

interface IncidentPattern {
  name: string;
  title: string;
  summary: string;
  severity: "critical" | "high" | "medium";
  confidence: "high" | "medium";
  requiredCategories: SecurityFindingCategory[];
  minMatches: number;
}

const CORRELATION_PATTERNS: IncidentPattern[] = [
  {
    name: "WEBSHELL_AND_RCE",
    title: "Webshell Backdoor & Remote Command Execution Threat",
    summary:
      "Multiple correlated signals indicate an active webshell or reverse shell backdoor coupled with anomalous process execution.",
    severity: "critical",
    confidence: "high",
    requiredCategories: [
      "MALWARE",
      "REVERSE_SHELL",
      "PROCESS_ANOMALY",
      "DELETED_EXECUTABLE",
      "SUSPICIOUS_FILES",
    ],
    minMatches: 2,
  },
  {
    name: "ROOT_PERSISTENCE_ESCALATION",
    title: "Privilege Escalation & Unauthorized Persistence Threat",
    summary:
      "Detected suspicious account modifications or rogue UID 0 / passwordless sudo combined with backdoor cron tasks or SSH keys.",
    severity: "critical",
    confidence: "high",
    requiredCategories: [
      "USERS",
      "CRON_JOBS",
      "AUTHORIZED_KEYS",
      "SUID_BINARIES",
      "WORLD_WRITABLE",
    ],
    minMatches: 2,
  },
  {
    name: "EXPOSED_DB_NO_FIREWALL",
    title: "Unprotected Database Service & Host Firewall Exposure",
    summary:
      "A sensitive database or cache service (MySQL, PostgreSQL, Redis) is listening on public interfaces while the host firewall is inactive or allowing open traffic.",
    severity: "high",
    confidence: "high",
    requiredCategories: ["LISTENING_PORTS", "FIREWALL"],
    minMatches: 2,
  },
  {
    name: "BRUTE_FORCE_INFILTRATION",
    title: "Brute Force Attack Storm & Authentication Exposure",
    summary:
      "Large spike in failed SSH logins detected while Fail2Ban is inactive or no defensive jails are operating.",
    severity: "high",
    confidence: "medium",
    requiredCategories: ["FAILED_LOGINS", "FAIL2BAN", "SSH_CONFIG"],
    minMatches: 2,
  },
];

@Injectable()
export class SecurityIncidentCorrelationService {
  private readonly logger = new Logger(SecurityIncidentCorrelationService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUES.NOTIFICATIONS) private readonly notifQueue: Queue,
  ) {}

  /**
   * Evaluates active findings for a server and correlates them into security incidents.
   */
  async correlateServerIncidents(serverId: number) {
    this.logger.log(`Running incident correlation for server ${serverId}`);

    // Fetch all open/investigating/new findings for this server
    const findings = await this.prisma.securityFinding.findMany({
      where: {
        server_id: BigInt(serverId),
        status: { in: ["new", "investigating", "acknowledged"] },
      },
    });

    if (findings.length < 2) {
      return { incidentsCreated: 0, incidentsUpdated: 0 };
    }

    let createdCount = 0;
    let updatedCount = 0;

    for (const pattern of CORRELATION_PATTERNS) {
      const matchingFindings = findings.filter((f) =>
        pattern.requiredCategories.includes(f.category as SecurityFindingCategory),
      );

      // Verify distinct categories matching the pattern
      const matchedCategories = new Set(matchingFindings.map((f) => f.category));

      if (matchedCategories.size >= pattern.minMatches) {
        // Check if an open incident already exists for this server & title
        const existingIncident = await this.prisma.securityIncident.findFirst({
          where: {
            server_id: BigInt(serverId),
            title: pattern.title,
            status: { in: ["open", "investigating"] },
          },
        });

        if (existingIncident) {
          // Link any unlinked findings to this incident
          const unlinkedFindingIds = matchingFindings
            .filter((f) => f.incident_id === null || f.incident_id !== existingIncident.id)
            .map((f) => f.id);

          if (unlinkedFindingIds.length > 0) {
            await this.prisma.securityFinding.updateMany({
              where: { id: { in: unlinkedFindingIds } },
              data: { incident_id: existingIncident.id },
            });
            updatedCount++;
          }
        } else {
          // Create a new incident
          const incident = await this.prisma.securityIncident.create({
            data: {
              server_id: BigInt(serverId),
              title: pattern.title,
              summary: `${pattern.summary} (Correlated from ${matchingFindings.length} distinct findings across ${matchedCategories.size} categories: ${Array.from(matchedCategories).join(", ")})`,
              severity: pattern.severity,
              confidence: pattern.confidence,
              status: "open",
            },
          });

          // Link all matching findings
          await this.prisma.securityFinding.updateMany({
            where: { id: { in: matchingFindings.map((f) => f.id) } },
            data: { incident_id: incident.id },
          });

          // Dispatch notification
          try {
            await this.notifQueue.add("security-incident-alert", {
              incidentId: Number(incident.id),
              serverId,
              title: pattern.title,
              severity: pattern.severity,
              summary: incident.summary,
            });
          } catch (err) {
            this.logger.warn(
              `Failed to dispatch notification for incident ${incident.id}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }

          createdCount++;
        }
      }
    }

    return { incidentsCreated: createdCount, incidentsUpdated: updatedCount };
  }
}
