import { z } from "zod";

// ─── Shared Domain Types ─────────────────────────────────────────────────────

/**
 * WordPress database credentials extracted from wp-config.php or .env files.
 * Used by CredentialParserService and callers in both api and worker.
 */
export interface WpDbCredentials {
  dbName: string;
  dbUser: string;
  dbPassword: string;
  dbHost: string;
}

// ─── Job Payload Types ────────────────────────────────────────────────────────
// These schemas describe exactly what is enqueued — workers fetch server/path
// details from Prisma directly, so payloads are minimal (IDs + type only).

export const BackupCreatePayloadSchema = z.object({
  environmentId: z.number().int().positive(),
  type: z.enum(["full", "db_only", "files_only", "incremental"]),
  jobExecutionId: z.number().int().positive(),
  backupId: z.number().int().positive(),
});
export type BackupCreatePayload = z.infer<typeof BackupCreatePayloadSchema>;

export const BackupRestorePayloadSchema = z.object({
  backupId: z.number().int().positive(),
  environmentId: z.number().int().positive(),
  jobExecutionId: z.number().int().positive(),
});
export type BackupRestorePayload = z.infer<typeof BackupRestorePayloadSchema>;

export const BackupDeleteFilePayloadSchema = z.object({
  filePath: z.string().min(1),
});
export type BackupDeleteFilePayload = z.infer<
  typeof BackupDeleteFilePayloadSchema
>;

export const BackupScheduledPayloadSchema = z.object({
  scheduleId: z.number().int().positive(),
  environmentId: z.number().int().positive(),
  type: z.enum(["full", "db_only", "files_only", "incremental"]),
});
export type BackupScheduledPayload = z.infer<
  typeof BackupScheduledPayloadSchema
>;

// ─── BackupSchedule Domain Types ─────────────────────────────────────────────

export type BackupFrequency = "daily" | "weekly" | "monthly";

export interface BackupSchedule {
  id: number;
  environment_id: number;
  type: "full" | "db_only" | "files_only" | "incremental";
  frequency: BackupFrequency;
  hour: number;
  minute: number;
  day_of_week: number | null;
  day_of_month: number | null;
  enabled: boolean;
  last_run_at: string | null;
  next_run_at: string | null;
  retention_count: number | null;
  retention_days: number | null;
  created_at: string;
  updated_at: string;
}

export const PluginScanRunPayloadSchema = z.object({
  environmentId: z.number().int().positive(),
  jobExecutionId: z.number().int().positive(),
});
export type PluginScanRunPayload = z.infer<typeof PluginScanRunPayloadSchema>;

export const PluginManagePayloadSchema = z.object({
  environmentId: z.number().int().positive(),
  jobExecutionId: z.number().int().positive(),
  action: z.enum([
    "add",
    "remove",
    "update",
    "update-all",
    "change-constraint",
    "read",
    "activate",
    "deactivate",
    "delete",
    "migrate-to-composer",
  ]),
  /** wpackagist-plugin/slug — required for add/remove/update/change-constraint, omit for update-all/read */
  slug: z.string().optional(),
  /** Version constraint e.g. "^1.5" — only relevant for add */
  version: z.string().optional(),
  /** New version constraint — only for change-constraint action */
  constraint: z.string().optional(),
  /** Workflow to use: composer or manual. Defaults to composer if bedrock, manual otherwise */
  workflow: z.enum(["composer", "manual"]).optional(),
  /** Skip safety backup before making changes */
  skipSafetyBackup: z.boolean().default(false),
});
export type PluginManagePayload = z.infer<typeof PluginManagePayloadSchema>;

export const PluginScheduledUpdatePayloadSchema = z.object({
  scheduleId: z.number().int().positive(),
  environmentId: z.number().int().positive(),
});
export type PluginScheduledUpdatePayload = z.infer<
  typeof PluginScheduledUpdatePayloadSchema
>;

