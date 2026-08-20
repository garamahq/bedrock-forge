import { RemoteExecutorService } from "@bedrock-forge/remote-executor";
import { StepTracker } from "../services/step-tracker";
import { readFile } from "fs/promises";
import { randomBytes } from "crypto";

/**
 * Wrap a string in single quotes for safe shell embedding.
 * Single quotes inside the value are escaped as: ' -> '\''
 */
export function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/**
 * Flip http↔https on a URL string.
 * Returns null if the URL doesn't start with http:// or https://.
 */
export function flipProtocol(url: string): string | null {
  if (url.startsWith("https://")) return "http://" + url.slice(8);
  if (url.startsWith("http://")) return "https://" + url.slice(7);
  return null;
}

/**
 * Fix CyberPanel file ownership on a remote docroot.
 *
 * CyberPanel assigns each website a dedicated system user and expects:
 *   - The docroot folder itself  →  user:nogroup  mode 750  (drwxr-x---)
 *   - All files/dirs inside       →  user:user     (recursive)
 *
 * Detection: stat the parent of rootPath (e.g. /home/<domain>) to find the
 * site owner, then fall back to stat on rootPath itself if the parent is
 * root-owned or unreadable. Skips silently when no non-root owner is found.
 */
export async function fixCyberPanelOwnership(
  executor: RemoteExecutorService,
  rootPath: string,
  tracker?: StepTracker,
): Promise<void> {
  const root = rootPath.replace(/\/+$/, "");
  const parentDir = root.replace(/\/[^/]+$/, "");

  const log = async (
    step: string,
    level: "info" | "warn",
    detail?: string,
  ): Promise<void> => {
    if (tracker) {
      await tracker.track({ step, level, detail }).catch(() => undefined);
    }
  };

  // Detect the site owner from the parent directory (e.g. /home/<domain>)
  const parentStat = await executor
    .execute(`stat -c '%U' ${shellQuote(parentDir)} 2>/dev/null`)
    .catch(() => ({ code: 1, stdout: "", stderr: "" }));
  let owner: string | null =
    parentStat.code === 0 &&
    parentStat.stdout.trim() &&
    parentStat.stdout.trim() !== "root"
      ? parentStat.stdout.trim()
      : null;

  // Fallback: stat the docroot itself when parent is root-owned or unreadable
  if (!owner) {
    const selfStat = await executor
      .execute(`stat -c '%U' ${shellQuote(root)} 2>/dev/null`)
      .catch(() => ({ code: 1, stdout: "", stderr: "" }));
    if (
      selfStat.code === 0 &&
      selfStat.stdout.trim() &&
      selfStat.stdout.trim() !== "root"
    ) {
      owner = selfStat.stdout.trim();
    }
  }

  if (!owner) {
    await log(
      "Could not detect site owner — skipping ownership fix",
      "warn",
      `root=${root}`,
    );
    return;
  }

  await log(
    `Fixing ownership & permissions: ${owner}:${owner} (recursive) then ${owner}:nogroup on docroot`,
    "info",
    root,
  );

  // Step 0 — standard modes: 755 dirs, 644 files
  await executor
    .execute(
      `find ${shellQuote(root)} -type d -exec chmod 755 {} + 2>/dev/null; find ${shellQuote(root)} -type f -exec chmod 644 {} + 2>/dev/null`,
    )
    .catch(() => {});

  // Step 1 — inner files: user:user (recursive)
  await executor
    .execute(`chown -R ${shellQuote(`${owner}:${owner}`)} ${shellQuote(root)}`)
    .catch(async (e: unknown) => {
      await log(
        "chown -R failed — inner files may have wrong ownership",
        "warn",
        e instanceof Error ? e.message : String(e),
      );
    });

  // Step 2 — docroot folder itself: user:nogroup (non-recursive override)
  await executor
    .execute(`chown ${shellQuote(`${owner}:nogroup`)} ${shellQuote(root)}`)
    .catch(async (e: unknown) => {
      await log(
        "chown user:nogroup on docroot failed",
        "warn",
        e instanceof Error ? e.message : String(e),
      );
    });

  // Step 3 — enforce correct mode on the docroot and secure configs
  await executor
    .execute(`chmod 750 ${shellQuote(root)}`)
    .catch(async (e: unknown) => {
      await log(
        "chmod 750 on docroot failed",
        "warn",
        e instanceof Error ? e.message : String(e),
      );
    });

  await executor
    .execute(
      `chmod 440 ${shellQuote(`${root}/wp-config.php`)} 2>/dev/null || true; chmod 440 ${shellQuote(`${root}/web/wp-config.php`)} 2>/dev/null || true; chmod 440 ${shellQuote(`${root}/.env`)} 2>/dev/null || true; chmod 440 ${shellQuote(`${root}/web/.env`)} 2>/dev/null || true;`,
    )
    .catch(() => {});

  await log(
    `Ownership & permissions fixed: ${owner}:nogroup on docroot, ${owner}:${owner} on contents (755/644)`,
    "info",
  );
}

