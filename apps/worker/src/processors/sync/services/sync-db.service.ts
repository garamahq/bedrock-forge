import { Injectable, Logger } from "@nestjs/common";
import { Job } from "bullmq";
import { mkdir, rm, writeFile, stat } from "fs/promises";
import { join } from "path";
import { randomBytes } from "node:crypto";
import { PrismaService } from "../../../prisma/prisma.service";
import { RcloneService } from "../../../services/rclone.service";
import { EncryptionService } from "../../../encryption/encryption.service";
import { StepTracker } from "../../../services/step-tracker";
import {
  createRemoteExecutor,
  CredentialParserService,
} from "@bedrock-forge/remote-executor";
import { escapeMysql } from "../../../utils/cyberpanel-http";
import {
  shellQuote,
  flipProtocol,
  createRemoteMyCnf,
  cleanupRemoteMyCnf,
  pushRemoteScript,
  WpCliBuilder,
  sanitizeTableList,
} from "../../../utils/processor-utils";
import { WpLayout } from "./layout-detector.service";
import { Creds } from "./protected-cpt.service";

type Executor = Awaited<ReturnType<typeof createRemoteExecutor>>;

const STAGING_DIR = "/tmp/forge-sync";

@Injectable()
export class SyncDbService {
  private readonly logger = new Logger(SyncDbService.name);
  private readonly credParser = new CredentialParserService();

  constructor(
    private readonly prisma: PrismaService,
    private readonly rclone: RcloneService,
    private readonly encryption: EncryptionService,
  ) {}

  /**
   * Resolve DB credentials from a remote environment.
   */
  async resolveCredentials(
    executor: Executor,
    rootPath: string,
    tracker: StepTracker,
    label: string,
    environmentId: bigint,
  ): Promise<Creds> {
    // Attempt 0: stored credentials in Bedrock Forge DB (manually configured, highest priority)
    try {
      const stored = await this.prisma.wpDbCredentials.findUnique({
        where: { environment_id: environmentId },
      });
      if (stored) {
        const creds: Creds = {
          dbHost: this.encryption.decrypt(stored.db_host_encrypted),
          dbUser: this.encryption.decrypt(stored.db_user_encrypted),
          dbPassword: this.encryption.decrypt(stored.db_password_encrypted),
          dbName: this.encryption.decrypt(stored.db_name_encrypted),
        };
        await tracker.track({
          step: `${label} credentials from Bedrock Forge (stored)`,
          level: "info",
          detail: `host=${creds.dbHost} user=${creds.dbUser} db=${creds.dbName}`,
        });
        return creds;
      }
    } catch (e) {
      await tracker.track({
        step: `${label} stored credentials could not be loaded — falling back to file`,
        level: "warn",
        detail: e instanceof Error ? e.message : String(e),
      });
    }

    const parentDir = rootPath.replace(/\/[^/]+\/?$/, "");

    // Attempt 1: wp-config.php inside root_path (standard WordPress)
    const wpConfigInRoot = `${rootPath}/wp-config.php`;
    try {
      const buf = await executor.pullFile(wpConfigInRoot);
      const creds = this.credParser.parse(buf.toString("utf8"));
      if (creds) {
        await tracker.track({
          step: `${label} credentials from wp-config.php`,
          level: "info",
          detail: wpConfigInRoot,
        });
        return creds as Creds;
      }
      await tracker.track({
        step: `${label} wp-config.php found but credentials could not be parsed`,
        level: "warn",
        detail: wpConfigInRoot,
      });
    } catch (e) {
      await tracker.track({
        step: `${label} wp-config.php not readable at root path`,
        level: "warn",
        detail: `${wpConfigInRoot}: ${e instanceof Error ? e.message : String(e)}`,
      });
    }

    // Attempt 2: wp-config.php one level above root_path
    const wpConfigAbove = `${parentDir}/wp-config.php`;
    try {
      const buf = await executor.pullFile(wpConfigAbove);
      const creds = this.credParser.parse(buf.toString("utf8"));
      if (creds) {
        await tracker.track({
          step: `${label} credentials from wp-config.php (above root)`,
          level: "info",
          detail: wpConfigAbove,
        });
        return creds as Creds;
      }
      await tracker.track({
        step: `${label} wp-config.php above root found but credentials could not be parsed`,
        level: "warn",
        detail: wpConfigAbove,
      });
    } catch (e) {
      await tracker.track({
        step: `${label} wp-config.php not readable above root path`,
        level: "warn",
        detail: `${wpConfigAbove}: ${e instanceof Error ? e.message : String(e)}`,
      });
    }

    // Attempt 3: .env inside root_path
    const envInRoot = `${rootPath}/.env`;
    try {
      const buf = await executor.pullFile(envInRoot);
      const creds = this.credParser.parse(buf.toString("utf8"));
      if (creds) {
        await tracker.track({
          step: `${label} credentials from .env (inside root)`,
          level: "info",
          detail: envInRoot,
        });
        return creds as Creds;
      }
      await tracker.track({
        step: `${label} .env inside root found but credentials could not be parsed`,
        level: "warn",
        detail: envInRoot,
      });
    } catch (e) {
      await tracker.track({
        step: `${label} .env not readable inside root path`,
        level: "warn",
        detail: `${envInRoot}: ${e instanceof Error ? e.message : String(e)}`,
      });
    }

    // Attempt 4: .env one directory above root_path
    const parentEnv = `${parentDir}/.env`;
    try {
      const buf = await executor.pullFile(parentEnv);
      const creds = this.credParser.parse(buf.toString("utf8"));
      if (creds) {
        await tracker.track({
          step: `${label} credentials from .env (Bedrock — above root)`,
          level: "info",
          detail: parentEnv,
        });
        return creds as Creds;
      }
      await tracker.track({
        step: `${label} .env above root found but credentials could not be parsed`,
        level: "warn",
        detail: parentEnv,
      });
    } catch (e) {
      await tracker.track({
        step: `${label} .env not readable above root path`,
        level: "warn",
        detail: `${parentEnv}: ${e instanceof Error ? e.message : String(e)}`,
      });
    }

    throw new Error(
      `Could not resolve database credentials for ${label} environment at ${rootPath}. ` +
        `Tried: ${wpConfigInRoot}, ${wpConfigAbove}, ${envInRoot}, ${parentEnv}. ` +
        `Check the execution log above for per-file error details.`,
    );
  }