export const SyncClonePayloadSchema = z.object({
  sourceEnvironmentId: z.number().int().positive(),
  targetEnvironmentId: z.number().int().positive(),
  jobExecutionId: z.number().int().positive(),
  skipSafetyBackup: z.boolean().default(false).optional(),
});
export type SyncClonePayload = z.infer<typeof SyncClonePayloadSchema>;

export const SyncPushPayloadSchema = z.object({
  sourceEnvironmentId: z.number().int().positive(),
  targetEnvironmentId: z.number().int().positive(),
  scope: z.enum(["database", "files", "both"]),
  jobExecutionId: z.number().int().positive(),
  skipSafetyBackup: z.boolean().default(false).optional(),
});
export type SyncPushPayload = z.infer<typeof SyncPushPayloadSchema>;

export const MonitorCheckPayloadSchema = z.object({
  monitorId: z.number().int().positive(),
});
export type MonitorCheckPayload = z.infer<typeof MonitorCheckPayloadSchema>;

export const LighthouseAuditPayloadSchema = z.object({
  auditId: z.number().int().positive(),
  environmentId: z.number().int().positive(),
  url: z.string().url(),
  strategy: z.enum(["mobile", "desktop"]),
  jobExecutionId: z.number().int().positive().optional(),
});
export type LighthouseAuditPayload = z.infer<
  typeof LighthouseAuditPayloadSchema
>;

// ─── Monitor HTTP Status Classification ─────────────────────────────────────

export function isHttpStatusWorking(
  statusCode: number | null | undefined,
): boolean {
  return (
    statusCode !== null &&
    statusCode !== undefined &&
    statusCode >= 200 &&
    statusCode < 400
  );
}

export function isHttpStatusFailure(
  statusCode: number | null | undefined,
): boolean {
  return (
    statusCode !== null &&
    statusCode !== undefined &&
    statusCode >= 400 &&
    statusCode < 600
  );
}

export const DomainWhoisPayloadSchema = z.object({
  domainId: z.number().int().positive(),
  domainName: z.string().min(1),
});
export type DomainWhoisPayload = z.infer<typeof DomainWhoisPayloadSchema>;

// Workers fetch project/server/rootPath from Prisma using the environmentId.
export const CreateBedrockPayloadSchema = z.object({
  environmentId: z.number().int().positive(),
  jobExecutionId: z.number().int().positive(),
  /** Present when CyberPanel provisioning is required */
  cyberpanel: z
    .object({
      domain: z.string(),
      dbName: z.string(),
      dbUser: z.string(),
      dbPassword: z.string(),
      dbHost: z.string().default("localhost"),
      phpVersion: z.string().default("8.3"),
      adminEmail: z.string().optional(),
    })
    .optional(),
  /** If set, clone this environment's DB + files instead of fresh Bedrock install */
  sourceEnvironmentId: z.number().int().positive().optional(),
});
export type CreateBedrockPayload = z.infer<typeof CreateBedrockPayloadSchema>;

export const ProjectArchivePayloadSchema = z.object({
  projectId: z.number().int().positive(),
  jobExecutionId: z.number().int().positive(),
  createBackup: z.boolean().default(true),
  deleteFromCyberpanel: z.boolean().default(true),
  deleteProject: z.boolean().default(false).optional(),
});
export type ProjectArchivePayload = z.infer<typeof ProjectArchivePayloadSchema>;

export const ProjectRestorePayloadSchema = z.object({
  projectId: z.number().int().positive(),
  jobExecutionId: z.number().int().positive(),
  environmentBackups: z.record(z.string(), z.number()),
});
export type ProjectRestorePayload = z.infer<typeof ProjectRestorePayloadSchema>;

export const EnvironmentDecommissionPayloadSchema = z.object({
  environmentId: z.number().int().positive(),
  jobExecutionId: z.number().int().positive(),
  deleteFromCyberpanel: z.boolean().default(true),
});
export type EnvironmentDecommissionPayload = z.infer<
  typeof EnvironmentDecommissionPayloadSchema
>;

// ─── WS Payload Types ─────────────────────────────────────────────────────────

export interface JobProgressEvent {
  jobId: string;
  queueName: string;
  progress: number;
  step?: string;
  environmentId?: number;
}

