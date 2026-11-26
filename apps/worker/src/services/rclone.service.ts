import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { EncryptionService } from "../encryption/encryption.service";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import {
  writeFile,
  mkdir,
  readFile,
  stat,
  rename,
  rm,
  chmod,
  utimes,
} from "fs/promises";
import { dirname } from "path";
import { randomUUID } from "crypto";
import type { Readable } from "stream";
import {
  GdriveFilePath,
  normalizeGoogleDriveFolderId,
  parseGdriveFilePath,
  reconcileRcloneConfigState,
} from "@bedrock-forge/shared";

const execFileAsync = promisify(execFile);

export type { GdriveFilePath };

export interface RcloneDeleteResult {
  deleted: boolean;
  alreadyMissing: boolean;
}

function isRcloneNotFoundError(err: unknown): boolean {
  const msg =
    err instanceof Error
      ? `${err.message} ${String((err as { stderr?: unknown }).stderr ?? "")}`
      : String(err);
  const code = (err as { code?: unknown })?.code;
  return (
    code === 3 ||
    code === 4 ||
    /object not found|directory not found|file not found|doesn't exist|no such file|404/i.test(
      msg,
    )
  );
}

/**
 * RcloneService
 *
 * Manages rclone configuration and cloud storage operations for the worker.
 * All backups target a specific Google Drive folder via --drive-root-folder-id.
 * Stored file_path format: gdrive:{folderId}/{filename}
 */