  /**
   * Detect the WordPress siteurl.
   */
  async resolveWpUrl(
    executor: Executor,
    creds: Creds,
    tracker: StepTracker,
    label: string,
    envUrl?: string | null,
  ): Promise<string | null> {
    if (envUrl && envUrl.trim()) {
      const url = envUrl.trim().replace(/\/$/, "");
      await tracker.track({
        step: `${label} URL from environment record`,
        level: "info",
        detail: url,
      });
      return url;
    }

    let urlMycnf: string | null = null;
    try {
      urlMycnf = await createRemoteMyCnf(executor, creds, `url_${Date.now()}`);
      const pfxRes = await executor.execute(
        `mysql --defaults-extra-file=${shellQuote(urlMycnf)} ${shellQuote(creds.dbName)} -sN -e ${shellQuote(
          `SELECT REPLACE(table_name,'options','') FROM information_schema.tables WHERE table_schema='${escapeMysql(creds.dbName)}' AND table_name LIKE '%options' LIMIT 1`,
        )}`,
      );
      const tblPrefix =
        pfxRes.code === 0 && pfxRes.stdout.trim()
          ? pfxRes.stdout.trim()
          : "wp_";
      const query = `SELECT option_value FROM \`${tblPrefix}options\` WHERE option_name = 'siteurl' LIMIT 1`;
      const result = await executor.execute(
        `mysql --defaults-extra-file=${shellQuote(urlMycnf)} ${shellQuote(creds.dbName)} -sN -e ${shellQuote(query)}`,
      );
      if (result.code === 0 && result.stdout.trim()) {
        const url = result.stdout.trim().replace(/\/$/, "");
        await tracker.track({
          step: `${label} URL from wp_options (prefix: ${tblPrefix})`,
          level: "info",
          detail: url,
        });
        return url;
      }
    } catch {
      // non-fatal
    } finally {
      if (urlMycnf) {
        await cleanupRemoteMyCnf(executor, urlMycnf);
      }
    }

    await tracker.track({
      step: `Could not detect ${label} URL`,
      level: "warn",
      detail: "Search-replace skipped for this side",
    });
    return null;
  }

  normalizeProtectedTables(tables: string[]): string[] {
    return sanitizeTableList(tables);
  }

  async trackProtectedTablePresence(
    executor: Executor,
    mycnf: string,
    dbName: string,
    protectedTables: string[],
    tracker: StepTracker,
  ): Promise<void> {
    if (protectedTables.length === 0) return;
    const quotedTables = protectedTables
      .map((t) => `'${escapeMysql(t)}'`)
      .join(",");
    const result = await executor.execute(
      `mysql --defaults-extra-file=${shellQuote(mycnf)} ${shellQuote(dbName)} -sN -e ${shellQuote(
        `SELECT TABLE_NAME FROM information_schema.tables WHERE table_schema='${escapeMysql(dbName)}' AND TABLE_NAME IN (${quotedTables})`,
      )}`,
      { timeout: 30_000 },
    );
    if (result.code !== 0) {
      await tracker.track({
        step: "Protected table presence check failed",
        level: "warn",
        detail: (result.stderr || result.stdout || "").slice(0, 300),
      });
      return;
    }
    const existing = new Set(
      result.stdout
        .split("\n")
        .map((t) => t.trim())
        .filter(Boolean),
    );
    const missing = protectedTables.filter((t) => !existing.has(t));
    if (missing.length > 0) {
      await tracker.track({
        step: "Some protected tables do not exist on target",
        level: "warn",
        detail: missing.join(", "),
      });
    }
  }

  async executeSqlProtectionQueries(
    executor: Executor,
    creds: Creds,
    sqlQueries: string[],
    tracker: StepTracker,
    jobId: string,
  ): Promise<void> {
    if (!sqlQueries || sqlQueries.length === 0) {
      return;
    }

    await tracker.track({
      step: "Executing SQL protection queries",
      level: "info",
      detail: `Executing ${sqlQueries.length} query/queries on target`,
    });

    const tgtMycnf = await createRemoteMyCnf(
      executor,
      creds,
      jobId,
      "forge_sync_prot_queries",
    );
    const queriesSqlFile = `/tmp/forge_sql_prot_exec_${jobId}.sql`;

    let prefix = "wp_";
    try {
      const prefixQuery = `SELECT REPLACE(table_name,'options','') FROM information_schema.tables WHERE table_schema='${escapeMysql(creds.dbName)}' AND table_name LIKE '%options' LIMIT 1`;
      const prefixResult = await executor.execute(
        `mysql --defaults-extra-file=${shellQuote(tgtMycnf)} ${shellQuote(creds.dbName)} -sN -e ${shellQuote(prefixQuery)}`,
      );
      if (prefixResult.code === 0 && prefixResult.stdout.trim()) {
        prefix = prefixResult.stdout.trim();
      }
    } catch (err) {
      this.logger.warn(
        `Failed to auto-detect target table prefix, defaulting to wp_: ${err}`,
      );
    }

    const processedQueries = sqlQueries.map((q) => {
      let processed = q
        .replace(/\{prefix\}/gi, prefix)
        .replace(/%prefix%/gi, prefix)
        .trim();
      if (processed && !processed.endsWith(";")) {
        processed += ";";
      }
      return processed;
    });

    const sqlContent = processedQueries.join("\n") + "\n";

    await executor.pushFile({
      remotePath: queriesSqlFile,
      content: Buffer.from(sqlContent),
    });

    const start = Date.now();
    let result;
    try {
      result = await executor.execute(
        `mysql --defaults-extra-file=${shellQuote(tgtMycnf)} ${shellQuote(creds.dbName)} < ${shellQuote(queriesSqlFile)}`,
        { timeout: 5 * 60_000 },
      );
    } finally {
      await cleanupRemoteMyCnf(executor, tgtMycnf);
      await executor.execute(`rm -f ${shellQuote(queriesSqlFile)}`).catch(() => {});
    }

    await tracker.trackCommand(
      "SQL protection queries execution",
      `mysql --defaults-extra-file=*** ${creds.dbName} < ${queriesSqlFile}`,
      result,
      Date.now() - start,
    );

    if (result.code !== 0) {
      throw new Error(
        `Failed to execute SQL protection queries on target: ${result.stderr.trim()}`,
      );
    }

    await tracker.track({
      step: "SQL protection queries executed successfully",
      level: "info",
      detail: `Processed queries: ${processedQueries.join(" ")}`,
    });
  }

