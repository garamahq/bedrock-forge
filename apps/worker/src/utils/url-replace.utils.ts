import { existsSync } from "node:fs";
import { join } from "node:path";
import { RemoteExecutorService } from "@bedrock-forge/remote-executor";
import { escapeMysql } from "./cyberpanel-http";
import {
  cleanupRemoteMyCnf,
  createRemoteMyCnf,
  flipProtocol,
  pushRemoteScript,
  shellQuote,
} from "./processor-utils";

export interface UrlReplaceLogEntry {
  step: string;
  level: "info" | "warn" | "error";
  detail?: string;
}

export interface SearchReplaceScriptSummary {
  tables_scanned: number;
  rows_affected: number;
  skipped_serialized?: number;
  errors: string[];
}

export interface SerializedDbSearchReplaceOptions {
  executor: Pick<RemoteExecutorService, "execute" | "pushFile">;
  creds: { dbUser: string; dbPassword?: string; dbHost: string };
  dbName: string;
  sourceUrl: string;
  targetUrl: string;
  jobId: string | number;
  tmpTag: string;
  scriptsDir?: string;
  onLog?: (entry: UrlReplaceLogEntry) => Promise<void> | void;
}

export function resolveWorkerScriptsDir(explicitDir?: string): string {
  if (explicitDir) return explicitDir;
  const fromSrcOrDist = join(__dirname, "..", "..", "scripts");
  if (existsSync(join(fromSrcOrDist, "search-replace.php"))) {
    return fromSrcOrDist;
  }
  return join(process.cwd(), "scripts");
}

export function buildUrlSearchReplacePairs(
  sourceUrl: string,
  targetUrl: string,
): Array<[string, string]> {
  const pairs: Array<[string, string]> = [[sourceUrl, targetUrl]];
  const altSrc = flipProtocol(sourceUrl);
  const altTgt = flipProtocol(targetUrl);
  if (altSrc && altTgt && altSrc !== targetUrl) {
    pairs.push([altSrc, altTgt]);
  }
  return pairs;
}

/**
 * Escape a literal string for a POSIX BRE `sed` pattern delimited by `|`.
 */
export function escapeSedLiteralPattern(value: string): string {
  return value.replace(/[\\.\[\]*^$|]/g, "\\$&");
}

/**
 * Escape a literal string for a `sed` replacement string delimited by `|`.
 */
export function escapeSedLiteralReplacement(value: string): string {
  return value.replace(/[\\&|]/g, "\\$&");
}

/**
 * Detect WordPress content directory (`web/app`, `app`, or `wp-content`) on a target server.
 */
export async function detectContentDirectory(
  executor: Pick<RemoteExecutorService, "execute">,
  rootPath: string,
): Promise<string> {
  const root = rootPath.replace(/\/+$/, "");
  for (const candidate of [
    `${root}/web/app`,
    `${root}/app`,
    `${root}/wp-content`,
  ]) {
    const check = await executor
      .execute(`test -d ${shellQuote(candidate)} && echo ok || echo missing`)
      .catch(() => ({ code: 1, stdout: "", stderr: "" }));
    if (check.code === 0 && check.stdout.trim() === "ok") {
      return candidate;
    }
  }
  return `${root}/wp-content`;
}

/**
 * Run serialization-aware search-replace.php against the target database.
 * Never falls back to destructive raw SQL REPLACE on serialized tables (#19, #60, #111).
 */
export async function runSerializedDbSearchReplace(
  options: SerializedDbSearchReplaceOptions,
): Promise<SearchReplaceScriptSummary[]> {
  const {
    executor,
    creds,
    dbName,
    sourceUrl,
    targetUrl,
    jobId,
    tmpTag,
    onLog,
  } = options;
  const scriptsDir = resolveWorkerScriptsDir(options.scriptsDir);
  const srScript = `/tmp/forge_sr_${tmpTag}_${jobId}.php`;
  const srMycnf = await createRemoteMyCnf(
    executor as RemoteExecutorService,
    creds,
    jobId,
    `forge_sr_${tmpTag}`,
  );
  const summaries: SearchReplaceScriptSummary[] = [];

  try {
    await pushRemoteScript(
      executor as RemoteExecutorService,
      join(scriptsDir, "search-replace.php"),
      srScript,
    );

    const prefixRes = await executor.execute(
      `mysql --defaults-extra-file=${shellQuote(srMycnf)} ${shellQuote(dbName)} -sN -e ${shellQuote(
        `SELECT REPLACE(table_name,'options','') FROM information_schema.tables WHERE table_schema='${escapeMysql(dbName)}' AND table_name LIKE '%options' LIMIT 1`,
      )}`,
    );
    const prefix =
      prefixRes.code === 0 && prefixRes.stdout.trim()
        ? prefixRes.stdout.trim()
        : "wp_";

    const pairs = buildUrlSearchReplacePairs(sourceUrl, targetUrl);
    for (const [oldUrl, newUrl] of pairs) {
      const phpResult = await executor.execute(
        `php ${shellQuote(srScript)}` +
          ` --mycnf=${shellQuote(srMycnf)}` +
          ` --db-name=${shellQuote(dbName)}` +
          ` --prefix=${shellQuote(prefix)}` +
          ` --search=${shellQuote(oldUrl)}` +
          ` --replace=${shellQuote(newUrl)}`,
        { timeout: 5 * 60_000 },
      );

      let parsed: SearchReplaceScriptSummary | null = null;
      try {
        parsed = JSON.parse(phpResult.stdout.trim()) as SearchReplaceScriptSummary;
      } catch {
        parsed = null;
      }

      if (phpResult.code !== 0 || !parsed || parsed.errors.length > 0) {
        const errorDetails = parsed?.errors?.length
          ? parsed.errors.join("; ")
          : (phpResult.stderr || phpResult.stdout || `exit ${phpResult.code}`).trim();
        await onLog?.({
          step: "Serialization-aware URL search-replace failed",
          level: "error",
          detail: `${oldUrl} → ${newUrl} (rows_affected=${parsed?.rows_affected ?? 0}): ${errorDetails}`,
        });
        throw new Error(
          `Serialization-aware URL search-replace failed for ${oldUrl} → ${newUrl} ` +
            `(rows updated: ${parsed?.rows_affected ?? 0}): ${errorDetails}`,
        );
      }

      summaries.push(parsed);
      await onLog?.({
        step: `URL search-replace complete for ${oldUrl} → ${newUrl}`,
        level: "info",
        detail: `${parsed.tables_scanned} tables scanned, ${parsed.rows_affected} rows updated`,
      });
    }

    return summaries;
  } finally {
    await cleanupRemoteMyCnf(executor as RemoteExecutorService, srMycnf).catch(() => {});
    await executor.execute(`rm -f ${shellQuote(srScript)}`).catch(() => {});
  }
}

