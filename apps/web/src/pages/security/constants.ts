import type { Severity } from "./types";

export const SEVERITY_LEVELS: Severity[] = [
  "critical",
  "high",
  "medium",
  "low",
  "info",
];

export const SCAN_TYPE_LABELS: Record<string, string> = {
  SSH_AUDIT: "SSH Audit",
  SERVER_HARDENING: "Server Hardening",
  MALWARE_SCAN: "Malware Scan",
  SYSTEM_AUDIT: "System Health Audit",
  PROCESS_AUDIT: "Process & Stealth Audit",
  NETWORK_AUDIT: "Network & Port Audit",
  FILESYSTEM_AUDIT: "Filesystem & Backup Audit",
  SERVICE_AUDIT: "Systemd Services Audit",
  CYBERPANEL_AUDIT: "CyberPanel Posture Audit",
  PHP_AUDIT: "PHP Security Config Audit",
  WP_AUDIT: "WP Audit",
  PROJECT_MALWARE: "Project Malware",
  BACKDOOR_SEARCH: "Backdoor Search",
  PLUGIN_AUDIT: "Plugin Audit",
};

export const SCAN_TYPE_DESCRIPTIONS: Record<string, string> = {
  SSH_AUDIT: "Review SSH configuration, auth logs, and brute-force signals.",
  SERVER_HARDENING: "Check server hardening posture and risky permissions.",
  MALWARE_SCAN: "Search common server paths for suspicious files and webshells.",
  SYSTEM_AUDIT: "Inspect OS version, pending kernel updates, disk, inode, memory and NTP.",
  PROCESS_AUDIT: "Detect deleted-running executables (/proc/*/exe), web shells, and CPU spikes.",
  NETWORK_AUDIT: "Scan listening ports, exposed databases (0.0.0.0), and insecure services.",
  FILESYSTEM_AUDIT: "Scan for exposed database dumps, sensitive world-writable files, and SUID binaries.",
  SERVICE_AUDIT: "Audit systemd services for anomalous binary locations and failed units.",
  CYBERPANEL_AUDIT: "Inspect CyberPanel management version, LiteSpeed status, and port 8090.",
  PHP_AUDIT: "Audit all installed PHP versions for dangerous allow_url_include and exposed settings.",
  WP_AUDIT: "Check WordPress users, core, config, and baseline posture.",
  PROJECT_MALWARE: "Search the WordPress tree for suspicious code patterns.",
  BACKDOOR_SEARCH: "Look for common PHP backdoor signatures and obfuscation.",
  PLUGIN_AUDIT: "Review plugin versions and known risky plugin signals.",
};

export const SCAN_FINDINGS_INITIAL_LIMIT = 3;

export const SCAN_TYPES_BY_KIND = {
  server: [
    "SSH_AUDIT",
    "SERVER_HARDENING",
    "MALWARE_SCAN",
    "SYSTEM_AUDIT",
    "PROCESS_AUDIT",
    "NETWORK_AUDIT",
    "FILESYSTEM_AUDIT",
    "SERVICE_AUDIT",
    "CYBERPANEL_AUDIT",
    "PHP_AUDIT",
  ],
  environment: [
    "WP_AUDIT",
    "PROJECT_MALWARE",
    "BACKDOOR_SEARCH",
    "PLUGIN_AUDIT",
  ],
} as const;

export const SERVER_HARDENING_ACTIONS = [
  {
    id: "FIX_WORLD_WRITABLE",
    label: "Fix world-writable files",
    description: "Remove world-writable permissions from files in public_html",
  },
  {
    id: "DISABLE_X11_FORWARDING",
    label: "Disable X11 forwarding",
    description: "Set X11Forwarding no in /etc/ssh/sshd_config",
  },
  {
    id: "SET_MAX_AUTH_TRIES",
    label: "Limit SSH auth tries",
    description: "Set MaxAuthTries 3 in /etc/ssh/sshd_config",
  },
  {
    id: "FIX_SSH_DIR_PERMS",
    label: "Fix .ssh directory permissions",
    description: "Set chmod 700 on /root/.ssh and all /home/*/.ssh",
  },
  {
    id: "INSTALL_FAIL2BAN",
    label: "Install / start fail2ban",
    description: "Install fail2ban and enable it to dynamically auto-ban brute-force IPs",
  },
  {
    id: "RESTRICT_INTERNAL_PORTS",
    label: "Restrict internal database / cache ports",
    description:
      "Bind MySQL (3306), Redis (6379), and Memcached (11211) to localhost (127.0.0.1) and deny external access in firewall",
  },
  {
    id: "CLEAN_HTACCESS_REDIRECTS",
    label: "Clean suspicious .htaccess redirects",
    description:
      "Remove hardcoded external-domain RewriteRule lines from .htaccess files",
  },
  {
    id: "QUARANTINE_MALWARE",
    label: "Quarantine malware files",
    description:
      "Move detected malware and suspicious files to a secure quarantine directory (/var/lib/bedrock-forge/quarantine)",
  },
] as const;

