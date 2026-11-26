import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { SettingsRepository } from "../settings.repository";
import { EncryptionService } from "../../../common/encryption/encryption.service";
import { ConfigService } from "@nestjs/config";
import { execFile } from "child_process";
import { promisify } from "util";
import {
  writeFile,
  unlink,
  mkdir,
  readFile,
  stat,
  chmod,
  rename,
  rm,
  utimes,
} from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { randomUUID } from "crypto";
import { reconcileRcloneConfigState } from "@bedrock-forge/shared";

const execFileAsync = promisify(execFile);

interface RcloneOAuthToken {
  access_token?: string;
  token_type?: string;
  refresh_token?: string;
  expiry?: string;
  [key: string]: unknown;
}

function buildRcloneConfig(remoteName: string, tokenJson: string): string {
  return `[${remoteName}]\ntype = drive\nscope = drive\ntoken = ${tokenJson}\n`;
}

export interface ProvisionedRcloneConfig {
  configPath: string;
  remoteName: string;
  dbValueSnapshot: string;
}

@Injectable()
export class GdriveSettingsService {
  private readonly logger = new Logger(GdriveSettingsService.name);
  private configMutex: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly repo: SettingsRepository,
    private readonly enc: EncryptionService,
    private readonly config: ConfigService,
  ) {}

  private runWithConfigLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.configMutex.then(fn, fn);
    this.configMutex = next.catch(() => undefined);
    return next;
  }

  private resolveConfigLocation(): { configPath: string; remoteName: string } {
    const configPath =
      this.config.get<string>("app.rcloneConfigPath") ??
      this.config.get<string>("RCLONE_CONFIG_PATH") ??
      "/home/node/.config/rclone/rclone.conf";
    const remoteName =
      this.config.get<string>("app.rcloneRemoteName") ??
      this.config.get<string>("RCLONE_REMOTE_NAME") ??
      "gdrive";
    return { configPath, remoteName };
  }

  private async atomicWriteConfig(
    configPath: string,
    content: string,
  ): Promise<void> {
    await mkdir(dirname(configPath), { recursive: true });
    const tmpPath = `${configPath}.tmp.${randomUUID()}`;
    try {
      await writeFile(tmpPath, content, { mode: 0o600 });
      await chmod(tmpPath, 0o600);
      await rename(tmpPath, configPath);
    } catch (err) {
      await rm(tmpPath, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  async getGdriveConfig() {
    const s = await this.repo.findByKey("rclone_gdrive_config");
    return { configured: !!s };
  }

  async setGdrive(token: string): Promise<void> {
    let parsed: RcloneOAuthToken;
    try {
      parsed = JSON.parse(token.trim()) as RcloneOAuthToken;
    } catch {
      throw new BadRequestException(
        'Invalid JSON — paste the token JSON printed by `rclone authorize "drive"`.',
      );
    }

    const required = ["access_token", "refresh_token"];
    const missing = required.filter((k) => !parsed[k]);
    if (missing.length) {
      throw new BadRequestException(
        `Token JSON is missing required fields: ${missing.join(", ")}. ` +
          "Make sure you copy the token JSON output by rclone authorize, not a credentials file.",
      );
    }

    const { configPath, remoteName } = this.resolveConfigLocation();
    const tokenOneLine = JSON.stringify(parsed);
    const rcloneConf = buildRcloneConfig(remoteName, tokenOneLine);
    const encrypted = this.enc.encrypt(rcloneConf);
    await this.repo.upsert("rclone_gdrive_config", encrypted);

    // Best-effort local sync on API host so intentional relink takes effect immediately
    await this.runWithConfigLock(() =>
      this.atomicWriteConfig(configPath, rcloneConf).catch(() => undefined),
    );

    this.logger.log(
      "Google Drive configured via OAuth token (rclone authorize).",
    );
  }

  async deleteGdrive(): Promise<void> {
    const { configPath } = this.resolveConfigLocation();
    await this.repo.delete("rclone_gdrive_config");
    await this.runWithConfigLock(() =>
      rm(configPath, { force: true }).catch(() => undefined),
    );
  }

  /**
   * Ensure the API container has a valid, up-to-date rclone.conf provisioned from
   * PostgreSQL before streaming a backup download (`#58`, `#36`, `#40`).
   * Unlinks any stale local file and throws if unconfigured or unreadable.
   */
  async ensureRcloneConfig(): Promise<ProvisionedRcloneConfig> {
    return this.runWithConfigLock(async () => {
      const { configPath, remoteName } = this.resolveConfigLocation();
      const setting = await this.repo.findByKey("rclone_gdrive_config");
      if (!setting) {
        await rm(configPath, { force: true }).catch(() => undefined);
        throw new NotFoundException(
          "Google Drive is not configured. Configure Google Drive in Settings first.",
        );
      }

      let dbContent: string;
      try {
        dbContent = this.enc.decrypt(setting.value);
      } catch {
        await rm(configPath, { force: true }).catch(() => undefined);
        throw new InternalServerErrorException(
          "Failed to decrypt Google Drive configuration.",
        );
      }

      let diskContent: string | null = null;
      let diskMtimeMs = 0;
      try {
        const [st, content] = await Promise.all([
          stat(configPath),
          readFile(configPath, "utf8"),
        ]);
        diskContent = content;
        diskMtimeMs = st.mtimeMs;
      } catch {
        diskContent = null;
      }

      let activeDbSnapshot = setting.value;

      if (diskContent !== null) {
        const decision = reconcileRcloneConfigState({
          dbContent,
          dbUpdatedAt: (setting as { updated_at?: Date | null }).updated_at,
          diskContent,
          diskMtimeMs,
          remoteName,
        });

        if (decision === "in_sync") {
          await chmod(configPath, 0o600).catch(() => undefined);
          return { configPath, remoteName, dbValueSnapshot: activeDbSnapshot };
        }

        if (decision === "keep_disk_and_sync_db") {
          await chmod(configPath, 0o600).catch(() => undefined);
          const nextEnc = this.enc.encrypt(diskContent);
          const updated = await this.repo.updateIfValueMatches(
            "rclone_gdrive_config",
            setting.value,
            nextEnc,
          );
          if (updated.count > 0) {
            activeDbSnapshot = nextEnc;
            const now = new Date();
            await utimes(configPath, now, now).catch(() => undefined);
          }
          return { configPath, remoteName, dbValueSnapshot: activeDbSnapshot };
        }
      }

      try {
        await this.atomicWriteConfig(configPath, dbContent);
      } catch (err) {
        await rm(configPath, { force: true }).catch(() => undefined);
        throw new InternalServerErrorException(
          `Failed to write rclone configuration to disk: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      return { configPath, remoteName, dbValueSnapshot: activeDbSnapshot };
    });
  }

  /**
   * Persist refreshed OAuth tokens written by `rclone cat` back to PostgreSQL
   * without overwriting an intentional concurrent relink.
   */
  async syncRefreshedRcloneConfig(previousSnapshot: string): Promise<void> {
    await this.runWithConfigLock(async () => {
      const { configPath, remoteName } = this.resolveConfigLocation();
      let diskContent: string;
      let diskMtimeMs: number;
      try {
        const [st, content] = await Promise.all([
          stat(configPath),
          readFile(configPath, "utf8"),
        ]);
        diskMtimeMs = st.mtimeMs;
        diskContent = content;
      } catch {
        return;
      }

      const setting = await this.repo.findByKey("rclone_gdrive_config");
      if (!setting) {
        await rm(configPath, { force: true }).catch(() => undefined);
        return;
      }

      let dbContent: string;
      try {
        dbContent = this.enc.decrypt(setting.value);
      } catch {
        return;
      }

      const decision = reconcileRcloneConfigState({
        dbContent,
        dbUpdatedAt: (setting as { updated_at?: Date | null }).updated_at,
        diskContent,
        diskMtimeMs,
        remoteName,
      });

      if (decision === "keep_disk_and_sync_db") {
        const nextEnc = this.enc.encrypt(diskContent);
        const res = await this.repo.updateIfValueMatches(
          "rclone_gdrive_config",
          previousSnapshot || setting.value,
          nextEnc,
        );
        if (res.count > 0) {
          const now = new Date();
          await utimes(configPath, now, now).catch(() => undefined);
        }
      }
    });
  }

  async testGdrive(): Promise<{ success: boolean; message: string }> {
    const s = await this.repo.findByKey("rclone_gdrive_config");
    if (!s) {
      return { success: false, message: "Google Drive is not configured." };
    }
    let rcloneConf: string;
    try {
      rcloneConf = this.enc.decrypt(s.value);
    } catch {
      return { success: false, message: "Failed to decrypt Google Drive credentials." };
    }

    const tmpConf = join(tmpdir(), `rclone_test_${randomUUID()}.conf`);
    const { remoteName } = this.resolveConfigLocation();

    try {
      await mkdir(tmpdir(), { recursive: true });
      await writeFile(tmpConf, rcloneConf, { mode: 0o600 });

      await execFileAsync("rclone", [
        "lsd",
        `${remoteName}:`,
        "--config",
        tmpConf,
        "--max-depth",
        "1",
      ]);

      return { success: true, message: "Connection successful." };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      this.logger.warn(`GDrive connection test failed: ${msg}`);
      return {
        success: false,
        message: `Connection failed: ${msg}`,
      };
    } finally {
      await unlink(tmpConf).catch(() => undefined);
    }
  }
}