  async createSafetyBackup(
    job: Job,
    targetEnv: {
      id: bigint;
      google_drive_folder_id: string | null;
      root_path: string;
      server: { ip_address: string };
    },
    targetExecutor: Executor,
    targetCreds: Creds,
    tracker: StepTracker,
  ): Promise<void> {
    const gdriveFolder = targetEnv.google_drive_folder_id;
    if (!gdriveFolder) {
      throw new Error(
        "Target environment has no Google Drive folder configured. Cannot create safety backup before sync.",
      );
    }

    await tracker.track({
      step: "Creating safety backup of target before overwrite",
      level: "info",
      detail: `GDrive folder: ${gdriveFolder}`,
    });

    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filename = `sync-safety-${ts}.sql`;
    const remoteTemp = `/tmp/sync_safety_${job.id}.sql`;
    const localDir = join(STAGING_DIR, String(job.id));
    const localFile = join(localDir, filename);

    const sbMycnf = await createRemoteMyCnf(
      targetExecutor,
      targetCreds,
      job.id!,
      "forge_sync_sb",
    );
    const maskedDump = `mysqldump --defaults-extra-file=*** --single-transaction --quick ${targetCreds.dbName}`;

    const dumpStart = Date.now();
    let dumpResult;
    try {
      dumpResult = await targetExecutor.execute(
        `mysqldump --defaults-extra-file=${shellQuote(sbMycnf)} --single-transaction --quick ${shellQuote(targetCreds.dbName)} > ${shellQuote(remoteTemp)}`,
      );
    } finally {
      await cleanupRemoteMyCnf(targetExecutor, sbMycnf);
    }
    await tracker.trackCommand(
      "Safety backup: mysqldump target",
      maskedDump,
      dumpResult,
      Date.now() - dumpStart,
    );

    if (dumpResult.code !== 0) {
      throw new Error(
        `Safety backup mysqldump failed (exit ${dumpResult.code}): ${dumpResult.stderr}`,
      );
    }

    await mkdir(localDir, { recursive: true });
    await targetExecutor.pullFileToPath(remoteTemp, localFile);
    await targetExecutor.execute(`rm -f ${shellQuote(remoteTemp)}`).catch(() => {});

    const { size: dumpBytes } = await stat(localFile);

    await tracker.track({
      step: "Safety backup pulled — uploading to Google Drive",
      level: "info",
      detail: `${filename} (${dumpBytes} bytes)`,
    });

    try {
      const configOk = await this.rclone.writeConfig();
      if (!configOk) {
        throw new Error(
          "Google Drive rclone not configured. Configure rclone in Settings first.",
        );
      }

      const uploadStart = Date.now();
      const filePath = await this.rclone.upload(
        localFile,
        gdriveFolder,
        filename,
      );
      await tracker.track({
        step: "Safety backup uploaded to Google Drive",
        level: "info",
        detail: filePath,
        durationMs: Date.now() - uploadStart,
      });

      await this.prisma.backup.create({
        data: {
          environment_id: targetEnv.id,
          type: "db_only",
          status: "completed",
          file_path: filePath,
          size_bytes: BigInt(dumpBytes),
          completed_at: new Date(),
          started_at: new Date(),
        },
      });

      await tracker.track({ step: "Safety backup recorded", level: "info" });
    } finally {
      await rm(localDir, { recursive: true, force: true });
    }
  }

