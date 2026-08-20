import { Processor, WorkerHost, InjectQueue } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { Job, Queue } from "bullmq";
import { mkdir, rm, readFile, stat, statfs } from "fs/promises";
import { StepTracker } from "../../services/step-tracker";
import { join, dirname } from "path";
import { PrismaService } from "../../prisma/prisma.service";
import { RcloneService } from "../../services/rclone.service";
import { SshKeyService } from "../../services/ssh-key.service";
import { EncryptionService } from "../../encryption/encryption.service";
import { createRemoteExecutor } from "@bedrock-forge/remote-executor";
import { escapeMysql } from "../../utils/cyberpanel-http";
import {
  QUEUES,
  JOB_TYPES,
  DEFAULT_JOB_OPTIONS,
  BackupDeleteFilePayloadSchema,
  BackupScheduledPayloadSchema,
  BackupRestorePayloadSchema,
  BackupCreatePayloadSchema,
} from "@bedrock-forge/shared";
import { ConfigService } from "@nestjs/config";
import {
  fixCyberPanelOwnership,
  shellQuote,
  pushRemoteScript,
  createRemoteMyCnf,
  cleanupRemoteMyCnf,
  flipProtocol,
  WpCliBuilder,
} from "../../utils/processor-utils";

const STAGING_DIR = "/tmp/forge-backups";

/** Lower-case, replace non-alphanumeric runs with hyphens, strip leading/trailing hyphens. */
function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "env"
  );
}

/** Format a Date as YYYY-MM-DD_HH-mm-ss for use in filenames. */
function formatTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

/**
 * BackupProcessor
 *
 * Handles all jobs on the BACKUPS queue:
 *   - backup:create      — remote execute → SFTP pull → GDrive upload → cleanup
 *   - backup:restore     — GDrive download → SFTP push → remote restore → cleanup
 *   - backup:delete-file — delete orphaned file from GDrive (fire-and-forget)
 */
// 90-min lock: PHP execution (up to 20 min) + large SFTP pull (up to 60 min) + GDrive upload (up to 10 min).
// BullMQ auto-renews at lockDuration/2 intervals, so this safely covers multi-GB backups.
// concurrency=1: backup jobs do SSH+SFTP+tar+rclone — one at a time prevents
// concurrent disk/network saturation on the CX23 VPS.
@Processor(QUEUES.BACKUPS, { concurrency: 1, lockDuration: 90 * 60 * 1_000 })
export class BackupProcessor extends WorkerHost {
  private readonly logger = new Logger(BackupProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rclone: RcloneService,
    private readonly config: ConfigService,
    private readonly sshKey: SshKeyService,
    private readonly encryption: EncryptionService,
    @InjectQueue(QUEUES.BACKUPS) private readonly backupsQueue: Queue,
  ) {
    super();
  }

