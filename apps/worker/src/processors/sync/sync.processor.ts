import { Processor, WorkerHost, InjectQueue } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { Job, Queue } from "bullmq";
import { mkdir, rm, mkdtemp } from "fs/promises";
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

    await job.updateProgress({ value: 5, step: "Connected to servers" });

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

    await job.updateProgress({ value: 15, step: "Credentials resolved" });

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

    await job.updateProgress({ value: 20, step: "URLs resolved" });

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
    await job.updateProgress({ value: 40, step: "Safety backup complete" });

    if (await tracker.isCancelled(this.syncQueue))
      throw new Error("Cancelled by user");

    // Dump source DB
    const dumpRemote = `/tmp/sync_${job.id}.sql`;
    const srcMycnf = await createRemoteMyCnf(
      sourceExecutor,
      sourceCreds,
      job.id ?? "default",
      "sync_src",
    );

    const cloneSafeProtected = this.syncDb.normalizeProtectedTables(
      targetEnv.protected_tables ?? [],
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

    await job.updateProgress({ value: 55, step: "Source database dumped" });

    if (await tracker.isCancelled(this.syncQueue))
      throw new Error("Cancelled by user");

    // Transfer dump to target via worker disk relay
    await tracker.track({
      step: "Transferring database dump to target",
      level: "info",
    });
    const localDumpDir = await mkdtemp(join(tmpdir(), "forge-sync-"));
    const localDumpPath = join(localDumpDir, `sync_${job.id}.sql`);
    try {
      await sourceExecutor.pullFileToPath(dumpRemote, localDumpPath);
      const cleanSrcResult = await sourceExecutor.execute(
        `rm -f ${shellQuote(dumpRemote)}`,
      );
      await tracker.trackCommand(
        "Source temp cleanup",
        `rm -f ${dumpRemote}`,
        cleanSrcResult,
        0,
      );

      const readStream = createReadStream(localDumpPath);
      await targetExecutor.pushFileFromStream(dumpRemote, readStream);
    } finally {
      await rm(localDumpDir, { recursive: true, force: true });
    }
    await job.updateProgress({ value: 65, step: "Dump transferred to target" });

    // Import on target
    const tgtMycnf = await createRemoteMyCnf(
      targetExecutor,
      targetCreds,
      job.id ?? "default",
      "sync_imp",
    );
    try {
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

      if (cloneSafeProtected.length > 0 || protectedPostTypesBackup) {
        await tracker.track({
          step: "Protected tables — checking target database existence",
          level: "info",
          detail: `Will preserve: ${cloneSafeProtected.join(", ")}`,
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
            cloneSafeProtected,
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
    } finally {
      await cleanupRemoteMyCnf(targetExecutor, tgtMycnf);
      const cleanTgtResult = await targetExecutor.execute(
        `rm -f ${shellQuote(dumpRemote)}`,
      );
      await tracker.trackCommand(
        "Target temp cleanup",
        `rm -f ${dumpRemote}`,
        cleanTgtResult,
        0,
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

    await job.updateProgress({
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

    await job.updateProgress({
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

    await job.updateProgress({ value: 85, step: "Files synced & config ensured" });

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
    await job.updateProgress({ value: 93, step: "File URLs replaced" });

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

    await job.updateProgress({ value: 100, step: "Clone complete" });
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

    await job.updateProgress({ value: 5, step: "Connected to servers" });

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

    await job.updateProgress({ value: 20, step: "Safety backup complete" });

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

    await job.updateProgress({
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

    await job.updateProgress({ value: 100, step: "Push complete" });
    await tracker.track({
      step: "Sync push complete",
      level: "info",
      detail: `scope=${scope}`,
    });
  }

  /** Push database from sourceEnv → targetEnv (same algorithm as processClone). */
  private async pushDatabase(
    job: Job,
    sourceEnv: { id: bigint; root_path: string; url?: string | null },
    targetEnv: {
      id: bigint;
      root_path: string;
      url?: string | null;
      protected_tables?: string[];
      sql_protection_queries?: string[];
      protected_post_types?: string[];
      server: { ip_address: string };
    },
    targetLayout: WpLayout,
    sourceExecutor: Executor,
    targetExecutor: Executor,
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
    );

    const pushSafeProtected = this.syncDb.normalizeProtectedTables(
      targetEnv.protected_tables ?? [],
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

    // Transfer via worker disk relay
    await tracker.track({
      step: "Transferring database dump to target",
      level: "info",
    });
    const localPushDir = await mkdtemp(join(tmpdir(), "forge-push-"));
    const localPushPath = join(localPushDir, `push_${job.id}.sql`);
    try {
      await sourceExecutor.pullFileToPath(dumpRemote, localPushPath);
      await sourceExecutor.execute(`rm -f ${shellQuote(dumpRemote)}`).catch(() => {});

      const readStream = createReadStream(localPushPath);
      await targetExecutor.pushFileFromStream(dumpRemote, readStream);
    } finally {
      await rm(localPushDir, { recursive: true, force: true });
    }

    // Import on target
    const tgtMycnf = await createRemoteMyCnf(
      targetExecutor,
      targetCreds,
      job.id ?? "default",
      "push_imp",
    );
    try {
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

      if (pushSafeProtected.length > 0 || protectedPostTypesBackup) {
        await tracker.track({
          step: "Protected tables — checking target database existence",
          level: "info",
          detail: `Will preserve: ${pushSafeProtected.join(", ")}`,
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
            pushSafeProtected,
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
    } finally {
      await cleanupRemoteMyCnf(targetExecutor, tgtMycnf);
      const cleanTgtResult = await targetExecutor.execute(
        `rm -f ${shellQuote(dumpRemote)}`,
      );
      await tracker.trackCommand(
        "Target temp cleanup",
        `rm -f ${dumpRemote}`,
        cleanTgtResult,
        0,
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