  async runUrlSearchReplace(
    sourceUrl: string | null,
    targetUrl: string | null,
    executor: Executor,
    creds: Creds,
    rootPath: string,
    tracker: StepTracker,
    job: Job,
    suffix: string,
    protectedTables: string[] = [],
  ): Promise<void> {
    if (!sourceUrl || !targetUrl || sourceUrl === targetUrl) {
      await tracker.track({
        step: "URL search-replace skipped",
        level: "info",
        detail:
          !sourceUrl || !targetUrl
            ? "Could not detect one or both URLs"
            : `Source and target URLs are identical (${sourceUrl})`,
      });
      return;
    }

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

    const allDisplayPairs = [...pairs, ...jsonPairs, ...urlEncodedPairs];
    const safeProtectedTables = this.normalizeProtectedTables(protectedTables);
    const protectedSet = new Set(safeProtectedTables);
    const skipTablesArg =
      safeProtectedTables.length > 0
        ? ` --skip-tables=${shellQuote(safeProtectedTables.join(","))}`
        : "";

    await tracker.track({
      step: "Running URL search-replace on target",
      level: "info",
      detail:
        allDisplayPairs.map(([o, n]) => `${o} → ${n}`).join(", ") +
        (safeProtectedTables.length
          ? ` (skipping protected tables: ${safeProtectedTables.join(", ")})`
          : ""),
    });

    const srStart = Date.now();
    const allWpCliPairs = [...pairs, ...jsonPairs, ...urlEncodedPairs];

    const wpCli = await WpCliBuilder.create(executor, rootPath);

    let wpCliSuccess = false;
    for (const skipPlugins of [false, true]) {
      const skiparg = skipPlugins ? " --skip-themes --skip-plugins" : "";
      let passOk = true;
      for (const [oldUrl, newUrl] of allWpCliPairs) {
        const srArgs = `search-replace ${shellQuote(oldUrl)} ${shellQuote(newUrl)} --path=${shellQuote(rootPath)} --all-tables --precise --skip-columns=guid${skipTablesArg}${skiparg}`;
        const wpCliResult = await executor.execute(wpCli.buildCommand(srArgs));
        if (wpCliResult.code === 0) {
          await tracker.track({
            step: `URL search-replace complete (WP-CLI${skipPlugins ? ", skip-plugins" : ""}): ${oldUrl} → ${newUrl}`,
            level: "info",
            detail: wpCliResult.stdout.trim() || "Done",
          });
        } else {
          let cdOk = false;
          if (!wpCli.prefix) {
            const cdArgs = `search-replace ${shellQuote(oldUrl)} ${shellQuote(newUrl)} --all-tables --precise --skip-columns=guid${skipTablesArg}${skiparg}`;
            const cdResult = await executor.execute(
              wpCli.buildCdCommand(cdArgs),
            );
            if (cdResult.code === 0) {
              await tracker.track({
                step: `URL search-replace complete (WP-CLI via cd${skipPlugins ? ", skip-plugins" : ""}): ${oldUrl} → ${newUrl}`,
                level: "info",
                detail: cdResult.stdout.trim() || "Done",
              });
              cdOk = true;
            }
          }
          if (!cdOk) {
            passOk = false;
            if (!skipPlugins) {
              await tracker.track({
                step: "WP-CLI failed without --skip-plugins — retrying with --skip-plugins",
                level: "warn",
                detail: `exit ${wpCliResult.code}: ${(wpCliResult.stderr || wpCliResult.stdout || "").slice(0, 200)}`,
              });
            } else {
              await tracker.track({
                step: "WP-CLI unavailable — falling back to SQL",
                level: "warn",
                detail: `exit ${wpCliResult.code}: ${(wpCliResult.stderr || wpCliResult.stdout || "command not found").slice(0, 200)}`,
              });
            }
            break;
          }
        }
      }
      if (passOk) {
        wpCliSuccess = true;
        break;
      }
      if (skipPlugins) break;
    }

    if (wpCliSuccess) return;

    const scriptsPath = join(__dirname, "..", "..", "..", "..", "scripts");
    const srScript = `/tmp/forge_sr_${suffix}_${job.id}.php`;
    await pushRemoteScript(
      executor,
      join(scriptsPath, "search-replace.php"),
      srScript,
    );

    const srMycnf = await createRemoteMyCnf(
      executor,
      creds,
      job.id!,
      `forge_sr_${suffix}`,
    );

    let p = "wp_";
    try {
      const prefixResult = await executor.execute(
        `mysql --defaults-extra-file=${shellQuote(srMycnf)} ${shellQuote(creds.dbName)} -sN -e ${shellQuote(
          `SELECT REPLACE(table_name,'options','') FROM information_schema.tables WHERE table_schema='${escapeMysql(creds.dbName)}' AND table_name LIKE '%options' LIMIT 1`,
        )}`,
      );
      if (prefixResult.code === 0 && prefixResult.stdout.trim()) {
        p = prefixResult.stdout.trim();
      }
    } catch {
      // fallback to wp_
    }

    await tracker.track({
      step: "Table prefix detected",
      level: "info",
      detail: `prefix=${p}`,
    });

    let phpSuccess = true;
    const allPairs = [...pairs, ...jsonPairs, ...urlEncodedPairs];
    try {
      for (const [oldUrl, newUrl] of allPairs) {
        const phpResult = await executor.execute(
          `php ${shellQuote(srScript)}` +
            ` --mycnf=${shellQuote(srMycnf)}` +
            ` --db-name=${shellQuote(creds.dbName)}` +
            ` --prefix=${shellQuote(p)}` +
            ` --search=${shellQuote(oldUrl)}` +
            ` --replace=${shellQuote(newUrl)}` +
            (safeProtectedTables.length
              ? ` --skip-tables=${shellQuote(safeProtectedTables.join(","))}`
              : ""),
          { timeout: 5 * 60_000 },
        );
        if (phpResult.code !== 0) {
          await tracker.track({
            step: "PHP search-replace failed — falling back to SQL",
            level: "warn",
            detail: (phpResult.stderr || phpResult.stdout || "").slice(0, 300),
          });
          phpSuccess = false;
          break;
        }
        try {
          const parsed = JSON.parse(phpResult.stdout) as {
            tables_scanned: number;
            rows_affected: number;
            errors: string[];
          };
          await tracker.track({
            step: `PHP search-replace: ${oldUrl} → ${newUrl}`,
            level: "info",
            detail: `${parsed.tables_scanned} tables scanned, ${parsed.rows_affected} rows updated${
              parsed.errors.length ? ` (${parsed.errors.length} errors)` : ""
            }`,
          });
        } catch {
          await tracker.track({
            step: `PHP search-replace: ${oldUrl} → ${newUrl}`,
            level: "info",
            detail: phpResult.stdout.slice(0, 200),
          });
        }
      }
    } finally {
      await cleanupRemoteMyCnf(executor, srMycnf);
      await executor.execute(`rm -f ${shellQuote(srScript)}`).catch(() => {});
    }

    if (phpSuccess) {
      await tracker.track({
        step: "URL search-replace complete (PHP, serialization-aware)",
        level: "info",
        detail: `prefix=${p}, ${allPairs.length} pair(s) — serialized data handled correctly`,
        durationMs: Date.now() - srStart,
      });
      return;
    }
    const statements: string[] = [];
    const addProtectedAwareStatement = (table: string, sql: string) => {
      if (!protectedSet.has(table)) {
        statements.push(sql);
      }
    };
    for (const [oldRaw, newRaw] of allPairs) {
      const o = escapeMysql(oldRaw);
      const n = escapeMysql(newRaw);
      addProtectedAwareStatement(
        `${p}options`,
        `UPDATE \`${p}options\` SET option_value = REPLACE(option_value, '${o}', '${n}')`,
      );
      addProtectedAwareStatement(
        `${p}posts`,
        `UPDATE \`${p}posts\` SET post_content = REPLACE(post_content, '${o}', '${n}')`,
      );
      addProtectedAwareStatement(
        `${p}posts`,
        `UPDATE \`${p}posts\` SET post_excerpt = REPLACE(post_excerpt, '${o}', '${n}')`,
      );
      addProtectedAwareStatement(
        `${p}postmeta`,
        `UPDATE \`${p}postmeta\` SET meta_value = REPLACE(CAST(meta_value AS CHAR), '${o}', '${n}')`,
      );
      addProtectedAwareStatement(
        `${p}usermeta`,
        `UPDATE \`${p}usermeta\` SET meta_value = REPLACE(meta_value, '${o}', '${n}')`,
      );
      addProtectedAwareStatement(
        `${p}comments`,
        `UPDATE \`${p}comments\` SET comment_content = REPLACE(comment_content, '${o}', '${n}')`,
      );
      addProtectedAwareStatement(
        `${p}comments`,
        `UPDATE \`${p}comments\` SET comment_author_url = REPLACE(comment_author_url, '${o}', '${n}')`,
      );
    }

    const sqlFile = `/tmp/forge_sr_fallback_${job.id}.sql`;
    await executor.pushFile({
      remotePath: sqlFile,
      content: Buffer.from(statements.join(";\n") + ";\n"),
    });

    const fallbackMycnf = await createRemoteMyCnf(
      executor,
      creds,
      job.id!,
      `forge_sr_fallback_${suffix}`,
    );

    const sqlStart = Date.now();
    let sqlResult;
    try {
      sqlResult = await executor.execute(
        `mysql --defaults-extra-file=${shellQuote(fallbackMycnf)} ${shellQuote(creds.dbName)} < ${shellQuote(sqlFile)}`,
        { timeout: 10 * 60_000 },
      );
    } finally {
      await cleanupRemoteMyCnf(executor, fallbackMycnf);
      await executor.execute(`rm -f ${shellQuote(sqlFile)}`).catch(() => {});
    }

    await tracker.trackCommand(
      "URL search-replace raw SQL fallback",
      `mysql --defaults-extra-file=*** ${creds.dbName} < ${sqlFile}`,
      sqlResult,
      Date.now() - sqlStart,
    );

    if (sqlResult.code !== 0) {
      throw new Error(
        `Raw SQL URL search-replace fallback failed: ${sqlResult.stderr || sqlResult.stdout}`,
      );
    }

    await tracker.track({
      step: "URL search-replace complete (raw SQL fallback)",
      level: "info",
      detail: `prefix=${p}, ${statements.length} UPDATE statement(s) executed`,
      durationMs: Date.now() - srStart,
    });
  }