export interface JobCompletedEvent {
  jobId: string;
  queueName: string;
  result?: unknown;
  environmentId?: number;
}

export interface JobFailedEvent {
  jobId: string;
  queueName: string;
  error: string;
  attempt: number;
  environmentId?: number;
}

export interface MonitorResultEvent {
  monitorId: number;
  environmentId: number;
  statusCode: number;
  responseMs: number;
  isUp: boolean;
  checkedAt: string;
}

export interface JobLogEvent {
  jobExecutionId: number;
  environmentId?: number;
  entry: {
    ts: string;
    step: string;
    level: "info" | "warn" | "error";
    detail?: string;
    command?: string;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    durationMs?: number;
  };
}

// ─── Custom Plugin Payload Types ─────────────────────────────────────────────

export const CustomPluginManagePayloadSchema = z.object({
  environmentId: z.number().int().positive(),
  jobExecutionId: z.number().int().positive(),
  action: z.enum(["add", "remove", "update"]),
  customPluginId: z.number().int().positive(),
  slug: z.string().regex(/^[a-z0-9_-]+$/),
  repoUrl: z.string().min(1),
  repoPath: z.string().default("."),
  type: z.enum(["plugin", "theme"]),
});
export type CustomPluginManagePayload = z.infer<
  typeof CustomPluginManagePayloadSchema
>;

// ─── Theme Scan Payload Types ─────────────────────────────────────────────────

export const ThemeScanRunPayloadSchema = z.object({
  environmentId: z.number().int().positive(),
  jobExecutionId: z.number().int().positive(),
});
export type ThemeScanRunPayload = z.infer<typeof ThemeScanRunPayloadSchema>;

export const ThemeManagePayloadSchema = z.object({
  environmentId: z.number().int().positive(),
  jobExecutionId: z.number().int().positive(),
  action: z.enum(["activate", "install", "delete", "update", "update-all"]),
  /** Theme slug — required for all actions except update-all */
  slug: z.string().optional(),
});
export type ThemeManagePayload = z.infer<typeof ThemeManagePayloadSchema>;

// ─── WP Core Payload Types ────────────────────────────────────────────────────

export const WpCoreCheckPayloadSchema = z.object({
  environmentId: z.number().int().positive(),
  jobExecutionId: z.number().int().positive(),
});
export type WpCoreCheckPayload = z.infer<typeof WpCoreCheckPayloadSchema>;

export const WpCoreUpdatePayloadSchema = z.object({
  environmentId: z.number().int().positive(),
  jobExecutionId: z.number().int().positive(),
});
export type WpCoreUpdatePayload = z.infer<typeof WpCoreUpdatePayloadSchema>;

// ─── Plugin Scan Types ────────────────────────────────────────────────────────

/**
 * Matches the JSON output of apps/worker/scripts/plugin-scan.php.
 * `active` is intentionally absent — the PHP script cannot determine
 * activation status without WordPress DB access.
 */
export const PluginInfoSchema = z.object({
  slug: z.string(),
  name: z.string(),
  version: z.string(),
  latest_version: z.string().nullable(),
  update_available: z.boolean(),
  author: z.string().nullable(),
  plugin_uri: z.string().nullable(),
  description: z.string().nullable(),
  /** True when the plugin entry exists in composer.json (Bedrock only) */
  managed_by_composer: z.boolean(),
  /** Composer version constraint from composer.json e.g. "^1.5.0" */
  composer_constraint: z.string().nullable(),
  /** True for must-use plugins (mu-plugins) — auto-loaded, cannot be managed via composer */
  is_mu_plugin: z.boolean().optional(),
  /** True when the plugin is managed via satusdev/monorepo-fetcher (extra.monorepo-sources) */
  managed_by_monorepo: z.boolean().optional(),
  /** GitHub repo URL for the monorepo source managing this plugin */
  monorepo_repo_url: z.string().nullable().optional(),
  status: z.enum(["active", "inactive"]),
});
export type PluginInfo = z.infer<typeof PluginInfoSchema>;

