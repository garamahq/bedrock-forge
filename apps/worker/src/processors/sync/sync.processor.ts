import { Processor, WorkerHost, InjectQueue } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { Job, Queue } from "bullmq";
import { mkdir, rm, mkdtemp, stat } from "fs/promises";
import { createReadStream } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { PrismaService } from "../../prisma/prisma.service";
import { SshKeyService } from "../../services/ssh-key.service";
import { StepTracker } from "../../services/step-tracker";
import { createRemoteExecutor } from "@bedrock-forge/remote-executor";
import {
  QUEUES,
  JOB_TYPES,
  SyncClonePayloadSchema,
  SyncPushPayloadSchema,
} from "@bedrock-forge/shared";
import {
  shellQuote,
  createRemoteMyCnf,
  cleanupRemoteMyCnf,
} from "../../utils/processor-utils";
import {
  LayoutDetectorService,
  WpLayout,
} from "./services/layout-detector.service";
import {
  ProtectedCptService,
  ProtectedPostTypeBackup,
} from "./services/protected-cpt.service";
import { SyncDbService } from "./services/sync-db.service";
import { SyncFilesService } from "./services/sync-files.service";

type Executor = Awaited<ReturnType<typeof createRemoteExecutor>>;

// concurrency=1: sync jobs do SSH+mysqldump+rsync — serialised to avoid
// saturating CPU/network on concurrent large file transfers.
@Processor(QUEUES.SYNC, {
  concurrency: 1,
  lockDuration: 60_000,
  stalledInterval: 15_000,
  maxStalledCount: 1,
})
export class SyncProcessor extends WorkerHost {
  private readonly logger = new Logger(SyncProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sshKey: SshKeyService,
    private readonly layoutDetector: LayoutDetectorService,
    private readonly protectedCpt: ProtectedCptService,
    private readonly syncDb: SyncDbService,
    private readonly syncFiles: SyncFilesService,
    @InjectQueue(QUEUES.SYNC) private readonly syncQueue: Queue,
  ) {
    super();
  }

  async process(job: Job) {
    const { jobExecutionId } = job.data;
    const tracker = await StepTracker.start(
      this.prisma,
      jobExecutionId,
      this.logger,
      job,
    );

    try {
      if (job.name === JOB_TYPES.SYNC_CLONE) {
        await this.processClone(job, tracker);
      } else {
        await this.processPush(job, tracker);
      }

      await tracker.complete();
    } catch (err: unknown) {
      await tracker.fail(err, "Sync process");
      throw err;
    }
  }

  // ── Clone ──────────────────────────────────────────────────────────────────