  async validateUrlReplacement(
    executor: Executor,
    creds: Creds,
    sourceUrl: string,
    targetUrl: string,
    tracker: StepTracker,
    protectedTables: string[] = [],
  ): Promise<void> {
    const protectedSet = new Set(
      this.normalizeProtectedTables(protectedTables),
    );
    const valMycnf = await createRemoteMyCnf(
      executor,
      creds,
      `val_${Date.now()}`,
    );
    try {
      const pfxRes = await executor.execute(
        `mysql --defaults-extra-file=${shellQuote(valMycnf)} ${shellQuote(creds.dbName)} -sN -e ${shellQuote(
          `SELECT REPLACE(table_name,'options','') FROM information_schema.tables WHERE table_schema='${escapeMysql(creds.dbName)}' AND table_name LIKE '%options' LIMIT 1`,
        )}`,
      );
      const tblPrefix =
        pfxRes.code === 0 && pfxRes.stdout.trim()
          ? pfxRes.stdout.trim()
          : "wp_";

      const likeSource = escapeMysql(sourceUrl);
      const NON_FUNCTIONAL_OPTIONS = ["elementor_log", "_elementor_log"];
      const excludeOptionNames = NON_FUNCTIONAL_OPTIONS.map(
        (n) => `'${escapeMysql(n)}'`,
      ).join(",");
      const allProbes = [
        {
          label: `${tblPrefix}options`,
          sql:
            `SELECT 'options', option_name, LEFT(REPLACE(REPLACE(option_value, CHAR(10), ' '), CHAR(13), ' '), 180) ` +
            `FROM \`${tblPrefix}options\` WHERE option_value LIKE '%${likeSource}%' ` +
            `AND option_name NOT IN (${excludeOptionNames}) ` +
            `AND option_name NOT LIKE '\_transient\_%' ` +
            `AND option_name NOT LIKE '\_site\_transient\_%' LIMIT 5`,
        },
        {
          label: `${tblPrefix}posts`,
          sql:
            `SELECT 'posts', CONCAT(ID, ':', post_type), LEFT(REPLACE(REPLACE(post_content, CHAR(10), ' '), CHAR(13), ' '), 180) ` +
            `FROM \`${tblPrefix}posts\` WHERE post_content LIKE '%${likeSource}%' LIMIT 5`,
        },
        {
          label: `${tblPrefix}postmeta`,
          sql:
            `SELECT 'postmeta', CONCAT(post_id, ':', meta_key), LEFT(REPLACE(REPLACE(CAST(meta_value AS CHAR), CHAR(10), ' '), CHAR(13), ' '), 180) ` +
            `FROM \`${tblPrefix}postmeta\` WHERE CAST(meta_value AS CHAR) LIKE '%${likeSource}%' LIMIT 5`,
        },
      ] as const;
      const probes = allProbes.filter(
        (probe) => !protectedSet.has(probe.label),
      );

      if (probes.length === 0) {
        await tracker.track({
          step: "URL replacement validation skipped for protected core tables",
          level: "info",
          detail: Array.from(protectedSet).join(", "),
        });
        return;
      }

      const staleMatches: string[] = [];
      for (const probe of probes) {
        const result = await executor.execute(
          `mysql --defaults-extra-file=${shellQuote(valMycnf)} ${shellQuote(creds.dbName)} -sN -e ${shellQuote(probe.sql)}`,
        );
        if (result.code !== 0) {
          throw new Error(
            `Validation probe failed for ${probe.label}: ${(result.stderr || result.stdout || `exit ${result.code}`).trim()}`,
          );
        }
        if (!result.stdout.trim()) continue;
        for (const line of result.stdout.trim().split("\n")) {
          const [bucket = probe.label, key = "(unknown)", ...excerptParts] =
            line.split("\t");
          const excerpt = excerptParts.join("\t").trim();
          staleMatches.push(
            `${bucket.trim()} ${key.trim()} = ${excerpt || "(empty)"}`,
          );
        }
      }

      if (staleMatches.length > 0) {
        throw new Error(
          `URL replacement did not complete: source URL (${sourceUrl}) is still present ` +
            `in target content after search-replace.\n` +
            `Sample stale rows: ${staleMatches.join("; ")}.\n` +
            `This would cause content to render with the wrong domain on the target site.`,
        );
      }

      await tracker.track({
        step: "URL replacement verified — no stale source URLs remain in core WP content",
        level: "info",
        detail:
          `${tblPrefix}options, ${tblPrefix}posts, and ${tblPrefix}postmeta no longer contain ${sourceUrl} ` +
          `(expected target: ${targetUrl})`,
      });
    } catch (e) {
      if (
        e instanceof Error &&
        e.message.includes("URL replacement did not complete")
      ) {
        throw e;
      }
      await tracker.track({
        step: "URL replacement validation probe failed — could not verify target content",
        level: "warn",
        detail: e instanceof Error ? e.message : String(e),
      });
    } finally {
      await cleanupRemoteMyCnf(executor, valMycnf);
    }
  }