/**
 * Detect the owner of a WordPress installation directory and return the
 * appropriate WP-CLI invocation prefix.
 *
 * On CyberPanel (and similar panel stacks) each site runs under its own Linux
 * user whose PHP-FPM pool has all required extensions (mysqli, etc.). Root's
 * CLI PHP (/usr/bin/php) is often a minimal build that lacks those extensions,
 * causing WP-CLI to fail with "missing MySQL extension" when invoked as root.
 *
 * Returns:
 *   Non-root owner → `{ prefix: 'sudo -u <owner>', allowRootFlag: '' }`
 *   Root-owned or stat failure → `{ prefix: '', allowRootFlag: '--allow-root' }`
 *   CyberPanel/OLS host → `lsphpBin` = lowest-version lsphp path with mysqli,
 *                          `wpBin`    = absolute path to wp phar/binary.
 *   When both are set, callers should invoke: `${prefix} ${lsphpBin} ${wpBin} args`
 *   to bypass the phar shebang entirely. If only `lsphpBin` is set (wp not found
 *   in PATH), fall back to `env WP_CLI_PHP=${lsphpBin} wp`.
 */
export async function buildWpCliPrefix(
  executor: RemoteExecutorService,
  wpPath: string,
): Promise<{
  prefix: string;
  allowRootFlag: string;
  lsphpBin: string | null;
  wpBin: string | null;
}> {
  let prefix = "";
  let allowRootFlag = "--allow-root";
  try {
    const r = await executor.execute(
      `stat -c '%U' ${shellQuote(wpPath)} 2>/dev/null`,
    );
    const owner = r.stdout.trim();
    // Accept only valid unix usernames — reject anything with shell metacharacters
    if (
      owner &&
      owner !== "root" &&
      /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(owner)
    ) {
      prefix = `sudo -u ${owner}`;
      allowRootFlag = "";
    }
  } catch {
    // stat failed — proceed with --allow-root
  }
  // Detect LiteSpeed PHP binary and WP-CLI path for direct phar invocation.
  // On CyberPanel, system PHP (/usr/bin/php) often lacks mysqli; lsphpXX does not.
  // When wp is installed as a PHP Phar (common on CyberPanel), WP_CLI_PHP env var
  // is silently ignored because the Phar shebang (#!/usr/bin/env php) is hardcoded.
  // The only reliable fix is to call:  lsphpXX /path/to/wp.phar args
  let lsphpBin: string | null = null;
  let wpBin: string | null = null;

  // 1. Try to extract domain from wpPath and parse vhost.conf config
  try {
    let domain: string | null = null;
    const match = wpPath.match(/\/home\/([^\/]+)\/public_html/);
    if (match) {
      domain = match[1];
    } else {
      const parts = wpPath.split("/");
      const idx = parts.indexOf("public_html");
      if (idx > 0) {
        domain = parts[idx - 1];
      }
    }

    if (domain) {
      const vhostConfigPath = `/usr/local/lsws/conf/vhosts/${domain}/vhost.conf`;
      const vhostResult = await executor.execute(
        `grep -oE '/usr/local/lsws/lsphp[0-9]+/bin/(ls)?php' ${shellQuote(vhostConfigPath)} 2>/dev/null | head -1`,
      );
      const vhostPhp = vhostResult.stdout.trim();
      if (
        vhostPhp &&
        /^\/usr\/local\/lsws\/lsphp\d+\/bin\/(ls)?php$/.test(vhostPhp)
      ) {
        const cliPhp = vhostPhp.replace(/\/bin\/lsphp$/, "/bin/php");
        const checkResult = await executor.execute(
          `[ -f ${shellQuote(cliPhp)} ] && echo yes || echo no`,
        );
        if (checkResult.stdout.trim() === "yes") {
          lsphpBin = cliPhp;
        } else {
          const checkOrigResult = await executor.execute(
            `[ -f ${shellQuote(vhostPhp)} ] && echo yes || echo no`,
          );
          if (checkOrigResult.stdout.trim() === "yes") {
            lsphpBin = vhostPhp;
          }
        }
      }
    }
  } catch {
    // Ignore and fallback
  }

  // 2. Fallback: Find the highest version of OpenLiteSpeed PHP
  if (!lsphpBin) {
    try {
      const lsphpResult = await executor.execute(
        `ls /usr/local/lsws/lsphp*/bin/php 2>/dev/null | sort -V | tail -1`,
      );
      const bin = lsphpResult.stdout.trim();
      // Strict path validation — only accept canonical CyberPanel/OpenLiteSpeed paths
      if (bin && /^\/usr\/local\/lsws\/lsphp\d+\/bin\/php$/.test(bin)) {
        lsphpBin = bin;
      }
    } catch {
      // lsphp not found — proceed without PHP override
    }
  }

  try {
    const wpResult = await executor.execute(`which wp 2>/dev/null`);
    const bin = wpResult.stdout.trim();
    // Strict path validation — only absolute paths, no metacharacters
    if (bin && /^\/[a-zA-Z0-9_.\/-]+$/.test(bin)) {
      wpBin = bin;
    }
  } catch {
    // wp not in PATH — fallback to checking common paths
  }

  if (!wpBin) {
    for (const path of ["/usr/local/bin/wp", "/usr/bin/wp"]) {
      try {
        const check = await executor.execute(
          `[ -x ${shellQuote(path)} ] && echo yes || echo no`,
        );
        if (check.stdout.trim() === "yes") {
          wpBin = path;
          break;
        }
      } catch {
        // ignore
      }
    }
  }

  return { prefix, allowRootFlag, lsphpBin, wpBin };
}

