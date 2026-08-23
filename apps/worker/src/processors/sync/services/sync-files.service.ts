import { Injectable, Logger } from "@nestjs/common";
import { Job } from "bullmq";
import { stat, mkdtemp, rm } from "fs/promises";
import { createReadStream } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SshKeyService } from "../../../services/ssh-key.service";
import { StepTracker } from "../../../services/step-tracker";
import { createRemoteExecutor } from "@bedrock-forge/remote-executor";
import {
  shellQuote,
  flipProtocol,
  fixCyberPanelOwnership,
} from "../../../utils/processor-utils";
import { WpLayout } from "./layout-detector.service";

type Executor = Awaited<ReturnType<typeof createRemoteExecutor>>;

@Injectable()
export class SyncFilesService {
  private readonly logger = new Logger(SyncFilesService.name);

  private readonly RSYNC_EXCLUDES = [
    ".env",
    ".env.*",
    "web/.env",
    "web/.env.*",
    "wp-config.php",
    "web/wp-config.php",
    ".htaccess",
    "web/.htaccess",
    "storage/",
    "node_modules/",
    // Builder and performance disk caches (regenerated cleanly on target)
    "wp-content/cache/",
    "wp-content/et-cache/",
    "wp-content/litespeed/",
    "wp-content/uploads/et-cache/",
    "wp-content/uploads/et_temp/",
    "wp-content/uploads/elementor/css/",
    "wp-content/uploads/bb-plugin/cache/",
    "wp-content/uploads/oxygen/css/",
    "wp-content/uploads/bricks/css/",
    "wp-content/uploads/fusion-styles/",
    "wp-content/uploads/cache/",
    "web/app/cache/",
    "web/app/et-cache/",
    "web/app/litespeed/",
    "web/app/uploads/et-cache/",
    "web/app/uploads/et_temp/",
    "web/app/uploads/elementor/css/",
    "web/app/uploads/bb-plugin/cache/",
    "web/app/uploads/oxygen/css/",
    "web/app/uploads/bricks/css/",
    "web/app/uploads/fusion-styles/",
    "web/app/uploads/cache/",
  ];

  constructor(private readonly sshKey: SshKeyService) {}

  /**
   * Sync site files from source → target via rsync over SSH.
   */
  async pushFiles(
    job: Job,
    sourceEnv: { root_path: string },
    targetEnv: {
      root_path: string;
      server: {
        ip_address: string;
        ssh_port: number;
        ssh_user: string;
        name: string;
        ssh_private_key_encrypted: string | null;
      };
    },
    sourceExecutor: Executor,
    targetExecutor: Executor,
    tracker: StepTracker,
    protectedFileExcludes: string[] = [],
  ): Promise<void> {
    const sourceSite = sourceEnv.root_path;
    const targetSite = targetEnv.root_path;

    await tracker.track({
      step: "Checking source site directory",
      level: "info",
      detail: sourceSite,
    });

    // Verify root_path exists on source
    const checkResult = await sourceExecutor.execute(
      `test -d ${shellQuote(sourceSite)} && echo ok || echo missing`,
    );
    if (checkResult.code !== 0 || checkResult.stdout.trim() === "missing") {
      await tracker.track({
        step: "Source site directory not found — skipping file sync",
        level: "warn",
        detail: `${sourceSite} does not exist`,
      });
      return;
    }

    // Pre-sync: proactively unlock permissions and immutable attributes on target
    await targetExecutor
      .execute(
        `chattr -R -i -a ${shellQuote(targetSite)} 2>/dev/null || true; chmod -R u+w ${shellQuote(targetSite)} 2>/dev/null || true; find ${shellQuote(targetSite)} -type d -exec chmod 755 {} + 2>/dev/null || true; find ${shellQuote(targetSite)} -type f -exec chmod 644 {} + 2>/dev/null || true`,
      )
      .catch(() => {});

    // Check if rsync is available on both source and target
    const [rsyncSrcCheck, rsyncTgtCheck] = await Promise.all([
      sourceExecutor.execute(
        "command -v rsync > /dev/null 2>&1 && echo ok || echo missing",
      ),
      targetExecutor.execute(
        "command -v rsync > /dev/null 2>&1 && echo ok || echo missing",
      ),
    ]);
    const hasRsync =
      rsyncSrcCheck.stdout.trim() === "ok" &&
      rsyncTgtCheck.stdout.trim() === "ok";

    if (hasRsync) {
      await this.pushFilesViaRsync(
        job,
        sourceSite,
        targetSite,
        targetEnv,
        sourceExecutor,
        tracker,
        protectedFileExcludes,
      );
    } else {
      await tracker.track({
        step: "rsync not available on source — using tar pipe relay",
        level: "warn",
        detail: "Falling back to tar + pull + push through worker",
      });
      await this.pushFilesViaTarRelay(
        job,
        sourceSite,
        targetSite,
        sourceExecutor,
        targetExecutor,
        tracker,
        protectedFileExcludes,
      );
    }

    await fixCyberPanelOwnership(targetExecutor, targetSite, tracker);
  }