  async flushWordPressCaches(
    executor: Executor,
    creds: Creds,
    layout: WpLayout,
    tracker: StepTracker,
    label: string,
    skipElementorCssFlush = false,
    siteUrl: string | null | undefined = undefined,
  ): Promise<void> {
    const { corePath, contentPath, isBedrock } = layout;

    const wpCli = await WpCliBuilder.create(executor, corePath);

    const cacheResult = await executor
      .execute(
        wpCli.buildCommand(
          `cache flush --path=${shellQuote(corePath)} --skip-themes --skip-plugins`,
        ),
      )
      .catch(() => ({ code: 1, stdout: "", stderr: "executor error" }));
    if (cacheResult.code === 0) {
      await tracker.track({
        step: `${label}: object cache flushed (WP-CLI)`,
        level: "info",
      });
      await executor
        .execute(
          wpCli.buildCommand(
            `rewrite flush --path=${shellQuote(corePath)} --skip-themes --skip-plugins`,
          ),
        )
        .catch(() => {});
      await executor
        .execute(
          wpCli.buildCommand(
            `eval 'if(function_exists("opcache_reset")){opcache_reset();}' --path=${shellQuote(corePath)} --skip-themes --skip-plugins`,
          ),
        )
        .catch(() => {});

      let cssFlushSummary = "rewrite rules and OPcache flushed (WP-CLI)";
      if (!skipElementorCssFlush) {
        const elementorActive = await executor
          .execute(
            wpCli.buildCommand(
              `plugin is-active elementor --path=${shellQuote(corePath)} --skip-themes --skip-plugins`,
            ),
          )
          .catch(() => ({ code: 1, stdout: "", stderr: "" }));

        if (elementorActive.code !== 0) {
          await tracker.track({
            step: `${label}: Elementor CSS flush skipped`,
            level: "info",
            detail: "Elementor is not active on this environment.",
          });
        } else {
          const elFlush = await executor
            .execute(
              wpCli.buildCommand(
                `elementor flush-css --path=${shellQuote(corePath)}`,
              ),
            )
            .catch(() => ({ code: 1, stdout: "", stderr: "" }));
          if (elFlush.code === 0) {
            cssFlushSummary =
              "rewrite rules, OPcache, and Elementor CSS flushed (WP-CLI)";
          } else {
            await executor
              .execute(
                `rm -rf ${shellQuote(contentPath)}/uploads/elementor/css 2>/dev/null; true`,
              )
              .catch(() => {});
            cssFlushSummary =
              "rewrite rules, OPcache, and Elementor CSS cache reset";
            await tracker.track({
              step: `${label}: Elementor CSS cache reset for auto-regeneration`,
              level: "warn",
              detail: (
                elFlush.stderr ||
                elFlush.stdout ||
                "Elementor CLI command failed"
              ).slice(0, 200),
            });
          }
        }
      }
      await tracker.track({
        step: `${label}: ${cssFlushSummary}`,
        level: "info",
      });

      await executor
        .execute(
          wpCli.buildCommand(
            `litespeed-purge all --path=${shellQuote(corePath)} --skip-themes --skip-plugins`,
          ),
        )
        .catch(() => {});
    } else {
      await tracker.track({
        step: `${label}: WP-CLI unavailable — flushing via SQL + disk`,
        level: "warn",
      });
      await executor
        .execute(
          `rm -f ${shellQuote(contentPath + "/object-cache.php")} 2>/dev/null; true`,
        )
        .catch(() => {});
      await tracker.track({
        step: `${label}: WordPress object cache drop-in removed — WP will re-query from DB until plugin restores it`,
        level: "info",
      });
    }

    // ── Universal Database Purge for Divi, Elementor, and Builders ─────────
    let dbFlushMycnf: string | null = null;
    try {
      dbFlushMycnf = await createRemoteMyCnf(
        executor,
        creds,
        `builder_flush_${Date.now()}`,
      );
      const pfxRes = await executor.execute(
        `mysql --defaults-extra-file=${shellQuote(dbFlushMycnf)} ${shellQuote(creds.dbName)} -sN -e ${shellQuote(
          `SELECT REPLACE(table_name,'options','') FROM information_schema.tables WHERE table_schema='${escapeMysql(creds.dbName)}' AND table_name LIKE '%options' LIMIT 1`,
        )}`,
      );
      const p =
        pfxRes.code === 0 && pfxRes.stdout.trim()
          ? pfxRes.stdout.trim()
          : "wp_";

      // Purge Divi, Elementor, and builder caches from postmeta
      const postmetaCleanSql =
        `DELETE FROM \`${p}postmeta\` WHERE ` +
        `meta_key LIKE '_et_pb_static_css%' OR ` +
        `meta_key LIKE '_et_pb_dynamic_css%' OR ` +
        `meta_key LIKE '_et_pb_inline_style%' OR ` +
        `meta_key LIKE '_et_builder_custom_css%' OR ` +
        `meta_key LIKE '_elementor_css%' OR ` +
        `meta_key LIKE '_elementor_element_cache%' OR ` +
        `meta_key LIKE '_fl_builder_%' OR ` +
        `meta_key LIKE 'bricks_css_%'`;

      // Purge Divi, Elementor, builder, and transients from options
      const optionsCleanSql =
        `DELETE FROM \`${p}options\` WHERE ` +
        `option_name LIKE '_transient_%' OR ` +
        `option_name LIKE '_site_transient_%' OR ` +
        `option_name LIKE 'et_dynamic_css%' OR ` +
        `option_name LIKE 'et_pb_dynamic_css%' OR ` +
        `option_name LIKE 'et_core_bb_layout_css%' OR ` +
        `option_name LIKE 'et_dynamic_css_cache_%' OR ` +
        `option_name LIKE 'et_pb_static_css_%' OR ` +
        `option_name LIKE 'et_pb_custom_css_%' OR ` +
        `option_name LIKE 'et_dynamic_assets%' OR ` +
        `option_name LIKE '_transient_et_pb_%' OR ` +
        `option_name LIKE '_transient_timeout_et_pb_%' OR ` +
        `option_name LIKE '_transient_et_core_%' OR ` +
        `option_name LIKE '_transient_timeout_et_core_%' OR ` +
        `option_name LIKE '_elementor_css%' OR ` +
        `option_name LIKE 'elementor_css_%' OR ` +
        `option_name LIKE '_elementor_general_css%' OR ` +
        `option_name = 'elementor_log' OR ` +
        `option_name LIKE 'fusion_dynamic_css_%'`;

      await executor.execute(
        `mysql --defaults-extra-file=${shellQuote(dbFlushMycnf)} ${shellQuote(creds.dbName)} -e ${shellQuote(`${postmetaCleanSql}; ${optionsCleanSql}`)}`,
      );

      await tracker.track({
        step: `${label}: Divi & page builder caches cleared (postmeta, options, prefix=${p})`,
        level: "info",
        detail: `Divi, Elementor, and builder caches purged — clean CSS will regenerate on next request`,
      });
    } catch (e) {
      await tracker.track({
        step: `${label}: Builder DB cache clear non-fatal warning`,
        level: "warn",
        detail: e instanceof Error ? e.message : String(e),
      });
    } finally {
      if (dbFlushMycnf) {
        await cleanupRemoteMyCnf(executor, dbFlushMycnf);
      }
    }

    // ── Universal Disk Purge for Divi, Elementor, and Builder Caches ───────
    const allCacheDirs = [
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
      shellQuote(`${contentPath}/uploads/astra-addon`),
    ];
    await executor
      .execute(`rm -rf ${allCacheDirs.join(" ")} 2>/dev/null; true`)
      .catch(() => {});

    await tracker.track({
      step: `${label}: disk cache directories removed`,
      level: "info",
      detail: allCacheDirs.join(", "),
    });

    if (siteUrl) {
      await executor
        .execute(
          `curl -s -o /dev/null --max-time 5 -X PURGE ${shellQuote(siteUrl)}/ 2>/dev/null; true`,
        )
        .catch(() => {});
      await executor
        .execute(
          `curl -s -o /dev/null --max-time 5 -H ${shellQuote("X-LiteSpeed-Purge: *")} ${shellQuote(siteUrl)}/ 2>/dev/null; true`,
        )
        .catch(() => {});
      await tracker.track({
        step: `${label}: LiteSpeed HTTP PURGE sent`,
        level: "info",
      });
    }
  }