  async process(job: Job) {
    // Fire-and-forget cloud file cleanup — no JobExecution involved
    if (job.name === JOB_TYPES.BACKUP_DELETE_FILE) {
      const { filePath } = BackupDeleteFilePayloadSchema.parse(job.data);
      return this.handleDelete(filePath);
    }

    // Scheduled backup: create Backup + JobExecution rows, then run create flow
    if (job.name === JOB_TYPES.BACKUP_SCHEDULED) {
      const { scheduleId, environmentId, type } =
        BackupScheduledPayloadSchema.parse(job.data);
      return this.handleScheduled(job, scheduleId, environmentId, type);
    }

    const isRestore = job.name === JOB_TYPES.BACKUP_RESTORE;
    let backupId: number | undefined;

    try {
      if (isRestore) {
        const {
          backupId: bid,
          environmentId,
          jobExecutionId,
        } = BackupRestorePayloadSchema.parse(job.data);
        backupId = bid;
        await this.handleRestore(job, backupId, environmentId, jobExecutionId);
      } else {
        const {
          environmentId,
          type,
          jobExecutionId,
          backupId: bid,
        } = BackupCreatePayloadSchema.parse(job.data);
        backupId = bid;
        await this.handleCreate(
          job,
          environmentId,
          type,
          jobExecutionId,
          backupId,
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Backup job ${job.id} failed: ${msg}`);
      // Mark the pre-created Backup row as failed so the UI reflects it
      if (backupId && !isRestore) {
        await this.prisma.backup
          .update({
            where: { id: BigInt(backupId) },
            data: {
              status: "failed",
              error_message: msg,
              completed_at: new Date(),
            },
          })
          .catch(() => undefined); // non-fatal if row already gone
      }
      throw err;
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  // ── Create ────────────────────────────────────────────────────────────────

  private async handleCreate(
    job: Job,
    environmentId: number,
    type: string,
    jobExecutionId: number,
    backupId: number,
  ) {
    const tracker = await StepTracker.start(
      this.prisma,
      jobExecutionId,
      this.logger,
      job,
    );

    const env = await this.prisma.environment.findUniqueOrThrow({
      where: { id: BigInt(environmentId) },
      include: { server: true, project: true },
    });

    if (!env.google_drive_folder_id) {
      throw new Error(
        `Environment ${environmentId} has no google_drive_folder_id configured — backup aborted.`,
      );
    }

    const executor = createRemoteExecutor(
      await this.sshKey.getSshConfig(env.server),
    );

    const scriptsPath = this.config.get<string>("scriptsPath")!;
    const remoteScript = `/tmp/forge_backup_${job.id}.php`;
    const remoteOutput = `/tmp/forge_backup_${job.id}.tar.gz`;
    const localStagingDir = `${STAGING_DIR}/${job.id}`;
    const localFile = `${localStagingDir}/forge_backup_${job.id}.tar.gz`;
    const backupFilename = `${slugify(env.project.name)}_${slugify(env.type)}_${formatTimestamp(new Date())}.tar.gz`;
    let output: { size: number; filename: string } | null = null;

    await tracker.track({
      step: "Backup started",
      level: "info",
      detail: `env=${environmentId} type=${type} server=${env.server.ip_address}`,
    });

    // Mark the pre-created Backup row as running
    await this.prisma.backup.update({
      where: { id: BigInt(backupId) },
      data: { status: "running", started_at: new Date() },
    });

    try {
      // ── Step A: Push backup.php to remote server ────────────────────────
      const pushStart = Date.now();
      await pushRemoteScript(
        executor,
        join(scriptsPath, "backup.php"),
        remoteScript,
      );
      await tracker.track({
        step: "Backup script uploaded",
        level: "info",
        durationMs: Date.now() - pushStart,
      });

      // ── Step B: Execute backup.php ──────────────────────────────────────
      // Attempt to retrieve stored DB credentials to pass as fallback CLI args.
      // backup.php will prefer on-disk credentials (wp-config.php / .env) and
      // only use these when filesystem parsing is incomplete.
      let myCnfPath: string | null = null;
      let storedCredsArgs = "";
      try {
        const storedCreds = await this.prisma.wpDbCredentials.findUnique({
          where: { environment_id: BigInt(environmentId) },
        });
        if (storedCreds) {
          const dbName = this.encryption.decrypt(storedCreds.db_name_encrypted);
          const dbUser = this.encryption.decrypt(storedCreds.db_user_encrypted);
          const dbPass = this.encryption.decrypt(
            storedCreds.db_password_encrypted,
          );
          const dbHost = this.encryption.decrypt(storedCreds.db_host_encrypted);

          myCnfPath = await createRemoteMyCnf(
            executor,
            { dbUser, dbPassword: dbPass, dbHost, dbName },
            job.id ?? "default",
            "forge_backup",
          );
          storedCredsArgs = ` --mycnf=${shellQuote(myCnfPath)}`;
        }
      } catch (err) {
        this.logger.warn(
          `Could not load stored DB credentials for env ${environmentId}: ${err}`,
        );
      }

      try {
        const phpCmd = `php ${shellQuote(remoteScript)} --docroot=${shellQuote(env.root_path)} --type=${shellQuote(type)} --output=${shellQuote(remoteOutput)}${storedCredsArgs}`;
        const maskedCmd = myCnfPath
          ? phpCmd.replace(myCnfPath, "/tmp/forge_backup_mycnf_***.cnf")
          : phpCmd;
        await tracker.track({
          step: "Executing backup script",
          level: "info",
          command: maskedCmd,
        });
        const execStart = Date.now();
        const result = await executor.execute(phpCmd, {
          timeout: 20 * 60 * 1000,
        });
        await tracker.trackCommand(
          "backup.php execution",
          maskedCmd,
          result,
          Date.now() - execStart,
        );

        if (result.code !== 0) {
          throw new Error(
            `backup.php failed (exit ${result.code}): ${result.stderr}`,
          );
        }

        output = JSON.parse(result.stdout) as { size: number; filename: string };
      } finally {
        if (myCnfPath) {
          await cleanupRemoteMyCnf(executor, myCnfPath);
        }
      }

      await job.updateProgress({
        value: 30,
        step: "Backup script executed on server",
      });

      // ── Step C: Pull backup via SFTP to local staging ───────────────────
      await tracker.track({
        step: "Pulling backup via SFTP",
        level: "info",
        detail: remoteOutput,
      });

      // Pre-flight disk space check: get remote file size via stat and compare
      // against available /tmp space before committing to the SFTP download.
      try {
        const statResult = await executor.execute(`stat -c%s ${shellQuote(remoteOutput)}`, {
          timeout: 10_000,
        });
        const remoteFileBytes = parseInt(statResult.stdout.trim(), 10);
        if (!isNaN(remoteFileBytes) && remoteFileBytes > 0) {
          const fsInfo = await statfs("/tmp");
          const availableBytes = fsInfo.bavail * fsInfo.bsize;
          // Require 10% buffer above file size
          const requiredBytes = Math.ceil(remoteFileBytes * 1.1);
          if (availableBytes < requiredBytes) {
            const availGb = (availableBytes / 1_073_741_824).toFixed(2);
            const requiredGb = (requiredBytes / 1_073_741_824).toFixed(2);
            throw new Error(
              `Insufficient local disk space: ${availGb} GB available, ${requiredGb} GB required (file + 10% buffer). Free up space on the host and retry.`,
            );
          }
          await tracker.track({
            step: "Disk space check passed",
            level: "info",
            detail: `remote=${(remoteFileBytes / 1_048_576).toFixed(0)} MB, available=${(availableBytes / 1_073_741_824).toFixed(2)} GB`,
          });
        }
      } catch (diskErr) {
        // Re-throw space errors directly; log and continue for other stat failures
        if (
          diskErr instanceof Error &&
          diskErr.message.startsWith("Insufficient local disk space")
        ) {
          throw diskErr;
        }
        this.logger.warn(
          `[${job.id}] Disk space pre-flight check failed (non-fatal): ${diskErr}`,
        );
      }

      // Wipe any stale staging dir before creating fresh (covers BullMQ retries
      // with the same job ID and leftover files from a previous failed attempt).
      await rm(localStagingDir, { recursive: true, force: true }).catch(
        () => undefined,
      );
      await mkdir(localStagingDir, { recursive: true });
      const pullStart = Date.now();
      let lastLoggedMb = 0;
      await executor.pullFileToPath(
        remoteOutput,
        localFile,
        undefined,
        (bytes) => {
          const mb = Math.floor(bytes / (1024 * 1024));
          if (mb >= lastLoggedMb + 50) {
            lastLoggedMb = mb;
            this.logger.log(
              `[${job.id}] SFTP pull progress: ${mb} MB received`,
            );
          }
        },
      );
      const { size: pulledBytes } = await stat(localFile);
      await tracker.track({
        step: "Backup pulled via SFTP",
        level: "info",
        detail: `${localFile} (${pulledBytes} bytes)`,
        durationMs: Date.now() - pullStart,
      });
      await job.updateProgress({
        value: 60,
        step: "Backup file pulled via SFTP",
      });

      // ── Step D: Upload to Google Drive ────────────────────────────────────
      const configWritten = await this.rclone.writeConfig();
      if (!configWritten) {
        throw new Error(
          "Google Drive not configured — cannot upload backup. Set up rclone in Settings.",
        );
      }
      await tracker.track({
        step: "Uploading to Google Drive",
        level: "info",
        detail: `${env.google_drive_folder_id}/${backupFilename}`,
      });
      const uploadStart = Date.now();
      const finalFilePath = await this.rclone.upload(
        localFile,
        env.google_drive_folder_id,
        backupFilename,
      );
      await tracker.track({
        step: "Google Drive upload complete",
        level: "info",
        detail: finalFilePath,
        durationMs: Date.now() - uploadStart,
      });
      await job.updateProgress({ value: 85, step: "Uploaded to Google Drive" });

      // ── Step E: Remote cleanup ──────────────────────────────────────────
      const cleanCmd = `rm -f ${shellQuote(remoteScript)} ${shellQuote(remoteOutput)}`;
      const cleanStart = Date.now();
      const cleanResult = await executor.execute(cleanCmd);
      await tracker.trackCommand(
        "Remote temp file cleanup",
        cleanCmd,
        cleanResult,
        Date.now() - cleanStart,
      );

      await rm(localFile, { force: true });
      await rm(localStagingDir, { recursive: true, force: true });

      await tracker.track({
        step: "Backup complete",
        level: "info",
        detail: `file_path=${finalFilePath} size=${output.size}`,
      });

      // ── Step F: Update the pre-created Backup row to completed ───────────
      await this.prisma.backup.update({
        where: { id: BigInt(backupId) },
        data: {
          status: "completed",
          file_path: finalFilePath,
          size_bytes: BigInt(output!.size),
          completed_at: new Date(),
        },
      });

      await tracker.complete();

      await job.updateProgress({ value: 100, step: "Backup complete" });
    } catch (err) {
      // Produce a clean, actionable message for ENOSPC errors
      const isEnospc =
        err instanceof Error &&
        (err.message.includes("ENOSPC") ||
          err.message.includes("no space left on device"));
      if (isEnospc) {
        (err as Error).message =
          "Backup failed: no space left on device on the Forge host. Free up disk space under /tmp and retry.";
      }
      // Attempt remote cleanup even on failure so temp files do not accumulate
      await executor
        .execute(`rm -f ${shellQuote(remoteScript)} ${shellQuote(remoteOutput)}`)
        .catch((e) =>
          this.logger.warn(
            `[${job.id}] Remote cleanup on failure failed: ${e}`,
          ),
        );
      // Always remove local staging dir — prevents large .tar.gz files
      // accumulating in /tmp/forge-backups/ across failed or retried jobs.
      await rm(localFile, { force: true }).catch(() => undefined);
      await rm(localStagingDir, { recursive: true, force: true }).catch(
        () => undefined,
      );
      await tracker.fail(err, "Backup create");
      throw err;
    }
  }

  // ── Restore ───────────────────────────────────────────────────────────────

  private async handleRestore(
    job: Job,
    backupId: number,
    environmentId: number,
    jobExecutionId: number,
  ) {
    const tracker = await StepTracker.start(
      this.prisma,
      jobExecutionId,
      this.logger,
      job,
    );

    const backup = await this.prisma.backup.findUniqueOrThrow({
      where: { id: BigInt(backupId) },
      include: { environment: true },
    });

    if (!backup.file_path) {
      throw new Error("Backup has no file_path — cannot restore.");
    }

    const env = await this.prisma.environment.findUniqueOrThrow({
      where: { id: BigInt(environmentId) },
      include: { server: true },
    });

    const executor = createRemoteExecutor(
      await this.sshKey.getSshConfig(env.server),
    );

    const scriptsPath = this.config.get<string>("scriptsPath")!;
    const remoteScript = `/tmp/forge_restore_${job.id}.php`;
    const remoteBackupPath = `/tmp/forge_restore_${job.id}.tar.gz`;

    await tracker.track({
      step: "Restore started",
      level: "info",
      detail: `backupId=${backupId} file_path=${backup.file_path} env=${environmentId}`,
    });

    // ── Retrieve stored DB credentials (fallback for backup.php --restore) ──
    let myCnfPath: string | null = null;
    let storedCredsArgs = "";
    try {
      const storedCreds = await this.prisma.wpDbCredentials.findUnique({
        where: { environment_id: BigInt(environmentId) },
      });
      if (storedCreds) {
        const dbName = this.encryption.decrypt(storedCreds.db_name_encrypted);
        const dbUser = this.encryption.decrypt(storedCreds.db_user_encrypted);
        const dbPass = this.encryption.decrypt(
          storedCreds.db_password_encrypted,
        );
        const dbHost = this.encryption.decrypt(storedCreds.db_host_encrypted);

        myCnfPath = await createRemoteMyCnf(
          executor,
          { dbUser, dbPassword: dbPass, dbHost, dbName },
          job.id ?? "default",
          "forge_restore",
        );
        storedCredsArgs = ` --mycnf=${shellQuote(myCnfPath)}`;
      }
    } catch (err) {
      this.logger.warn(
        `Could not load stored DB credentials for env ${environmentId}: ${err}`,
      );
    }

    try {
      // ── Step A: Configure rclone ────────────────────────────────────────
      const configWritten = await this.rclone.writeConfig();
      if (!configWritten) {
        throw new Error(
          "Google Drive not configured — cannot restore a cloud backup.",
        );
      }

      // ── Step B: Push restore script via SFTP ────────────────────────────
      const pushStart = Date.now();
      await pushRemoteScript(
        executor,
        join(scriptsPath, "backup.php"),
        remoteScript,
      );
      await tracker.track({
        step: "Restore script uploaded",
        level: "info",
        durationMs: Date.now() - pushStart,
      });

      // ── Step C: Stream archive directly from Google Drive → server ──────
      // Zero local temp files — rclone stdout is piped directly into SFTP.
      const totalBytes = backup.size_bytes ? Number(backup.size_bytes) : 0;
      let lastLoggedMb = 0;
      let lastCancelCheckMb = 0;

      await tracker.track({
        step: "Streaming archive from Google Drive to server",
        level: "info",
        detail: `${backup.file_path}${totalBytes > 0 ? ` (${Math.round(totalBytes / 1024 / 1024)} MB)` : ""}`,
      });
      await job.updateProgress({ value: 5, step: "Download stream started" });

      const { child: rcloneChild, stream: downloadStream } =
        this.rclone.downloadStream(backup.file_path);

      // Collect rclone stderr for error reporting
      const rcloneStderrChunks: string[] = [];
      rcloneChild.stderr?.on("data", (chunk: Buffer) => {
        rcloneStderrChunks.push(chunk.toString());
      });

      const streamStart = Date.now();
      await executor.pushFileFromStream(
        remoteBackupPath,
        downloadStream,
        45 * 60 * 1000,
        async (bytesTransferred) => {
          const mb = Math.floor(bytesTransferred / (1024 * 1024));

          // Check for user cancellation every ~10 MB — responsive but
          // avoids a Redis round-trip on every SFTP chunk event.
          if (mb >= lastCancelCheckMb + 10) {
            lastCancelCheckMb = mb;
            if (await tracker.isCancelled(this.backupsQueue)) {
              rcloneChild.kill("SIGTERM");
              throw new Error("Cancelled by user");
            }
          }

          if (mb >= lastLoggedMb + 50) {
            lastLoggedMb = mb;
            const totalMb =
              totalBytes > 0 ? Math.round(totalBytes / 1024 / 1024) : 0;
            const pct =
              totalBytes > 0
                ? Math.min(
                    75,
                    Math.floor(5 + (bytesTransferred / totalBytes) * 70),
                  )
                : Math.min(75, 5 + Math.floor(mb / 10));

            await tracker.track({
              step: "Streaming archive to server",
              level: "info",
              detail: `${mb} MB transferred${totalMb > 0 ? ` / ${totalMb} MB` : ""}`,
              durationMs: Date.now() - streamStart,
            });
            await job.updateProgress({
              value: pct,
              step: `Streaming: ${mb} MB${totalMb > 0 ? ` / ${totalMb} MB` : ""}`,
            });
          }
        },
      );

      // Verify rclone exited cleanly after stdout closed
      await new Promise<void>((resolve, reject) => {
        if (rcloneChild.exitCode !== null) {
          // Already exited
          if (rcloneChild.exitCode !== 0) {
            reject(
              new Error(
                `rclone cat failed (exit ${rcloneChild.exitCode}): ${rcloneStderrChunks.join("")}`,
              ),
            );
          } else {
            resolve();
          }
          return;
        }
        rcloneChild.on("close", (code) => {
          if (code !== 0) {
            reject(
              new Error(
                `rclone cat failed (exit ${code}): ${rcloneStderrChunks.join("")}`,
              ),
            );
          } else {
            resolve();
          }
        });
        rcloneChild.on("error", reject);
      });

      await tracker.track({
        step: "Archive transferred to server",
        level: "info",
        detail: `${lastLoggedMb} MB — ${remoteBackupPath}`,
        durationMs: Date.now() - streamStart,
      });
      await job.updateProgress({
        value: 78,
        step: "Archive on server, starting restore",
      });

      // ── Step D: Execute restore script ──────────────────────────────────
      if (await tracker.isCancelled(this.backupsQueue)) {
        throw new Error("Cancelled by user");
      }

      // Proactively unlock any immutable attributes and grant write permissions using root SSH
      await executor
        .execute(
          `mkdir -p ${shellQuote(dirname(env.root_path))} 2>/dev/null || true; chattr -R -i -a ${shellQuote(env.root_path)} 2>/dev/null || true; chmod -R u+w ${shellQuote(env.root_path)} 2>/dev/null || true; find ${shellQuote(env.root_path)} -type d -exec chmod 755 {} + 2>/dev/null || true; find ${shellQuote(env.root_path)} -type f -exec chmod 644 {} + 2>/dev/null || true`,
        )
        .catch(() => {});

      const isCrossRestore = backup.environment_id !== BigInt(environmentId);
      const siteUrlArg = isCrossRestore ? ` --site-url=${shellQuote(env.url)}` : "";
      const restoreCmd = `php ${shellQuote(remoteScript)} --restore --file=${shellQuote(remoteBackupPath)} --docroot=${shellQuote(env.root_path)}${storedCredsArgs}${siteUrlArg}`;
      const maskedCmd = myCnfPath
        ? restoreCmd.replace(myCnfPath, "/tmp/forge_restore_mycnf_***.cnf")
        : restoreCmd;

      await tracker.track({
        step: "Executing restore script",
        level: "info",
        command: maskedCmd,
        detail: `docroot=${env.root_path}`,
      });
      const execStart = Date.now();
      const result = await executor.execute(restoreCmd, {
        timeout: 20 * 60 * 1000,
      });
      await tracker.trackCommand(
        "backup.php restore execution",
        maskedCmd,
        result,
        Date.now() - execStart,
      );

      if (result.code !== 0) {
        throw new Error(
          `Restore failed (exit ${result.code}): ${result.stderr}`,
        );
      }

      // Parse result to log db_imported status
      try {
        const parsed = JSON.parse(result.stdout) as { db_imported?: boolean };
        await tracker.track({
          step: parsed.db_imported
            ? "Files + database restored"
            : "Files restored (no DB dump found)",
          level: "info",
          detail: `db_imported=${String(parsed.db_imported ?? false)}`,
        });
      } catch {
        // Non-fatal — log raw output
        await tracker.track({
          step: "Restore script completed",
          level: "info",
        });
      }

      // ── Step D+: Fix file ownership ─────────────────────────────────────
      await fixCyberPanelOwnership(executor, env.root_path, tracker);

      // ── Step D++: Run URL search-replace if Cross-Environment Restore ──
      if (isCrossRestore) {
        const srcUrl = backup.environment?.url;
        const tgtUrl = env.url;

        if (srcUrl && tgtUrl && srcUrl !== tgtUrl) {
          await tracker.track({
            step: "Running cross-environment URL search-replace",
            level: "info",
            detail: `${srcUrl} → ${tgtUrl}`,
          });

          // Fetch target DB credentials
          const targetCreds = await this.prisma.wpDbCredentials.findUnique({
            where: { environment_id: BigInt(environmentId) },
          });

          if (targetCreds) {
            const dbName = this.encryption.decrypt(targetCreds.db_name_encrypted);
            const dbUser = this.encryption.decrypt(targetCreds.db_user_encrypted);
            const dbPass = this.encryption.decrypt(targetCreds.db_password_encrypted);
            const dbHost = this.encryption.decrypt(targetCreds.db_host_encrypted);

            const srMycnf = await createRemoteMyCnf(
              executor,
              { dbUser, dbPassword: dbPass, dbHost },
              job.id ?? "default",
              "forge_sr_restore",
            );
            const srScript = `/tmp/forge_sr_restore_${job.id}.php`;

            try {
              await pushRemoteScript(
                executor,
                join(scriptsPath, "search-replace.php"),
                srScript,
              );

              // Auto-detect WP table prefix; fallback 'wp_'
              const prefixRes = await executor.execute(
                `mysql --defaults-extra-file=${shellQuote(srMycnf)} ${shellQuote(dbName)} -sN -e ${shellQuote(
                  `SELECT REPLACE(table_name,'options','') FROM information_schema.tables WHERE table_schema='${escapeMysql(dbName)}' AND table_name LIKE '%options' LIMIT 1`,
                )}`,
              );
              const p =
                prefixRes.code === 0 && prefixRes.stdout.trim()
                  ? prefixRes.stdout.trim()
                  : "wp_";

              const pairs: Array<[string, string]> = [[srcUrl, tgtUrl]];
              const alt = flipProtocol(srcUrl);
              const altTgt = flipProtocol(tgtUrl);
              if (alt && altTgt && alt !== tgtUrl) pairs.push([alt, altTgt]);

              let allPairsOk = true;
              for (const [oldUrl, newUrl] of pairs) {
                const phpResult = await executor.execute(
                  `php ${shellQuote(srScript)}` +
                    ` --mycnf=${shellQuote(srMycnf)}` +
                    ` --db-name=${shellQuote(dbName)}` +
                    ` --prefix=${shellQuote(p)}` +
                    ` --search=${shellQuote(oldUrl)}` +
                    ` --replace=${shellQuote(newUrl)}`,
                  { timeout: 5 * 60_000 },
                );
                if (phpResult.code !== 0) {
                  allPairsOk = false;
                  await tracker.track({
                    step: "PHP search-replace failed for pair, falling back to SQL",
                    level: "warn",
                    detail: `${oldUrl} → ${newUrl}: ${phpResult.stderr || phpResult.stdout}`,
                  });
                  break;
                }
              }

              if (allPairsOk) {
                await tracker.track({
                  step: "URL search-replace complete (PHP, serialization-aware)",
                  level: "info",
                  detail: `${pairs.length} pair(s) — serialized data handled correctly`,
                });
              } else {
                const srSqlFile = `/tmp/forge_sr_restore_${job.id}.sql`;
                const statements: string[] = [];
                for (const [oldRaw, newRaw] of pairs) {
                  const o = escapeMysql(oldRaw);
                  const n = escapeMysql(newRaw);
                  statements.push(
                    `UPDATE \`${p}options\` SET option_value = REPLACE(option_value, '${o}', '${n}')`,
                    `UPDATE \`${p}posts\` SET post_content = REPLACE(post_content, '${o}', '${n}')`,
                    `UPDATE \`${p}posts\` SET post_excerpt = REPLACE(post_excerpt, '${o}', '${n}')`,
                    `UPDATE \`${p}postmeta\` SET meta_value = REPLACE(CAST(meta_value AS CHAR), '${o}', '${n}')`,
                    `UPDATE \`${p}usermeta\` SET meta_value = REPLACE(meta_value, '${o}', '${n}')`,
                    `UPDATE \`${p}comments\` SET comment_content = REPLACE(comment_content, '${o}', '${n}')`,
                    `UPDATE \`${p}comments\` SET comment_author_url = REPLACE(comment_author_url, '${o}', '${n}')`,
                    `UPDATE \`${p}commentmeta\` SET meta_value = REPLACE(meta_value, '${o}', '${n}')`,
                    `UPDATE \`${p}termmeta\` SET meta_value = REPLACE(meta_value, '${o}', '${n}')`,
                    `UPDATE \`${p}links\` SET link_url = REPLACE(link_url, '${o}', '${n}')`,
                    `UPDATE \`${p}links\` SET link_image = REPLACE(link_image, '${o}', '${n}')`,
                    `UPDATE \`${p}links\` SET link_rss = REPLACE(link_rss, '${o}', '${n}')`,
                  );
                }
                await executor.pushFile({
                  remotePath: srSqlFile,
                  content: Buffer.from(statements.join(";\n") + ";"),
                });
                const srResult = await executor.execute(
                  `mysql --defaults-extra-file=${shellQuote(srMycnf)} ${shellQuote(dbName)} < ${shellQuote(srSqlFile)}`,
                );
                await executor.execute(`rm -f ${shellQuote(srSqlFile)}`).catch(() => {});

                if (srResult.code !== 0) {
                  await tracker.track({
                    step: "URL search-replace SQL failed",
                    level: "warn",
                    detail: srResult.stderr,
                  });
                } else {
                  await tracker.track({
                    step: "URL search-replace SQL completed",
                    level: "info",
                  });
                }
              }
            } finally {
              await cleanupRemoteMyCnf(executor, srMycnf);
              await executor.execute(`rm -f ${srScript}`).catch(() => {});
            }

