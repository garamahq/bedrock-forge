import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { Job } from "bullmq";
import { PrismaService } from "../../prisma/prisma.service";
import { EncryptionService } from "../../encryption/encryption.service";
import { QUEUES, JOB_TYPES } from "@bedrock-forge/shared";

interface NotificationJob {
  eventType: string;
  payload: Record<string, unknown>;
}

type SecurityAttackNotification =
  | { type: "mass_infection"; criticalCount: number; targetCount: number }
  | { type: "batch_pattern"; title: string; count: number; targets: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSecurityAttackNotification(
  value: unknown,
): value is SecurityAttackNotification {
  if (!isRecord(value)) return false;
  if (value.type === "mass_infection") {
    return (
      typeof value.criticalCount === "number" &&
      typeof value.targetCount === "number"
    );
  }
  return (
    value.type === "batch_pattern" &&
    typeof value.title === "string" &&
    typeof value.count === "number" &&
    Array.isArray(value.targets) &&
    value.targets.every((target: unknown) => typeof target === "string")
  );
}

// concurrency=3: notification provider calls are lightweight network I/O.
@Processor(QUEUES.NOTIFICATIONS, { concurrency: 3, lockDuration: 30_000 })
export class NotificationProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {
    super();
  }

  async process(job: Job<NotificationJob>) {
    if (job.name !== JOB_TYPES.NOTIFICATION_SEND) return;

    const { eventType, payload } = job.data;
    this.logger.debug(`Dispatching notification for event: ${eventType}`);

    // Always create in-app notifications for alert events, regardless of Slack config
    await this.createInAppNotification(eventType, payload);

    const channels = await this.prisma.notificationChannel.findMany({
      where: {
        active: true,
        events: { has: eventType },
      },
    });

    if (channels.length === 0) return;

    await Promise.allSettled(
      channels.map((channel) =>
        this.sendToChannel(channel, eventType, payload),
      ),
    );
  }

  private async sendToChannel(
    channel: {
      id: bigint;
      name: string;
      type: string;
      slack_bot_token_enc: string | null;
      slack_channel_id: string | null;
      google_chat_webhook_url_enc: string | null;
      webhook_url_enc?: string | null;
      webhook_secret_enc?: string | null;
    },
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    let status: "sent" | "failed" = "failed";
    let error: string | undefined;

    try {
      const text = this.buildMessage(eventType, payload);

      if (channel.type === "google_chat") {
        await this.sendGoogleChat(channel, text);
      } else if (channel.type === "webhook") {
        await this.sendWebhook(channel, eventType, payload);
      } else {
        await this.sendSlack(channel, text);
      }


      status = "sent";
      this.logger.log(
        `${this.providerLabel(channel.type)} notification sent to channel ${channel.name} for ${eventType}`,
      );
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : String(err);
      error = raw.includes("channel_not_found")
        ? `channel_not_found: Bot is not a member of the private channel "${channel.slack_channel_id}". Invite the bot via /invite @BotName in Slack.`
        : raw;
      this.logger.error(
        `Failed to send ${this.providerLabel(channel.type)} notification to channel ${channel.name}: ${error}`,
      );
    }

    await this.prisma.notificationLog.create({
      data: {
        channel_id: channel.id,
        event_type: eventType,
        payload: payload as Record<string, never>,
        status,
        error: error ?? null,
      },
    });
  }

  private async sendSlack(
    channel: {
      slack_bot_token_enc: string | null;
      slack_channel_id: string | null;
    },
    text: string,
  ) {
    if (!channel.slack_bot_token_enc || !channel.slack_channel_id) {
      throw new Error("Missing bot token or channel ID");
    }

    const { WebClient } = await import("@slack/web-api");
    const token = this.encryption.decrypt(channel.slack_bot_token_enc);
    const slack = new WebClient(token);
    await slack.chat.postMessage({
      channel: channel.slack_channel_id,
      text,
    });
  }

  private async sendWebhook(
    channel: { webhook_url_enc?: string | null; webhook_secret_enc?: string | null; name: string },
    eventType: string,
    payload: Record<string, unknown>,
  ) {
    if (!channel.webhook_url_enc) {
      throw new Error("Missing webhook URL");
    }

    const webhookUrl = this.encryption.decrypt(channel.webhook_url_enc);
    const body = JSON.stringify({
      event: eventType,
      payload,
      timestamp: new Date().toISOString(),
      source: "bedrock-forge",
    });

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Forge-Event": eventType,
    };

    // Optional HMAC-SHA256 signature
    if (channel.webhook_secret_enc) {
      const secret = this.encryption.decrypt(channel.webhook_secret_enc);
      const { createHmac } = await import("crypto");
      const sig = createHmac("sha256", secret).update(body).digest("hex");
      headers["X-Forge-Signature"] = `sha256=${sig}`;
    }

    const res = await fetch(webhookUrl, { method: "POST", headers, body });
    if (!res.ok) {
      const respBody = await res.text().catch(() => "");
      throw new Error(`Webhook returned ${res.status}: ${respBody}`);
    }
  }

  private async sendGoogleChat(
    channel: { google_chat_webhook_url_enc: string | null },
    text: string,
  ) {
    if (!channel.google_chat_webhook_url_enc) {
      throw new Error("Missing Google Chat webhook URL");
    }

    const webhookUrl = this.encryption.decrypt(
      channel.google_chat_webhook_url_enc,
    );
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Google Chat returned ${res.status}: ${body}`);
    }
  }

  private providerLabel(type: string): string {
    if (type === "google_chat") return "Google Chat";
    if (type === "webhook") return "Webhook";
    return "Slack";
  }


  private async createInAppNotification(
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const ALERT_EVENTS = new Set([
      "backup.failed",
      "plugin-update.failed",
      "sync.failed",
      "monitor.down",
      "monitor.ssl_expiry",
      "monitor.dns_failed",
      "invoice.overdue",
      "security.critical_found",
      "security.high_found",
      "security.ssh_login",
      "security.ssh_failed_login_spike",
      "security.file_changes",
    ]);

    if (!ALERT_EVENTS.has(eventType)) return;

    try {
      const users = await this.prisma.user.findMany({
        where: {
          user_roles: {
            some: { role: { name: { in: ["admin", "manager"] } } },
          },
        },
        select: { id: true },
      });

      if (users.length === 0) return;

      const { title, message } = this.buildInAppContent(eventType, payload);

      await this.prisma.userNotification.createMany({
        data: users.map((u) => ({
          user_id: u.id,
          type: eventType,
          title,
          message,
          action_url: null,
        })),
      });
    } catch (err: unknown) {
      this.logger.error(
        `Failed to create in-app notification: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private buildInAppContent(
    eventType: string,
    payload: Record<string, unknown>,
  ): { title: string; message: string } {
    switch (eventType) {
      case "backup.failed":
        return {
          title: "Backup failed",
          message: `Backup for environment #${payload.environmentId ?? "?"} failed: ${payload.error ?? "Unknown error"}`,
        };
      case "plugin-update.failed":
        return {
          title: "Plugin update failed",
          message: `Plugin update for environment #${payload.environmentId ?? "?"} failed`,
        };
      case "sync.failed":
        return {
          title: "Sync failed",
          message: `Sync operation failed: ${payload.error ?? "Unknown error"}`,
        };
      case "monitor.down":
        return {
          title: "Site is down",
          message: `${payload.url ?? "Unknown site"} returned HTTP ${payload.statusCode ?? "?"}`,
        };
      case "monitor.ssl_expiry":
        return {
          title: "SSL certificate expiring",
          message: `SSL certificate for ${payload.url ?? "unknown"} expires in ${payload.daysRemaining ?? "?"} days`,
        };
      case "monitor.dns_failed":
        return {
          title: "DNS resolution failed",
          message: `DNS lookup failed for ${payload.url ?? "unknown"}`,
        };
      case "invoice.overdue":
        return {
          title: "Invoice overdue",
          message: `Invoice ${payload.invoiceNumber ?? "?"} is overdue (€${payload.totalAmount ?? "?"})`,
        };
      case "security.critical_found":
        return {
          title: "Security: Critical findings",
          message: `Security scan found ${(payload.summary as Record<string, number>)?.critical ?? "?"} critical issue(s) — score: ${payload.score ?? "?"}`,
        };
      case "security.high_found":
        return {
          title: "Security: High severity findings",
          message: `Security scan found high severity issues — score: ${payload.score ?? "?"}`,
        };
      case "security.ssh_login":
        return {
          title: "Security: SSH login",
          message: `${payload.user ?? "Unknown user"} logged in to ${payload.serverName ?? `server #${payload.serverId ?? "?"}`} from ${payload.sourceIp ?? "?"}`,
        };
      case "security.ssh_failed_login_spike":
        return {
          title: "Security: Failed SSH login spike",
          message: `${payload.count ?? "?"} failed SSH login attempts from ${payload.sourceIp ?? "?"} on ${payload.serverName ?? `server #${payload.serverId ?? "?"}`}`,
        };
      case "security.file_changes":
        return {
          title: "Security: Sensitive file changes",
          message: `${payload.addedCount ?? 0} added, ${payload.modifiedCount ?? 0} modified, ${payload.deletedCount ?? 0} deleted on ${payload.serverName ?? `server #${payload.serverId ?? "?"}`}`,
        };
      default:
        return {
          title: eventType,
          message: JSON.stringify(payload).slice(0, 200),
        };
    }
  }

  private buildMessage(
    eventType: string,
    payload: Record<string, unknown>,
  ): string {
    const lines: string[] = [`*[Bedrock Forge]* Event: \`${eventType}\``];

    switch (eventType) {
      case "backup.completed":
        lines.push(
          `✅ Backup completed for environment #${payload.environmentId ?? "?"}`,
          `Type: ${payload.backupType ?? "?"} | Size: ${this.formatBytes(payload.sizeBytes as number)}`,
        );
        break;
      case "backup.failed":
        lines.push(
          `❌ Backup failed for environment #${payload.environmentId ?? "?"}`,
          `Error: ${payload.error ?? "Unknown error"}`,
        );
        break;
      case "sync.completed":
        lines.push(`✅ Sync completed`);
        break;
      case "sync.failed":
        lines.push(`❌ Sync failed: ${payload.error ?? "Unknown error"}`);
        break;
      case "plugin-scan.completed":
        lines.push(
          `🔍 Plugin scan completed for environment #${payload.environmentId ?? "?"}`,
          `Found ${payload.pluginCount ?? "?"} plugins`,
        );
        break;
      case "monitor.down":
        lines.push(
          `🔴 Site is DOWN: ${payload.url ?? "?"}`,
          `Status: ${payload.statusCode ?? "?"} | Response: ${payload.responseMs ?? "?"}ms`,
        );
        break;
      case "monitor.up":
        lines.push(
          `🟢 Site is back UP: ${payload.url ?? "?"}`,
          `Response: ${payload.responseMs ?? "?"}ms`,
        );
        break;
      case "monitor.degraded":
        lines.push(
          `🟡 Site is DEGRADED (slow): ${payload.url ?? "?"}`,
          `Response time: ${payload.responseMs ?? "?"}ms (threshold: 5000ms) | Status: ${payload.statusCode ?? "?"}`,
        );
        break;
      case "invoice.created":
        lines.push(
          `📄 Invoice ${payload.invoiceNumber ?? "?"} created`,
          `Project: ${payload.projectName ?? "?"} | Client: ${payload.clientName ?? "?"}`,
          `Total: €${payload.totalAmount ?? "?"} (${payload.year ?? "?"})`,
        );
        break;
      case "invoice.overdue":
        lines.push(
          `⚠️ Invoice ${payload.invoiceNumber ?? "?"} is overdue`,
          `Client: ${payload.clientName ?? "?"} | Amount: €${payload.totalAmount ?? "?"}`,
        );
        break;
      case "security.critical_found": {
        const s = payload.summary as Record<string, number> | undefined;
        lines.push(
          `🚨 Security scan: CRITICAL findings detected`,
          `Critical: ${s?.critical ?? 0} | High: ${s?.high ?? 0} | Medium: ${s?.medium ?? 0} | Score: ${payload.score ?? "?"}`,
          payload.serverId
            ? `Server ID: ${payload.serverId}`
            : `Environment ID: ${payload.environmentId}`,
        );
        break;
      }
      case "security.high_found": {
        const s = payload.summary as Record<string, number> | undefined;
        lines.push(
          `⚠️ Security scan: High severity findings`,
          `High: ${s?.high ?? 0} | Medium: ${s?.medium ?? 0} | Score: ${payload.score ?? "?"}`,
          payload.serverId
            ? `Server ID: ${payload.serverId}`
            : `Environment ID: ${payload.environmentId}`,
        );
        break;
      }
      case "security.attack_detected": {
        const attacks = Array.isArray(payload.attacks)
          ? (payload.attacks as unknown[]).filter(isSecurityAttackNotification)
          : [];
        lines.push(`🚨 *SECURITY ATTACK DETECTED* 🚨`);
        lines.push(`Time: \`${payload.timestamp}\``);

        for (const a of attacks) {
          if (a.type === "mass_infection") {
            lines.push(
              `• *Mass Infection*: Found ${a.criticalCount} critical issues across ${a.targetCount} targets.`,
            );
          } else {
            lines.push(
              `• *Batch Pattern*: \`${a.title}\` found on ${a.count} targets:`,
            );
            lines.push(`  > ${a.targets.join(", ")}`);
          }
        }
        lines.push(
          `\n_Action required: Check the Security Dashboard immediately._`,
        );
        break;
      }
      case "security.scan_completed": {
        const s = payload.summary as Record<string, number> | undefined;
        lines.push(
          `✅ Security scan completed`,
          `Score: ${payload.score ?? "?"} | Info: ${s?.info ?? 0}`,
        );
        break;
      }
      case "security.ssh_login":
        lines.push(
          `SSH login accepted`,
          `Server: ${payload.serverName ?? "?"} (${payload.serverIp ?? "?"})`,
          `User: ${payload.user ?? "?"} | Source: ${payload.sourceIp ?? "?"} | Method: ${payload.authMethod ?? "?"}`,
          `Time: ${payload.timestamp ?? "?"}`,
          `Log: ${(String(payload.rawExcerpt ?? "") || "?").slice(0, 500)}`,
        );
        break;
      case "security.ssh_failed_login_spike":
        lines.push(
          `Failed SSH login spike`,
          `Server: ${payload.serverName ?? "?"} (${payload.serverIp ?? "?"})`,
          `Source: ${payload.sourceIp ?? "?"} | Attempts: ${payload.count ?? "?"} | Threshold: ${payload.threshold ?? "?"}`,
          `Window: ${payload.windowStart ?? "?"} to ${payload.windowEnd ?? "?"}`,
        );
        break;
      case "security.file_changes": {
        const paths = Array.isArray(payload.topChangedPaths)
          ? payload.topChangedPaths
          : [];
        lines.push(
          `Sensitive file changes detected`,
          `Server: ${payload.serverName ?? "?"} (${payload.serverIp ?? "?"})`,
          `Window: ${payload.windowStart ?? "?"} to ${payload.windowEnd ?? "?"}`,
          `Added: ${payload.addedCount ?? 0} | Modified: ${payload.modifiedCount ?? 0} | Deleted: ${payload.deletedCount ?? 0}`,
        );
        if (paths.length > 0) {
          lines.push(
            `Top changed paths:\n${paths
              .map((path) => `• ${String(path).slice(0, 180)}`)
              .join("\n")}`,
          );
        }
        break;
      }
      case "user.registered":
        lines.push(`👤 New user registered: ${payload.email ?? "?"}`);
        break;
      case "user.login":
        lines.push(
          `🔑 User logged in: ${payload.email ?? "?"} from ${payload.ip ?? "?"}`,
        );
        break;
      case "server.created":
        lines.push(
          `🖥️ New server added: ${payload.serverName ?? "?"} (${payload.ip ?? "?"})`,
        );
        break;
      case "server.deleted":
        lines.push(`🗑️ Server removed: ${payload.serverName ?? "?"}`);
        break;
      case "report.weekly":
        lines.push(
          `📊 Weekly report generated`,
          `Period: ${payload.dateRange ?? "?"} | Backups: ${payload.successfulBackups ?? "?"} ok / ${payload.failedBackups ?? "?"} failed | Monitors down: ${payload.monitorsDown ?? "?"}`,
        );
        break;
      case "config.drift_detected": {
        const envs = Array.isArray(payload.environments) ? payload.environments : [];
        lines.push(
          `⚠️ Config drift detected for project #${payload.projectId ?? "?"}`,
          `${payload.driftedEnvironments ?? "?"} environment(s) drifted | ${payload.totalMismatches ?? "?"} total plugin mismatches`,
        );
        for (const env of envs.slice(0, 5)) {
          lines.push(
            `• ${(env as Record<string, unknown>).type ?? "env"} (${(env as Record<string, unknown>).url ?? "?"}): ${(env as Record<string, unknown>).mismatchCount ?? 0} mismatches`,
          );
        }
        break;
      }
      default:
        lines.push(JSON.stringify(payload, null, 2).slice(0, 500));
    }

    return lines.join("\n");
  }

  private formatBytes(bytes?: number): string {
    if (!bytes) return "?";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024)
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
}