export const ENVIRONMENT_HARDENING_ACTIONS = [
  {
    id: "BLOCK_PHP_UPLOADS",
    label: "Block PHP in uploads",
    description: "Deny PHP execution in uploads directories via .htaccess",
    group: "recommended",
    risk: "safe",
    preview:
      "Writes an uploads .htaccess rule that denies PHP/PHTML execution while preserving normal media access.",
  },
  {
    id: "BLOCK_XMLRPC",
    label: "Block XML-RPC",
    description: "Deny access to xmlrpc.php via .htaccess",
    group: "recommended",
    risk: "safe",
    preview:
      "Adds an xmlrpc.php deny rule to reduce brute-force and amplification traffic.",
  },
  {
    id: "BLOCK_VERSION_DISCLOSURE",
    label: "Hide WordPress version",
    description: "Deny readme.html, license.txt, readme.txt via .htaccess",
    group: "recommended",
    risk: "safe",
    preview:
      "Blocks public WordPress metadata files that reveal version or installation details.",
  },
  {
    id: "ADD_SECURITY_HEADERS",
    label: "Add security headers",
    description: "Add X-Frame-Options, X-Content-Type-Options, CSP headers",
    group: "recommended",
    risk: "safe",
    preview:
      "Adds baseline browser security headers. Review custom iframe or CSP needs after applying.",
  },
  {
    id: "DISABLE_DIRECTORY_LISTING",
    label: "Disable directory listing",
    description: "Add Options -Indexes to .htaccess",
    group: "recommended",
    risk: "safe",
    preview:
      "Adds Options -Indexes to prevent visitors browsing directory contents.",
  },
  {
    id: "CLEAN_HTACCESS_REDIRECTS",
    label: "Clean suspicious .htaccess redirects",
    description:
      "Remove hardcoded external-domain RewriteRule lines from .htaccess",
    group: "incident",
    risk: "review",
    preview:
      "Removes suspicious external RewriteRule redirects from .htaccess. Review if the site intentionally proxies external URLs.",
  },
  {
    id: "BLOCK_DEBUG_LOG",
    label: "Block debug log access",
    description:
      "Deny HTTP access to .log files (e.g. wp-content/debug.log) via .htaccess",
    group: "recommended",
    risk: "safe",
    preview:
      "Blocks public log files and removes common debug.log files from wp-content.",
  },
  {
    id: "BLOCK_SENSITIVE_FILES",
    label: "Block sensitive file access",
    description:
      "Deny access to .env, *.bak, *.sql, composer.json/lock, package.json, etc. via .htaccess",
    group: "recommended",
    risk: "safe",
    preview:
      "Safely blocks secrets, backups, and package metadata without interfering with legitimate plugin endpoints.",
  },
  {
    id: "DISABLE_FILE_EDITOR",
    label: "Disable wp-admin file editor",
    description:
      "Add WP_DISALLOW_FILE_EDIT=true to wp-config.php to block the theme/plugin code editor",
    group: "recommended",
    risk: "safe",
    preview:
      "Adds WP_DISALLOW_FILE_EDIT to WordPress config so admins cannot edit PHP files from wp-admin.",
  },
  {
    id: "BLOCK_USER_ENUMERATION",
    label: "Block user enumeration",
    description:
      "Redirect ?author=N queries via .htaccess to prevent WordPress username disclosure",
    group: "recommended",
    risk: "safe",
    preview:
      "Adds a rewrite guard to stop ?author=N username discovery redirects.",
  },
  {
    id: "QUARANTINE_MALWARE",
    label: "Quarantine malware files",
    description:
      "Move detected malware and suspicious files to a secure quarantine directory (/var/lib/bedrock-forge/quarantine)",
    group: "cleanup",
    risk: "risky",
    risky: true,
    defaultSelected: false,
    preview:
      "Moves detected malware and suspicious files from this environment to /var/lib/bedrock-forge/quarantine/.",
  },
] as const;

export const HARDENING_ACTION_GROUP_LABELS: Record<string, string> = {
  recommended: "Recommended safe protections",
  cleanup: "Cleanup actions",
  incident: "Incident response",
};

export const DEFAULT_ENVIRONMENT_HARDENING_ACTION_IDS =
  ENVIRONMENT_HARDENING_ACTIONS.filter(
    (action) =>
      !("defaultSelected" in action) || action.defaultSelected !== false,
  ).map((action) => action.id);

const DEFAULT_SAFE_HARDENING_ACTION_IDS =
  DEFAULT_ENVIRONMENT_HARDENING_ACTION_IDS;

export const HARDENING_PRESETS = [
  {
    id: "safe-hardening",
    label: "Safe hardening",
    description: "Apply low-risk web-root and WordPress protection rules.",
    actions: DEFAULT_SAFE_HARDENING_ACTION_IDS,
  },
  {
    id: "bedrock-app-shield",
    label: "Bedrock app shield",
    description: "Focus on direct app-path, secret, log, and upload exposure.",
    actions: [
      "BLOCK_PHP_UPLOADS",
      "BLOCK_DEBUG_LOG",
      "BLOCK_SENSITIVE_FILES",
      "DISABLE_DIRECTORY_LISTING",
    ],
  },
  {
    id: "incident-response",
    label: "Incident response",
    description: "Add safe guards and include suspicious redirect cleanup.",
    actions: [...DEFAULT_SAFE_HARDENING_ACTION_IDS, "CLEAN_HTACCESS_REDIRECTS"],
  },
] as const;

export const RISKY_ENVIRONMENT_HARDENING_ACTION_IDS =
  ENVIRONMENT_HARDENING_ACTIONS.filter(
    (action) => "risky" in action && action.risky,
  ).map((action) => action.id);

export function isRiskyEnvironmentHardeningAction(id: string): boolean {
  return RISKY_ENVIRONMENT_HARDENING_ACTION_IDS.includes(
    id as (typeof RISKY_ENVIRONMENT_HARDENING_ACTION_IDS)[number],
  );
}