  /** rsync source → target using SSH, executed on the source server. */
  private async pushFilesViaRsync(
    job: Job,
    sourceRoot: string,
    targetRoot: string,
    targetEnv: {
      server: {
        ip_address: string;
        ssh_port: number;
        ssh_user: string;
        name: string;
        ssh_private_key_encrypted: string | null;
      };
    },
    sourceExecutor: Executor,
    tracker: StepTracker,
    protectedFileExcludes: string[] = [],
  ): Promise<void> {
    // Upload worker's private key to source as a temp file
    const keyPath = `/tmp/forge_push_key_${job.id}`;
    const excludeFilePath = `/tmp/forge_rsync_exclude_${job.id}.txt`;
    const rawKey = await this.sshKey.resolvePrivateKey(targetEnv.server);
    await sourceExecutor.pushFile({
      remotePath: keyPath,
      content: Buffer.from(rawKey),
    });
    await sourceExecutor.execute(`chmod 600 ${shellQuote(keyPath)}`);

    // Prepend '/' to anchor each pattern to the transfer root, so rsync won't
    // strip nested directories with the same name inside plugins or themes.
    const allExcludes = this.buildFileSyncExcludes(protectedFileExcludes);
    const excludeFileContent = allExcludes.map((e) => `/${e}`).join("\n") + "\n";
    await sourceExecutor.pushFile({
      remotePath: excludeFilePath,
      content: Buffer.from(excludeFileContent, "utf8"),
    });

    const rsyncCmd = [
      "rsync",
      "-az",
      "--delete",
      "--no-owner",
      "--no-group",
      "--no-perms",
      "--ignore-errors",
      "--timeout=300",
      `--exclude-from=${shellQuote(excludeFilePath)}`,
      "-e",
      shellQuote(`ssh -i ${keyPath} -p ${targetEnv.server.ssh_port} -o StrictHostKeyChecking=no -o ConnectTimeout=30`),
      `${shellQuote(sourceRoot)}/`,
      `${shellQuote(targetEnv.server.ssh_user)}@${targetEnv.server.ip_address}:${shellQuote(targetRoot)}/`,
    ].join(" ");

    const customCount = protectedFileExcludes.length;
    const loggedExcludes =
      customCount > 0
        ? `.env, wp-config.php, .htaccess, storage/, node_modules/, builder & disk caches (+ ${customCount} protected uploads/files)`
        : `.env, wp-config.php, .htaccess, storage/, node_modules/, builder & disk caches`;

    await tracker.track({
      step: "Syncing site files via rsync",
      level: "info",
      detail: `${sourceRoot} → ${targetEnv.server.ip_address}:${targetRoot} (excluding: ${loggedExcludes})`,
      command: "rsync -az --delete --no-perms --exclude-from=[excludes] (key redacted)",
    });

    const rsyncStart = Date.now();
    const rsyncResult = await sourceExecutor.execute(rsyncCmd);

    // Cleanup key and exclude file regardless of outcome
    await sourceExecutor.execute(
      `rm -f ${shellQuote(keyPath)} ${shellQuote(excludeFilePath)}`,
    ).catch(() => {});

    await tracker.trackCommand(
      "rsync site files",
      "rsync -az --delete --no-perms --exclude-from=[excludes] (key redacted)",
      rsyncResult,
      Date.now() - rsyncStart,
    );

    const RSYNC_PARTIAL = 23; // partial transfer / some attrs not set
    const rsyncOutput = rsyncResult.stderr || rsyncResult.stdout || "";
    const isPermissionOnlyPartial =
      rsyncResult.code === RSYNC_PARTIAL &&
      this.isRsyncPermissionOnlyPartial(rsyncOutput);

    if (
      rsyncResult.code !== 0 &&
      (rsyncResult.code !== RSYNC_PARTIAL || !isPermissionOnlyPartial)
    ) {
      throw new Error(
        `rsync failed (exit ${rsyncResult.code}): ${rsyncResult.stderr || rsyncResult.stdout}`,
      );
    }

    if (isPermissionOnlyPartial) {
      const permLines = rsyncOutput
        .split("\n")
        .filter(
          (l) =>
            l.includes("Operation not permitted") ||
            l.includes("failed to set permissions"),
        )
        .join(" | ")
        .slice(0, 400);
      await tracker.track({
        step: "File sync complete (rsync) — some attrs skipped (root-owned files)",
        level: "warn",
        detail:
          (permLines ||
            rsyncResult.stderr ||
            "Some file attributes could not be set") +
          " — this is expected for intentionally root-owned files (e.g. wp-config.php) and does NOT affect the sync.",
      });
    } else {
      await tracker.track({
        step: "File sync complete (rsync)",
        level: "info",
        detail: rsyncResult.stdout.trim() || "Done",
      });
    }
  }

