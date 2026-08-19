// ─── Security Finding Types ───────────────────────────────────────────────────

export type SecuritySeverity = "critical" | "high" | "medium" | "low" | "info";

export type SecurityFindingStatus =
  | "new"
  | "investigating"
  | "acknowledged"
  | "remediated"
  | "resolved"
  | "ignored"
  | "false_positive";

export type SecurityFindingCategory =
  | "SSH_CONFIG"
  | "AUTHORIZED_KEYS"
  | "FAILED_LOGINS"
  | "SUCCESSFUL_LOGINS"
  | "MALWARE"
  | "OPEN_PORTS"
  | "WP_CONFIG"
  | "WP_USERS"
  | "FILE_PERMISSIONS"
  | "PHP_CONFIG"
  | "SUSPICIOUS_FILES"
  | "OS_UPDATES"
  | "FIREWALL"
  | "CRON_JOBS"
  | "WORLD_WRITABLE"
  | "SUID_BINARIES"
  | "HTACCESS"
  | "VERSION_DISCLOSURE"
  | "REVERSE_SHELL"
  | "SECURITY_TOOLS"
  | "PROCESS_ANOMALY"
  | "DELETED_EXECUTABLE"
  | "LISTENING_PORTS"
  | "FAIL2BAN"
  | "USERS"
  | "SERVICES"
  | "CYBERPANEL"
  | "MALWARE_INDICATORS"
  | "SYSTEM_HEALTH"
  | "EXPOSED_BACKUPS"
  | "WORDPRESS_CORE"
  | "INACTIVE_PLUGINS"
  | "VULNERABLE_PLUGINS"
  | "ABANDONED_PLUGINS"
  | "INACTIVE_THEMES"
  | "CONFIG_DRIFT"
  | "BASE_DRIFT"
  | "INCIDENT";

export interface SecurityFinding {
  id: string;
  severity: SecuritySeverity;
  category: SecurityFindingCategory;
  title: string;
  description: string;
  remediation?: string;
  resource?: string;
  metadata?: Record<string, unknown>;
  remediation_available?: boolean;
  remediation_type?: string;
  remediation_meta?: Record<string, unknown>;
}

export interface SecurityFindingRecord {
  id: number;
  scan_id?: number | null;
  server_id?: number | null;
  environment_id?: number | null;
  incident_id?: number | null;
  category: SecurityFindingCategory;
  severity: SecuritySeverity;
  status: SecurityFindingStatus;
  title: string;
  description: string;
  evidence?: unknown;
  resource?: string | null;
  recommendation?: string | null;
  remediation_available: boolean;
  remediation_type?: string | null;
  remediation_meta?: Record<string, unknown> | null;
  first_seen_at: string;
  last_seen_at: string;
  resolved_at?: string | null;
  scanner_version?: string | null;
  dedup_key?: string | null;
  created_at: string;
  updated_at: string;
  server?: { id: number; name: string; ip_address: string } | null;
  environment?: { id: number; type: string; url: string; project?: { id: number; name: string } } | null;
  transitions?: SecurityFindingTransitionRecord[];
}

export interface SecurityFindingTransitionRecord {
  id: number;
  finding_id: number;
  from_status: SecurityFindingStatus | null;
  to_status: SecurityFindingStatus;
  actor_id?: number | null;
  actor?: { id: number; name: string; email: string } | null;
  note?: string | null;
  created_at: string;
}

export type SecurityScanSummary = Record<SecuritySeverity, number>;

// ─── Job Payload Types ────────────────────────────────────────────────────────

export interface SecurityServerScanPayload {
  serverId: number;
  scanTypes: SecurityScanType[];
  jobExecutionId: number;
  scanIds: number[]; // one SecurityScan row per scan_type, pre-created
}

export interface SecurityEnvironmentScanPayload {
  environmentId: number;
  scanTypes: SecurityScanType[];
  jobExecutionId: number;
  scanIds: number[];
}

export type SecurityScanType =
  | "SSH_AUDIT"
  | "SERVER_HARDENING"
  | "MALWARE_SCAN"
  | "WP_AUDIT"
  | "PROJECT_MALWARE"
  | "BACKDOOR_SEARCH"
  | "PLUGIN_AUDIT"
  | "SYSTEM_AUDIT"
  | "PROCESS_AUDIT"
  | "NETWORK_AUDIT"
  | "FILESYSTEM_AUDIT"
  | "SERVICE_AUDIT"
  | "CYBERPANEL_AUDIT"
  | "PHP_AUDIT";

