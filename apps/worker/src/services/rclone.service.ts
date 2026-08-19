import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { EncryptionService } from "../encryption/encryption.service";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { writeFile, mkdir } from "fs/promises";
import { dirname } from "path";
import type { Readable } from "stream";

const execFileAsync = promisify(execFile);

/** Parsed components of a stored gdrive file_path. */
export interface GdriveFilePath {
  folderId: string;
  filename: string;
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

  constructor(
    private readonly prisma: PrismaService,
    private readonly enc: EncryptionService,
    private readonly config: ConfigService,
  ) {
    this.configPath = this.config.get<string>("rclone.configPath")!;
    this.remoteName = this.config.get<string>("rclone.remoteName")!;
  }

  /**
   * Parse a stored gdrive file_path into its folder ID and filename.
   * Format: gdrive:{folderId}/{filename}
   * Throws if the format is unrecognised.
   */
  static parseFilePath(filePath: string): GdriveFilePath {
    if (!filePath.startsWith("gdrive:")) {
      throw new Error(`Invalid gdrive file_path format: ${filePath}`);
    }
    const rest = filePath.slice("gdrive:".length);
    const slashIdx = rest.indexOf("/");
    if (slashIdx < 1 || !rest.slice(slashIdx + 1)) {
      throw new Error(
        `Invalid gdrive file_path — expected gdrive:{folderId}/{filename}, got: ${filePath}`,
      );
    }
    return {
      folderId: rest.slice(0, slashIdx),
      filename: rest.slice(slashIdx + 1),
    };
  }

  /**
   * Fetch the rclone config from AppSetting, decrypt it, and write it to disk.
   * Returns true if config was written, false if not configured.
   */
  async writeConfig(): Promise<boolean> {
    const setting = await this.prisma.appSetting.findUnique({
      where: { key: "rclone_gdrive_config" },
    });
    if (!setting) return false;
    try {
      const decrypted = this.enc.decrypt(setting.value);
      await mkdir(dirname(this.configPath), { recursive: true });
      await writeFile(this.configPath, decrypted, { mode: 0o600 });
      this.logger.log("rclone config written to disk");
      return true;
    } catch (err) {
      this.logger.error(
        `Failed to write rclone config: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
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
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Upload a local file directly into a Google Drive folder.
   * Uses rclone copyto with --drive-root-folder-id to target the folder by ID
   * and rename the file to the given filename in one operation.
   * Returns the stored file_path: gdrive:{folderId}/{filename}
   */
  async upload(
    localFilePath: string,
    folderId: string,
    filename: string,
  ): Promise<string> {
    this.logger.log(
      `Uploading ${localFilePath} → gdrive:${folderId}/${filename}`,
    );
    await execFileAsync(
      "rclone",
      [
        "copyto",
        "--config",
        this.configPath,
        "--drive-root-folder-id",
        folderId,
        localFilePath,
        `${this.remoteName}:${filename}`,
      ],
      { timeout: 2 * 60 * 60 * 1_000 }, // 2-hour max for large file uploads
    );
    return `gdrive:${folderId}/${filename}`;
  }

  /**
   * Download a file from Google Drive to a local directory.
   * Parses the stored file_path (gdrive:{folderId}/{filename}) and uses
   * --drive-root-folder-id to target the correct folder.
   */
  async download(filePath: string, localDir: string): Promise<void> {
    const { folderId, filename } = RcloneService.parseFilePath(filePath);
    this.logger.log(`Downloading gdrive:${folderId}/${filename} → ${localDir}`);
    await mkdir(localDir, { recursive: true });
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
  }

  /**
   * Delete a single file from Google Drive.
   * Parses the stored file_path (gdrive:{folderId}/{filename}) and uses
   * --drive-root-folder-id to target the correct folder.
   */
  async deleteFile(filePath: string): Promise<void> {
    const { folderId, filename } = RcloneService.parseFilePath(filePath);
    this.logger.log(`Deleting gdrive:${folderId}/${filename}`);
    await execFileAsync("rclone", [
      "deletefile",
      "--config",
      this.configPath,
      "--drive-root-folder-id",
      folderId,
      `${this.remoteName}:${filename}`,
    ]);
  }

  /**
   * Stream a file from Google Drive directly as a Readable.
   * Spawns `rclone cat` and returns the child process stdout.
   * Callers must handle child.stderr and child process exit for error checking.
   *
   * Use this for zero-copy restore: pipe the returned stream directly
   * into an SFTP write stream without writing to local disk.
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
    return { child, stream: child.stdout as Readable };
  }

  /**
   * Get a shareable Google Drive web URL for a file using `rclone link`.
   */
  async getShareLink(folderId: string, filename: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync(
        "rclone",
        [
          "link",
          "--config",
          this.configPath,
          "--drive-root-folder-id",
          folderId,
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
    }
  }

  get remote(): string {
    return this.remoteName;
  }
}
