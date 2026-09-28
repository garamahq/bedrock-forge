import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../../prisma/prisma.service";
import { SshKeyService } from "../../../services/ssh-key.service";
import { createRemoteExecutor } from "@bedrock-forge/remote-executor";
import { FindingDeduplicationService } from "./finding-deduplication.service";
import { makeFinding } from "../scoring";
import { createHash } from "crypto";
import { toPrismaJsonValue } from "../../../utils/prisma-json";

export interface BaselineItemData {
  category: string;
  key: string;
  value: unknown;
}

export interface DriftDiff {
  category: string;
  key: string;
  change_type: "added" | "removed" | "modified";
  old_value?: unknown;
  new_value?: unknown;
  severity: "critical" | "high" | "medium" | "low" | "info";
  description: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

@Injectable()
export class SecurityBaselineService {
  private readonly logger = new Logger(SecurityBaselineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sshKey: SshKeyService,
    private readonly findingDedup: FindingDeduplicationService,
  ) {}

  /**
   * Captures the known-good state of a server or environment into a SecurityBaseline.
   */
  async createBaseline(
    targetType: "server" | "environment",
    targetId: number,
    userId?: number,
    label?: string,
  ) {
    this.logger.log(`Creating baseline for ${targetType} ${targetId}`);
    const items = await this.collectCurrentState(targetType, targetId);

    return this.prisma.$transaction(async (tx) => {
      // Create new baseline record
      const baseline = await tx.securityBaseline.create({
        data: {
          server_id: targetType === "server" ? BigInt(targetId) : null,
          environment_id: targetType === "environment" ? BigInt(targetId) : null,
          created_by_id: userId ? BigInt(userId) : null,
          label: label || `Baseline captured on ${new Date().toISOString()}`,
        },
      });

      // Insert all baseline items
      if (items.length > 0) {
        await tx.securityBaselineItem.createMany({
          data: items.map((item) => ({
            baseline_id: baseline.id,
            category: item.category,
            key: item.key,
            value: toPrismaJsonValue(item.value),
          })),
        });
      }

      return {
        baselineId: Number(baseline.id),
        itemCount: items.length,
        label: baseline.label,
        createdAt: baseline.created_at,
      };
    });
  }

  /**
   * Compares the live target state against the most recent SecurityBaseline.
   * Generates SecurityDriftEvents and linked SecurityFindings.
   */
  async compareBaseline(
    targetType: "server" | "environment",
    targetId: number,
  ) {
    const latestBaseline = await this.prisma.securityBaseline.findFirst({
      where:
        targetType === "server"
          ? { server_id: BigInt(targetId) }
          : { environment_id: BigInt(targetId) },
      orderBy: { created_at: "desc" },
      include: { items: true },
    });

    if (!latestBaseline) {
      throw new NotFoundException(
        `No baseline found for ${targetType} ${targetId}. Please capture a baseline first.`,
      );
    }

    const currentItems = await this.collectCurrentState(targetType, targetId);
    const DELIM = ":::";
    const baselineMap = new Map<string, unknown>();
    for (const item of latestBaseline.items) {
      baselineMap.set(`${item.category}${DELIM}${item.key}`, item.value);
    }

    const currentMap = new Map<string, unknown>();
    for (const item of currentItems) {
      currentMap.set(`${item.category}${DELIM}${item.key}`, item.value);
    }

    const diffs: DriftDiff[] = [];

    // 1. Check for Added or Modified items
    for (const [compositeKey, currentVal] of currentMap.entries()) {
      const idx = compositeKey.indexOf(DELIM);
      const category = compositeKey.substring(0, idx);
      const key = compositeKey.substring(idx + DELIM.length);
      if (!baselineMap.has(compositeKey)) {
        diffs.push({
          category,
          key,
          change_type: "added",
          new_value: currentVal,
          severity: this.assessDriftSeverity(category, "added", currentVal),
          description: `New ${category} entry detected: ${key}`,
        });
      } else {
        const oldVal = baselineMap.get(compositeKey);
        const oldHash = JSON.stringify(oldVal);
        const newHash = JSON.stringify(currentVal);
        if (oldHash !== newHash) {
          diffs.push({
            category,
            key,
            change_type: "modified",
            old_value: oldVal,
            new_value: currentVal,
            severity: this.assessDriftSeverity(category, "modified", currentVal),
            description: `${category} entry modified: ${key}`,
          });
        }
      }
    }

    // 2. Check for Removed items
    for (const [compositeKey, oldVal] of baselineMap.entries()) {
      const idx = compositeKey.indexOf(DELIM);
      const category = compositeKey.substring(0, idx);
      const key = compositeKey.substring(idx + DELIM.length);
      if (!currentMap.has(compositeKey)) {
        diffs.push({
          category,
          key,
          change_type: "removed",
          old_value: oldVal,
          severity: this.assessDriftSeverity(category, "removed", oldVal),
          description: `${category} entry was removed: ${key}`,
        });
      }
    }

    // 3. Persist Drift Events and Security Findings
    const findingsToUpsert: ReturnType<typeof makeFinding>[] = [];
    const driftEventsCreated = [];

    for (const diff of diffs) {
      const driftEvent = await this.prisma.securityDriftEvent.create({
        data: {
          server_id: targetType === "server" ? BigInt(targetId) : null,
          environment_id: targetType === "environment" ? BigInt(targetId) : null,
          baseline_id: latestBaseline.id,
          category: diff.category,
          key: diff.key,
          change_type: diff.change_type,
          ...(diff.old_value !== undefined && {
            old_value: toPrismaJsonValue(diff.old_value),
          }),
          ...(diff.new_value !== undefined && {
            new_value: toPrismaJsonValue(diff.new_value),
          }),
        },
      });
      driftEventsCreated.push(driftEvent);

      findingsToUpsert.push(
        makeFinding(
          diff.severity,
          "BASE_DRIFT",
          `Security Baseline Drift: ${diff.change_type.toUpperCase()} in ${diff.category} (${diff.key})`,
          diff.description,
          {
            resource: diff.key,
            remediation: `Verify if the modification of ${diff.key} was an authorized change. If authorized, capture a new baseline to update expected state.`,
            metadata: {
              baselineId: Number(latestBaseline.id),
              driftEventId: Number(driftEvent.id),
              category: diff.category,
              changeType: diff.change_type,
              oldValue: diff.old_value,
              newValue: diff.new_value,
            },
          },
        ),
      );
    }

    if (findingsToUpsert.length > 0) {
      await this.findingDedup.upsertFindings({
        findings: findingsToUpsert,
        serverId: targetType === "server" ? targetId : undefined,
        environmentId: targetType === "environment" ? targetId : undefined,
      });
    }

    return {
      baselineId: Number(latestBaseline.id),
      totalCompared: currentItems.length,
      driftCount: diffs.length,
      diffs,
    };
  }