            // Determine content path (Standard wp-content vs Bedrock web/app)
            const isBedrock = await executor
              .execute(
                `test -d ${shellQuote(env.root_path + "/web/app")} && echo ok || echo missing`,
              )
              .then((r) => r.stdout.trim() === "ok")
              .catch(() => false);
            const contentPath = isBedrock
              ? `${env.root_path}/web/app`
              : `${env.root_path}/wp-content`;

            // Replace hardcoded URLs in content files (CSS, JS, PHP, etc.)
            const sedEscape = (s: string) =>
              s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
            const filePairs: Array<[string, string]> = [[srcUrl, tgtUrl]];
            const altSrc = flipProtocol(srcUrl);
            const altTgt = flipProtocol(tgtUrl);
            if (altSrc && altTgt && altSrc !== tgtUrl)
              filePairs.push([altSrc, altTgt]);

            for (const [oldUrl, newUrl] of filePairs) {
              await executor
                .execute(
                  [
                    `find ${shellQuote(contentPath)} -type f`,
                    `\\( -name '*.css' -o -name '*.js' -o -name '*.json' -o -name '*.html'`,
                    `-o -name '*.htm' -o -name '*.svg' -o -name '*.xml' -o -name '*.txt'`,
                    `-o -name '*.php' \\)`,
                    `-exec sed -i 's|${sedEscape(oldUrl)}|${sedEscape(newUrl)}|g' {} +`,
                  ].join(" "),
                )
                .catch(() => {});
            }

