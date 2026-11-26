import { join } from "path";

// Resolves to apps/worker/scripts/ from both dev (src/config/) and prod (dist/config/)
const DEFAULT_SCRIPTS_PATH = join(__dirname, "..", "..", "scripts");

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export default () => ({
  redis: { url: process.env.REDIS_URL ?? "redis://localhost:6379" },
  database: { url: process.env.DATABASE_URL },
  encryption: { key: process.env.ENCRYPTION_KEY },
  scriptsPath: process.env.SCRIPTS_PATH ?? DEFAULT_SCRIPTS_PATH,
  backup: {
    execIdleTimeoutMs: parsePositiveInt(
      process.env.BACKUP_EXEC_IDLE_TIMEOUT_MS,
      15 * 60 * 1_000,
    ),
    execMaxTimeoutMs: parsePositiveInt(
      process.env.BACKUP_EXEC_MAX_TIMEOUT_MS,
      2 * 60 * 60 * 1_000,
    ),
  },
  rclone: {
    configPath:
      process.env.RCLONE_CONFIG_PATH ?? "/home/node/.config/rclone/rclone.conf",
    remoteName: process.env.RCLONE_REMOTE_NAME ?? "gdrive",
  },
  pagespeed: {
    apiKey: process.env.PAGESPEED_API_KEY,
    provider: process.env.LIGHTHOUSE_PROVIDER ?? "auto",
    chromePath:
      process.env.LIGHTHOUSE_CHROME_PATH ??
      process.env.CHROME_PATH ??
      "/usr/bin/chromium-browser",
  },
});
