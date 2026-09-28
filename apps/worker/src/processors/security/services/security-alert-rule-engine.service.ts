import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../../prisma/prisma.service";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { QUEUES, SecurityFinding, SecuritySeverity } from "@bedrock-forge/shared";

const SEVERITY_WEIGHTS: Record<SecuritySeverity, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

@Injectable()
export class SecurityAlertRuleEngineService {
  private readonly logger = new Logger(SecurityAlertRuleEngineService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUES.NOTIFICATIONS) private readonly notifQueue: Queue,
  ) {}

  /**
   * Evaluates new or active findings against enabled SecurityAlertRules.
   */
  async evaluateFindings(
    serverId: number | undefined,
    environmentId: number | undefined,
    findings: SecurityFinding[],
  ) {
    if (findings.length === 0) return { rulesTriggered: 0 };

    const rules = await this.prisma.securityAlertRule.findMany({
      where: { enabled: true },
    });

    if (rules.length === 0) return { rulesTriggered: 0 };

    let triggeredCount = 0;
    const now = new Date();

    for (const rule of rules) {
      // 1. Check server filter
      if (
        rule.server_ids.length > 0 &&
        serverId &&
        !rule.server_ids.includes(BigInt(serverId))
      ) {
        continue;
      }

      // 2. Check cooldown
      if (rule.last_fired_at) {
        const cooldownMs = rule.cooldown_minutes * 60 * 1000;
        if (now.getTime() - rule.last_fired_at.getTime() < cooldownMs) {
          continue;
        }
      }

      // 3. Find matching findings
      const matchingFindings = findings.filter((f) => {
        // Check minimum severity
        if (rule.min_severity) {
          const ruleWeight = SEVERITY_WEIGHTS[rule.min_severity] || 0;
          const findingWeight = SEVERITY_WEIGHTS[f.severity] || 0;
          if (findingWeight < ruleWeight) return false;
        }

        // Check categories filter (empty means all)
        if (rule.categories.length > 0 && !rule.categories.includes(f.category)) {
          return false;
        }

        return true;
      });

      if (matchingFindings.length > 0) {
        // Trigger alert rule
        await this.prisma.securityAlertRule.update({
          where: { id: rule.id },
          data: { last_fired_at: now },
        });

        // If rule configured to create incident, create one
        if (rule.create_incident && serverId) {
          await this.prisma.securityIncident.create({
            data: {
              server_id: BigInt(serverId),
              title: `Alert Rule: ${rule.name}`,
              summary: `Triggered by ${matchingFindings.length} finding(s) matching alert rule "${rule.name}".`,
              severity: rule.min_severity ?? "high",
              confidence: "high",
              status: "open",
            },
          });
        }

        // Dispatch notification
        try {
          await this.notifQueue.add("security-alert-rule-fired", {
            ruleId: Number(rule.id),
            ruleName: rule.name,
            serverId,
            environmentId,
            matchCount: matchingFindings.length,
            findings: matchingFindings.slice(0, 5).map((f) => ({
              title: f.title,
              severity: f.severity,
              category: f.category,
            })),
          });
        } catch (err) {
          this.logger.warn(
            `Failed to enqueue notification for rule ${rule.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        triggeredCount++;
      }
    }

    return { rulesTriggered: triggeredCount };
  }
}