  private isRsyncPermissionOnlyPartial(output: string): boolean {
    const meaningfulLines = output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .filter((line) => !/^rsync error: .*code 23\b/.test(line));

    return (
      meaningfulLines.length > 0 &&
      meaningfulLines.every(
        (line) =>
          line.includes("Operation not permitted") ||
          line.includes("failed to set permissions"),
      )
    );
  }

  private buildFileSyncExcludes(
    protectedFileExcludes: string[] = [],
  ): string[] {
    const cleanProtected = protectedFileExcludes
      .map((p) => p.replace(/^\/+/, "").replace(/\/+/g, "/").trim())
      .filter((p) => p.length > 0 && !p.includes(".."));

    return Array.from(new Set([...this.RSYNC_EXCLUDES, ...cleanProtected]));
  }

  /**
   * Fallback file sync: tar on source → pull through worker → untar on target.
   */
  private async pushFilesViaTarRelay(
    job: Job,
    sourceContent: string,
    targetContent: string,
    sourceExecutor: Executor,
    targetExecutor: Executor,
    tracker: StepTracker,
    protectedFileExcludes: string[] = [],
  ): Promise<void> {
    const remoteTar = `/tmp/forge_push_content_${job.id}.tar.gz`;
    const tarExcludeFile = `/tmp/forge_tar_exclude_${job.id}.txt`;

    const allExcludes = this.buildFileSyncExcludes(protectedFileExcludes);
    const tarExcludeContent = allExcludes.map((e) => `./${e}`).join("\n") + "\n";
    await sourceExecutor.pushFile({
      remotePath: tarExcludeFile,
      content: Buffer.from(tarExcludeContent, "utf8"),
    });

    const tarCmd = `tar -czf ${shellQuote(remoteTar)} --exclude-from=${shellQuote(tarExcludeFile)} -C ${shellQuote(sourceContent)} .`;
    await tracker.track({
      step: "Archiving site files on source",
      level: "info",
      command: `tar -czf [tar] --exclude-from=[excludes] -C ${sourceContent} .`,
    });
    const tarStart = Date.now();
    const tarResult = await sourceExecutor.execute(tarCmd);
    await sourceExecutor.execute(`rm -f ${shellQuote(tarExcludeFile)}`).catch(() => {});
    await tracker.trackCommand(
      "tar site files",
      `tar -czf [tar] --exclude-from=[excludes] -C ${sourceContent} .`,
      tarResult,
      Date.now() - tarStart,
    );

    if (tarResult.code > 1) {
      throw new Error(
        `tar archiving failed (exit ${tarResult.code}): ${tarResult.stderr}`,
      );
    }
    if (tarResult.code === 1) {
      await tracker.track({
        step: "tar exited 1 (file changed during read) — proceeding with archive",
        level: "warn",
      });
    }

    await tracker.track({
      step: "Relaying site archive through worker (streaming)",
      level: "info",
    });
    const localTarDir = await mkdtemp(join(tmpdir(), "forge-tar-"));
    const localTarPath = join(localTarDir, `content_${job.id}.tar.gz`);
    try {
      await sourceExecutor.pullFileToPath(remoteTar, localTarPath);
      await sourceExecutor.execute(`rm -f ${shellQuote(remoteTar)}`).catch(() => {});
      const tarStat = await stat(localTarPath);
      await tracker.track({
        step: `Archive pulled (${(tarStat.size / 1024 / 1024).toFixed(1)} MB) — pushing to target`,
        level: "info",
      });
      const tarStream = createReadStream(localTarPath);
      await targetExecutor.pushFileFromStream(remoteTar, tarStream);
    } finally {
      await rm(localTarDir, { recursive: true, force: true });
    }

    await targetExecutor.execute(`mkdir -p ${shellQuote(targetContent)}`);
    const extractCmd = `tar -xzf ${shellQuote(remoteTar)} -C ${shellQuote(targetContent)} --no-same-owner --no-same-permissions --touch --unlink-first --warning=no-timestamp`;
    await tracker.track({
      step: "Extracting site files on target",
      level: "info",
      command: extractCmd,
    });
    const extractStart = Date.now();
    const extractResult = await targetExecutor.execute(extractCmd);
    await targetExecutor.execute(`rm -f ${shellQuote(remoteTar)}`).catch(() => {});
    await tracker.trackCommand(
      "tar extract on target",
      extractCmd,
      extractResult,
      Date.now() - extractStart,
    );

    if (extractResult.code > 1) {
      throw new Error(
        `tar extract failed (exit ${extractResult.code}): ${extractResult.stderr}`,
      );
    }

    await tracker.track({
      step: "File sync complete (tar relay)",
      level: "info",
    });
  }