  /**
   * Helper to collect current system state items for baseline or comparison.
   */
  private async collectCurrentState(
    targetType: "server" | "environment",
    targetId: number,
  ): Promise<BaselineItemData[]> {
    if (targetType === "server") {
      return this.collectServerState(targetId);
    } else {
      return this.collectEnvironmentState(targetId);
    }
  }

  private async collectServerState(serverId: number): Promise<BaselineItemData[]> {
    const server = await this.prisma.server.findUnique({
      where: { id: BigInt(serverId) },
    });
    if (!server) throw new NotFoundException(`Server ${serverId} not found`);

    const sshKey = await this.sshKey.resolvePrivateKey(server);
    const executor = createRemoteExecutor({
      host: server.ip_address,
      port: server.ssh_port,
      username: server.ssh_user,
      privateKey: sshKey,
    });

    const items: BaselineItemData[] = [];

    // 1. Authorized SSH Keys
    const { stdout: authKeys } = await executor.execute(
      `cat /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys 2>/dev/null || true`,
      { timeout: 10000 },
    );
    for (const keyLine of authKeys.split("\n").filter((l) => l.trim() && !l.startsWith("#"))) {
      const parts = keyLine.trim().split(/\s+/);
      if (parts.length >= 2) {
        const keyType = parts[0];
        const keyBody = parts[1];
        const comment = parts[2] || "no-comment";
        const fp = createHash("sha256").update(keyBody).digest("hex").substring(0, 16);
        items.push({
          category: "ssh_keys",
          key: `${keyType}:${fp}`,
          value: { type: keyType, fingerprint: fp, comment },
        });
      }
    }

    // 2. System Users
    const { stdout: passwdOut } = await executor.execute(
      `awk -F: '{print $1, $3, $4, $6, $7}' /etc/passwd 2>/dev/null || true`,
      { timeout: 5000 },
    );
    for (const line of passwdOut.split("\n").filter(Boolean)) {
      const [user, uid, gid, home, shell] = line.trim().split(/\s+/);
      if (user) {
        items.push({
          category: "users",
          key: user,
          value: { uid: parseInt(uid, 10), gid: parseInt(gid, 10), home, shell },
        });
      }
    }

    // 3. Listening Ports
    const { stdout: portsOut } = await executor.execute(
      `ss -tlnp 2>/dev/null | awk 'NR>1 {print $4}' || true`,
      { timeout: 10000 },
    );
    for (const portEntry of portsOut.split("\n").filter(Boolean)) {
      items.push({
        category: "ports",
        key: portEntry.trim(),
        value: { address: portEntry.trim() },
      });
    }

    // 4. Enabled Systemd Services
    const { stdout: servicesOut } = await executor.execute(
      `systemctl list-unit-files --type=service --state=enabled --no-legend 2>/dev/null | awk '{print $1}' || true`,
      { timeout: 10000 },
    );
    for (const s of servicesOut.split("\n").filter(Boolean)) {
      items.push({
        category: "services",
        key: s.trim(),
        value: { enabled: true },
      });
    }

    // 5. Cron Jobs
    const { stdout: cronOut } = await executor.execute(
      `cat /etc/crontab /etc/cron.d/* /var/spool/cron/crontabs/* 2>/dev/null || true`,
      { timeout: 10000 },
    );
    let cronIndex = 0;
    for (const c of cronOut.split("\n").filter((l) => l.trim() && !l.startsWith("#"))) {
      cronIndex++;
      const hash = createHash("md5").update(c.trim()).digest("hex").substring(0, 8);
      items.push({
        category: "cron",
        key: `cron-${cronIndex}-${hash}`,
        value: { command: c.trim() },
      });
    }

    // 6. Security Tools Status
    const { stdout: secTools } = await executor.execute(
      `echo "fail2ban:$(systemctl is-active fail2ban 2>/dev/null || echo missing)"; ` +
        `echo "ufw:$(systemctl is-active ufw 2>/dev/null || echo missing)"`,
      { timeout: 5000 },
    );
    for (const t of secTools.split("\n").filter(Boolean)) {
      const [name, status] = t.split(":");
      if (name && status) {
        items.push({
          category: "security_tools",
          key: name.trim(),
          value: { status: status.trim() },
        });
      }
    }

    return items;
  }

