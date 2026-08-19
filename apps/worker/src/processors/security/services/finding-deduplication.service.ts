import { Injectable, Logger } from "@nestjs/common";
import { createHash } from "crypto";
import { PrismaService } from "../../../prisma/prisma.service";
import type { SecurityFinding, SecuritySeverity } from "@bedrock-forge/shared";
import type { SecurityFindingStatus } from "@prisma/client";

export interface UpsertFindingsParams {
  serverId?: number;
  environmentId?: number;
  scanId?: number;
  findings: SecurityFinding[];
  scannerVersion?: string;
}

@Injectable()
export class FindingDeduplicationService {
  private readonly logger = new Logger(FindingDeduplicationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Computes a deterministic dedup_key for a security finding based on its
   * target scope (server or environment), category, title, and resource path.
   */
  computeDedupKey(
    scope: { serverId?: number; environmentId?: number },
    category: string,
    title: string,
    resource?: string,
  ): string {
    const raw = `${scope.serverId ?? ""}:${scope.environmentId ?? ""}:${category.trim().toLowerCase()}:${title.trim().toLowerCase()}:${(resource ?? "").trim().toLowerCase()}`;
    return createHash("sha1").update(raw).digest("hex").substring(0, 32);
  }

  /**
   * Persists findings into the security_findings table:
   * - Inserts new findings with status = 'new' and creates an initial transition record.
   * - Updates existing findings (updating last_seen_at, severity, description, evidence, etc.).
   * - If a previously resolved/ignored/remediated finding is found again, reopens it as 'new' with a transition record.
   */
  async upsertFindings(params: UpsertFindingsParams): Promise<void> {
    const { serverId, environmentId, scanId, findings, scannerVersion } = params;
    if (!findings || findings.length === 0) return;

    const now = new Date();

    for (const f of findings) {
      const dedupKey = this.computeDedupKey(
        { serverId, environmentId },
        f.category,
        f.title,
        f.resource,
      );

      try {
        const existing = await this.prisma.securityFinding.findFirst({
          where: { dedup_key: dedupKey },
        });

        if (existing) {
          const shouldReopen =
            existing.status === "resolved" ||
            existing.status === "ignored" ||
            existing.status === "remediated" ||
            existing.status === "false_positive";

          const newStatus: SecurityFindingStatus = shouldReopen
            ? "new"
            : existing.status;

          await this.prisma.securityFinding.update({
            where: { id: existing.id },
            data: {
              scan_id: scanId ? BigInt(scanId) : existing.scan_id,
              severity: f.severity as SecuritySeverity,
              status: newStatus,
              description: f.description,
              evidence: (f.metadata ?? null) as any,
              resource: f.resource ?? null,
              recommendation: f.remediation ?? null,
              remediation_available: f.remediation_available ?? false,
              remediation_type: f.remediation_type ?? null,
              remediation_meta: (f.remediation_meta ?? null) as any,
              last_seen_at: now,
              resolved_at: shouldReopen ? null : existing.resolved_at,
              scanner_version: scannerVersion ?? existing.scanner_version,
            },
          });

          if (shouldReopen) {
            await this.prisma.securityFindingTransition.create({
              data: {
                finding_id: existing.id,
                from_status: existing.status,
                to_status: "new",
                note: "Reopened by scanner: finding re-detected during scan",
              },
            });
            this.logger.log(
              `Reopened finding ${existing.id} [${f.category}] "${f.title}" (${existing.status} -> new)`,
            );
          }
        } else {
          const created = await this.prisma.securityFinding.create({
            data: {
              scan_id: scanId ? BigInt(scanId) : null,
              server_id: serverId ? BigInt(serverId) : null,
              environment_id: environmentId ? BigInt(environmentId) : null,
              category: f.category,
              severity: f.severity as SecuritySeverity,
              status: "new",
              title: f.title,
              description: f.description,
              evidence: (f.metadata ?? null) as any,
              resource: f.resource ?? null,
              recommendation: f.remediation ?? null,
              remediation_available: f.remediation_available ?? false,
              remediation_type: f.remediation_type ?? null,
              remediation_meta: (f.remediation_meta ?? null) as any,
              first_seen_at: now,
              last_seen_at: now,
              scanner_version: scannerVersion ?? "1.0.0",
              dedup_key: dedupKey,
            },
          });

          await this.prisma.securityFindingTransition.create({
            data: {
              finding_id: created.id,
              from_status: null,
              to_status: "new",
              note: "Initial detection by security scanner",
            },
          });

          this.logger.debug(
            `Created new security finding ${created.id} [${f.severity}] ${f.title}`,
          );
        }
      } catch (err) {
        this.logger.error(
          `Failed to upsert finding "${f.title}" (dedup_key: ${dedupKey}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}