  /**
   * Ensure target environment configuration (.env for Bedrock, wp-config.php for Standard WP)
   * is present, valid, and synchronized with target database credentials, salts, and site URLs.
   */
  async ensureTargetEnvironmentConfig(
    executor: Executor,
    targetEnv: {
      id: bigint;
      root_path: string;
      url?: string | null;
      type?: string | null;
    },
    targetLayout: WpLayout,
    targetCreds: Creds,
    targetUrl: string | null,
    tracker: StepTracker,
    tablePrefix = "wp_",
  ): Promise<void> {
    const rootPath = targetEnv.root_path.replace(/\/+$/, "");

    // Check if target is Bedrock (via layout detector or presence of Bedrock markers)
    let isBedrock = targetLayout.isBedrock;
    if (!isBedrock) {
      const bedrockMarkerCheck = await executor.execute(
        `test -f ${shellQuote(`${rootPath}/config/application.php`)} || test -f ${shellQuote(`${rootPath}/web/wp-config.php`)} && echo yes || echo no`,
      );
      if (bedrockMarkerCheck.stdout.trim() === "yes") {
        isBedrock = true;
      }
    }

    if (isBedrock) {
      await this.ensureTargetBedrockEnv(
        executor,
        rootPath,
        targetEnv,
        targetCreds,
        targetUrl,
        tracker,
        tablePrefix,
      );
    } else {
      await this.ensureTargetStandardWpConfig(
        executor,
        rootPath,
        targetEnv,
        targetCreds,
        targetUrl,
        tracker,
        tablePrefix,
      );
    }
  }