/** Top-level output from plugin-scan.php (new format) */
export const PluginScanOutputSchema = z.object({
  is_bedrock: z.boolean(),
  plugins: z.array(PluginInfoSchema),
});
export type PluginScanOutput = z.infer<typeof PluginScanOutputSchema>;

// ─── Theme Types ──────────────────────────────────────────────────────────────

/** Matches the JSON output of `wp theme list --format=json` */
export interface ThemeInfo {
  name: string;
  /** Normalized internal identifier. WP-CLI theme list exposes this as `name`. */
  slug: string;
  status: "active" | "inactive";
  version: string;
  update_version: string | null;
  update: "available" | "none" | "none available";
  title: string;
  description: string | null;
  author: string | null;
}

// ─── WP DB Credentials ───────────────────────────────────────────────────────

export interface WpDbCredentials {
  dbName: string;
  dbUser: string;
  dbPassword: string;
  dbHost: string;
}

// ─── Notification Event Types ─────────────────────────────────────────────────

export const NOTIFICATION_EVENTS = {
  jobs: [
    "backup.completed",
    "backup.failed",
    "plugin-scan.completed",
    "plugin-update.completed",
    "plugin-update.failed",
    "sync.completed",
    "sync.failed",
  ],
  monitoring: [
    "monitor.down",
    "monitor.up",
    "monitor.degraded",
    "monitor.ssl_expiry",
    "monitor.dns_failed",
    "monitor.keyword_missing",
  ],
  billing: ["invoice.created", "invoice.overdue"],
  users: ["user.registered", "user.login"],
  servers: ["server.created", "server.deleted"],
  reports: ["report.weekly"],
  security: [
    "security.critical_found",
    "security.high_found",
    "security.scan_completed",
    "security.attack_detected",
    "security.ssh_login",
    "security.ssh_failed_login_spike",
    "security.file_changes",
    "security.incident_detected",
    "security.watcher_offline",
    "security.baseline_drift",
    "security.process_anomaly",
    "security.webshell_detected",
    "security.new_ssh_key",
    "security.new_privileged_user",
    "security.finding_resolved",
  ],
} as const;

export type NotificationEventType =
  | "backup.completed"
  | "backup.failed"
  | "plugin-scan.completed"
  | "plugin-update.completed"
  | "plugin-update.failed"
  | "sync.completed"
  | "sync.failed"
  | "monitor.down"
  | "monitor.up"
  | "monitor.degraded"
  | "monitor.ssl_expiry"
  | "monitor.dns_failed"
  | "monitor.keyword_missing"
  | "invoice.created"
  | "invoice.overdue"
  | "user.registered"
  | "user.login"
  | "server.created"
  | "server.deleted"
  | "report.weekly"
  | "security.critical_found"
  | "security.high_found"
  | "security.scan_completed"
  | "security.attack_detected"
  | "security.ssh_login"
  | "security.ssh_failed_login_spike"
  | "security.file_changes"
  | "security.incident_detected"
  | "security.watcher_offline"
  | "security.baseline_drift"
  | "security.process_anomaly"
  | "security.webshell_detected"
  | "security.new_ssh_key"
  | "security.new_privileged_user"
  | "security.finding_resolved";

// ─── Pagination ───────────────────────────────────────────────────────────────

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export const PaginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().optional(),
});
export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

// ─── Settings Response Types ──────────────────────────────────────────────────

export const BillingSettingsResponseSchema = z.object({
  currency_code: z.string(),
  currency_locale: z.string(),
});
export type BillingSettingsResponse = z.infer<
  typeof BillingSettingsResponseSchema
>;

export const CloudflareConfigResponseSchema = z.object({
  configured: z.boolean(),
  zone_id: z.string().nullable(),
  zone_name: z.string().nullable(),
});
export type CloudflareConfigResponse = z.infer<
  typeof CloudflareConfigResponseSchema
>;

export const GdriveConfigResponseSchema = z.object({
  configured: z.boolean(),
});
export type GdriveConfigResponse = z.infer<typeof GdriveConfigResponseSchema>;

