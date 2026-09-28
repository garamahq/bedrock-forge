import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { Job, Queue } from "bullmq";
import { join } from "path";
import { PrismaService } from "../../prisma/prisma.service";
import { SshKeyService } from "../../services/ssh-key.service";
import { StepTracker } from "../../services/step-tracker";
import { createRemoteExecutor } from "@bedrock-forge/remote-executor";
import {
  QUEUES,
  JOB_TYPES,
  PluginInfoSchema,
  PluginScanOutputSchema,
  type PluginInfo,
  type PluginScanOutput,
  PluginManagePayload,
} from "@bedrock-forge/shared";
import { ConfigService } from "@nestjs/config";
import {
  buildWpCliPrefix,
  shellQuote,
  pushRemoteScript,
} from "../../utils/processor-utils";

function parsePluginScanOutput(value: unknown): PluginScanOutput {
  const output = PluginScanOutputSchema.safeParse(value);
  if (output.success) return output.data;

  const legacyPlugins = PluginInfoSchema.array().safeParse(value);
  if (legacyPlugins.success) {
    return { is_bedrock: false, plugins: legacyPlugins.data };
  }
  throw new Error("Plugin scan returned an invalid response");
}

function normalizeGithubRepoUrl(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  const ssh = trimmed.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i);
  if (ssh) return `${ssh[1].toLowerCase()}/${ssh[2].toLowerCase()}`;
  const https = trimmed.match(
    /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/i,
  );
  if (https) return `${https[1].toLowerCase()}/${https[2].toLowerCase()}`;
  return trimmed.replace(/\.git$/i, "").toLowerCase();
}