  private async processClone(job: Job, tracker: StepTracker) {
    const { sourceEnvironmentId, targetEnvironmentId, jobExecutionId } =
      SyncClonePayloadSchema.parse(job.data);

    await tracker.track({
      step: "Database sync started",
      level: "info",
      detail: `source env ${sourceEnvironmentId} → target env ${targetEnvironmentId}`,
    });

    // Load environments
    const [sourceEnv, targetEnv] = await Promise.all([
      this.prisma.environment.findUniqueOrThrow({
        where: { id: BigInt(sourceEnvironmentId) },
        include: { server: true, project: true },
      }),
      this.prisma.environment.findUniqueOrThrow({
        where: { id: BigInt(targetEnvironmentId) },
        include: { server: true, project: true },
      }),
    ]);

    await tracker.track({
      step: "Sync direction",
      level: "info",
      detail: `${sourceEnv.project.name} (${sourceEnv.type}) → ${targetEnv.project.name} (${targetEnv.type})`,
    });

    // Connect to both servers
    await tracker.track({
      step: "Connecting to source server",
      level: "info",
      detail: sourceEnv.server.ip_address,
    });
    const sourceExecutor = createRemoteExecutor(
      await this.sshKey.getSshConfig(sourceEnv.server),
    );

    await tracker.track({
      step: "Connecting to target server",
      level: "info",
      detail: targetEnv.server.ip_address,
    });
    const targetExecutor = createRemoteExecutor(
      await this.sshKey.getSshConfig(targetEnv.server),
    );

    await tracker.updateProgress({ value: 5, step: "Connected to servers" });

    // Detect WordPress layout on both servers (standard vs Bedrock)
    const [sourceLayout, targetLayout] = await Promise.all([
      this.layoutDetector.detectWpLayout(
        sourceExecutor,
        sourceEnv.root_path,
        tracker,
        "source",
      ),
      this.layoutDetector.detectWpLayout(
        targetExecutor,
        targetEnv.root_path,
        tracker,
        "target",
      ),
    ]);

    // Resolve credentials
    await tracker.track({
      step: "Reading source database credentials",
      level: "info",
      detail: sourceEnv.root_path,
    });
    const sourceCreds = await this.syncDb.resolveCredentials(
      sourceExecutor,
      sourceEnv.root_path,
      tracker,
      "source",
      sourceEnv.id,
    );

    await tracker.track({
      step: "Reading target database credentials",
      level: "info",
      detail: targetEnv.root_path,
    });
    const targetCreds = await this.syncDb.resolveCredentials(
      targetExecutor,
      targetEnv.root_path,
      tracker,
      "target",
      targetEnv.id,
    );

    await tracker.updateProgress({ value: 15, step: "Credentials resolved" });

    // Auto-detect URLs for search-replace — no manual input required
    const sourceUrl = await this.syncDb.resolveWpUrl(
      sourceExecutor,
      sourceCreds,
      tracker,
      "source",
      sourceEnv.url,
    );
    const targetUrl = await this.syncDb.resolveWpUrl(
      targetExecutor,
      targetCreds,
      tracker,
      "target",
      targetEnv.url,
    );

    await tracker.updateProgress({ value: 20, step: "URLs resolved" });

    // Safety backup of target (optional if skipSafetyBackup=true, mandatory otherwise)
    if (job.data.skipSafetyBackup) {
      await tracker.track({
        step: "Safety backup SKIPPED — data loss risk accepted by user",
        level: "warn",
        detail:
          "skipSafetyBackup=true was passed. The target database will be overwritten without a prior backup.",
      });
    } else {
      await this.syncDb.createSafetyBackup(
        job,
        targetEnv,
        targetExecutor,
        targetCreds,
        tracker,
      );
    }
    await tracker.updateProgress({ value: 40, step: "Safety backup complete" });

    if (await tracker.isCancelled(this.syncQueue))
      throw new Error("Cancelled by user");

    // Dump source DB
    const dumpRemote = `/tmp/sync_${job.id}.sql`;
    const srcMycnf = await createRemoteMyCnf(
      sourceExecutor,
      sourceCreds,
      job.id ?? "default",
      "sync_src",
      { includeDatabase: false },
    );

    const cloneConfiguredProtected = this.syncDb.normalizeProtectedTables(
      targetEnv.protected_tables ?? [],
    );
    const cloneSourceGuardTables =
      await this.syncDb.getExistingSecureGuardTables(
        sourceExecutor,
        sourceCreds,
        srcMycnf,
      );
    const cloneSafeProtected = Array.from(
      new Set([...cloneConfiguredProtected, ...cloneSourceGuardTables]),
    );
    let protectedPostTypesBackup: ProtectedPostTypeBackup | null = null;

    try {
      const cloneIgnoreFlags =
        cloneSafeProtected.length > 0
          ? " " +
            cloneSafeProtected
              .map((t) => `--ignore-table=${sourceCreds.dbName}.${t}`)
              .join(" ")
          : "";
      if (cloneSafeProtected.length > 0) {
        await tracker.track({
          step: `Protected tables — excluding ${cloneSafeProtected.length} table(s) from dump`,
          level: "info",
          detail: cloneSafeProtected.join(", "),
        });
      }
      const maskedDump = `mysqldump --defaults-extra-file=*** --single-transaction --quick${cloneIgnoreFlags} ${sourceCreds.dbName}`;

      await tracker.track({
        step: "Dumping source database",
        level: "info",
        command: maskedDump,
      });
      const dumpStart = Date.now();
      const dumpResult = await sourceExecutor.execute(
        `mysqldump --defaults-extra-file=${shellQuote(srcMycnf)} --single-transaction --quick${cloneIgnoreFlags} ${shellQuote(sourceCreds.dbName)} > ${shellQuote(dumpRemote)}`,
        { timeout: 10 * 60_000 },
      );
      await tracker.trackCommand(
        "mysqldump source database",
        maskedDump,
        dumpResult,
        Date.now() - dumpStart,
      );

      if (dumpResult.code !== 0) {
        throw new Error(
          `mysqldump failed (exit ${dumpResult.code}): ${dumpResult.stderr}`,
        );
      }
    } finally {
      await cleanupRemoteMyCnf(sourceExecutor, srcMycnf);
    }

    await tracker.updateProgress({ value: 55, step: "Source database dumped" });

    if (await tracker.isCancelled(this.syncQueue))
      throw new Error("Cancelled by user");

    await this.transferDatabaseDump(
      job,
      sourceExecutor,
      targetExecutor,
      dumpRemote,
      "forge-sync-",
      `${sourceEnv.server.name} (${sourceEnv.server.ip_address})`,
      `${targetEnv.server.name} (${targetEnv.server.ip_address})`,
      55,
      tracker,
    );

    // Import on target
    const tgtMycnf = await createRemoteMyCnf(
      targetExecutor,
      targetCreds,
      job.id ?? "default",
      "sync_imp",
    );
    let databaseImportFailed = false;
    try {
      const targetBlogPublic = await this.syncDb.captureTargetBlogPublic(
        targetExecutor,
        targetCreds,
        tgtMycnf,
        tracker,
      );
      const targetRuntimeOptions =
        await this.syncDb.captureTargetRuntimeOptions(
          targetExecutor,
          targetCreds,
          tgtMycnf,
          tracker,
        );
      const cloneTargetGuardTables =
        await this.syncDb.getExistingSecureGuardTables(
          targetExecutor,
          targetCreds,
          tgtMycnf,
        );
      const cloneTargetProtected = Array.from(
        new Set([...cloneConfiguredProtected, ...cloneTargetGuardTables]),
      );

      if (
        targetEnv.protected_post_types &&
        targetEnv.protected_post_types.length > 0
      ) {
        protectedPostTypesBackup =
          await this.protectedCpt.backupProtectedPostTypes(
            targetExecutor,
            targetCreds,
            tgtMycnf,
            targetEnv.protected_post_types,
            tracker,
          );
      }

      if (cloneTargetProtected.length > 0 || protectedPostTypesBackup) {
        await tracker.track({
          step: "Protected tables — checking target database existence",
          level: "info",
          detail: `Will preserve: ${cloneTargetProtected.join(", ")}`,
        });
        const dbExistsRes = await targetExecutor.execute(
          `mysql --defaults-extra-file=${shellQuote(tgtMycnf)} -e ${shellQuote(`SHOW DATABASES LIKE '${targetCreds.dbName}';`)}`,
          { timeout: 30_000 },
        );
        const dbExists =
          dbExistsRes.code === 0 && dbExistsRes.stdout.trim().length > 0;

        if (dbExists) {
          await this.syncDb.trackProtectedTablePresence(
            targetExecutor,
            tgtMycnf,
            targetCreds.dbName,
            cloneTargetProtected,
            tracker,
          );
          await tracker.track({
            step: "Target database exists — skipping DROP/CREATE to preserve protected tables",
            level: "info",
            detail:
              "Unprotected tables replaced via DROP TABLE IF EXISTS in dump",
          });
        } else {
          await tracker.track({
            step: "Target database does not exist — creating (no data at risk)",
            level: "info",
            detail: targetCreds.dbName,
          });
          const createResult = await targetExecutor.execute(
            `mysql --defaults-extra-file=${shellQuote(tgtMycnf)} -e ${shellQuote(`CREATE DATABASE \`${targetCreds.dbName}\`;`)}`,
            { timeout: 2 * 60_000 },
          );
          if (createResult.code !== 0) {
            throw new Error(
              `Cannot create target database \`${targetCreds.dbName}\` — ` +
                `ensure ${targetCreds.dbUser} has CREATE privilege then retry.\n` +
                `Detail: ${createResult.stderr.trim()}`,
            );
          }
        }
      } else {
        await tracker.track({
          step: "Dropping and recreating target database (clean slate)",
          level: "info",
          detail: targetCreds.dbName,
        });
        const dropCreateResult = await targetExecutor.execute(
          `mysql --defaults-extra-file=${shellQuote(tgtMycnf)} -e ${shellQuote(`DROP DATABASE IF EXISTS \`${targetCreds.dbName}\`; CREATE DATABASE \`${targetCreds.dbName}\`;`)}`,
          { timeout: 2 * 60_000 },
        );
        if (dropCreateResult.code !== 0) {
          throw new Error(
            `Cannot reset target database for a clean-slate import. ` +
              `DROP DATABASE / CREATE DATABASE failed for \`${targetCreds.dbName}\` — ` +
              `ensure ${targetCreds.dbUser} has DROP and CREATE privileges then retry.\n` +
              `Detail: ${dropCreateResult.stderr.trim()}`,
          );
        }
      }

      const maskedImport = `mysql --defaults-extra-file=*** ${targetCreds.dbName}`;

      await tracker.track({
        step: "Importing database on target",
        level: "info",
        command: maskedImport,
      });
      const importStart = Date.now();
      const importResult = await targetExecutor.execute(
        `mysql --defaults-extra-file=${shellQuote(tgtMycnf)} ${shellQuote(targetCreds.dbName)} < ${shellQuote(dumpRemote)}`,
        { timeout: 10 * 60_000 },
      );

      if (importResult.code === 0 && protectedPostTypesBackup) {
        await this.protectedCpt.restoreProtectedPostTypes(
          targetExecutor,
          targetCreds,
          tgtMycnf,
          targetEnv.protected_post_types ?? [],
          protectedPostTypesBackup.prefix,
          tracker,
        );
      }

      await tracker.trackCommand(
        "mysql import on target",
        maskedImport,
        importResult,
        Date.now() - importStart,
      );

      if (importResult.code !== 0) {
        throw new Error(
          `mysql import failed (exit ${importResult.code}): ${importResult.stderr}`,
        );
      }

      await this.runTrackedStage(
        tracker,
        "Restoring target search visibility",
        () =>
          this.syncDb.enforceTargetBlogPublic(
            targetExecutor,
            targetCreds,
            tgtMycnf,
            targetEnv.type,
            targetBlogPublic,
            tracker,
          ),
      );
      await this.runTrackedStage(
        tracker,
        "Restoring target runtime options",
        () =>
          this.syncDb.restoreTargetRuntimeOptions(
            targetExecutor,
            targetCreds,
            tgtMycnf,
            targetRuntimeOptions,
            tracker,
          ),
      );
      await this.runTrackedStage(tracker, "Checking Secure Guard tables", () =>
        this.syncDb.scheduleSecureGuardSchemaRepair(
          targetExecutor,
          targetCreds,
          tgtMycnf,
          tracker,
        ),
      );
    } catch (err: unknown) {
      databaseImportFailed = true;
      throw err;
    } finally {
      await this.cleanupImportedDatabaseArtifacts(
        targetExecutor,
        tgtMycnf,
        dumpRemote,
        `${targetEnv.server.name} (${targetEnv.server.ip_address})`,
        tracker,
        databaseImportFailed,
      );
    }

    if (
      targetEnv.sql_protection_queries &&
      targetEnv.sql_protection_queries.length > 0
    ) {
      await this.syncDb.executeSqlProtectionQueries(
        targetExecutor,
        targetCreds,
        targetEnv.sql_protection_queries,
        tracker,
        job.id?.toString() || "unknown",
      );
    }

    await tracker.updateProgress({
      value: 80,
      step: "Database imported on target",
    });

    // URL search-replace
    await this.syncDb.runUrlSearchReplace(
      sourceUrl,
      targetUrl,
      targetExecutor,
      targetCreds,
      targetLayout.corePath,
      tracker,
      job,
      "sync",
      cloneSafeProtected,
    );

    if (sourceUrl && targetUrl && sourceUrl !== targetUrl) {
      await this.syncDb.validateUrlReplacement(
        targetExecutor,
        targetCreds,
        sourceUrl,
        targetUrl,
        tracker,
        cloneSafeProtected,
      );
    }

    await tracker.updateProgress({
      value: 83,
      step: "Database cloned, syncing files",
    });
    if (await tracker.isCancelled(this.syncQueue))
      throw new Error("Cancelled by user");

    // Sync site files source → target
    await this.syncFiles.pushFiles(
      job,
      sourceEnv,
      targetEnv,
      sourceExecutor,
      targetExecutor,
      tracker,
      this.protectedCpt.buildProtectedUploadFileExcludes(
        targetEnv.root_path,
        targetLayout,
        protectedPostTypesBackup?.uploadPaths ?? [],
      ),
    );

    // Re-detect WordPress layout on target after files are synced
    const updatedTargetLayout = await this.layoutDetector.detectWpLayout(
      targetExecutor,
      targetEnv.root_path,
      tracker,
      "target (post-sync)",
    );

    // Guarantee target .env / wp-config.php is synchronized with target DB credentials and URLs
    await this.syncDb.ensureTargetEnvironmentConfig(
      targetExecutor,
      targetEnv,
      updatedTargetLayout,
      targetCreds,
      targetUrl,
      tracker,
    );

    await tracker.updateProgress({
      value: 85,
      step: "Files synced & config ensured",
    });

    // Replace hardcoded URLs inside content files
    if (sourceUrl && targetUrl && sourceUrl !== targetUrl) {
      await this.syncFiles.replaceUrlsInFiles(
        sourceUrl,
        targetUrl,
        updatedTargetLayout.contentPath,
        targetExecutor,
        tracker,
        job,
      );
    }
    await tracker.updateProgress({ value: 93, step: "File URLs replaced" });

    const urlsIdentical = !sourceUrl || !targetUrl || sourceUrl === targetUrl;
    await this.syncDb.flushWordPressCaches(
      targetExecutor,
      targetCreds,
      updatedTargetLayout,
      tracker,
      "Clone",
      urlsIdentical,
      targetUrl,
    );

    await tracker.updateProgress({ value: 100, step: "Clone complete" });
    await tracker.track({
      step: "Sync complete",
      level: "info",
      detail:
        sourceUrl && targetUrl && sourceUrl !== targetUrl
          ? `URL changed: ${sourceUrl} → ${targetUrl}`
          : "Database cloned successfully",
    });
  }

  // ── Push ────────────────────────────────────────────────────────────────────

  private async processPush(job: Job, tracker: StepTracker) {
    const {
      sourceEnvironmentId,
      targetEnvironmentId,
      scope,
      jobExecutionId,
      skipSafetyBackup,
    } = SyncPushPayloadSchema.parse(job.data);

    await tracker.track({
      step: "Sync push started",
      level: "info",
      detail: `source env ${sourceEnvironmentId} → target env ${targetEnvironmentId}, scope=${scope}`,
    });

    // Load environments
    const [sourceEnv, targetEnv] = await Promise.all([
      this.prisma.environment.findUniqueOrThrow({
        where: { id: BigInt(sourceEnvironmentId) },
        include: { server: true, project: true },
      }),
      this.prisma.environment.findUniqueOrThrow({
        where: { id: BigInt(targetEnvironmentId) },
        include: { server: true, project: true },
      }),
    ]);

    await tracker.track({
      step: "Sync direction",
      level: "info",
      detail: `${sourceEnv.project.name} (${sourceEnv.type}) → ${targetEnv.project.name} (${targetEnv.type})`,
    });

    await tracker.track({
      step: "Connecting to source server",
      level: "info",
      detail: sourceEnv.server.ip_address,
    });
    const sourceExecutor = createRemoteExecutor(
      await this.sshKey.getSshConfig(sourceEnv.server),
    );

    await tracker.track({
      step: "Connecting to target server",
      level: "info",
      detail: targetEnv.server.ip_address,
    });
    const targetExecutor = createRemoteExecutor(
      await this.sshKey.getSshConfig(targetEnv.server),
    );

    await tracker.updateProgress({ value: 5, step: "Connected to servers" });

    // Detect WordPress layout on both servers
    const [sourcePushLayout, targetPushLayout] = await Promise.all([
      this.layoutDetector.detectWpLayout(
        sourceExecutor,
        sourceEnv.root_path,
        tracker,
        "source",
      ),
      this.layoutDetector.detectWpLayout(
        targetExecutor,
        targetEnv.root_path,
        tracker,
        "target",
      ),
    ]);

    // Safety backup of target before overwrite
    if (scope !== "files") {
      if (skipSafetyBackup) {
        await tracker.track({
          step: "Safety backup SKIPPED — data loss risk accepted by user",
          level: "warn",
          detail: "skipSafetyBackup=true was passed.",
        });
      } else {
        await this.syncDb.createSafetyBackup(
          job,
          targetEnv,
          targetExecutor,
          await this.syncDb.resolveCredentials(
            targetExecutor,
            targetEnv.root_path,
            tracker,
            "target-preflight",
            targetEnv.id,
          ),
          tracker,
        );
      }
    }

    await tracker.updateProgress({ value: 20, step: "Safety backup complete" });

    if (await tracker.isCancelled(this.syncQueue))
      throw new Error("Cancelled by user");
    let filesUrlsChanged: boolean | null = null;
    let protectedUploadFileExcludes: string[] = [];

    if (scope === "database" || scope === "both") {
      protectedUploadFileExcludes = await this.pushDatabase(
        job,
        sourceEnv,
        targetEnv,
        targetPushLayout,
        sourceExecutor,
        targetExecutor,
        `${sourceEnv.server.name} (${sourceEnv.server.ip_address})`,
        `${targetEnv.server.name} (${targetEnv.server.ip_address})`,
        tracker,
      );
    } else if (
      scope === "files" &&
      targetEnv.protected_post_types &&
      targetEnv.protected_post_types.length > 0
    ) {
      try {
        const targetCreds = await this.syncDb.resolveCredentials(
          targetExecutor,
          targetEnv.root_path,
          tracker,
          "target (protected file excludes)",
          targetEnv.id,
        );
        const tgtMycnf = await createRemoteMyCnf(
          targetExecutor,
          targetCreds,
          job.id ?? "default",
          "files_protected",
        );
        try {
          const protectedUploadPaths =
            await this.protectedCpt.collectProtectedPostTypeUploadPaths(
              targetExecutor,
              targetCreds,
              tgtMycnf,
              targetEnv.protected_post_types,
              tracker,
            );
          protectedUploadFileExcludes =
            this.protectedCpt.buildProtectedUploadFileExcludes(
              targetEnv.root_path,
              targetPushLayout,
              protectedUploadPaths,
            );
        } finally {
          await cleanupRemoteMyCnf(targetExecutor, tgtMycnf);
        }
      } catch (e) {
        await tracker.track({
          step: "Protected Post Types — upload file protection skipped",
          level: "warn",
          detail: e instanceof Error ? e.message : String(e),
        });
      }
    }

    await tracker.updateProgress({
      value: scope === "database" ? 100 : 60,
      step: scope === "database" ? "Push complete" : "Database pushed",
    });

    if (scope === "files" || scope === "both") {
      await this.syncFiles.pushFiles(
        job,
        sourceEnv,
        targetEnv,
        sourceExecutor,
        targetExecutor,
        tracker,
        protectedUploadFileExcludes,
      );

      // Re-detect WordPress layout on target after files are synced
      const updatedTargetPushLayout = await this.layoutDetector.detectWpLayout(
        targetExecutor,
        targetEnv.root_path,
        tracker,
        "target (post-sync)",
      );

      let filesSrcUrl: string | null = null;
      let filesTgtUrl: string | null = null;
      try {
        const srcCreds = await this.syncDb.resolveCredentials(
          sourceExecutor,
          sourceEnv.root_path,
          tracker,
          "source (file-replace)",
          sourceEnv.id,
        );
        const tgtCreds = await this.syncDb.resolveCredentials(
          targetExecutor,
          targetEnv.root_path,
          tracker,
          "target (file-replace)",
          targetEnv.id,
        );

        // Guarantee target .env / wp-config.php is synchronized with target DB credentials and URLs
        await this.syncDb.ensureTargetEnvironmentConfig(
          targetExecutor,
          targetEnv,
          updatedTargetPushLayout,
          tgtCreds,
          targetEnv.url ?? null,
          tracker,
        );

        filesSrcUrl = await this.syncDb.resolveWpUrl(
          sourceExecutor,
          srcCreds,
          tracker,
          "source (file-replace)",
          sourceEnv.url,
        );
        filesTgtUrl = await this.syncDb.resolveWpUrl(
          targetExecutor,
          tgtCreds,
          tracker,
          "target (file-replace)",
          targetEnv.url,
        );
        if (filesSrcUrl && filesTgtUrl) {
          filesUrlsChanged = filesSrcUrl !== filesTgtUrl;
        }
      } catch (e) {
        await tracker.track({
          step: "Could not resolve URLs for file search-replace — skipping",
          level: "warn",
          detail: e instanceof Error ? e.message : String(e),
        });
      }

      if (filesSrcUrl && filesTgtUrl && filesSrcUrl !== filesTgtUrl) {
        await this.syncFiles.replaceUrlsInFiles(
          filesSrcUrl,
          filesTgtUrl,
          updatedTargetPushLayout.contentPath,
          targetExecutor,
          tracker,
          job,
        );
      }
    }

    // Flush all WordPress caches on target after any push operation
    try {
      const pushFlushLayout =
        scope === "files" || scope === "both"
          ? await this.layoutDetector.detectWpLayout(
              targetExecutor,
              targetEnv.root_path,
              tracker,
              "target (cache-flush)",
            )
          : targetPushLayout;

      const pushFlushCreds = await this.syncDb.resolveCredentials(
        targetExecutor,
        targetEnv.root_path,
        tracker,
        "target (cache-flush)",
        targetEnv.id,
      );
      await this.syncDb.flushWordPressCaches(
        targetExecutor,
        pushFlushCreds,
        pushFlushLayout,
        tracker,
        "Push",
        scope === "files" || (scope === "both" && filesUrlsChanged === false),
        targetEnv.url,
      );
    } catch (e) {
      await tracker.track({
        step: "Post-push cache flush skipped — credentials unavailable",
        level: "warn",
        detail: e instanceof Error ? e.message : String(e),
      });
    }

    await tracker.updateProgress({ value: 100, step: "Push complete" });
    await tracker.track({
      step: "Sync push complete",
      level: "info",
      detail: `scope=${scope}`,
    });
  }

  /** Push database from sourceEnv → targetEnv (same algorithm as processClone). */
  private async transferDatabaseDump(
    job: Job,
    sourceExecutor: Executor,
    targetExecutor: Executor,
    dumpRemote: string,
    localDirectoryPrefix: string,
    sourceServerLabel: string,
    targetServerLabel: string,
    startingProgress: number,
    tracker: StepTracker,
  ): Promise<void> {
    const localDumpDir = await mkdtemp(join(tmpdir(), localDirectoryPrefix));
    const localDumpPath = join(localDumpDir, `sync_${job.id}.sql`);
    let targetDumpUploaded = false;

    try {
      await tracker.updateProgress({
        value: startingProgress,
        step: "Downloading database dump from source server",
      });
      await tracker.track({
        step: "Downloading database dump from source server",
        level: "info",
        detail: sourceServerLabel,
      });

      const downloadStartedAt = Date.now();
      try {
        await sourceExecutor.pullFileToPath(dumpRemote, localDumpPath);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        await tracker.track({
          step: "Database dump download failed",
          level: "error",
          detail: `${sourceServerLabel}: ${message}`,
          durationMs: Date.now() - downloadStartedAt,
        });
        throw new Error(
          `Database dump download from source server (${sourceServerLabel}) failed: ${message}`,
        );
      } finally {
        await this.cleanupTemporaryDump(
          sourceExecutor,
          dumpRemote,
          "Source temporary database dump cleanup",
          tracker,
        );
      }

      const dumpSize = (await stat(localDumpPath)).size;
      await tracker.track({
        step: "Database dump downloaded from source server",
        level: "info",
        detail: `${sourceServerLabel}; ${dumpSize.toLocaleString()} bytes`,
        durationMs: Date.now() - downloadStartedAt,
      });
      await tracker.updateProgress({
        value: startingProgress + 5,
        step: "Uploading database dump to target server",
      });
      await tracker.track({
        step: "Uploading database dump to target server",
        level: "info",
        detail: `${targetServerLabel}; ${dumpSize.toLocaleString()} bytes`,
      });

      const uploadStartedAt = Date.now();
      try {
        await targetExecutor.pushFileFromStream(
          dumpRemote,
          createReadStream(localDumpPath),
        );
        targetDumpUploaded = true;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        await tracker.track({
          step: "Database dump upload failed",
          level: "error",
          detail: `${targetServerLabel}: ${message}`,
          durationMs: Date.now() - uploadStartedAt,
        });
        throw new Error(
          `Database dump upload to target server (${targetServerLabel}) failed: ${message}`,
        );
      }

      await tracker.track({
        step: "Database dump uploaded to target server",
        level: "info",
        detail: `${targetServerLabel}; ${dumpSize.toLocaleString()} bytes`,
        durationMs: Date.now() - uploadStartedAt,
      });
      await tracker.updateProgress({
        value: startingProgress + 10,
        step: "Database dump transferred to target",
      });
    } finally {
      await rm(localDumpDir, { recursive: true, force: true });
      if (!targetDumpUploaded) {
        await this.cleanupTemporaryDump(
          targetExecutor,
          dumpRemote,
          "Partial target database dump cleanup",
          tracker,
        );
      }
    }
  }

  private async cleanupTemporaryDump(
    executor: Executor,
    dumpRemote: string,
    step: string,
    tracker: StepTracker,
  ): Promise<void> {
    try {
      const result = await executor.execute(`rm -f ${shellQuote(dumpRemote)}`, {
        timeout: 30_000,
      });
      if (result.code !== 0) {
        await tracker.track({
          step,
          level: "warn",
          detail: `Cleanup command exited ${result.code}: ${result.stderr || result.stdout}`,
        });
      }
    } catch (err: unknown) {
      await tracker.track({
        step,
        level: "warn",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async runTrackedStage<T>(
    tracker: StepTracker,
    stage: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    await tracker.track({ step: stage, level: "info" });
    try {
      const result = await operation();
      await tracker.track({ step: `${stage} complete`, level: "info" });
      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      await tracker.track({
        step: `${stage} failed`,
        level: "error",
        detail: message,
      });
      throw new Error(`${stage} failed: ${message}`);
    }
  }

  private async cleanupImportedDatabaseArtifacts(
    executor: Executor,
    mycnf: string,
    dumpRemote: string,
    serverLabel: string,
    tracker: StepTracker,
    previousFailure: boolean,
  ): Promise<void> {
    const failures: string[] = [];

    await tracker.track({
      step: "Removing temporary target database credentials",
      level: "info",
      detail: serverLabel,
    });
    try {
      await cleanupRemoteMyCnf(executor, mycnf);
      await tracker.track({
        step: "Removed temporary target database credentials",
        level: "info",
        detail: serverLabel,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`temporary database credentials: ${message}`);
    }

    try {
      const cleanResult = await executor.execute(
        `rm -f ${shellQuote(dumpRemote)}`,
        { timeout: 30_000 },
      );
      await tracker.trackCommand(
        "Target temporary database dump cleanup",
        `rm -f ${dumpRemote}`,
        cleanResult,
        0,
      );
      if (cleanResult.code !== 0) {
        failures.push(
          `temporary database dump: ${cleanResult.stderr || cleanResult.stdout || `exit ${cleanResult.code}`}`,
        );
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`temporary database dump: ${message}`);
    }

    if (failures.length === 0) return;

    const detail = `${serverLabel}; ${failures.join("; ")}`;
    await tracker.track({
      step: "Target database cleanup incomplete",
      level: previousFailure ? "warn" : "error",
      detail,
    });
    if (!previousFailure) {
      throw new Error(
        `Database import completed, but temporary files could not be fully removed from ${serverLabel}: ${failures.join("; ")}`,
      );
    }
  }

  private async pushDatabase(
    job: Job,
    sourceEnv: { id: bigint; root_path: string; url?: string | null },
    targetEnv: {
      id: bigint;
      root_path: string;
      url?: string | null;
      type?: string | null;
      protected_tables?: string[];
      sql_protection_queries?: string[];
      protected_post_types?: string[];
      server: { ip_address: string };
    },
    targetLayout: WpLayout,
    sourceExecutor: Executor,
    targetExecutor: Executor,
    sourceServerLabel: string,
    targetServerLabel: string,
    tracker: StepTracker,
  ): Promise<string[]> {
    await tracker.track({
      step: "Resolving source database credentials",
      level: "info",
    });
    const sourceCreds = await this.syncDb.resolveCredentials(
      sourceExecutor,
      sourceEnv.root_path,
      tracker,
      "source",
      sourceEnv.id,
    );

    await tracker.track({
      step: "Resolving target database credentials",
      level: "info",
    });
    const targetCreds = await this.syncDb.resolveCredentials(
      targetExecutor,
      targetEnv.root_path,
      tracker,
      "target",
      targetEnv.id,
    );

    const sourceUrl = await this.syncDb.resolveWpUrl(
      sourceExecutor,
      sourceCreds,
      tracker,
      "source",
      sourceEnv.url,
    );
    const targetUrl = await this.syncDb.resolveWpUrl(
      targetExecutor,
      targetCreds,
      tracker,
      "target",
      targetEnv.url,
    );

    // Dump source
    const dumpRemote = `/tmp/forge_push_${job.id}.sql`;
    const srcMycnf = await createRemoteMyCnf(
      sourceExecutor,
      sourceCreds,
      job.id ?? "default",
      "push_src",
      { includeDatabase: false },
    );

    const pushConfiguredProtected = this.syncDb.normalizeProtectedTables(
      targetEnv.protected_tables ?? [],
    );
    const pushSourceGuardTables =
      await this.syncDb.getExistingSecureGuardTables(
        sourceExecutor,
        sourceCreds,
        srcMycnf,
      );
    const pushSafeProtected = Array.from(
      new Set([...pushConfiguredProtected, ...pushSourceGuardTables]),
    );
    let protectedPostTypesBackup: ProtectedPostTypeBackup | null = null;

    try {
      const pushIgnoreFlags =
        pushSafeProtected.length > 0
          ? " " +
            pushSafeProtected
              .map((t) => `--ignore-table=${sourceCreds.dbName}.${t}`)
              .join(" ")
          : "";
      if (pushSafeProtected.length > 0) {
        await tracker.track({
          step: `Protected tables — excluding ${pushSafeProtected.length} table(s) from dump`,
          level: "info",
          detail: pushSafeProtected.join(", "),
        });
      }
      const maskedDump = `mysqldump --defaults-extra-file=*** --single-transaction --quick${pushIgnoreFlags} ${sourceCreds.dbName}`;

      await tracker.track({
        step: "Dumping source database",
        level: "info",
        command: maskedDump,
      });
      const dumpStart = Date.now();
      const dumpResult = await sourceExecutor.execute(
        `mysqldump --defaults-extra-file=${shellQuote(srcMycnf)} --single-transaction --quick${pushIgnoreFlags} ${shellQuote(sourceCreds.dbName)} > ${shellQuote(dumpRemote)}`,
        { timeout: 10 * 60_000 },
      );
      await tracker.trackCommand(
        "mysqldump source database",
        maskedDump,
        dumpResult,
        Date.now() - dumpStart,
      );
      if (dumpResult.code !== 0) {
        throw new Error(
          `mysqldump failed (exit ${dumpResult.code}): ${dumpResult.stderr}`,
        );
      }
    } finally {
      await cleanupRemoteMyCnf(sourceExecutor, srcMycnf);
    }

    await this.transferDatabaseDump(
      job,
      sourceExecutor,
      targetExecutor,
      dumpRemote,
      "forge-push-",
      sourceServerLabel,
      targetServerLabel,
      50,
      tracker,
    );

    // Import on target
    const tgtMycnf = await createRemoteMyCnf(
      targetExecutor,
      targetCreds,
      job.id ?? "default",
      "push_imp",
    );
    let databaseImportFailed = false;
    try {
      const targetBlogPublic = await this.syncDb.captureTargetBlogPublic(
        targetExecutor,
        targetCreds,
        tgtMycnf,
        tracker,
      );
      const targetRuntimeOptions =
        await this.syncDb.captureTargetRuntimeOptions(
          targetExecutor,
          targetCreds,
          tgtMycnf,
          tracker,
        );
      const pushTargetGuardTables =
        await this.syncDb.getExistingSecureGuardTables(
          targetExecutor,
          targetCreds,
          tgtMycnf,
        );
      const pushTargetProtected = Array.from(
        new Set([...pushConfiguredProtected, ...pushTargetGuardTables]),
      );

      if (
        targetEnv.protected_post_types &&
        targetEnv.protected_post_types.length > 0
      ) {
        protectedPostTypesBackup =
          await this.protectedCpt.backupProtectedPostTypes(
            targetExecutor,
            targetCreds,
            tgtMycnf,
            targetEnv.protected_post_types,
            tracker,
          );
      }

      if (pushTargetProtected.length > 0 || protectedPostTypesBackup) {
        await tracker.track({
          step: "Protected tables — checking target database existence",
          level: "info",
          detail: `Will preserve: ${pushTargetProtected.join(", ")}`,
        });
        const dbExistsRes = await targetExecutor.execute(
          `mysql --defaults-extra-file=${shellQuote(tgtMycnf)} -e ${shellQuote(`SHOW DATABASES LIKE '${targetCreds.dbName}';`)}`,
          { timeout: 30_000 },
        );
        const dbExists =
          dbExistsRes.code === 0 && dbExistsRes.stdout.trim().length > 0;

        if (dbExists) {
          await this.syncDb.trackProtectedTablePresence(
            targetExecutor,
            tgtMycnf,
            targetCreds.dbName,
            pushTargetProtected,
            tracker,
          );
          await tracker.track({
            step: "Target database exists — skipping DROP/CREATE to preserve protected tables",
            level: "info",
            detail:
              "Unprotected tables replaced via DROP TABLE IF EXISTS in dump",
          });
        } else {
          await tracker.track({
            step: "Target database does not exist — creating (no data at risk)",
            level: "info",
            detail: targetCreds.dbName,
          });
          const createResult = await targetExecutor.execute(
            `mysql --defaults-extra-file=${shellQuote(tgtMycnf)} -e ${shellQuote(`CREATE DATABASE \`${targetCreds.dbName}\`;`)}`,
            { timeout: 2 * 60_000 },
          );
          if (createResult.code !== 0) {
            throw new Error(
              `Cannot create target database \`${targetCreds.dbName}\` — ` +
                `ensure ${targetCreds.dbUser} has CREATE privilege then retry.\n` +
                `Detail: ${createResult.stderr.trim()}`,
            );
          }
        }
      } else {
        await tracker.track({
          step: "Dropping and recreating target database (clean slate)",
          level: "info",
          detail: targetCreds.dbName,
        });
        const dropCreateResult = await targetExecutor.execute(
          `mysql --defaults-extra-file=${shellQuote(tgtMycnf)} -e ${shellQuote(`DROP DATABASE IF EXISTS \`${targetCreds.dbName}\`; CREATE DATABASE \`${targetCreds.dbName}\`;`)}`,
          { timeout: 2 * 60_000 },
        );
        if (dropCreateResult.code !== 0) {
          throw new Error(
            `Cannot reset target database for a clean-slate import. ` +
              `DROP DATABASE / CREATE DATABASE failed for \`${targetCreds.dbName}\` — ` +
              `ensure ${targetCreds.dbUser} has DROP and CREATE privileges then retry.\n` +
              `Detail: ${dropCreateResult.stderr.trim()}`,
          );
        }
      }

      const maskedImport = `mysql --defaults-extra-file=*** ${targetCreds.dbName}`;

      await tracker.track({
        step: "Importing database on target",
        level: "info",
        command: maskedImport,
      });
      const importStart = Date.now();
      const importResult = await targetExecutor.execute(
        `mysql --defaults-extra-file=${shellQuote(tgtMycnf)} ${shellQuote(targetCreds.dbName)} < ${shellQuote(dumpRemote)}`,
        { timeout: 10 * 60_000 },
      );

      if (importResult.code === 0 && protectedPostTypesBackup) {
        await this.protectedCpt.restoreProtectedPostTypes(
          targetExecutor,
          targetCreds,
          tgtMycnf,
          targetEnv.protected_post_types ?? [],
          protectedPostTypesBackup.prefix,
          tracker,
        );
      }

      await tracker.trackCommand(
        "mysql import on target",
        maskedImport,
        importResult,
        Date.now() - importStart,
      );

      if (importResult.code !== 0) {
        throw new Error(
          `mysql import failed (exit ${importResult.code}): ${importResult.stderr}`,
        );
      }

      await this.runTrackedStage(
        tracker,
        "Restoring target search visibility",
        () =>
          this.syncDb.enforceTargetBlogPublic(
            targetExecutor,
            targetCreds,
            tgtMycnf,
            targetEnv.type,
            targetBlogPublic,
            tracker,
          ),
      );
      await this.runTrackedStage(
        tracker,
        "Restoring target runtime options",
        () =>
          this.syncDb.restoreTargetRuntimeOptions(
            targetExecutor,
            targetCreds,
            tgtMycnf,
            targetRuntimeOptions,
            tracker,
          ),
      );
      await this.runTrackedStage(tracker, "Checking Secure Guard tables", () =>
        this.syncDb.scheduleSecureGuardSchemaRepair(
          targetExecutor,
          targetCreds,
          tgtMycnf,
          tracker,
        ),
      );
    } catch (err: unknown) {
      databaseImportFailed = true;
      throw err;
    } finally {
      await this.cleanupImportedDatabaseArtifacts(
        targetExecutor,
        tgtMycnf,
        dumpRemote,
        targetServerLabel,
        tracker,
        databaseImportFailed,
      );
    }

    if (
      targetEnv.sql_protection_queries &&
      targetEnv.sql_protection_queries.length > 0
    ) {
      await this.syncDb.executeSqlProtectionQueries(
        targetExecutor,
        targetCreds,
        targetEnv.sql_protection_queries,
        tracker,
        job.id?.toString() || "unknown",
      );
    }

    // URL search-replace
    await this.syncDb.runUrlSearchReplace(
      sourceUrl,
      targetUrl,
      targetExecutor,
      targetCreds,
      targetLayout.corePath,
      tracker,
      job,
      "push",
      pushSafeProtected,
    );

    if (sourceUrl && targetUrl && sourceUrl !== targetUrl) {
      await this.syncDb.validateUrlReplacement(
        targetExecutor,
        targetCreds,
        sourceUrl,
        targetUrl,
        tracker,
        pushSafeProtected,
      );
    }

    // Guarantee target .env / wp-config.php is synchronized with target DB credentials
    await this.syncDb.ensureTargetEnvironmentConfig(
      targetExecutor,
      targetEnv,
      targetLayout,
      targetCreds,
      targetUrl,
      tracker,
    );

    return this.protectedCpt.buildProtectedUploadFileExcludes(
      targetEnv.root_path,
      targetLayout,
      protectedPostTypesBackup?.uploadPaths ?? [],
    );
  }
}