            // Flush caches
            const wpCli = await WpCliBuilder.create(executor, env.root_path);
            await executor
              .execute(wpCli.buildCommand("cache flush"))
              .catch(() => {});
            await executor
              .execute(wpCli.buildCommand("rewrite flush"))
              .catch(() => {});
            await executor
              .execute(wpCli.buildCommand("elementor flush-css"))
              .catch(() => {});

            // Purge all builder and performance disk caches
            const restoreCacheDirs = [
              shellQuote(`${contentPath}/cache`),
              shellQuote(`${contentPath}/et-cache`),
              shellQuote(`${contentPath}/litespeed`),
              shellQuote(`${contentPath}/uploads/et-cache`),
              shellQuote(`${contentPath}/uploads/et_temp`),
              shellQuote(`${contentPath}/uploads/elementor/css`),
              shellQuote(`${contentPath}/uploads/bb-plugin/cache`),
              shellQuote(`${contentPath}/uploads/oxygen/css`),
              shellQuote(`${contentPath}/uploads/bricks/css`),
              shellQuote(`${contentPath}/uploads/fusion-styles`),
              shellQuote(`${contentPath}/uploads/cache`),
            ];
            await executor
              .execute(`rm -rf ${restoreCacheDirs.join(" ")} 2>/dev/null; true`)
              .catch(() => {});
          }
        }
      }

      await job.updateProgress({
        value: 95,
        step: "Cleaning up remote temp files",
      });

      // ── Step E: Remote cleanup ──────────────────────────────────────────
      const cleanCmd = `rm -f ${remoteScript} ${remoteBackupPath}`;
      const cleanResult = await executor.execute(cleanCmd);
      await tracker.trackCommand(
        "Remote temp file cleanup",
        cleanCmd,
        cleanResult,
        0,
      );

      await tracker.track({ step: "Restore complete", level: "info" });
      await tracker.complete();
      await job.updateProgress({ value: 100, step: "Restore complete" });
    } catch (err) {
      await tracker.fail(err, "Backup restore");
      throw err;
    } finally {
      if (myCnfPath) {
        await cleanupRemoteMyCnf(executor, myCnfPath).catch(() => {});
      }
      await executor
        .execute(`rm -f ${remoteScript} ${remoteBackupPath}`)
        .catch((e) =>
          this.logger.warn(
            `[${job.id}] Remote cleanup on failure failed: ${e}`,
          ),
        );
    }
  }

  // ── Scheduled backup ──────────────────────────────────────────────────────

  private async handleScheduled(
    job: Job,
    scheduleId: number,
    environmentId: number,
    type: string,
  ) {
    this.logger.log(
      `[${job.id}] Scheduled backup triggered: scheduleId=${scheduleId} env=${environmentId} type=${type}`,
    );

    // Guard: if the schedule was deleted from the DB or disabled, self-clean the orphaned repeatable job
    const scheduleRecord = await this.prisma.backupSchedule.findUnique({
      where: { id: BigInt(scheduleId) },
    });
    if (!scheduleRecord || !scheduleRecord.enabled) {
      this.logger.warn(
        `[${job.id}] Schedule ${scheduleId} is disabled or no longer exists in DB — removing orphaned repeatable job and skipping`,
      );
      try {
        const repeatableJobs = await this.backupsQueue.getRepeatableJobs();
        const orphanKey = `backup-schedule-${scheduleId}`;
        for (const rj of repeatableJobs) {
          if (rj.id === orphanKey) {
            await this.backupsQueue.removeRepeatableByKey(rj.key);
            this.logger.log(
              `[${job.id}] Removed orphaned repeatable job: ${rj.key}`,
            );
          }
        }
      } catch (cleanupErr) {
        this.logger.warn(
          `[${job.id}] Could not remove orphaned repeatable job: ${cleanupErr}`,
        );
      }
      return;
    }

    // Create the Backup and JobExecution rows, then delegate to handleCreate
    const bullJobId = job.id ?? String(scheduleId);

    const exec = await this.prisma.jobExecution.create({
      data: {
        queue_name: QUEUES.BACKUPS,
        bull_job_id: bullJobId,
        environment_id: BigInt(environmentId),
        status: "queued",
        payload: { scheduleId, environmentId, type } as object,
      },
    });

    const env = await this.prisma.environment.findUniqueOrThrow({
      where: { id: BigInt(environmentId) },
    });

    if (!env.google_drive_folder_id) {
      const tracker = await StepTracker.start(
        this.prisma,
        exec.id,
        this.logger,
        job,
      );
      await tracker.fail(
        new Error(`Environment ${environmentId} has no google_drive_folder_id`),
        "Scheduled backup pre-flight",
      );
      this.logger.error(
        `[${job.id}] Scheduled backup aborted: no google_drive_folder_id on env ${environmentId}`,
      );
      return;
    }

    const backup = await this.prisma.backup.create({
      data: {
        environment_id: BigInt(environmentId),
        job_execution_id: exec.id,
        type: type as "full" | "db_only" | "files_only",
        status: "pending",
      },
    });

    // Update schedule's last_run_at
    await this.prisma.backupSchedule
      .update({
        where: { id: BigInt(scheduleId) },
        data: { last_run_at: new Date() },
      })
      .catch((e) =>
        this.logger.warn(`Could not update schedule last_run_at: ${e}`),
      );

    // Delegate to the standard create flow
    const jobExecutionId = Number(exec.id);
    const backupId = Number(backup.id);

    try {
      await this.handleCreate(
        job,
        environmentId,
        type,
        jobExecutionId,
        backupId,
      );
    } catch (err) {
      // handleCreate already marks backup + jobExecution as failed
      throw err;
    }

    // Run retention cleanup after a successful scheduled backup (non-fatal)
    await this.cleanupRetention(
      environmentId,
      backupId,
      scheduleRecord.retention_count ?? null,
      scheduleRecord.retention_days ?? null,
    ).catch((err) =>
      this.logger.warn(
        `[${job.id}] Retention cleanup failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
  }

  // ── Retention cleanup ─────────────────────────────────────────────────────

  /**
   * After a successful scheduled backup, prune older scheduled backups that
   * exceed the environment's retention policy. Only scheduled backups
   * (job_type = 'backup:scheduled') are considered — manual backups are never
   * auto-deleted. Runs non-fatally: failures are logged but do not fail the job.
   */
  private async cleanupRetention(
    environmentId: number,
    justCreatedBackupId: number,
    retentionCount: number | null,
    retentionDays: number | null,
  ): Promise<void> {
    if (!retentionCount && !retentionDays) return;

    // Fetch all completed scheduled backups for this environment,
    // ordered newest-first, excluding the backup just created.
    const scheduledBackups = await this.prisma.backup.findMany({
      where: {
        environment_id: BigInt(environmentId),
        status: "completed",
        id: { not: BigInt(justCreatedBackupId) },
        jobExecution: {
          job_type: JOB_TYPES.BACKUP_SCHEDULED,
        },
      },
      orderBy: { created_at: "desc" },
      select: { id: true, file_path: true, created_at: true },
    });

    const toDelete = new Set<bigint>();

    // Count limit: justCreated counts as 1. Keep (retentionCount - 1) from
    // the sorted list and mark the remainder for deletion.
    if (retentionCount && scheduledBackups.length >= retentionCount) {
      for (const b of scheduledBackups.slice(retentionCount - 1)) {
        toDelete.add(b.id);
      }
    }

    // Age limit: mark anything older than retentionDays for deletion.
    if (retentionDays) {
      const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
      for (const b of scheduledBackups) {
        if (b.created_at < cutoff) toDelete.add(b.id);
      }
    }

    if (toDelete.size === 0) return;

    this.logger.log(
      `[env ${environmentId}] Retention cleanup: removing ${toDelete.size} stale scheduled backup(s)`,
    );

    // Enqueue GDrive file deletion before removing DB rows (fire-and-forget)
    for (const id of toDelete) {
      const b = scheduledBackups.find((sb) => sb.id === id);
      if (b?.file_path) {
        await this.backupsQueue.add(
          JOB_TYPES.BACKUP_DELETE_FILE,
          { filePath: b.file_path },
          { ...DEFAULT_JOB_OPTIONS, attempts: 5 },
        );
      }
    }

    await this.prisma.backup.deleteMany({
      where: { id: { in: [...toDelete] } },
    });
  }

  // ── Delete file ───────────────────────────────────────────────────────────

  private async handleDelete(filePath: string) {
    if (!filePath) return;

    this.logger.log(`Deleting GDrive backup file: ${filePath}`);
    const configWritten = await this.rclone.writeConfig();

    if (!configWritten) {
      this.logger.warn(
        `No rclone config — cannot delete GDrive file: ${filePath}`,
      );
      return;
    }

    try {
      await this.rclone.deleteFile(filePath);
      this.logger.log(`Deleted GDrive file: ${filePath}`);
    } catch (err) {
      // Non-fatal — log and continue. File can be cleaned up manually.
      this.logger.error(
        `Failed to delete GDrive file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