function parseVersion(value: string | null | undefined): number[] | null {
  if (!value) return null;
  const match = value.trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/i);
  if (!match) return null;
  return [Number(match[1] ?? 0), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

function compareVersions(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;
  for (let i = 0; i < 3; i++) {
    if (left[i] > right[i]) return 1;
    if (left[i] < right[i]) return -1;
  }
  return 0;
}

function caretConstraintFor(version: string): string | null {
  const parsed = parseVersion(version);
  if (!parsed) return null;
  return `^${parsed[0]}.${parsed[1]}`;
}

function constraintAllowsVersion(
  constraint: string | null | undefined,
  version: string | null | undefined,
): boolean {
  const parsed = parseVersion(version);
  if (!constraint || !parsed) return false;
  const normalized = constraint.trim();
  const exact = parseVersion(normalized);

  if (/^\^/.test(normalized)) {
    const base = parseVersion(normalized.slice(1));
    if (!base) return false;
    if (base[0] === 0) {
      return parsed[0] === base[0] && parsed[1] === base[1];
    }
    return (
      parsed[0] === base[0] &&
      compareVersions(version, normalized.slice(1)) >= 0
    );
  }

  if (/^~/.test(normalized)) {
    const base = parseVersion(normalized.slice(1));
    if (!base) return false;
    return parsed[0] === base[0] && parsed[1] === base[1];
  }

  if (exact) {
    return compareVersions(version, normalized) === 0;
  }

  return false;
}

// concurrency=2: plugin scans are SSH+PHP — moderate I/O, two at a time is safe.
@Processor(QUEUES.PLUGIN_SCANS, { concurrency: 2 })
export class PluginScanProcessor extends WorkerHost {
  private readonly logger = new Logger(PluginScanProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly sshKey: SshKeyService,
  ) {
    super();
  }

  async process(job: Job) {
    if (job.name === JOB_TYPES.PLUGIN_MANAGE) {
      return this.processManage(job);
    }
    return this.processScan(job);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Plugin scan (existing logic, updated to parse new PHP output format)
  // ─────────────────────────────────────────────────────────────────────────

  private async processScan(job: Job) {
    const { environmentId, jobExecutionId } = job.data as {
      environmentId: number;
      jobExecutionId: number;
    };

    const tracker = await StepTracker.start(
      this.prisma,
      jobExecutionId,
      this.logger,
      job,
    );

    try {
      await tracker.track({
        step: "Plugin scan started",
        level: "info",
        detail: `env=${environmentId}`,
      });

      const env = await this.prisma.environment.findUniqueOrThrow({
        where: { id: BigInt(environmentId) },
        include: { server: true },
      });

      const server = env.server;
      await tracker.track({
        step: "Connecting to server",
        level: "info",
        detail: server.ip_address,
      });
      const executor = createRemoteExecutor(
        await this.sshKey.getSshConfig(server),
      );

      await job.updateProgress(10);

      const scriptsPath = this.config.get<string>("scriptsPath")!;
      const remoteScript = `/tmp/plugin_scan_${job.id}.php`;
      await tracker.track({
        step: "Uploading plugin-scan script",
        level: "info",
        detail: `${join(scriptsPath, "plugin-scan.php")} → ${remoteScript}`,
      });
      await pushRemoteScript(
        executor,
        join(scriptsPath, "plugin-scan.php"),
        remoteScript,
      );

      await job.updateProgress(30);

      // Detect layout and WP path to resolve correct php binary version
      const wpPathResult = await executor.execute(
        `[ -d ${shellQuote(env.root_path + "/web/wp")} ] && echo bedrock || echo standard`,
        { timeout: 10_000 },
      );
      const isBedrockLayout = wpPathResult.stdout.trim() === "bedrock";
      const wpPath = isBedrockLayout
        ? `${env.root_path}/web/wp`
        : env.root_path;

      const { lsphpBin } = await buildWpCliPrefix(executor, wpPath);
      const phpCmd = lsphpBin ? lsphpBin : "php";

      await tracker.track({
        step: "Executing plugin scan",
        level: "info",
        detail: `docroot=${env.root_path} php=${phpCmd}`,
      });
      const scanStart = Date.now();
      const result = await executor.execute(
        `${phpCmd} ${shellQuote(remoteScript)} --docroot=${shellQuote(env.root_path)}`,
        { timeout: 5 * 60 * 1000 },
      );
      await tracker.trackCommand(
        "plugin-scan.php",
        `${phpCmd} ${shellQuote(remoteScript)} --docroot=${shellQuote(env.root_path)}`,
        result,
        Date.now() - scanStart,
      );

      if (result.code !== 0) {
        throw new Error(
          `plugin-scan.php failed (exit ${result.code}): ${result.stderr}`,
        );
      }

      await tracker.track({ step: "Parsing plugin results", level: "info" });
      // Handle both legacy array output and new { is_bedrock, plugins } format
      const scanOutput = parsePluginScanOutput(
        JSON.parse(result.stdout) as unknown,
      );
      const plugins = scanOutput.plugins;

      await job.updateProgress(80);

      await this.prisma.pluginScan.create({
        data: {
          environment_id: env.id,
          plugins: scanOutput as never,
          scanned_at: new Date(),
        },
      });

      await this.reconcileCustomPluginCatalog(env.id, plugins);

      await tracker.track({
        step: "Storing scan results",
        level: "info",
        detail: `${plugins.length} plugins found`,
      });
      await executor.execute(`rm -f ${shellQuote(remoteScript)}`);
      await job.updateProgress(100);

      await tracker.track({
        step: "Plugin scan complete",
        level: "info",
        detail: `${plugins.length} plugins`,
      });

      await tracker.complete();

      this.logger.log(
        `[${job.id}] Plugin scan complete. ${plugins.length} plugins found.`,
      );
    } catch (err: unknown) {
      this.logger.error(
        `Plugin scan job ${job.id} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      await tracker.fail(err, "Plugin scan");
      throw err;
    }
  }

  private async reconcileCustomPluginCatalog(
    environmentId: bigint,
    plugins: PluginInfo[],
  ) {
    const catalog = await this.prisma.customPlugin.findMany({
      where: { type: "plugin" },
      select: { id: true, slug: true, repo_url: true },
    });
    if (catalog.length === 0) return;

    const catalogBySlug = new Map(
      catalog.map((plugin) => [plugin.slug, plugin]),
    );
    const detectedCatalogIds = new Set<bigint>();
    for (const plugin of plugins) {
      if (plugin.is_mu_plugin) continue;
      if (!plugin.managed_by_monorepo) continue;
      const catalogPlugin = catalogBySlug.get(plugin.slug);
      if (!catalogPlugin) continue;

      const scannedRepo = normalizeGithubRepoUrl(plugin.monorepo_repo_url);
      const catalogRepo = normalizeGithubRepoUrl(catalogPlugin.repo_url);
      if (scannedRepo && catalogRepo && scannedRepo !== catalogRepo) continue;

      detectedCatalogIds.add(catalogPlugin.id);
      await this.prisma.environmentCustomPlugin.upsert({
        where: {
          environment_id_custom_plugin_id: {
            environment_id: environmentId,
            custom_plugin_id: catalogPlugin.id,
          },
        },
        update: {
          installed_version: plugin.version || null,
        },
        create: {
          environment_id: environmentId,
          custom_plugin_id: catalogPlugin.id,
          installed_version: plugin.version || null,
        },
      });
    }

    const staleCatalogIds = catalog
      .map((plugin) => plugin.id)
      .filter((id) => !detectedCatalogIds.has(id));
    if (staleCatalogIds.length > 0) {
      await this.prisma.environmentCustomPlugin.deleteMany({
        where: {
          environment_id: environmentId,
          custom_plugin_id: { in: staleCatalogIds },
        },
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Plugin manage (add / remove / update / update-all via composer)
  // ─────────────────────────────────────────────────────────────────────────

  private async processManage(job: Job) {
    const payload = job.data as PluginManagePayload & {
      workflow?: "composer" | "manual";
    };
    const {
      environmentId,
      jobExecutionId,
      action,
      slug,
      version,
      skipSafetyBackup,
    } = payload;

    const tracker = await StepTracker.start(
      this.prisma,
      jobExecutionId,
      this.logger,
      job,
    );

    try {
      const env = await this.prisma.environment.findUniqueOrThrow({
        where: { id: BigInt(environmentId) },
        include: { server: true },
      });

      // PRE-FLIGHT BACKUP LOGIC
      if (action !== "read" && !skipSafetyBackup) {
        if (!env.google_drive_folder_id) {
          throw new Error(
            'Google Drive not configured for this environment. Cannot perform safety backup. Please configure Google Drive or check "Skip safety backup".',
          );
        }

        await tracker.track({
          step: "Queueing pre-flight backup",
          level: "info",
        });

        const backupExec = await this.prisma.jobExecution.create({
          data: {
            environment_id: BigInt(environmentId),
            queue_name: QUEUES.BACKUPS,
            job_type: JOB_TYPES.BACKUP_CREATE,
            bull_job_id: "",
            status: "queued",
          },
        });

        const backup = await this.prisma.backup.create({
          data: {
            environment_id: BigInt(environmentId),
            type: "db_only",
            status: "running",
            size_bytes: 0,
            file_path: "temp",
            job_execution_id: backupExec.id,
          },
        });

        const redisUrl = this.config.get<string>("redis.url")!;
        const backupQueue = new Queue(QUEUES.BACKUPS, {
          connection: { url: redisUrl },
        });
        const { randomUUID } = await import("crypto");
        const backupBullJobId = randomUUID();

        await backupQueue.add(
          JOB_TYPES.BACKUP_CREATE,
          {
            environmentId,
            type: "db_only",
            jobExecutionId: Number(backupExec.id),
            backupId: Number(backup.id),
          },
          { jobId: backupBullJobId },
        );
        await backupQueue.close();

        await this.prisma.jobExecution.update({
          where: { id: backupExec.id },
          data: { bull_job_id: backupBullJobId },
        });

        let attempts = 0;
        let backupFailed = false;
        while (attempts < 120) {
          // wait up to 20 minutes (10s intervals)
          const exec = await this.prisma.jobExecution.findUnique({
            where: { id: backupExec.id },
          });
          if (exec?.status === "completed") break;
          if (exec?.status === "failed") {
            backupFailed = true;
            throw new Error("Pre-flight backup failed: " + exec.last_error);
          }
          await new Promise((r) => setTimeout(r, 10000));
          attempts++;
        }
        if (attempts >= 120 && !backupFailed) {
          throw new Error("Pre-flight backup timed out after 20 minutes");
        }

        await tracker.track({
          step: "Pre-flight backup completed successfully",
          level: "info",
        });
        await job.updateProgress(5);
      }

      await tracker.track({
        step: "Connecting to server",
        level: "info",
        detail: env.server.ip_address,
      });

      const executor = createRemoteExecutor(
        await this.sshKey.getSshConfig(env.server),
      );

      await job.updateProgress(10);

      // WP-CLI resolves the docroot via --path; for Bedrock the core is at
      // <root_path>/web/wp — detect by checking if that subdirectory exists.
      const wpPathResult = await executor.execute(
        `[ -d ${shellQuote(env.root_path + "/web/wp")} ] && echo bedrock || echo standard`,
        { timeout: 10_000 },
      );
      const isBedrockLayout = wpPathResult.stdout.trim() === "bedrock";
      const wpPath = isBedrockLayout
        ? `${env.root_path}/web/wp`
        : env.root_path;

      await tracker.track({
        step: "Detected WP layout",
        level: "info",
        detail: `${isBedrockLayout ? "Bedrock (web/wp)" : "Standard"} at ${wpPath}`,
      });

      const {
        prefix: wpPrefix,
        allowRootFlag,
        lsphpBin,
        wpBin,
      } = await buildWpCliPrefix(executor, wpPath);
      const phpCmd = lsphpBin ? shellQuote(lsphpBin) : "php";

      const buildWpCmd = (args: string): string => {
        let phpAndWp: string;
        if (lsphpBin && wpBin) {
          phpAndWp = `${shellQuote(lsphpBin)} ${shellQuote(wpBin)}`;
        } else if (lsphpBin) {
          phpAndWp = `env WP_CLI_PHP=${shellQuote(lsphpBin)} wp`;
        } else {
          phpAndWp = "wp";
        }
        return [wpPrefix, phpAndWp, args.trim(), allowRootFlag]
          .filter(Boolean)
          .join(" ");
      };

      // Fetch the latest scan to check plugin attributes (like managed_by_composer)
      const latestScan = await this.prisma.pluginScan.findFirst({
        where: { environment_id: BigInt(environmentId) },
        orderBy: { scanned_at: "desc" },
      });
      let isComposerManaged = false;
      let isPublicDomain = false;
      let matchedPlugin: PluginInfo | undefined;
      if (latestScan && latestScan.plugins) {
        const storedOutput = parsePluginScanOutput(latestScan.plugins);
        matchedPlugin = storedOutput.plugins.find((plugin) => plugin.slug === slug);
        if (matchedPlugin) {
          if (matchedPlugin.managed_by_composer) {
            isComposerManaged = true;
          }
          if (
            matchedPlugin.latest_version !== null &&
            matchedPlugin.latest_version !== undefined
          ) {
            isPublicDomain = true;
          }
        }
      }

      let useComposer = false;
      if (
        action === "update-all" ||
        action === "change-constraint" ||
        action === "read"
      ) {
        useComposer = true;
      } else if (action === "update") {
        useComposer = isBedrockLayout && isComposerManaged;
      } else if (action === "remove") {
        useComposer = true;
      } else if (action === "add") {
        useComposer =
          isBedrockLayout &&
          (!payload.workflow || payload.workflow === "composer");
      } else if (action === "delete") {
        useComposer = isBedrockLayout && isComposerManaged;
      } else if (action === "migrate-to-composer") {
        useComposer = true;
      }

      let manageResult: { code: number; stdout: string; stderr: string };
      const manageStart = Date.now();

      if (useComposer) {
        const scriptsPath = this.config.get<string>("scriptsPath")!;
        const remoteScript = `/tmp/composer_mgr_${job.id}.php`;

        await tracker.track({
          step: "Uploading composer-manager script",
          level: "info",
        });
        await pushRemoteScript(
          executor,
          join(scriptsPath, "composer-manager.php"),
          remoteScript,
        );

        await job.updateProgress(20);

        if (action === "migrate-to-composer") {
          if (!isBedrockLayout) {
            throw new Error(
              "Migration to Composer is only supported in Bedrock environments.",
            );
          }
          if (!slug) {
            throw new Error("Plugin slug is required for migration.");
          }
          if (!isPublicDomain) {
            throw new Error(
              `Plugin ${slug} is not available in the public WordPress repository and cannot be migrated to Composer.`,
            );
          }

          await tracker.track({
            step: "Renaming manual plugin directory for backup",
            level: "info",
            detail: slug,
          });

          const backupDirCmd = `mv ${shellQuote(env.root_path + "/web/app/plugins/" + slug)} ${shellQuote(env.root_path + "/web/app/plugins/" + slug + "_backup")}`;
          await executor.execute(backupDirCmd);

          const composerCmd = `${phpCmd} ${shellQuote(remoteScript)} --docroot=${shellQuote(env.root_path)} --action=add --package=${shellQuote("wpackagist-plugin/" + slug)}`;
          await tracker.track({
            step: "Requiring package via composer",
            level: "info",
            detail: `wpackagist-plugin/${slug}`,
          });

          manageResult = await executor.execute(composerCmd, {
            timeout: 10 * 60 * 1000,
          });
          await tracker.trackCommand(
            `composer add wpackagist-plugin/${slug}`,
            composerCmd,
            manageResult,
            Date.now() - manageStart,
          );

          if (manageResult.code === 0) {
            await tracker.track({
              step: "Cleaning up manual backup",
              level: "info",
            });
            await executor.execute(
              `rm -rf ${shellQuote(env.root_path + "/web/app/plugins/" + slug + "_backup")}`,
            );
          } else {
            await tracker.track({
              step: "Composer failed. Restoring manual plugin backup",
              level: "warn",
              detail: manageResult.stderr,
            });
            await executor.execute(
              `mv ${shellQuote(env.root_path + "/web/app/plugins/" + slug + "_backup")} ${shellQuote(env.root_path + "/web/app/plugins/" + slug)}`,
            );
            throw new Error(
              `composer migration failed: ${manageResult.stderr}`,
            );
          }
        } else {
          const pkgArg = slug
            ? ` --package=${shellQuote(`wpackagist-plugin/${slug}`)}`
            : "";
          const versionArg = version ? ` --version=${shellQuote(version)}` : "";
          let composerAction = action === "delete" ? "remove" : action;
          let nextConstraint = payload.constraint;
          if (
            action === "update" &&
            slug &&
            matchedPlugin?.latest_version &&
            matchedPlugin?.version &&
            compareVersions(
              matchedPlugin.latest_version,
              matchedPlugin.version,
            ) > 0 &&
            !constraintAllowsVersion(
              matchedPlugin.composer_constraint,
              matchedPlugin.latest_version,
            )
          ) {
            nextConstraint =
              caretConstraintFor(matchedPlugin.latest_version) ?? undefined;
            if (nextConstraint) {
              composerAction = "change-constraint";
              await tracker.track({
                step: "Widening composer constraint",
                level: "info",
                detail: `${slug}: ${matchedPlugin.composer_constraint ?? "(none)"} → ${nextConstraint}`,
              });
            }
          }
          const constraintArg = nextConstraint
            ? ` --constraint=${shellQuote(nextConstraint)}`
            : "";
          const cmd =
            `${phpCmd} ${shellQuote(remoteScript)} --docroot=${shellQuote(env.root_path)}` +
            ` --action=${shellQuote(composerAction)}${pkgArg}${versionArg}${constraintArg}`;

          await tracker.track({
            step: `Running composer ${composerAction}`,
            level: "info",
            detail: slug ?? "all packages",
          });

          manageResult = await executor.execute(cmd, {
            timeout: 10 * 60 * 1000,
          });
          await tracker.trackCommand(
            `composer ${composerAction}`,
            cmd,
            manageResult,
            Date.now() - manageStart,
          );
        }

        await executor.execute(`rm -f ${shellQuote(remoteScript)}`);
      } else {
        // WP-CLI Action
        let cliArgs = "";
        if (action === "add") {
          if (!slug) throw new Error("Plugin slug is required to install.");
          const wpVer = version ? ` --version=${shellQuote(version)}` : "";
          cliArgs = `plugin install ${shellQuote(slug)}${wpVer}`;
        } else if (action === "update") {
          if (!slug) throw new Error("Plugin slug is required to update.");
          cliArgs = `plugin update ${shellQuote(slug)}`;
        } else if (action === "delete") {
          if (!slug) throw new Error("Plugin slug is required to delete.");
          cliArgs = `plugin delete ${shellQuote(slug)}`;
        } else if (action === "activate") {
          if (!slug) throw new Error("Plugin slug is required to activate.");
          cliArgs = `plugin activate ${shellQuote(slug)}`;
        } else if (action === "deactivate") {
          if (!slug) throw new Error("Plugin slug is required to deactivate.");
          cliArgs = `plugin deactivate ${shellQuote(slug)}`;
        } else {
          throw new Error(`Unsupported WP-CLI action: ${action}`);
        }

        const cmd = buildWpCmd(
          `${cliArgs} --skip-plugins --path=${shellQuote(wpPath)}`,
        );

        await tracker.track({
          step: `Running wp-cli ${action}`,
          level: "info",
          detail: slug,
        });

        manageResult = await executor.execute(cmd, { timeout: 2 * 60 * 1000 });
        await tracker.trackCommand(
          `wp-cli ${action}`,
          cmd,
          manageResult,
          Date.now() - manageStart,
        );
      }

      if (manageResult.code !== 0) {
        throw new Error(
          `Action ${action} failed (exit ${manageResult.code}): ${manageResult.stderr}`,
        );
      }

      if (
        action === "update" &&
        slug &&
        matchedPlugin?.latest_version &&
        compareVersions(matchedPlugin.latest_version, matchedPlugin.version) > 0
      ) {
        const verifyCmd = buildWpCmd(
          `plugin get ${shellQuote(slug)} --field=version --skip-plugins --path=${shellQuote(wpPath)}`,
        );
        const verifyStart = Date.now();
        const verifyResult = await executor.execute(verifyCmd, {
          timeout: 60_000,
        });
        await tracker.trackCommand(
          `wp-cli verify ${slug} version`,
          verifyCmd,
          verifyResult,
          Date.now() - verifyStart,
        );
        if (verifyResult.code !== 0) {
          throw new Error(
            `Could not verify ${slug} after update: ${verifyResult.stderr || verifyResult.stdout}`,
          );
        }

        const installedVersion = verifyResult.stdout.trim();
        if (
          installedVersion &&
          compareVersions(installedVersion, matchedPlugin.latest_version) < 0
        ) {
          throw new Error(
            `${useComposer ? "Composer" : "WP-CLI"} finished without updating ${slug}. Installed ${installedVersion}, latest ${matchedPlugin.latest_version}. Check ${useComposer ? "composer constraints and lockfile output" : "the wp-cli output and WordPress.org availability"}.`,
          );
        }
      }

      await job.updateProgress(70);

      if (action === "read") {
        // Store the full JSON response as a retrievable log entry.
        await tracker.track({
          step: "composer-read-result",
          level: "info",
          detail: manageResult.stdout,
        });
      } else {
        // Always trigger a fresh plugin scan after any mutation so the stored
        // plugin list reflects the updated state.
        await tracker.track({
          step: "Triggering fresh plugin scan",
          level: "info",
        });

        const { randomUUID } = await import("crypto");
        const scanBullJobId = randomUUID();
        const scanExec = await this.prisma.jobExecution.create({
          data: {
            environment_id: BigInt(environmentId),
            queue_name: QUEUES.PLUGIN_SCANS,
            job_type: JOB_TYPES.PLUGIN_SCAN_RUN,
            bull_job_id: scanBullJobId,
          },
        });

        const { Queue } = await import("bullmq");
        const redisUrl = this.config.get<string>("redis.url")!;
        const scanQueue = new Queue(QUEUES.PLUGIN_SCANS, {
          connection: { url: redisUrl },
        });
        await scanQueue.add(
          JOB_TYPES.PLUGIN_SCAN_RUN,
          { environmentId, jobExecutionId: Number(scanExec.id) },
          { jobId: scanBullJobId },
        );
        await scanQueue.close();
      }

      await job.updateProgress(100);

      await tracker.track({
        step: `Action ${action} complete`,
        level: "info",
      });

      await tracker.complete();
    } catch (err: unknown) {
      this.logger.error(
        `Plugin manage job ${job.id} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      await tracker.fail(err, `plugin ${action}`);
      throw err;
    }
  }
}