  /**
   * Search-replace hardcoded URLs in wp-content text files (CSS, JS, etc.).
   */
  async replaceUrlsInFiles(
    sourceUrl: string,
    targetUrl: string,
    wpContentPath: string,
    executor: Executor,
    tracker: StepTracker,
    job: Job,
  ): Promise<void> {
    const pairs: Array<[string, string]> = [[sourceUrl, targetUrl]];
    const srcAlt = flipProtocol(sourceUrl);
    const tgtAlt = flipProtocol(targetUrl);
    if (srcAlt && tgtAlt && srcAlt !== targetUrl) {
      pairs.push([srcAlt, tgtAlt]);
    }

    const jsonPairs: Array<[string, string]> = [];
    for (const [old, nw] of pairs) {
      const oj = old.replace(/\//g, "\\/");
      const nj = nw.replace(/\//g, "\\/");
      if (oj !== old) jsonPairs.push([oj, nj]);
    }

    const urlEncodedPairs: Array<[string, string]> = [];
    for (const [old, nw] of pairs) {
      const oe = old.replace("://", "%3A%2F%2F");
      const ne = nw.replace("://", "%3A%2F%2F");
      if (oe !== old) urlEncodedPairs.push([oe, ne]);
    }

    const allFilePairs = [...pairs, ...jsonPairs, ...urlEncodedPairs];

    await tracker.track({
      step: "Replacing URLs in wp-content files",
      level: "info",
      detail: `${wpContentPath} — ${allFilePairs.map(([o, n]) => `${o} → ${n}`).join(", ")}`,
    });

    const checkResult = await executor.execute(
      `test -d ${shellQuote(wpContentPath)} && echo ok || echo missing`,
    );
    if (checkResult.stdout.trim() !== "ok") {
      await tracker.track({
        step: "wp-content not found on target — skipping file URL replace",
        level: "warn",
        detail: wpContentPath,
      });
      return;
    }

    // Ensure content files and directories are writable before search-replace
    await executor
      .execute(
        `chattr -R -i -a ${shellQuote(wpContentPath)} 2>/dev/null || true; chmod -R u+w ${shellQuote(wpContentPath)} 2>/dev/null || true; find ${shellQuote(wpContentPath)} -type f -exec chmod 644 {} + 2>/dev/null || true`,
      )
      .catch(() => {});

    const fileStart = Date.now();
    let anyError = false;

    for (const [oldUrl, newUrl] of allFilePairs) {
      const sedEscape = (s: string) =>
        s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
      const oldSed = sedEscape(oldUrl);
      const newSed = sedEscape(newUrl);

      const sedExpr = `s|${oldSed}|${newSed}|g`;
      const sedCmd = [
        `find ${shellQuote(wpContentPath)} -type f`,
        `\\( -name '*.css' -o -name '*.js' -o -name '*.json' -o -name '*.html'`,
        `-o -name '*.htm' -o -name '*.svg' -o -name '*.xml' -o -name '*.txt'`,
        `-o -name '*.php' \\)`,
        `-exec sed -i ${shellQuote(sedExpr)} {} +`,
      ].join(" ");

      const sedResult = await executor.execute(sedCmd);
      if (sedResult.code !== 0) {
        await tracker.track({
          step: `File URL replace failed for ${oldUrl}`,
          level: "warn",
          detail: sedResult.stderr.trim() || `exit ${sedResult.code}`,
        });
        anyError = true;
      }
    }

    await tracker.track({
      step: anyError
        ? "File URL replace completed with warnings"
        : "File URL replace complete",
      level: anyError ? "warn" : "info",
      detail: `${wpContentPath}, ${allFilePairs.length} pair(s), extensions: css/js/json/html/svg/xml/txt/php`,
      durationMs: Date.now() - fileStart,
    });

    if (anyError) {
      throw new Error(
        `File URL replacement failed for one or more URL patterns in ${wpContentPath}. ` +
          `The target may contain stale source-domain URLs in static assets (CSS, JS). ` +
          `Check the execution log above for per-pattern error details.`,
      );
    }

    await this.validateFileUrlReplacement(
      sourceUrl,
      targetUrl,
      wpContentPath,
      executor,
      tracker,
    );
  }

  /**
   * Verify that text assets under wp-content no longer contain the source URL.
   */
  private async validateFileUrlReplacement(
    sourceUrl: string,
    targetUrl: string,
    wpContentPath: string,
    executor: Executor,
    tracker: StepTracker,
  ): Promise<void> {
    try {
      const grepCmd = [
        `find ${shellQuote(wpContentPath)} -type f`,
        `\\( -name '*.css' -o -name '*.js' -o -name '*.json' -o -name '*.html'`,
        `-o -name '*.htm' -o -name '*.svg' -o -name '*.xml' -o -name '*.txt'`,
        `-o -name '*.php' \\)`,
        `-exec grep -nHF -m 1 -- ${shellQuote(sourceUrl)} {} + 2>/dev/null`,
      ].join(" ");
      const grepResult = await executor.execute(grepCmd);

      if (grepResult.code === 0 && grepResult.stdout.trim()) {
        const samples = grepResult.stdout
          .trim()
          .split("\n")
          .slice(0, 10)
          .join("; ");
        throw new Error(
          `File URL replacement did not complete: source URL (${sourceUrl}) is still present ` +
            `in text assets under ${wpContentPath} after search-replace.\n` +
            `Sample files: ${samples}.\n` +
            `This would cause stale links or assets to render from the wrong domain.`,
        );
      }
      if (grepResult.code > 1) {
        throw new Error(
          `File validation probe failed: ${(grepResult.stderr || grepResult.stdout || `exit ${grepResult.code}`).trim()}`,
        );
      }

      await tracker.track({
        step: "File URL replacement verified — no stale source URLs remain in text assets",
        level: "info",
        detail: `${wpContentPath} no longer contains ${sourceUrl} (expected target: ${targetUrl})`,
      });
    } catch (e) {
      if (
        e instanceof Error &&
        e.message.includes("File URL replacement did not complete")
      ) {
        throw e;
      }
      await tracker.track({
        step: "File URL replacement validation probe failed — could not verify text assets",
        level: "warn",
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  }
}