/**
 * Perform exact literal URL search-replace inside text assets under `contentPath`,
 * failing explicitly if any file edit or residual check fails (#54, #112).
 */
export async function replaceLiteralUrlInFiles(
  executor: Pick<RemoteExecutorService, "execute">,
  contentPath: string,
  sourceUrl: string,
  targetUrl: string,
  onLog?: (entry: UrlReplaceLogEntry) => Promise<void> | void,
): Promise<void> {
  const dirCheck = await executor.execute(
    `test -d ${shellQuote(contentPath)} && echo ok || echo missing`,
  );
  if (dirCheck.code !== 0 || dirCheck.stdout.trim() !== "ok") {
    await onLog?.({
      step: "Content directory not found — skipping literal file URL replacement",
      level: "warn",
      detail: contentPath,
    });
    return;
  }

  const basePairs = buildUrlSearchReplacePairs(sourceUrl, targetUrl);
  const allFilePairs: Array<[string, string]> = [...basePairs];
  for (const [oldUrl, newUrl] of basePairs) {
    const oj = oldUrl.replace(/\//g, "\\/");
    const nj = newUrl.replace(/\//g, "\\/");
    if (oj !== oldUrl) allFilePairs.push([oj, nj]);
    const oe = oldUrl.replace("://", "%3A%2F%2F");
    const ne = newUrl.replace("://", "%3A%2F%2F");
    if (oe !== oldUrl) allFilePairs.push([oe, ne]);
  }

  for (const [oldUrl, newUrl] of allFilePairs) {
    if (/[\r\n\0]/.test(oldUrl) || /[\r\n\0]/.test(newUrl)) {
      throw new Error("URLs for file replacement cannot contain control characters");
    }
    const sedExpr = `s|${escapeSedLiteralPattern(oldUrl)}|${escapeSedLiteralReplacement(newUrl)}|g`;
    const sedCmd = [
      `find ${shellQuote(contentPath)} -type f`,
      `\\( -name '*.css' -o -name '*.js' -o -name '*.json' -o -name '*.html'`,
      `-o -name '*.htm' -o -name '*.svg' -o -name '*.xml' -o -name '*.txt'`,
      `-o -name '*.php' \\)`,
      `-exec sed -i ${shellQuote(sedExpr)} {} +`,
    ].join(" ");

    const sedRes = await executor.execute(sedCmd);
    if (sedRes.code !== 0) {
      const detail = (sedRes.stderr || sedRes.stdout || `exit ${sedRes.code}`).trim();
      await onLog?.({
        step: "Literal file URL replacement failed",
        level: "error",
        detail: `${contentPath} (${oldUrl}): ${detail}`,
      });
      throw new Error(
        `Literal file URL replacement failed in ${contentPath} for ${oldUrl} (exit ${sedRes.code}): ${detail}`,
      );
    }
  }

  // Verify no literal source URL strings remain in scanned text assets
  const verifyCmd = [
    `find ${shellQuote(contentPath)} -type f`,
    `\\( -name '*.css' -o -name '*.js' -o -name '*.json' -o -name '*.html'`,
    `-o -name '*.htm' -o -name '*.svg' -o -name '*.xml' -o -name '*.txt'`,
    `-o -name '*.php' \\)`,
    `-exec grep -nHF -m 1 -- ${shellQuote(sourceUrl)} {} +`,
  ].join(" ");
  const grepRes = await executor.execute(verifyCmd);
  if (grepRes.code === 0 && grepRes.stdout.trim()) {
    const sample = grepRes.stdout.trim().split("\n").slice(0, 5).join("; ");
    throw new Error(
      `Literal file URL replacement verification failed: stale URL (${sourceUrl}) still present in ${contentPath}: ${sample}`,
    );
  }
  if (grepRes.code > 1) {
    const detail = (grepRes.stderr || grepRes.stdout || `exit ${grepRes.code}`).trim();
    throw new Error(`Literal file URL verification error in ${contentPath}: ${detail}`);
  }

  await onLog?.({
    step: "Literal file URL replacement complete",
    level: "info",
    detail: `${contentPath} (${allFilePairs.length} literal pair(s) applied)`,
  });
}