export const SERVER_SCAN_TYPES: SecurityScanType[] = [
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
];

export const ENVIRONMENT_SCAN_TYPES: SecurityScanType[] = [
  "WP_AUDIT",
  "PROJECT_MALWARE",
  "BACKDOOR_SEARCH",
  "PLUGIN_AUDIT",
];
// ─── Schedule Types ──────────────────────────────────────────────────────────

export type SecurityScheduleFrequency = "daily" | "weekly" | "monthly";

export interface SecurityScanSchedule {
  id: number;
  server_id?: number | null;
  environment_id?: number | null;
  scan_types: SecurityScanType[];
  frequency: SecurityScheduleFrequency;
  hour: number;
  minute: number;
  day_of_week?: number | null;
  day_of_month?: number | null;
  enabled: boolean;
  last_run_at?: string | null;
  notify_enabled: boolean;
  notify_threshold: SecuritySeverity;
  created_at: string;
  updated_at: string;
}

export interface SecurityScheduledScanPayload {
  scheduleId: number;
  serverId?: number;
  environmentId?: number;
  scanTypes: SecurityScanType[];
  notifyEnabled: boolean;
  notifyThreshold: SecuritySeverity;
}

// ─── Hardening Action Types ───────────────────────────────────────────────────

/**
 * Server-scoped hardening actions.
 * Each action is idempotent — running it twice produces `skipped` on the
 * second run if the fix is already in place.
 */
export type ServerHardeningActionType =
  | "FIX_WORLD_WRITABLE" // chmod o-w all world-writable files in /home
  | "DISABLE_X11_FORWARDING" // sshd_config X11Forwarding no + reload
  | "SET_MAX_AUTH_TRIES" // sshd_config MaxAuthTries 3 + reload
  | "FIX_SSH_DIR_PERMS" // chmod 700 /root/.ssh + all /home/*/.ssh
  | "DISABLE_PASSWORD_AUTH" // sshd_config PasswordAuthentication no + reload
  | "INSTALL_FAIL2BAN" // apt install (if missing) + systemctl enable/start
  | "INSTALL_AUDITD" // apt install (if missing) + systemctl enable/start
  | "BLOCK_BRUTE_FORCE_IPS" // detect IPs ≥50 failed logins → ufw deny each
  | "DELETE_PHP_UPLOAD_FILES" // rm PHP files in /home/*/public_html/*/uploads/
  | "CLEAN_HTACCESS_REDIRECTS" // remove hardcoded external-domain RewriteRule lines
  | "QUARANTINE_MALWARE"; // move detected malware files to a quarantine directory

/**
 * Environment-scoped (WordPress) hardening actions.
 * Resolves web root automatically for both standard WP and Bedrock layouts.
 */
export type EnvironmentHardeningActionType =
  | "BLOCK_PHP_UPLOADS" // add deny-php rule to wp-content/uploads/.htaccess
  | "BLOCK_XMLRPC" // deny xmlrpc.php via .htaccess
  | "BLOCK_VERSION_DISCLOSURE" // deny readme.html, license.txt, readme.txt
  | "ADD_SECURITY_HEADERS" // X-Frame-Options, X-Content-Type-Options, XSS
  | "DISABLE_DIRECTORY_LISTING" // Options -Indexes
  | "DELETE_PHP_UPLOAD_FILES" // rm PHP files from wp-content/uploads/
  | "CLEAN_HTACCESS_REDIRECTS" // remove external-domain RewriteRule lines
  | "BLOCK_DEBUG_LOG" // deny HTTP access to *.log files (debug.log) via .htaccess
  | "BLOCK_SENSITIVE_FILES" // deny .env, *.bak, *.sql, composer files via .htaccess
  | "DISABLE_FILE_EDITOR" // add WP_DISALLOW_FILE_EDIT=true to wp-config.php
  | "BLOCK_USER_ENUMERATION" // redirect ?author=N queries to block username enumeration
  | "FORCE_REINSTALL_CORE" // wp core download --force
  | "UPDATE_ALL_PLUGINS" // wp plugin update --all
  | "QUARANTINE_MALWARE"; // move detected malware files to a quarantine directory