/**
 * Create a temporary MySQL client config file on the remote host for secure password handling.
 * Returns the remote path to the created file.
 */
export async function createRemoteMyCnf(
  executor: RemoteExecutorService,
  creds: { dbUser: string; dbPassword?: string; dbHost: string; dbName?: string },
  jobId: string | number,
  prefix = "forge",
): Promise<string> {
  // Housekeeping: clean any orphaned cnf files older than 60 minutes
  await executor.execute(`find /tmp -name "${prefix}_mycnf_*.cnf" -mmin +60 -delete 2>/dev/null || true`).catch(() => {});

  const rand = randomBytes(16).toString("hex");
  const remotePath = `/tmp/${prefix}_mycnf_${jobId}_${rand}.cnf`;
  let content = `[client]\nuser=${creds.dbUser}\npassword=${creds.dbPassword ?? ""}\nhost=${creds.dbHost}\n`;
  if (creds.dbName) {
    content += `database=${creds.dbName}\n`;
  }
  await executor.pushFile({
    remotePath,
    content: Buffer.from(content),
  });
  await executor.execute(`chmod 600 ${shellQuote(remotePath)}`);
  return remotePath;
}

/**
 * Delete a temporary MySQL config file on the remote host.
 */
export async function cleanupRemoteMyCnf(
  executor: RemoteExecutorService,
  remotePath: string,
): Promise<void> {
  await executor.execute(`rm -f ${shellQuote(remotePath)}`).catch(() => {});
}