  private async collectEnvironmentState(environmentId: number): Promise<BaselineItemData[]> {
    const env = await this.prisma.environment.findUnique({
      where: { id: BigInt(environmentId) },
      include: { server: true },
    });
    if (!env || !env.server) {
      throw new NotFoundException(`Environment ${environmentId} not found`);
    }

    const sshKey = await this.sshKey.resolvePrivateKey(env.server);
    const executor = createRemoteExecutor({
      host: env.server.ip_address,
      port: env.server.ssh_port,
      username: env.server.ssh_user,
      privateKey: sshKey,
    });

    const items: BaselineItemData[] = [];
    const rootPath = env.root_path || `/home/${env.server.ssh_user}/public_html`;

    // 1. WordPress Core Version
    const { stdout: wpVersion } = await executor.execute(
      `wp core version --path=${rootPath} --allow-root 2>/dev/null || true`,
      { timeout: 15000 },
    );
    if (wpVersion.trim()) {
      items.push({
        category: "wp_core",
        key: "version",
        value: { version: wpVersion.trim() },
      });
    }

    // 2. WordPress Plugins list & version & status
    const { stdout: pluginsOut } = await executor.execute(
      `wp plugin list --fields=name,status,update,version --format=json --path=${rootPath} --allow-root 2>/dev/null || true`,
      { timeout: 20000 },
    );
    try {
      const plugins = JSON.parse(pluginsOut);
      if (Array.isArray(plugins)) {
        for (const p of plugins) {
          items.push({
            category: "wp_plugins",
            key: p.name,
            value: { version: p.version, status: p.status },
          });
        }
      }
    } catch {
      // JSON parse fallback
    }

    // 3. WordPress Themes list & version & status
    const { stdout: themesOut } = await executor.execute(
      `wp theme list --fields=name,status,version --format=json --path=${rootPath} --allow-root 2>/dev/null || true`,
      { timeout: 20000 },
    );
    try {
      const themes = JSON.parse(themesOut);
      if (Array.isArray(themes)) {
        for (const t of themes) {
          items.push({
            category: "wp_themes",
            key: t.name,
            value: { version: t.version, status: t.status },
          });
        }
      }
    } catch {
      // JSON parse fallback
    }

    return items;
  }

  private assessDriftSeverity(
    category: string,
    changeType: string,
    value: unknown,
  ): "critical" | "high" | "medium" | "low" | "info" {
    if (category === "ssh_keys") {
      return changeType === "added" ? "critical" : "medium";
    }
    if (category === "users") {
      if (
        isRecord(value) &&
        (value.uid === 0 ||
          (typeof value.shell === "string" &&
            (value.shell.includes("bash") || value.shell.includes("sh"))))
      ) {
        return "critical";
      }
      return "high";
    }
    if (category === "cron") {
      return "high";
    }
    if (category === "ports") {
      return "high";
    }
    if (category === "services") {
      return "medium";
    }
    if (category === "wp_plugins" || category === "wp_core") {
      return "medium";
    }
    return "low";
  }
}