  private async ensureTargetBedrockEnv(
    executor: Executor,
    rootPath: string,
    targetEnv: { url?: string | null; type?: string | null },
    targetCreds: Creds,
    targetUrl: string | null,
    tracker: StepTracker,
    tablePrefix: string,
  ): Promise<void> {
    const envPath = `${rootPath}/.env`;
    const checkResult = await executor.execute(
      `test -f ${shellQuote(envPath)} && echo exists || echo missing`,
    );
    const envExists = checkResult.stdout.trim() === "exists";

    const salt = () => randomBytes(48).toString("base64url").slice(0, 64);
    const escapeSingleQuote = (val: string) => val.replace(/'/g, "\\'");
    const effectiveUrl = targetUrl || targetEnv.url || "";
    const wpEnv = targetEnv.type || "production";

    if (!envExists) {
      // Create fresh .env with full credentials, URLs, and newly generated secure salts
      const lines = [
        `DB_NAME='${escapeSingleQuote(targetCreds.dbName)}'`,
        `DB_USER='${escapeSingleQuote(targetCreds.dbUser)}'`,
        `DB_PASSWORD='${escapeSingleQuote(targetCreds.dbPassword)}'`,
        `DB_HOST='${escapeSingleQuote(targetCreds.dbHost)}'`,
        `DB_PREFIX='${escapeSingleQuote(tablePrefix)}'`,
        ``,
        `WP_ENV='${escapeSingleQuote(wpEnv)}'`,
        `WP_HOME='${escapeSingleQuote(effectiveUrl)}'`,
        `WP_SITEURL=\${WP_HOME}/wp`,
        ``,
        `AUTH_KEY='${salt()}'`,
        `SECURE_AUTH_KEY='${salt()}'`,
        `LOGGED_IN_KEY='${salt()}'`,
        `NONCE_KEY='${salt()}'`,
        `AUTH_SALT='${salt()}'`,
        `SECURE_AUTH_SALT='${salt()}'`,
        `LOGGED_IN_SALT='${salt()}'`,
        `NONCE_SALT='${salt()}'`,
      ];

      await executor.pushFile({
        remotePath: envPath,
        content: Buffer.from(lines.join("\n") + "\n", "utf8"),
      });
      await executor
        .execute(`chmod 640 ${shellQuote(envPath)}`)
        .catch(() => {});

      await tracker.track({
        step: "Created target .env file",
        level: "info",
        detail: `${envPath} (DB: ${targetCreds.dbName}, User: ${targetCreds.dbUser}, URL: ${effectiveUrl})`,
      });
    } else {
      // Existing .env file — read, safely merge/update DB creds, URLs, prefix, and any missing salts
      let existingContent = "";
      try {
        const buf = await executor.pullFile(envPath);
        existingContent = buf.toString("utf8");
      } catch (e) {
        this.logger.warn(`Could not pull existing .env: ${e}`);
      }

      let updated = existingContent;

      const setOrAppendEnvKey = (key: string, value: string) => {
        const regex = new RegExp(`^(\\s*#?\\s*${key}\\s*=).*$`, "m");
        const formatted = `${key}='${escapeSingleQuote(value)}'`;
        if (regex.test(updated)) {
          updated = updated.replace(regex, formatted);
        } else {
          updated = updated.trimEnd() + `\n${formatted}\n`;
        }
      };

      setOrAppendEnvKey("DB_NAME", targetCreds.dbName);
      setOrAppendEnvKey("DB_USER", targetCreds.dbUser);
      setOrAppendEnvKey("DB_PASSWORD", targetCreds.dbPassword);
      setOrAppendEnvKey("DB_HOST", targetCreds.dbHost);
      if (tablePrefix) {
        setOrAppendEnvKey("DB_PREFIX", tablePrefix);
      }
      if (effectiveUrl) {
        setOrAppendEnvKey("WP_HOME", effectiveUrl);
        setOrAppendEnvKey("WP_SITEURL", `${effectiveUrl}/wp`);
      }
      if (wpEnv) {
        setOrAppendEnvKey("WP_ENV", wpEnv);
      }

      // Ensure all 8 standard salts exist
      const saltKeys = [
        "AUTH_KEY",
        "SECURE_AUTH_KEY",
        "LOGGED_IN_KEY",
        "NONCE_KEY",
        "AUTH_SALT",
        "SECURE_AUTH_SALT",
        "LOGGED_IN_SALT",
        "NONCE_SALT",
      ];
      for (const sk of saltKeys) {
        const regex = new RegExp(`^\\s*${sk}\\s*=`, "m");
        if (!regex.test(updated)) {
          setOrAppendEnvKey(sk, salt());
        }
      }

      // Unlock and write back
      await executor
        .execute(`chmod u+w ${shellQuote(envPath)} 2>/dev/null || true`)
        .catch(() => {});
      await executor.pushFile({
        remotePath: envPath,
        content: Buffer.from(updated.trim() + "\n", "utf8"),
      });
      await executor
        .execute(`chmod 640 ${shellQuote(envPath)}`)
        .catch(() => {});

      await tracker.track({
        step: "Updated target .env with target database credentials and site URL",
        level: "info",
        detail: `${envPath} (DB: ${targetCreds.dbName}, User: ${targetCreds.dbUser})`,
      });
    }
  }

  private async ensureTargetStandardWpConfig(
    executor: Executor,
    rootPath: string,
    targetEnv: { url?: string | null },
    targetCreds: Creds,
    targetUrl: string | null,
    tracker: StepTracker,
    tablePrefix: string,
  ): Promise<void> {
    const wpConfigPath = `${rootPath}/wp-config.php`;
    const checkResult = await executor.execute(
      `test -f ${shellQuote(wpConfigPath)} && echo exists || echo missing`,
    );
    const configExists = checkResult.stdout.trim() === "exists";
    const escapeSingleQuote = (val: string) => val.replace(/'/g, "\\'");

    if (configExists) {
      let content = "";
      try {
        const buf = await executor.pullFile(wpConfigPath);
        content = buf.toString("utf8");
      } catch (e) {
        this.logger.warn(`Could not pull wp-config.php: ${e}`);
        return;
      }

      let updated = content;
      const updateDefine = (key: string, value: string) => {
        const regex = new RegExp(
          `define\\s*\\(\\s*['"]${key}['"]\\s*,\\s*['"][^'"]*['"]\\s*\\);?`,
          "g",
        );
        const replacement = `define('${key}', '${escapeSingleQuote(value)}');`;
        if (regex.test(updated)) {
          updated = updated.replace(regex, replacement);
        }
      };

      updateDefine("DB_NAME", targetCreds.dbName);
      updateDefine("DB_USER", targetCreds.dbUser);
      updateDefine("DB_PASSWORD", targetCreds.dbPassword);
      updateDefine("DB_HOST", targetCreds.dbHost);

      if (tablePrefix) {
        const prefixRegex = /\$table_prefix\s*=\s*['"][^'"]*['"];?/;
        if (prefixRegex.test(updated)) {
          updated = updated.replace(
            prefixRegex,
            `$table_prefix = '${escapeSingleQuote(tablePrefix)}';`,
          );
        }
      }

      await executor
        .execute(`chmod u+w ${shellQuote(wpConfigPath)} 2>/dev/null || true`)
        .catch(() => {});
      await executor.pushFile({
        remotePath: wpConfigPath,
        content: Buffer.from(updated, "utf8"),
      });
      await executor
        .execute(`chmod 640 ${shellQuote(wpConfigPath)}`)
        .catch(() => {});

      await tracker.track({
        step: "Updated target wp-config.php with target database credentials",
        level: "info",
        detail: `${wpConfigPath} (DB: ${targetCreds.dbName}, User: ${targetCreds.dbUser})`,
      });
    }
  }
}