@Injectable()
export class RcloneService {
  private readonly logger = new Logger(RcloneService.name);
  private readonly configPath: string;
  private readonly remoteName: string;
  private configMutex: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly prisma: PrismaService,
    private readonly enc: EncryptionService,
    private readonly config: ConfigService,
  ) {
    this.configPath = this.config.get<string>("rclone.configPath")!;
    this.remoteName = this.config.get<string>("rclone.remoteName")!;
  }

  private runWithConfigLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.configMutex.then(fn, fn);
    this.configMutex = next.catch(() => undefined);
    return next;
  }

  /**
   * Parse a stored gdrive file_path into its canonical folder ID and filename.
   * Format: gdrive:{folderId}/{filename}
   * Recovers legacy stored Drive folder URL prefixes via `parseGdriveFilePath`.
   */
  static parseFilePath(filePath: string): GdriveFilePath {
    return parseGdriveFilePath(filePath);
  }

  private async atomicWriteConfig(content: string): Promise<void> {
    await mkdir(dirname(this.configPath), { recursive: true });
    const tmpPath = `${this.configPath}.tmp.${randomUUID()}`;
    try {
      await writeFile(tmpPath, content, { mode: 0o600 });
      await chmod(tmpPath, 0o600);
      await rename(tmpPath, this.configPath);
    } catch (err) {
      await rm(tmpPath, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  /**
   * Persist locally refreshed rclone config back to PostgreSQL when disk mtime
   * is newer than (or equal to) the stored DB record without clobbering an
   * intentional relink stored in PostgreSQL. Never logs config or tokens.
   */
  async syncRefreshedConfig(): Promise<void> {
    return this.runWithConfigLock(async () => {
      let diskContent: string;
      let diskMtimeMs: number;
      try {
        const [st, content] = await Promise.all([
          stat(this.configPath),
          readFile(this.configPath, "utf8"),
        ]);
        diskMtimeMs = st.mtimeMs;
        diskContent = content;
      } catch {
        return;
      }

      const setting = await this.prisma.appSetting.findUnique({
        where: { key: "rclone_gdrive_config" },
      });
      if (!setting) {
        await rm(this.configPath, { force: true }).catch(() => undefined);
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
        dbUpdatedAt: setting.updated_at,
        diskContent,
        diskMtimeMs,
        remoteName: this.remoteName,
      });

      if (decision === "keep_disk_and_sync_db") {
        await chmod(this.configPath, 0o600).catch(() => undefined);
        const encrypted = this.enc.encrypt(diskContent);
        const res = await this.prisma.appSetting.updateMany({
          where: { key: "rclone_gdrive_config", value: setting.value },
          data: { value: encrypted, updated_at: new Date() },
        });
        if (res.count > 0) {
          const now = new Date();
          await utimes(this.configPath, now, now).catch(() => undefined);
        }
      }
    });
  }

  /**
   * Reconcile and ensure rclone config on disk from AppSetting.
   * - Removes any stale local config if unconfigured or undecryptable, returning false.
   * - Preserves locally refreshed OAuth tokens on disk and syncs them back to DB.
   * - Overwrites disk when DB holds a newer intentional relink/rotation.
   */
  async writeConfig(): Promise<boolean> {
    return this.runWithConfigLock(async () => {
      const setting = await this.prisma.appSetting.findUnique({
        where: { key: "rclone_gdrive_config" },
      });
      if (!setting) {
        await rm(this.configPath, { force: true }).catch(() => undefined);
        return false;
      }

      let decrypted: string;
      try {
        decrypted = this.enc.decrypt(setting.value);
      } catch (err) {
        await rm(this.configPath, { force: true }).catch(() => undefined);
        this.logger.error(
          `Failed to decrypt rclone config: ${err instanceof Error ? err.message : String(err)}`,
        );
        return false;
      }

      try {
        let diskContent: string | null = null;
        let diskMtimeMs = 0;
        try {
          const [st, content] = await Promise.all([
            stat(this.configPath),
            readFile(this.configPath, "utf8"),
          ]);
          diskContent = content;
          diskMtimeMs = st.mtimeMs;
        } catch {
          diskContent = null;
        }

        if (diskContent !== null) {
          const decision = reconcileRcloneConfigState({
            dbContent: decrypted,
            dbUpdatedAt: setting.updated_at,
            diskContent,
            diskMtimeMs,
            remoteName: this.remoteName,
          });

          if (decision === "in_sync") {
            await chmod(this.configPath, 0o600).catch(() => undefined);
            return true;
          }

          if (decision === "keep_disk_and_sync_db") {
            await chmod(this.configPath, 0o600).catch(() => undefined);
            const encrypted = this.enc.encrypt(diskContent);
            const res = await this.prisma.appSetting.updateMany({
              where: { key: "rclone_gdrive_config", value: setting.value },
              data: { value: encrypted, updated_at: new Date() },
            });
            if (res.count > 0) {
              const now = new Date();
              await utimes(this.configPath, now, now).catch(() => undefined);
            }
            this.logger.log("rclone refreshed OAuth token preserved and synced");
            return true;
          }
        }

        await this.atomicWriteConfig(decrypted);
        this.logger.log("rclone config written to disk");
        return true;
      } catch (err) {
        await rm(this.configPath, { force: true }).catch(() => undefined);
        this.logger.error(
          `Failed to write rclone config: ${err instanceof Error ? err.message : String(err)}`,
        );
        return false;
      }
    });
  }

  /**
   * Check if the remote is accessible by attempting a directory listing.
   * Returns false if not configured or credentials are invalid.
   */
  async isConfigured(): Promise<boolean> {
    try {
      await execFileAsync("rclone", [
        "lsd",
        `${this.remoteName}:`,
        "--config",
        this.configPath,
        "--max-depth",
        "1",
      ]);
      await this.syncRefreshedConfig().catch(() => undefined);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Upload a local file directly into a Google Drive folder.
   * Normalizes supported Drive URLs or canonical folder IDs before invoking rclone.
   * Returns the stored file_path: gdrive:{folderId}/{filename}
   */
  async upload(
    localFilePath: string,
    folderId: string,
    filename: string,
  ): Promise<string> {
    const normalizedFolderId = normalizeGoogleDriveFolderId(folderId);
    this.logger.log(
      `Uploading ${localFilePath} → gdrive:${normalizedFolderId}/${filename}`,
    );
    try {
      await execFileAsync(
        "rclone",
        [
          "copyto",
          "--config",
          this.configPath,
          "--drive-root-folder-id",
          normalizedFolderId,
          localFilePath,
          `${this.remoteName}:${filename}`,
        ],
        { timeout: 2 * 60 * 60 * 1_000 }, // 2-hour max for large file uploads
      );
      return `gdrive:${normalizedFolderId}/${filename}`;
    } finally {
      await this.syncRefreshedConfig().catch(() => undefined);
    }
  }

  /**
   * Download a file from Google Drive to a local directory.
   */
  async download(filePath: string, localDir: string): Promise<void> {
    const { folderId, filename } = RcloneService.parseFilePath(filePath);
    this.logger.log(`Downloading gdrive:${folderId}/${filename} → ${localDir}`);
    await mkdir(localDir, { recursive: true });
    try {
      await execFileAsync(
        "rclone",
        [
          "copy",
          "--config",
          this.configPath,
          "--drive-root-folder-id",
          folderId,
          `${this.remoteName}:${filename}`,
          localDir,
        ],
        { timeout: 2 * 60 * 60 * 1_000 }, // 2-hour max for large file downloads
      );
    } finally {
      await this.syncRefreshedConfig().catch(() => undefined);
    }
  }

  /**
   * Delete a single file from Google Drive.
   * Distinguishes verified missing objects (via `rclone lsf`) from transient storage/auth errors.
   */
  async deleteFile(filePath: string): Promise<RcloneDeleteResult> {
    const { folderId, filename } = RcloneService.parseFilePath(filePath);
    this.logger.log(`Deleting gdrive:${folderId}/${filename}`);
    try {
      await execFileAsync("rclone", [
        "deletefile",
        "--config",
        this.configPath,
        "--drive-root-folder-id",
        folderId,
        `${this.remoteName}:${filename}`,
      ]);
      return { deleted: true, alreadyMissing: false };
    } catch (err) {
      if (isRcloneNotFoundError(err)) {
        try {
          const { stdout } = await execFileAsync("rclone", [
            "lsf",
            "--config",
            this.configPath,
            "--drive-root-folder-id",
            folderId,
            `${this.remoteName}:${filename}`,
          ]);
          if (String(stdout ?? "").trim() === "") {
            return { deleted: false, alreadyMissing: true };
          }
        } catch {
          // If verification itself fails (e.g. auth/network issue), surface original failure
        }
      }
      throw err;
    } finally {
      await this.syncRefreshedConfig().catch(() => undefined);
    }
  }

  /**
   * Stream a file from Google Drive directly as a Readable.
   */
  downloadStream(filePath: string): {
    child: ReturnType<typeof spawn>;
    stream: Readable;
  } {
    const { folderId, filename } = RcloneService.parseFilePath(filePath);
    this.logger.log(`Streaming gdrive:${folderId}/${filename} via rclone cat`);
    const child = spawn("rclone", [
      "cat",
      "--config",
      this.configPath,
      "--drive-root-folder-id",
      folderId,
      `${this.remoteName}:${filename}`,
    ]);
    child.once("close", () => {
      void this.syncRefreshedConfig().catch(() => undefined);
    });
    return { child, stream: child.stdout as Readable };
  }

  /**
   * Get a shareable Google Drive web URL for a file using `rclone link`.
   */
  async getShareLink(folderId: string, filename: string): Promise<string | null> {
    const normalizedFolderId = normalizeGoogleDriveFolderId(folderId);
    try {
      const { stdout } = await execFileAsync(
        "rclone",
        [
          "link",
          "--config",
          this.configPath,
          "--drive-root-folder-id",
          normalizedFolderId,
          `${this.remoteName}:${filename}`,
        ],
        { timeout: 30_000 },
      );
      const link = stdout.trim();
      return link.startsWith("http") ? link : null;
    } catch (err) {
      this.logger.warn(
        `Failed to generate Google Drive share link for ${filename}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    } finally {
      await this.syncRefreshedConfig().catch(() => undefined);
    }
  }

  get remote(): string {
    return this.remoteName;
  }
}
