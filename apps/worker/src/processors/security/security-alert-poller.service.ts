import { Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import type { Job } from "bullmq";
import { PrismaService } from "../../prisma/prisma.service";
import { SshKeyService } from "../../services/ssh-key.service";
import { createRemoteExecutor } from "@bedrock-forge/remote-executor";
import { QUEUES, JOB_TYPES } from "@bedrock-forge/shared";

const FAILED_LOGIN_SPIKE_THRESHOLD = 10;
const MAX_RAW_LOG_EXCERPT = 500;

type FileSnapshotEntry = {
  hash: string;
  size: number;
  mtime: number;
};

type FileSnapshot = Record<string, FileSnapshotEntry>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type FileChangeBatch = {
  added: string[];
  modified: string[];
  deleted: string[];
};

export const DEFAULT_SECURITY_ALERT_WATCH_PATHS = [
  "/etc/ssh",
  "/root/.ssh",
  "/home/*/.ssh",
  "/etc/sudoers",
  "/etc/sudoers.d",
  "/etc/crontab",
  "/etc/cron.d",
  "/etc/cron.daily",
  "/etc/cron.hourly",
  "/etc/cron.weekly",
  "/etc/cron.monthly",
  "/root/.bashrc",
  "/root/.profile",
  "/home/*/.bashrc",
  "/home/*/.profile",
  "/var/www/*/wp-config.php",
  "/var/www/*/web/wp-config.php",
  "/var/www/*/web/app/plugins",
  "/var/www/*/web/app/themes",
  "/home/*/public_html/wp-config.php",
  "/home/*/public_html/wp-content/plugins",
  "/home/*/public_html/wp-content/themes",
];

@Injectable()
export class SecurityAlertPollerService {
  private readonly logger = new Logger(SecurityAlertPollerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sshKey: SshKeyService,
    @InjectQueue(QUEUES.NOTIFICATIONS)
    private readonly notificationsQueue: Queue,
  ) {}

  async processAlertPoll(job: Job) {
    const data = job.data as { serverId?: number; force?: boolean };
    const now = new Date();
    const settings = await this.prisma.serverSecurityAlertSetting.findMany({
      where: data.serverId
        ? { server_id: BigInt(data.serverId) }
        : { enabled: true },
      include: {
        server: {
          include: {
            environments: { select: { root_path: true } },
          },
        },
      },
    });

    for (const setting of settings) {
      if (!data.force && (!setting.enabled || !this.isAlertDue(setting, now))) {
        continue;
      }

      try {
        const executor = createRemoteExecutor(
          await this.sshKey.getSshConfig(setting.server),
        );

        const windowStart =
          setting.last_checked_at ??
          new Date(now.getTime() - setting.interval_minutes * 60_000);

        // Check if server is currently in a scheduled maintenance window
        const activeMaintenance = await this.prisma.maintenanceWindow.count({
          where: {
            resource_type: "server",
            resource_id: setting.server_id,
            starts_at: { lte: now },
            ends_at: { gte: now },
          },
        });
        const suppressNotifications = activeMaintenance > 0;
        if (suppressNotifications) {
          this.logger.log(
            `Suppressing security alert notifications for server ${Number(setting.server_id)} due to active maintenance window.`,
          );
        }

        if (setting.ssh_login_alerts_enabled) {
          await this.pollAuthLogs(setting, executor, windowStart, now, suppressNotifications);
        }

        if (setting.file_change_alerts_enabled) {
          await this.pollFileChanges(setting, executor, windowStart, now, suppressNotifications);
        }

        await this.prisma.serverSecurityAlertSetting.update({
          where: { id: setting.id },
          data: {
            last_checked_at: now,
            last_auth_cursor: now.toISOString(),
          },
        });
      } catch (err) {
        this.logger.error(
          `Security alert poll failed for server ${Number(setting.server_id)}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  private isAlertDue(
    setting: { last_checked_at: Date | null; interval_minutes: number },
    now: Date,
  ): boolean {
    if (!setting.last_checked_at) return true;
    const intervalMs = Math.max(1, setting.interval_minutes) * 60_000;
    return now.getTime() - setting.last_checked_at.getTime() >= intervalMs;
  }

  private async pollAuthLogs(
    setting: {
      server_id: bigint;
      server: { name: string; ip_address: string };
    },
    executor: ReturnType<typeof createRemoteExecutor>,
    windowStart: Date,
    windowEnd: Date,
    suppressNotifications: boolean,
  ) {
    const result = await executor.execute(
      this.buildAuthLogCommand(windowStart),
      {
        timeout: 30_000,
      },
    );
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    if (!output.trim()) return;

    const successful = this.parseSuccessfulLogins(output);
    for (const login of successful) {
      if (!suppressNotifications) {
        await this.notificationsQueue.add(
          JOB_TYPES.NOTIFICATION_SEND,
          {
            eventType: "security.ssh_login",
            payload: {
              serverId: Number(setting.server_id),
              serverName: setting.server.name,
              serverIp: setting.server.ip_address,
              user: login.user,
              sourceIp: login.sourceIp,
              authMethod: login.authMethod,
              timestamp: login.timestamp,
              rawExcerpt: login.rawExcerpt,
            },
          },
          { removeOnComplete: 100, removeOnFail: 100 },
        );
      }
    }

    const failuresBySource = this.parseFailedLoginCounts(output);
    for (const [sourceIp, count] of failuresBySource.entries()) {
      if (count < FAILED_LOGIN_SPIKE_THRESHOLD) continue;
      if (!suppressNotifications) {
        await this.notificationsQueue.add(
          JOB_TYPES.NOTIFICATION_SEND,
          {
            eventType: "security.ssh_failed_login_spike",
            payload: {
              serverId: Number(setting.server_id),
              serverName: setting.server.name,
              serverIp: setting.server.ip_address,
              sourceIp,
              count,
              threshold: FAILED_LOGIN_SPIKE_THRESHOLD,
              windowStart: windowStart.toISOString(),
              windowEnd: windowEnd.toISOString(),
            },
          },
          { removeOnComplete: 100, removeOnFail: 100 },
        );
      }
    }
  }

  private async pollFileChanges(
    setting: {
      id: bigint;
      server_id: bigint;
      file_watch_paths: string[];
      file_snapshot: unknown;
      server: {
        name: string;
        ip_address: string;
        environments: { root_path: string }[];
      };
    },
    executor: ReturnType<typeof createRemoteExecutor>,
    windowStart: Date,
    windowEnd: Date,
    suppressNotifications: boolean,
  ) {
    const watchPaths = this.expandWatchPaths(
      setting.file_watch_paths,
      setting.server.environments.map((env) => env.root_path),
    );
    if (watchPaths.length === 0) return;

    const result = await executor.execute(
      this.buildFileSnapshotCommand(watchPaths),
      { timeout: 120_000 },
    );
    const nextSnapshot = this.parseFileSnapshot(result.stdout);
    const previousSnapshot = this.asFileSnapshot(setting.file_snapshot);
    const changes = this.compareSnapshots(previousSnapshot, nextSnapshot);

    await this.prisma.serverSecurityAlertSetting.update({
      where: { id: setting.id },
      data: {
        file_snapshot: nextSnapshot,
      },
    });

    if (!previousSnapshot || !this.hasFileChanges(changes)) return;

    if (!suppressNotifications) {
      await this.notificationsQueue.add(
        JOB_TYPES.NOTIFICATION_SEND,
        {
          eventType: "security.file_changes",
          payload: {
            serverId: Number(setting.server_id),
            serverName: setting.server.name,
            serverIp: setting.server.ip_address,
            windowStart: windowStart.toISOString(),
            windowEnd: windowEnd.toISOString(),
            addedCount: changes.added.length,
            modifiedCount: changes.modified.length,
            deletedCount: changes.deleted.length,
            topChangedPaths: [
              ...changes.added,
              ...changes.modified,
              ...changes.deleted,
            ].slice(0, 12),
          },
        },
        { removeOnComplete: 100, removeOnFail: 100 },
      );
    }
  }

  private buildAuthLogCommand(windowStart: Date): string {
    const since = this.shellQuote(windowStart.toISOString());
    return [
      "if command -v journalctl >/dev/null 2>&1; then",
      `journalctl -u ssh -u sshd --since ${since} --no-pager -o short-iso 2>/dev/null || true;`,
      "else",
      "tail -n 2500 /var/log/auth.log /var/log/secure 2>/dev/null || true;",
      "fi",
    ].join(" ");
  }

  private buildFileSnapshotCommand(paths: string[]): string {
    const args = paths.map((path) => this.shellGlobArg(path)).join(" ");
    const excludes = [
      "*/vendor/*",
      "*/node_modules/*",
      "*/cache/*",
      "*/.cache/*",
      "*/backups/*",
      "*/backup/*",
      "*/logs/*",
      "*/log/*",
      "*/uploads/*",
      "*/wp-content/uploads/*",
    ]
      .map((pattern) => `-path ${this.shellQuote(pattern)}`)
      .join(" -o ");

    return [
      "bash -lc",
      this.shellQuote(`
shopt -s nullglob
for target in ${args}; do
  [ -e "$target" ] || continue
  if [ -d "$target" ]; then
    find "$target" \\( ${excludes} \\) -prune -o -type f -size -5M -exec sh -c '
      for file do
        hash=$(sha256sum "$file" 2>/dev/null | awk "{print \\$1}") || continue
        meta=$(stat -c "%s	%Y" "$file" 2>/dev/null) || continue
        printf "%s	%s	%s\\n" "$hash" "$meta" "$file"
      done
    ' sh {} +
  elif [ -f "$target" ]; then
    hash=$(sha256sum "$target" 2>/dev/null | awk "{print \\$1}") || continue
    meta=$(stat -c "%s	%Y" "$target" 2>/dev/null) || continue
    printf "%s	%s	%s\\n" "$hash" "$meta" "$target"
  fi
done
`),
    ].join(" ");
  }

  private parseSuccessfulLogins(output: string) {
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = line.match(
          /Accepted\s+(\S+)\s+for\s+(\S+)\s+from\s+([^\s]+)\s+port/i,
        );
        if (!match) return null;
        return {
          authMethod: match[1],
          user: match[2],
          sourceIp: match[3],
          timestamp: this.extractLogTimestamp(line),
          rawExcerpt: line.slice(0, MAX_RAW_LOG_EXCERPT),
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  }

  private parseFailedLoginCounts(output: string): Map<string, number> {
    const counts = new Map<string, number>();
    for (const line of output.split("\n")) {
      const match = line.match(
        /Failed\s+\S+\s+for\s+(?:invalid user\s+)?\S+\s+from\s+([^\s]+)\s+port/i,
      );
      if (!match) continue;
      counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
    }
    return counts;
  }

  private parseFileSnapshot(output: string): FileSnapshot {
    const snapshot: FileSnapshot = {};
    let count = 0;
    for (const line of output.split("\n")) {
      if (!line.trim()) continue;
      const [hash, sizeRaw, mtimeRaw, ...pathParts] = line.split("\t");
      const path = pathParts.join("\t");
      const size = Number(sizeRaw);
      const mtime = Number(mtimeRaw);
      if (!hash || !path || Number.isNaN(size) || Number.isNaN(mtime)) continue;
      if (count >= 10000) {
        this.logger.warn(
          "File snapshot exceeded MAX_FILES limit (10,000 files). Truncating snapshot to avoid database size blowup.",
        );
        break;
      }
      snapshot[path] = { hash, size, mtime };
      count++;
    }
    return snapshot;
  }

  private compareSnapshots(
    previous: FileSnapshot | null,
    next: FileSnapshot,
  ): FileChangeBatch {
    const added: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];
    if (!previous) return { added, modified, deleted };

    for (const [path, nextEntry] of Object.entries(next)) {
      const prevEntry = previous[path];
      if (!prevEntry) {
        added.push(path);
      } else if (
        prevEntry.hash !== nextEntry.hash ||
        prevEntry.size !== nextEntry.size ||
        prevEntry.mtime !== nextEntry.mtime
      ) {
        modified.push(path);
      }
    }

    for (const path of Object.keys(previous)) {
      if (!next[path]) deleted.push(path);
    }

    return { added, modified, deleted };
  }

  private hasFileChanges(changes: FileChangeBatch): boolean {
    return (
      changes.added.length > 0 ||
      changes.modified.length > 0 ||
      changes.deleted.length > 0
    );
  }

  private asFileSnapshot(value: unknown): FileSnapshot | null {
    if (!isRecord(value)) return null;
    const snapshot: FileSnapshot = {};
    for (const [path, entry] of Object.entries(value)) {
      if (
        !isRecord(entry) ||
        typeof entry.hash !== "string" ||
        typeof entry.size !== "number" ||
        !Number.isFinite(entry.size) ||
        typeof entry.mtime !== "number" ||
        !Number.isFinite(entry.mtime)
      ) {
        return null;
      }
      snapshot[path] = {
        hash: entry.hash,
        size: entry.size,
        mtime: entry.mtime,
      };
    }
    return snapshot;
  }

  private expandWatchPaths(
    paths: string[],
    environmentRoots: string[],
  ): string[] {
    const expanded = new Set(paths.filter((path) => path.trim().length > 0));
    for (const root of environmentRoots) {
      expanded.add(`${root}/wp-config.php`);
      expanded.add(`${root}/web/wp-config.php`);
      expanded.add(`${root}/web/app/plugins`);
      expanded.add(`${root}/web/app/themes`);
      expanded.add(`${root}/wp-content/plugins`);
      expanded.add(`${root}/wp-content/themes`);
    }
    return [...expanded];
  }

  private extractLogTimestamp(line: string): string {
    const iso = line.match(/\d{4}-\d{2}-\d{2}T[^\s]+/);
    return iso?.[0] ?? new Date().toISOString();
  }

  private shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
  }

  private shellGlobArg(value: string): string {
    return value
      .split("*")
      .map((part) => this.shellQuote(part))
      .join("*");
  }
}
