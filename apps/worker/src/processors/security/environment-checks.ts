import type { SecurityFinding } from "@bedrock-forge/shared";
import { makeFinding } from "./scoring";

type Executor = {
  execute(
    cmd: string,
    opts?: { timeout?: number },
  ): Promise<{ stdout: string; stderr: string; code: number }>;
};

// ─── WP_AUDIT ────────────────────────────────────────────────────────────────

export async function runWpAudit(
  exec: Executor,
  rootPath: string,
): Promise<SecurityFinding[]> {
  const findings: SecurityFinding[] = [];

  const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

  // 1. wp-config.php location and permissions
  const wpConfigCandidates = [
    `${rootPath}/wp-config.php`,
    `${rootPath}/web/wp-config.php`,
  ];
  let wpConfigPath: string | null = null;

  for (const candidate of wpConfigCandidates) {
    const { stdout } = await exec.execute(
      `test -f ${q(candidate)} && echo found || echo missing`,
    );
    if (stdout.trim() === "found") {
      wpConfigPath = candidate;
      break;
    }
  }

  if (!wpConfigPath) {
    findings.push(
      makeFinding(
        "medium",
        "WP_CONFIG",
        "wp-config.php not found",
        `Could not locate wp-config.php in ${rootPath} or ${rootPath}/web/`,
        {
          remediation: "Verify the root_path is correct for this environment.",
        },
      ),
    );
    return findings;
  }

  // Check permissions on wp-config.php
  const { stdout: statOut } = await exec.execute(
    `stat -c '%a' ${q(wpConfigPath)} 2>/dev/null || true`,
  );
  const perms = statOut.trim();
  if (perms && !["400", "440", "444"].includes(perms)) {
    findings.push(
      makeFinding(
        perms === "666" || perms === "777" ? "critical" : "high",
        "FILE_PERMISSIONS",
        `wp-config.php has insecure permissions: ${perms}`,
        "wp-config.php contains database credentials and should be readable only by the web server user.",
        {
          remediation: `chmod 440 ${wpConfigPath}`,
          resource: wpConfigPath,
          metadata: { current_permissions: perms },
        },
      ),
    );
  }

  // Read wp-config.php content for analysis
  const { stdout: wpConfigContent } = await exec.execute(
    `cat ${q(wpConfigPath)} 2>/dev/null | head -200 || true`,
  );

  // 2. WP_DEBUG enabled on production
  if (/define\s*\(\s*['"]WP_DEBUG['"]\s*,\s*true/i.test(wpConfigContent)) {
    findings.push(
      makeFinding(
        "high",
        "WP_CONFIG",
        "WP_DEBUG is enabled",
        "Debug mode exposes error details, PHP notices, and stack traces to visitors — a significant information disclosure risk.",
        {
          remediation: `Set define('WP_DEBUG', false) in ${wpConfigPath}`,
          resource: wpConfigPath,
        },
      ),
    );
  }

  // 3. table_prefix = 'wp_' (default — easy to target in SQL injection)
  if (/\$table_prefix\s*=\s*['"]wp_['"]/i.test(wpConfigContent)) {
    findings.push(
      makeFinding(
        "medium",
        "WP_CONFIG",
        "Default WordPress table prefix 'wp_' in use",
        "The default wp_ prefix is well-known and aids automated SQL injection attacks.",
        {
          remediation:
            "Change the table prefix in wp-config.php and rename all tables in the database. " +
            "Use a tool like Better Search Replace or manual SQL.",
          resource: wpConfigPath,
        },
      ),
    );
  }

  // 4. AUTH_KEY / SECURE_AUTH_KEY length (should be 60+ chars)
  const saltMatches = wpConfigContent.match(
    /define\s*\(\s*['"]AUTH_KEY['"]\s*,\s*['"](.+?)['"]/,
  );
  if (saltMatches && saltMatches[1].length < 20) {
    findings.push(
      makeFinding(
        "high",
        "WP_CONFIG",
        "Weak or default WordPress secret keys",
        "WordPress authentication keys/salts are too short or appear to be placeholder values.",
        {
          remediation:
            "Generate strong keys at https://api.wordpress.org/secret-key/1.1/salt/ and update wp-config.php.",
          resource: wpConfigPath,
        },
      ),
    );
  }

  // 4b. WP_DISALLOW_FILE_EDIT — check both wp-config.php and Bedrock's config/application.php
  const { stdout: bedrockAppConfig } = await exec.execute(
    `cat ${q(rootPath + "/config/application.php")} 2>/dev/null | head -300 || true`,
  );
  const combinedWpConfig = wpConfigContent + "\n" + bedrockAppConfig;
  if (
    !/define\s*\(\s*['"]WP_DISALLOW_FILE_EDIT['"]\s*,\s*true/i.test(
      combinedWpConfig,
    )
  ) {
    findings.push(
      makeFinding(
        "medium",
        "WP_CONFIG",
        "WordPress file editor is enabled",
        "The built-in theme/plugin file editor in wp-admin allows arbitrary PHP to be written to the server. A compromised admin account gives instant RCE.",
        {
          remediation: `Add to ${wpConfigPath ?? "wp-config.php"}: define('WP_DISALLOW_FILE_EDIT', true);`,
          resource: wpConfigPath ?? undefined,
        },
      ),
    );
  }

  // 5. PHP version check
  const { stdout: phpVersion } = await exec.execute(
    `php -r "echo PHP_MAJOR_VERSION . '.' . PHP_MINOR_VERSION;" 2>/dev/null || true`,
  );
  const version = phpVersion.trim();
  if (version) {
    const [major, minor] = version.split(".").map(Number);
    if (major < 8 || (major === 8 && minor < 1)) {
      findings.push(
        makeFinding(
          major < 7 ? "critical" : "high",
          "PHP_CONFIG",
          `PHP ${version} is outdated`,
          `PHP ${version} has reached end-of-life and no longer receives security updates.`,
          {
            remediation: "Upgrade to PHP 8.2 or higher.",
            metadata: { php_version: version },
          },
        ),
      );
    }
  }

  // 6. Dangerous PHP ini settings
  const { stdout: phpIni } = await exec.execute(
    `php -r "echo json_encode(['display_errors'=>ini_get('display_errors'),'allow_url_fopen'=>ini_get('allow_url_fopen'),'allow_url_include'=>ini_get('allow_url_include')]);" 2>/dev/null || true`,
  );
  try {
    const ini = JSON.parse(phpIni.trim()) as Record<string, string>;
    if (
      ini["display_errors"] &&
      ini["display_errors"] !== "" &&
      ini["display_errors"] !== "0"
    ) {
      findings.push(
        makeFinding(
          "medium",
          "PHP_CONFIG",
          "PHP display_errors is enabled",
          "Displaying errors in production leaks stack traces and path information to potential attackers.",
          { remediation: "Set display_errors = Off in php.ini or .user.ini" },
        ),
      );
    }
    if (ini["allow_url_include"] === "1" || ini["allow_url_include"] === "On") {
      findings.push(
        makeFinding(
          "high",
          "PHP_CONFIG",
          "PHP allow_url_include is enabled",
          "allow_url_include enables remote file inclusion (RFI) attacks, a common malware entry point.",
          { remediation: "Set allow_url_include = Off in php.ini" },
        ),
      );
    }
  } catch {
    // PHP not available or JSON parse error — skip
  }

  // 7. WP admin users
  const { stdout: wpCliCheck } = await exec.execute(
    `which wp 2>/dev/null && echo found || echo missing`,
  );
  if (wpCliCheck.trim() === "found") {
    const { stdout: adminUsers } = await exec.execute(
      `wp user list --role=administrator --fields=ID,user_login,user_email,user_registered --format=json --path=${q(rootPath)} 2>/dev/null || true`,
      { timeout: 30000 },
    );
    try {
      const users = JSON.parse(adminUsers.trim()) as {
        ID: number;
        user_login: string;
        user_email: string;
        user_registered: string;
      }[];

      if (users.length > 0) {
        // Flag users registered within last 7 days
        const recentCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const recentAdmins = users.filter(
          (u) => new Date(u.user_registered) > recentCutoff,
        );
        if (recentAdmins.length > 0) {
          findings.push(
            makeFinding(
              "critical",
              "WP_USERS",
              `${recentAdmins.length} new WordPress admin account(s) created in the last 7 days`,
              `New admins: ${recentAdmins.map((u) => `${u.user_login} (${u.user_email})`).join(", ")}`,
              {
                remediation:
                  "Immediately verify these accounts are legitimate. " +
                  "If unknown, delete them and change all admin passwords.",
                metadata: {
                  new_admins: recentAdmins.map((u) => ({
                    login: u.user_login,
                    email: u.user_email,
                    registered: u.user_registered,
                  })),
                  all_admin_count: users.length,
                },
              },
            ),
          );
        }

        if (users.length > 5) {
          findings.push(
            makeFinding(
              "medium",
              "WP_USERS",
              `${users.length} WordPress administrator accounts`,
              "A high number of admin accounts increases the attack surface.",
              {
                remediation:
                  "Review all admin accounts. Downgrade inactive or unnecessary admins to a lower role.",
                metadata: {
                  admins: users.map((u) => ({
                    login: u.user_login,
                    email: u.user_email,
                  })),
                },
              },
            ),
          );
        } else {
          findings.push(
            makeFinding(
              "info",
              "WP_USERS",
              `${users.length} WordPress administrator account(s)`,
              `Admin users: ${users.map((u) => u.user_login).join(", ")}`,
              {
                metadata: {
                  admins: users.map((u) => ({
                    login: u.user_login,
                    email: u.user_email,
                  })),
                },
              },
            ),
          );
        }
      }
    } catch {
      // WP-CLI not available or not a WordPress install
    }
  }

  // 8. Retrieve site URL for HTTP-based checks (WP_CLI preferred, fallback grep)
  let siteUrl = "";
  try {
    const { stdout: urlFromCli } = await exec.execute(
      `wp option get siteurl --path=${q(rootPath)} --skip-themes --skip-plugins 2>/dev/null || true`,
      { timeout: 15000 },
    );
    siteUrl = urlFromCli.trim();
  } catch {
    // WP CLI not available — try reading from wp-config
    if (wpConfigContent) {
      const match =
        wpConfigContent.match(
          /define\s*\(\s*['"]WP_HOME['"]\s*,\s*['"]([^'"]+)['"]/i,
        ) ??
        wpConfigContent.match(
          /define\s*\(\s*['"]WP_SITEURL['"]\s*,\s*['"]([^'"]+)['"]/i,
        );
      if (match) siteUrl = match[1].trim();
    }
  }

  if (siteUrl && siteUrl.startsWith("http")) {
    const cleanUrl = siteUrl.replace(/\/$/, "");
    const probeStatus = async (path: string): Promise<string> => {
      const { stdout } = await exec.execute(
        `curl -s -o /dev/null -w "%{http_code}" --max-time 10 "${cleanUrl}${path}" 2>/dev/null || echo 000`,
        { timeout: 15000 },
      );
      return stdout.trim();
    };

    // xmlrpc.php exposed — common DDoS amplification and brute-force vector
    const xmlrpcCode = await probeStatus("/xmlrpc.php");
    if (xmlrpcCode === "200") {
      findings.push(
        makeFinding(
          "high",
          "WP_CONFIG",
          "xmlrpc.php is publicly accessible",
          "XML-RPC allows brute-force login bypassing standard rate limiting. It is also used for DDoS amplification.",
          {
            remediation:
              'Disable XML-RPC by adding to wp-config.php: add_filter("xmlrpc_enabled","__return_false"); ' +
              "Or block via .htaccess: <Files xmlrpc.php> deny from all </Files>",
            resource: `${cleanUrl}/xmlrpc.php`,
          },
        ),
      );
    }

    // readme.html accessible — reveals WordPress version
    const readmeCode = await probeStatus("/readme.html");
    if (readmeCode === "200") {
      findings.push(
        makeFinding(
          "medium",
          "VERSION_DISCLOSURE",
          "WordPress readme.html is publicly accessible (version disclosure)",
          "readme.html reveals the WordPress version, enabling targeted version-specific exploits.",
          {
            remediation: `rm ${rootPath}/readme.html or block via nginx/Apache: deny access to readme.html`,
            resource: `${cleanUrl}/readme.html`,
          },
        ),
      );
    }

    // wp-json user enumeration — leaks all usernames
    const { stdout: usersJson } = await exec.execute(
      `curl -s --max-time 10 "${cleanUrl}/wp-json/wp/v2/users" 2>/dev/null || echo '[]'`,
      { timeout: 15000 },
    );
    try {
      const parsed = JSON.parse(usersJson.trim());
      if (Array.isArray(parsed) && parsed.length > 0) {
        const logins = (parsed as { slug?: string; name?: string }[])
          .map((u) => u.slug ?? u.name ?? "unknown")
          .slice(0, 10);
        findings.push(
          makeFinding(
            "medium",
            "VERSION_DISCLOSURE",
            `WordPress REST API exposes ${parsed.length} username(s)`,
            "The /wp-json/wp/v2/users endpoint reveals usernames publicly, aiding targeted brute-force attacks.",
            {
              remediation:
                'Add to functions.php or a security plugin: add_filter("rest_endpoints", function($e){ unset($e["/wp/v2/users"]); return $e; });',
              resource: `${cleanUrl}/wp-json/wp/v2/users`,
              metadata: { usernames: logins, total: parsed.length },
            },
          ),
        );
      }
    } catch {
      // JSON parse error — endpoint might not be enabled
    }

    // .git directory exposed — full source code disclosure
    const gitHeadCode = await probeStatus("/.git/HEAD");
    if (gitHeadCode === "200") {
      findings.push(
        makeFinding(
          "high",
          "VERSION_DISCLOSURE",
          ".git directory is publicly accessible",
          "An exposed .git directory allows attackers to download the full source code, including credentials in commit history.",
          {
            remediation:
              'Block access via Nginx: location ~ /\\.git { deny all; } or Apache: <DirectoryMatch "^.*/\\.git"> deny from all </DirectoryMatch>',
            resource: `${cleanUrl}/.git/HEAD`,
          },
        ),
      );
    }

    // wp-content/debug.log accessible — may expose credentials and stack traces
    const debugLogCode = await probeStatus("/wp-content/debug.log");
    if (debugLogCode === "200") {
      findings.push(
        makeFinding(
          "high",
          "VERSION_DISCLOSURE",
          "WordPress debug.log is publicly accessible",
          "The debug log is accessible over HTTP and may contain database credentials, file paths, API keys, and detailed error traces.",
          {
            remediation:
              'Block access via .htaccess: <Files "debug.log"> Order Deny,Allow Deny from all </Files>. Also set WP_DEBUG_LOG to false in wp-config.php.',
            resource: `${cleanUrl}/wp-content/debug.log`,
          },
        ),
      );
    }

    // .env accessible — critical credential exposure (common in misconfigured Bedrock installs)
    const envFileCode = await probeStatus("/.env");
    if (envFileCode === "200") {
      findings.push(
        makeFinding(
          "critical",
          "VERSION_DISCLOSURE",
          ".env file is publicly accessible",
          "The .env file is accessible over HTTP and contains database credentials, API keys, and other secrets.",
          {
            remediation:
              'For Bedrock: ensure the web root is /web, not the project root. Block via .htaccess: <Files ".env"> deny from all </Files>.',
            resource: `${cleanUrl}/.env`,
          },
        ),
      );
    }

    const bedrockAppProbes: {
      path: string;
      title: string;
      severity: "critical" | "high" | "medium";
      description: string;
    }[] = [
      {
        path: "/app/.env",
        title: "Bedrock /app/.env is publicly accessible",
        severity: "critical",
        description:
          "The Bedrock app path exposes an .env file over HTTP. This can disclose database credentials, API keys, and salts.",
      },
      {
        path: "/app/debug.log",
        title: "Bedrock /app/debug.log is publicly accessible",
        severity: "high",
        description:
          "The Bedrock app path exposes debug.log over HTTP. Logs can include credentials, paths, plugin errors, and stack traces.",
      },
      {
        path: "/app/error_log",
        title: "Bedrock /app/error_log is publicly accessible",
        severity: "high",
        description:
          "The Bedrock app path exposes an error_log file over HTTP. Logs can include sensitive runtime details.",
      },
      {
        path: "/app/composer.json",
        title: "Bedrock /app/composer.json is publicly accessible",
        severity: "medium",
        description:
          "Composer metadata is reachable through the Bedrock app path. This reveals package names and versions useful for targeted attacks.",
      },
      {
        path: "/app/dsd",
        title: "Unexpected Bedrock /app file is publicly accessible",
        severity: "medium",
        description:
          "A non-static, extensionless file under the Bedrock app path returned HTTP 200. Direct app file access should be denied unless it is a known public asset.",
      },
    ];

    for (const probe of bedrockAppProbes) {
      const code = await probeStatus(probe.path);
      if (code !== "200") {
        continue;
      }

      findings.push(
        makeFinding(
          probe.severity,
          "VERSION_DISCLOSURE",
          probe.title,
          probe.description,
          {
            remediation:
              "Apply the Block sensitive file access hardening action. It writes a Bedrock app path guard that denies unsafe direct files while keeping normal static assets available.",
            resource: `${cleanUrl}${probe.path}`,
          },
        ),
      );
    }

    // User enumeration via ?author= redirect — leaks WordPress usernames
    const { stdout: authorStatus } = await exec.execute(
      `curl -s -o /dev/null -w "%{http_code}" --max-time 10 --max-redirs 0 "${cleanUrl}/?author=1" 2>/dev/null || echo 000`,
      { timeout: 15000 },
    );
    if (["301", "302"].includes(authorStatus.trim())) {
      const { stdout: authorLocation } = await exec.execute(
        `curl -sI --max-time 10 "${cleanUrl}/?author=1" 2>/dev/null | grep -i "^location:" | head -1 || true`,
        { timeout: 15000 },
      );
      if (authorLocation.toLowerCase().includes("/author/")) {
        findings.push(
          makeFinding(
            "medium",
            "VERSION_DISCLOSURE",
            "WordPress user enumeration via ?author= is possible",
            "The ?author=N redirect reveals WordPress usernames publicly, enabling targeted brute-force attacks.",
            {
              remediation:
                "Add to .htaccess: RewriteCond %{QUERY_STRING} ^author=\\d RewriteRule ^ /? [L,R=301]",
              resource: `${cleanUrl}/?author=1`,
            },
          ),
        );
      }
    }
  }

  // 9. timthumb.php — vulnerable image resizing script frequently exploited
  const { stdout: timthumbFiles } = await exec.execute(
    `find ${q(rootPath)} -type f \\( -name "timthumb.php" -o -name "thumb.php" \\) 2>/dev/null | head -10 || true`,
    { timeout: 20000 },
  );
  const ttFiles = timthumbFiles
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (ttFiles.length > 0) {
    findings.push(
      makeFinding(
        "high",
        "SUSPICIOUS_FILES",
        `timthumb.php found in ${ttFiles.length} location(s)`,
        "timthumb.php is a legacy image resizer with multiple known RCE vulnerabilities (CVE-2011-4825 and others).",
        {
          remediation:
            "Delete timthumb.php. Update or replace any themes/plugins that depend on it.",
          metadata: { files: ttFiles },
        },
      ),
    );
  }

  // 10. WordPress core file integrity — modified files outside wp-content indicate a breach
  const { stdout: coreModified } = await exec.execute(
    `find ${q(rootPath + "/wp-includes")} ${q(rootPath + "/wp-admin")} -name "*.php" -newer ${q(rootPath + "/wp-includes/version.php")} -type f 2>/dev/null | head -20 || true`,
    { timeout: 30000 },
  );
  const modifiedCore = coreModified
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (modifiedCore.length > 0) {
    findings.push(
      makeFinding(
        "critical",
        "SUSPICIOUS_FILES",
        `${modifiedCore.length} WordPress core PHP file(s) modified after initial install`,
        "WordPress core files in wp-includes or wp-admin should never be modified. Changes indicate tampering or backdoor injection.",
        {
          remediation:
            "Re-download WordPress core files and compare with official release. " +
            "Run: wp core verify-checksums --path=" +
            rootPath,
          metadata: { files: modifiedCore },
        },
      ),
    );
  }

  return findings;
}

// ─── PROJECT_MALWARE ────────────────────────────────────────────────────────

export async function runProjectMalware(
  exec: Executor,
  rootPath: string,
): Promise<SecurityFinding[]> {
  const findings: SecurityFinding[] = [];
  const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

  // 1. PHP files in uploads (always critical)
  const { stdout: phpInUploads } = await exec.execute(
    `find ${q(rootPath)} -path "*/uploads/*.php" -type f 2>/dev/null | head -20 || true`,
    { timeout: 30000 },
  );
  const phpFiles = phpInUploads
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (phpFiles.length > 0) {
    findings.push(
      makeFinding(
        "critical",
        "SUSPICIOUS_FILES",
        `${phpFiles.length} PHP file(s) in WordPress uploads directory`,
        "PHP files in /uploads/ are a definitive indicator of a webshell or injected malware.",
        {
          remediation:
            "Delete these files immediately. Block PHP execution in uploads via .htaccess.",
          metadata: { files: phpFiles },
        },
      ),
    );
  }

  // 2. Pattern-based malware scan scoped to this environment
  const patterns: {
    name: string;
    pattern: string;
    severity: "critical" | "high";
  }[] = [
    {
      name: "eval(base64_decode)",
      pattern: "eval(base64_decode",
      severity: "critical",
    },
    {
      name: "gzinflate eval chain",
      pattern: "gzinflate.*eval\\|eval.*gzinflate",
      severity: "critical",
    },
    {
      name: "c99/r57 webshell",
      pattern: "FilesMan\\|c99shell\\|r57shell",
      severity: "critical",
    },
    {
      name: "assert(base64_decode)",
      pattern: "assert.base64_decode",
      severity: "high",
    },
    {
      name: "POST execution",
      pattern: "\\$_POST.*eval\\|eval.*\\$_POST",
      severity: "high",
    },
  ];

  for (const { name, pattern, severity } of patterns) {
    const { stdout } = await exec.execute(
      `grep -rl "${pattern}" ${q(rootPath)} --include="*.php" 2>/dev/null | head -20 || true`,
      { timeout: 60000 },
    );
    const matched = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (matched.length > 0) {
      findings.push(
        makeFinding(
          severity,
          "MALWARE",
          `${name} pattern found in ${matched.length} file(s)`,
          `Suspicious PHP code pattern detected.`,
          {
            remediation:
              "Inspect these files. If malicious, delete them and trace how they appeared.",
            metadata: { files: matched },
          },
        ),
      );
    }
  }

  // 3. Recently modified PHP files (not in wp-admin / wp-includes)
  const { stdout: recentMod } = await exec.execute(
    `find ${q(rootPath)} -name "*.php" -mtime -7 -type f ` +
      `-not -path "*/wp-includes/*" -not -path "*/wp-admin/*" 2>/dev/null | head -50 || true`,
    { timeout: 30000 },
  );
  const recentFiles = recentMod
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (recentFiles.length > 15) {
    findings.push(
      makeFinding(
        "medium",
        "SUSPICIOUS_FILES",
        `${recentFiles.length} non-core PHP files modified in the last 7 days`,
        "Widespread recent modifications to PHP files outside wp-core may indicate a mass injection.",
        {
          remediation:
            "Compare against a clean deployment to identify injected code.",
          metadata: { files: recentFiles.slice(0, 30) },
        },
      ),
    );
  } else if (recentFiles.length > 0) {
    findings.push(
      makeFinding(
        "info",
        "SUSPICIOUS_FILES",
        `${recentFiles.length} non-core PHP file(s) modified recently`,
        "Review to confirm changes are expected (plugin updates, custom code, etc.).",
        { metadata: { files: recentFiles } },
      ),
    );
  }

  // 4. .htaccess injection scoped to this environment
  const { stdout: htaccessMatches } = await exec.execute(
    `find ${q(rootPath)} -name ".htaccess" -exec grep -lE "eval|base64_decode|RewriteRule.*https?://" {} \\; 2>/dev/null | head -10 || true`,
    { timeout: 30000 },
  );
  const htFiles = htaccessMatches
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (htFiles.length > 0) {
    findings.push(
      makeFinding(
        "critical",
        "HTACCESS",
        `Malicious .htaccess content detected in ${htFiles.length} file(s)`,
        ".htaccess files with eval/base64 or unauthorized rewrites indicate active malware injection.",
        {
          remediation:
            "Inspect each .htaccess file. Remove injected lines. Check for the source (compromised plugin or theme).",
          metadata: { files: htFiles },
        },
      ),
    );
  }

  // 5. PHP files in non-standard image directories (images/, img/, etc.)
  const { stdout: phpInImgDirs } = await exec.execute(
    `find ${q(rootPath)} -type f -name "*.php" \\( -path "*/images/*" -o -path "*/img/*" -o -path "*/thumbnails/*" \\) 2>/dev/null | head -15 || true`,
    { timeout: 20000 },
  );
  const imgPhpFiles = phpInImgDirs
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (imgPhpFiles.length > 0) {
    findings.push(
      makeFinding(
        "critical",
        "SUSPICIOUS_FILES",
        `${imgPhpFiles.length} PHP file(s) found in image directories`,
        "PHP scripts in image directories are a common webshell placement — attackers upload disguised PHP as images.",
        {
          remediation:
            "Delete these files. Add PHP execution denial to image directories via .htaccess: php_flag engine off",
          metadata: { files: imgPhpFiles },
        },
      ),
    );
  }

  // 6. Reverse shell patterns in project PHP files
  const reverseShellPatterns = [
    { name: "bash reverse shell (/dev/tcp)", pattern: "/dev/tcp/" },
    { name: "Python pty.spawn", pattern: "import pty.*spawn\\|pty\\.spawn" },
  ];
  for (const { name, pattern } of reverseShellPatterns) {
    const { stdout: rsMatches } = await exec.execute(
      `grep -rl "${pattern}" ${q(rootPath)} --include="*.php" 2>/dev/null | head -10 || true`,
      { timeout: 30000 },
    );
    const rsFiles = rsMatches
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (rsFiles.length > 0) {
      findings.push(
        makeFinding(
          "critical",
          "REVERSE_SHELL",
          `Reverse shell pattern detected: ${name}`,
          `Found ${rsFiles.length} PHP file(s) with reverse shell pattern — active backdoor indicator.`,
          {
            remediation:
              "Delete these files immediately. Rotate all server credentials. " +
              "Investigate attack vector (outdated plugin, weak FTP password, etc.)",
            metadata: { files: rsFiles },
          },
        ),
      );
    }
  }

  return findings;
}

// ─── BACKDOOR_SEARCH ────────────────────────────────────────────────────────

export async function runBackdoorSearch(
  exec: Executor,
  rootPath: string,
): Promise<SecurityFinding[]> {
  const findings: SecurityFinding[] = [];
  const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

  // 1. Search for suspicious file names in the entire root (common backdoor names)
  const suspiciousNames = [
    "shell.php",
    "cmd.php",
    "wp-log.php",
    "database.php", // common in uploads
    "wp-config-bak.php",
    ".user.php", // can override php.ini settings
    ".htaccess.bak",
    "uploader.php",
    "wso.php",
    "c99.php",
    "r57.php",
  ];
  const { stdout: foundSuspicious } = await exec.execute(
    `find ${q(rootPath)} -type f \\( ${suspiciousNames.map((n) => `-name "${n}"`).join(" -o ")} \\) 2>/dev/null | head -50 || true`,
    { timeout: 30000 },
  );
  const suspiciousFiles = foundSuspicious
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (suspiciousFiles.length > 0) {
    findings.push(
      makeFinding(
        "critical",
        "SUSPICIOUS_FILES",
        `${suspiciousFiles.length} file(s) with suspicious names detected`,
        "Files with names like shell.php or cmd.php are almost certainly backdoors.",
        {
          remediation: "Inspect and delete these files immediately.",
          metadata: { files: suspiciousFiles },
        },
      ),
    );
  }

  // 2. Search for PHP files starting with a dot (hidden PHP files)
  const { stdout: hiddenPhp } = await exec.execute(
    `find ${q(rootPath)} -type f -name ".*.php" 2>/dev/null | head -20 || true`,
    { timeout: 30000 },
  );
  const hiddenFiles = hiddenPhp
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (hiddenFiles.length > 0) {
    findings.push(
      makeFinding(
        "critical",
        "SUSPICIOUS_FILES",
        `${hiddenFiles.length} hidden PHP file(s) detected`,
        "Hidden PHP files (starting with a dot) are often used to hide backdoors.",
        {
          remediation: "Inspect and delete these files.",
          metadata: { files: hiddenFiles },
        },
      ),
    );
  }

  // 3. Advanced pattern matching (signatures of modern backdoors)
  const advancedPatterns = [
    {
      name: "Dynamic function call",
      pattern: "\\$\\w+\\s*\\(\\s*\\$_(POST|GET|REQUEST|COOKIE)",
      severity: "critical" as const,
    },
    {
      name: "Obfuscated eval (gzuncompress)",
      pattern: "eval\\s*\\(\\s*gzuncompress\\s*\\(",
      severity: "critical" as const,
    },
    {
      name: "Obfuscated eval (str_rot13)",
      pattern: "eval\\s*\\(\\s*str_rot13\\s*\\(",
      severity: "critical" as const,
    },
    {
      name: "Payload extraction",
      pattern: "extract\\s*\\(\\s*\\$_(POST|GET|REQUEST|COOKIE)",
      severity: "high" as const,
    },
    {
      name: "Inline hex/base64 blob",
      pattern: "[a-zA-Z0-9+/]{100,}", // Long strings of base64-like chars
      severity: "medium" as const,
    },
  ];

  for (const { name, pattern, severity } of advancedPatterns) {
    const { stdout } = await exec.execute(
      `grep -rlE "${pattern}" ${q(rootPath)} --include="*.php" --exclude-dir=node_modules --exclude-dir=vendor 2>/dev/null | head -20 || true`,
      { timeout: 60000 },
    );
    const matched = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (matched.length > 0) {
      findings.push(
        makeFinding(
          severity,
          "MALWARE",
          `${name} pattern detected in ${matched.length} file(s)`,
          `Signature of obfuscated or malicious code found.`,
          {
            remediation: "Manually audit these files for malicious content.",
            metadata: { files: matched },
          },
        ),
      );
    }
  }

  // 4. WP Core Integrity check (Deep)
  const { stdout: wpCliCheck } = await exec.execute(
    `which wp 2>/dev/null && echo found || echo missing`,
  );
  if (wpCliCheck.trim() === "found") {
    const { stdout: checksums, code } = await exec.execute(
      `wp core verify-checksums --path=${q(rootPath)} --format=json --skip-plugins 2>/dev/null || true`,
      { timeout: 60000 },
    );
    if (code !== 0 && checksums.trim()) {
      try {
        const failed = JSON.parse(checksums.trim()) as {
          file: string;
          message: string;
        }[];
        if (failed.length > 0) {
          findings.push(
            makeFinding(
              "critical",
              "SUSPICIOUS_FILES",
              `WordPress core integrity check failed for ${failed.length} file(s)`,
              "Modified core files are a strong indicator of a compromised site.",
              {
                remediation:
                  'Run "wp core download --force" to restore official core files.',
                metadata: { failed_files: failed },
              },
            ),
          );
        }
      } catch {
        // Parse error
      }
    }
  }

  return findings;
}

// ─── PLUGIN_AUDIT ───────────────────────────────────────────────────────────

export async function runPluginAudit(
  exec: Executor,
  rootPath: string,
): Promise<SecurityFinding[]> {
  const findings: SecurityFinding[] = [];
  const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

  // 1. WP-CLI Plugin List Audit
  const { stdout: wpCliCheck } = await exec.execute(
    `which wp 2>/dev/null && echo found || echo missing`,
  );

  let pluginsList: Array<{
    name: string;
    status: string;
    update: string;
    version: string;
  }> = [];

  if (wpCliCheck.trim() === "found") {
    const { stdout: pluginOut } = await exec.execute(
      `wp plugin list --path=${q(rootPath)} --format=json --skip-plugins --skip-themes 2>/dev/null || true`,
      { timeout: 30000 },
    );
    try {
      if (pluginOut.trim().startsWith("[")) {
        pluginsList = JSON.parse(pluginOut.trim());
      }
    } catch {
      // JSON parse error
    }
  }

  // 2. Inactive Plugins Check (Attack surface hygiene)
  const inactivePlugins = pluginsList.filter((p) => p.status === "inactive");
  if (inactivePlugins.length > 0) {
    findings.push(
      makeFinding(
        "low",
        "INACTIVE_PLUGINS",
        `${inactivePlugins.length} inactive plugin(s) found`,
        "Inactive plugins still pose a security risk if they contain known vulnerabilities, as PHP files inside plugin folders can often still be executed directly via HTTP.",
        {
          remediation:
            "Delete unused and inactive plugins to minimize attack surface: wp plugin delete <slug>",
          metadata: {
            inactive_plugins: inactivePlugins.map((p) => `${p.name} (${p.version})`),
          },
        },
      ),
    );
  }

  // 3. Outdated Plugins Check
  const outdatedPlugins = pluginsList.filter((p) => p.update === "available");
  if (outdatedPlugins.length > 0) {
    findings.push(
      makeFinding(
        "medium",
        "VULNERABLE_PLUGINS",
        `${outdatedPlugins.length} plugin(s) have pending security/feature updates`,
        "Outdated WordPress plugins are the most frequent entry point for automated exploits and website compromise.",
        {
          remediation:
            'Update all plugins to their latest versions: wp plugin update --all',
          metadata: {
            outdated_plugins: outdatedPlugins.map((p) => `${p.name} (${p.version})`),
          },
        },
      ),
    );
  }

  // 4. Plugin Checksum Verification (Tampering / Malware Injection in Plugins)
  if (wpCliCheck.trim() === "found") {
    const { stdout: checksumOut, code } = await exec.execute(
      `wp plugin verify-checksums --all --path=${q(rootPath)} --format=json --skip-plugins --skip-themes 2>/dev/null || true`,
      { timeout: 60000 },
    );
    if (code !== 0 && checksumOut.trim().startsWith("[")) {
      try {
        const failedPlugins = JSON.parse(checksumOut.trim()) as Array<{
          plugin_name: string;
          file: string;
          message: string;
        }>;
        if (failedPlugins.length > 0) {
          findings.push(
            makeFinding(
              "critical",
              "VULNERABLE_PLUGINS",
              `Plugin file integrity verification failed for ${failedPlugins.length} file(s)`,
              "Files inside official wordpress.org plugins were modified or added. This strongly indicates plugin tampering, injection, or malware infection.",
              {
                remediation:
                  "Reinstall the affected plugins from clean official sources using 'wp plugin install <name> --force'.",
                metadata: { modified_files: failedPlugins.slice(0, 25) },
              },
            ),
          );
        }
      } catch {
        // Parse error
      }
    }
  }

  // 5. Must-Use Plugins (mu-plugins) Audit
  const muDirs = [
    `${rootPath}/wp-content/mu-plugins`,
    `${rootPath}/web/app/mu-plugins`,
  ];
  for (const muDir of muDirs) {
    const { stdout: muFiles } = await exec.execute(
      `test -d ${q(muDir)} && find ${q(muDir)} -maxdepth 2 -type f -name "*.php" 2>/dev/null || true`,
      { timeout: 15000 },
    );
    const files = muFiles.split("\n").map((f) => f.trim()).filter(Boolean);
    if (files.length > 0) {
      // Look for suspicious obfuscation in mu-plugins
      const { stdout: evalInMu } = await exec.execute(
        `grep -rnE '(eval\\s*\\(|base64_decode|gzuncompress|assert\\s*\\()' ${q(muDir)} 2>/dev/null | head -10 || true`,
        { timeout: 15000 },
      );
      if (evalInMu.trim()) {
        findings.push(
          makeFinding(
            "critical",
            "SUSPICIOUS_FILES",
            `Suspicious obfuscated code pattern detected in mu-plugins`,
            "Must-Use plugins run automatically on every request with highest privilege. Found eval/base64/gzuncompress calls.",
            {
              remediation: `Inspect files in ${muDir} and remove any unrecognized or obfuscated PHP scripts.`,
              resource: muDir,
              metadata: { suspicious_lines: evalInMu.split("\n").filter(Boolean) },
            },
          ),
        );
      }
    }
  }

  // 6. Bedrock Forge Official Security Plugin: Secure Guard (garamahq/wp-secure-guard)
  const secureGuardPlugin = pluginsList.find(
    (p) =>
      p.name === "wp-secure-guard" ||
      p.name === "secure-guard" ||
      p.name.includes("secure-guard"),
  );

  if (!secureGuardPlugin || secureGuardPlugin.status !== "active") {
    findings.push(
      makeFinding(
        "medium",
        "SECURE_GUARD",
        "Forge default security plugin (wp-secure-guard) is not active",
        "Secure Guard provides zero-trust REST API protection, JWT rate limiting, and tamper watchdog for Bedrock Forge environments.",
        {
          remediation:
            "Install and activate garamahq/wp-secure-guard via the Forge Security tab.",
          resource: "wp-secure-guard",
          metadata: {
            installed: !!secureGuardPlugin,
            status: secureGuardPlugin?.status ?? "not_installed",
          },
        },
      ),
    );
  } else {
    // Check Watchdog MU-plugin deployment
    let watchdogFound = false;
    for (const muDir of muDirs) {
      const { stdout: wdCheck } = await exec.execute(
        `test -f ${q(muDir + "/secure-guard-watchdog.php")} && echo found || echo missing`,
      );
      if (wdCheck.trim() === "found") {
        watchdogFound = true;
        break;
      }
    }

    if (!watchdogFound) {
      findings.push(
        makeFinding(
          "low",
          "SECURE_GUARD",
          "Secure Guard Watchdog MU-plugin is not deployed",
          "The Watchdog MU-plugin enables early boot tamper detection and emergency lockdown enforcement before standard plugins execute.",
          {
            remediation:
              "Deploy the Watchdog MU-plugin using the Forge Security dashboard.",
            resource: "secure-guard-watchdog.php",
          },
        ),
      );
    }
  }

  return findings;
}