export interface WpOrgSearchResult {
  name: string;
  slug: string;
  version: string;
  author: string;
  short_description: string;
  homepage: string;
}

// ─── Project & Environment Canonical Types ─────────────────────────────────────

export interface ProjectLink {
  label: string;
  url?: string;
  type?: "link" | "text";
  value?: string;
}

export interface ProjectEnvironment {
  id: number;
  project_id?: number;
  server_id: number;
  type: string;
  url: string;
  root_path: string;
  backup_path?: string | null;
  google_drive_folder_id?: string | null;
  protected_tables?: string[];
  sql_protection_queries?: string[];
  protected_post_types?: string[];
  is_baseline?: boolean;
  is_multisite?: boolean;
  multisite_url?: string | null;
  server?: {
    id: number;
    name: string;
    ip_address: string;
    status: string;
    ssh_port?: number;
    ssh_user?: string;
  };
  git_remote_url?: string | null;
  git_branch?: string | null;
  git_current_commit?: string | null;
  git_last_deployed_at?: string | null;
  has_deploy_webhook_token?: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface Project {
  id: number;
  name: string;
  client_id: number;
  client?: {
    id: number;
    name: string;
    email?: string | null;
    phone?: string | null;
  };
  hosting_package_id?: number | null;
  support_package_id?: number | null;
  hosting_package?: {
    id: number;
    name: string;
    price_monthly?: number | string;
  } | null;
  support_package?: {
    id: number;
    name: string;
    price_monthly?: number | string;
  } | null;
  status: "active" | "inactive" | "archived";
  notes?: string | null;
  links?: ProjectLink[] | null;
  github_repo?: string | null;
  created_at?: string;
  updated_at?: string;
  environments?: ProjectEnvironment[];
}

// ─── Git Deploy Payloads ───────────────────────────────────────────────────────

export const GitDeployPayloadSchema = z.object({
  environmentId: z.number().int().positive(),
  jobExecutionId: z.number().int().positive(),
  branch: z.string().optional(),
  commitSha: z.string().optional(),
  runComposer: z.boolean().default(true),
  updateDb: z.boolean().default(true),
  flushCache: z.boolean().default(true),
});
export type GitDeployPayload = z.infer<typeof GitDeployPayloadSchema>;

// ─── Secure Guard Payloads ────────────────────────────────────────────────────

export const SecureGuardInstallPayloadSchema = z.object({
  environmentId: z.number().int().positive(),
  jobExecutionId: z.number().int().positive(),
  preset: z
    .enum(["beginner", "balanced", "maximum", "custom"])
    .default("balanced"),
  deployWatchdog: z.boolean().default(true),
});
export type SecureGuardInstallPayload = z.infer<
  typeof SecureGuardInstallPayloadSchema
>;

export const SecureGuardWatchdogPayloadSchema = z.object({
  environmentId: z.number().int().positive(),
  jobExecutionId: z.number().int().positive(),
  action: z.enum(["deploy", "remove", "verify"]).default("deploy"),
});
export type SecureGuardWatchdogPayload = z.infer<
  typeof SecureGuardWatchdogPayloadSchema
>;

// ─── WP-CLI & DB Tool Payloads ────────────────────────────────────────────────

export const WpCliRunPayloadSchema = z.object({
  environmentId: z.number().int().positive(),
  command: z.string().min(1).max(500),
});
export type WpCliRunPayload = z.infer<typeof WpCliRunPayloadSchema>;

export const WpSearchReplacePayloadSchema = z.object({
  environmentId: z.number().int().positive(),
  search: z.string().min(1),
  replace: z.string(),
  dryRun: z.boolean().default(true),
  skipTransients: z.boolean().default(true),
  tables: z.string().optional(),
});
export type WpSearchReplacePayload = z.infer<
  typeof WpSearchReplacePayloadSchema
>;

export const WpDbExportPayloadSchema = z.object({
  environmentId: z.number().int().positive(),
});
export type WpDbExportPayload = z.infer<typeof WpDbExportPayloadSchema>;