export const SERVER_HARDENING_ACTION_TYPES: ServerHardeningActionType[] = [
  "FIX_WORLD_WRITABLE",
  "DISABLE_X11_FORWARDING",
  "SET_MAX_AUTH_TRIES",
  "FIX_SSH_DIR_PERMS",
  "INSTALL_FAIL2BAN",
  "CLEAN_HTACCESS_REDIRECTS",
  "QUARANTINE_MALWARE",
];

export const ENVIRONMENT_HARDENING_ACTION_TYPES: EnvironmentHardeningActionType[] =
  [
    "BLOCK_PHP_UPLOADS",
    "BLOCK_XMLRPC",
    "BLOCK_VERSION_DISCLOSURE",
    "ADD_SECURITY_HEADERS",
    "DISABLE_DIRECTORY_LISTING",
    "CLEAN_HTACCESS_REDIRECTS",
    "BLOCK_DEBUG_LOG",
    "BLOCK_SENSITIVE_FILES",
    "DISABLE_FILE_EDITOR",
    "BLOCK_USER_ENUMERATION",
    "QUARANTINE_MALWARE",
  ];

export interface HardeningActionResult {
  action: string;
  /** applied = change made; skipped = already in desired state; failed = error */
  status: "applied" | "skipped" | "failed";
  detail: string;
}

export interface SecurityServerHardeningPayload {
  serverId: number;
  jobExecutionId: number;
  actions: ServerHardeningActionType[];
}

export interface SecurityEnvironmentHardeningPayload {
  environmentId: number;
  jobExecutionId: number;
  actions: EnvironmentHardeningActionType[];
}

export interface SecurityBaselineItemRecord {
  id: number;
  baseline_id: number;
  category: string;
  key: string;
  value: unknown;
  created_at: string;
}

export interface SecurityBaselineRecord {
  id: number;
  server_id?: number | null;
  environment_id?: number | null;
  label?: string | null;
  created_by_id?: number | null;
  created_at: string;
  items?: SecurityBaselineItemRecord[];
}

export interface SecurityDriftEventRecord {
  id: number;
  server_id?: number | null;
  environment_id?: number | null;
  baseline_id: number;
  category: string;
  key: string;
  change_type: "added" | "removed" | "modified" | "permission_changed" | "owner_changed";
  old_value?: unknown;
  new_value?: unknown;
  detected_at: string;
  finding_id?: number | null;
}

export type SecurityIncidentStatus =
  | "open"
  | "investigating"
  | "contained"
  | "resolved"
  | "false_positive";

export interface SecurityIncidentRecord {
  id: number;
  server_id?: number | null;
  title: string;
  summary?: string | null;
  severity: SecuritySeverity;
  status: SecurityIncidentStatus;
  confidence: string;
  detected_at: string;
  resolved_at?: string | null;
  created_at: string;
  updated_at: string;
  server?: { id: number; name: string } | null;
  findings?: SecurityFindingRecord[];
}

export interface SecurityAlertRuleRecord {
  id: number;
  name: string;
  enabled: boolean;
  min_severity?: SecuritySeverity | null;
  categories: string[];
  server_ids: number[];
  channel_ids: number[];
  create_incident: boolean;
  cooldown_minutes: number;
  last_fired_at?: string | null;
  created_at: string;
  updated_at: string;
}

export type SecurityWatcherMode = "agentless" | "agent";
export type SecurityWatcherStatus = "online" | "degraded" | "offline" | "disabled";

export interface SecurityWatcherRecord {
  id: number;
  server_id: number;
  enabled: boolean;
  mode: SecurityWatcherMode;
  status: SecurityWatcherStatus;
  interval_minutes: number;
  last_heartbeat?: string | null;
  last_event_at?: string | null;
  collector_version?: string | null;
  watcher_errors: string[];
  watch_processes: boolean;
  watch_files: boolean;
  watch_auth: boolean;
  watch_services: boolean;
  watch_cron: boolean;
  watch_wordpress: boolean;
  extra_watch_paths: string[];
  excluded_paths: string[];
  created_at: string;
  updated_at: string;
  server?: { id: number; name: string; ip_address: string; status: string } | null;
}
