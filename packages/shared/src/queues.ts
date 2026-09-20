// ─── Queue Names ───────────────────────────────────────────────────────────────

export const QUEUES = {
  BACKUPS: "backups",
  PLUGIN_SCANS: "plugin-scans",
  PLUGIN_UPDATES: "plugin-updates",
  CUSTOM_PLUGINS: "custom-plugins",
  THEME_SCANS: "theme-scans",
  SYNC: "sync",
  MONITORS: "monitors",
  DOMAINS: "domains",
  PROJECTS: "projects",
  NOTIFICATIONS: "notifications",
  REPORTS: "reports",
  WP_ACTIONS: "wp-actions",
  SYSTEM_BACKUPS: "system-backups",
  SECURITY: "security",
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

// NOTE: BullMQ does not use separate queue names for dead-lettered jobs —
// failed jobs are accessible via queue.getFailed(). The DLQ pattern here
// would require custom consumer code; until that is implemented these names
// are removed to prevent misleading dead references in the codebase.
// ─── Job Types ────────────────────────────────────────────────────────────────

export const JOB_TYPES = {
  // Backups
  BACKUP_CREATE: "backup:create",
  BACKUP_RESTORE: "backup:restore",
  BACKUP_SCHEDULED: "backup:scheduled",
  BACKUP_DELETE_FILE: "backup:delete-file",

  // Plugin scans
  PLUGIN_SCAN_RUN: "plugin-scan:run",
  PLUGIN_MANAGE: "plugin:manage",
  PLUGIN_SCHEDULED_UPDATE: "plugin:scheduled-update",

  // Custom GitHub plugins
  CUSTOM_PLUGIN_MANAGE: "custom-plugin:manage",

  // Sync
  SYNC_CLONE: "sync:clone",
  SYNC_PUSH: "sync:push",

  // Monitors
  MONITOR_CHECK: "monitor:check",
  LIGHTHOUSE_AUDIT: "lighthouse:audit",

  // Domains
  DOMAIN_WHOIS: "domain:whois",
  DOMAIN_SSL_CHECK: "domain:ssl-check",

  // Projects
  PROJECT_CREATE_BEDROCK: "project:create-bedrock",
  PROJECT_ARCHIVE: "project:archive",
  PROJECT_RESTORE: "project:restore",
  PROJECT_GIT_DEPLOY: "project:git-deploy",
  ENVIRONMENT_DECOMMISSION: "environment:decommission",

  // Notifications
  NOTIFICATION_SEND: "notification:send",

  // Reports
  REPORT_GENERATE: "report:generate",

  // WP Actions
  WP_FIX_ACTION: "wp:fix-action",
  WP_DEBUG_TOGGLE: "wp:debug-toggle",
  WP_DEBUG_REVERT: "wp:debug-revert",
  WP_LOGS_FETCH: "wp:logs-fetch",
  WP_CRON_LIST: "wp:cron-list",
  WP_CLEANUP: "wp:cleanup",
  WP_CORE_CHECK: "wp:core-check",
  WP_CORE_UPDATE: "wp:core-update",
  WP_MAINTENANCE_MODE: "wp:maintenance-mode",
  WP_SECURE_GUARD_INSTALL: "wp:secure-guard-install",
  WP_SECURE_GUARD_WATCHDOG: "wp:secure-guard-watchdog",

  // Theme scans
  THEME_SCAN_RUN: "theme-scan:run",
  THEME_MANAGE: "theme:manage",

  // System (Forge self-backup)
  SYSTEM_BACKUP_CREATE: "system-backup:create",
  SYSTEM_BACKUP_SCHEDULED: "system-backup:scheduled",

  // Security
  SECURITY_SERVER_SCAN: "security:server-scan",
  SECURITY_ENVIRONMENT_SCAN: "security:environment-scan",
  SECURITY_SCHEDULED_SCAN: "security:scheduled-scan",
  SECURITY_REPORT_GENERATE: "security:report-generate",
  SECURITY_SERVER_HARDEN: "security:server-harden",
  SECURITY_ENVIRONMENT_HARDEN: "security:environment-harden",
  SECURITY_ATTACK_WATCH: "security:attack-watch",
  SECURITY_ALERT_POLL: "security:alert-poll",
  SECURITY_DATA_RETENTION: "security:data-retention",
  SECURITY_BASELINE_CREATE: "security:baseline-create",
  SECURITY_BASELINE_COMPARE: "security:baseline-compare",
  SECURITY_WATCH_COLLECT: "security:watch-collect",
  SECURITY_INCIDENT_CORRELATE: "security:incident-correlate",
} as const;

// ─── Default Job Options ──────────────────────────────────────────────────────

export const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 1000 },
  removeOnComplete: 1000,
  removeOnFail: 5000,
} as const;

export const BACKUP_JOB_OPTIONS = {
  ...DEFAULT_JOB_OPTIONS,
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 300_000 }, // 5 min initial
  // 30 min timeout handled in processor
} as const;

export const SYNC_JOB_OPTIONS = {
  ...DEFAULT_JOB_OPTIONS,
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 300_000 }, // 5 min initial
} as const;

// ─── WebSocket Events ─────────────────────────────────────────────────────────

export const WS_EVENTS = {
  JOB_PROGRESS: "job:progress",
  JOB_COMPLETED: "job:completed",
  JOB_FAILED: "job:failed",
  JOB_LOG: "job:log",
  MONITOR_RESULT: "monitor:result",
  NOTIFICATION_NEW: "notification:new",
} as const;

export type WsEvent = (typeof WS_EVENTS)[keyof typeof WS_EVENTS];