/**
 * Validate that a table name contains only safe characters to prevent shell/SQL injection.
 */
export function isValidTableName(tableName: string): boolean {
  return /^[A-Za-z0-9_$]+$/.test(tableName);
}

/**
 * Filter and normalize a list of table names to ensure they are safe for SQL and shell commands.
 */
export function sanitizeTableList(tables: string[]): string[] {
  const seen = new Set<string>();
  const safe: string[] = [];
  for (const raw of tables) {
    const table = raw.trim();
    if (isValidTableName(table) && !seen.has(table)) {
      seen.add(table);
      safe.push(table);
    }
  }
  return safe;
}

/**
 * Push a local helper script from the scripts directory to the remote server.
 */
export async function pushRemoteScript(
  executor: RemoteExecutorService,
  localScriptPath: string,
  remoteScriptPath: string,
): Promise<void> {
  const content = await readFile(localScriptPath);
  await executor.pushFile({
    remotePath: remoteScriptPath,
    content,
  });
}

/**
 * Builder for constructing WP-CLI commands safely with paths, permissions, and panel-specific PHP overrides.
 */
export class WpCliBuilder {
  constructor(
    public readonly prefix: string,
    public readonly allowRootFlag: string,
    public readonly lsphpBin: string | null,
    public readonly wpBin: string | null,
    private readonly rootPath: string,
  ) {}

  static async create(
    executor: RemoteExecutorService,
    rootPath: string,
  ): Promise<WpCliBuilder> {
    const info = await buildWpCliPrefix(executor, rootPath);
    return new WpCliBuilder(
      info.prefix,
      info.allowRootFlag,
      info.lsphpBin,
      info.wpBin,
      rootPath,
    );
  }

  buildCommand(args: string): string {
    let phpAndWp: string;
    if (this.lsphpBin && this.wpBin) {
      phpAndWp = `${shellQuote(this.lsphpBin)} ${shellQuote(this.wpBin)}`;
    } else if (this.lsphpBin) {
      phpAndWp = `env WP_CLI_PHP=${shellQuote(this.lsphpBin)} wp`;
    } else {
      phpAndWp = this.wpBin ? shellQuote(this.wpBin) : "wp";
    }

    let finalArgs = args.trim();
    if (!finalArgs.includes("--path=")) {
      finalArgs += ` --path=${shellQuote(this.rootPath)}`;
    }

    const parts = [this.prefix, phpAndWp, finalArgs, this.allowRootFlag].filter(
      Boolean,
    );

    return parts.join(" ") + " 2>&1";
  }

  buildCdCommand(args: string): string {
    const wp = this.wpBin ? shellQuote(this.wpBin) : "wp";
    const parts = [wp, args.trim(), this.allowRootFlag].filter(Boolean);
    return `cd ${shellQuote(this.rootPath)} && ${parts.join(" ")} 2>&1`;
  }
}

/**
 * Builder for constructing composer-manager commands with docroot and action parameters.
 */
export class ComposerCommandBuilder {
  private readonly phpCmd: string;

  constructor(
    private readonly scriptPath: string,
    private readonly docroot: string,
    lsphpBin: string | null = null,
  ) {
    this.phpCmd = lsphpBin ? shellQuote(lsphpBin) : "php";
  }

  build(
    action: string,
    options: { package?: string; version?: string; constraint?: string } = {},
  ): string {
    let cmd = `${this.phpCmd} ${shellQuote(this.scriptPath)} --docroot=${shellQuote(this.docroot)} --action=${shellQuote(action)}`;
    if (options.package) {
      cmd += ` --package=${shellQuote(options.package)}`;
    }
    if (options.version) {
      cmd += ` --version=${shellQuote(options.version)}`;
    }
    if (options.constraint) {
      cmd += ` --constraint=${shellQuote(options.constraint)}`;
    }
    return cmd;
  }
}
