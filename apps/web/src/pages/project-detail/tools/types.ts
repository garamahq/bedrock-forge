export interface Environment {
  id: number;
  type: string;
  url?: string;
  root_path?: string;
  server: { name: string };
}

export interface DebugStatus {
  success: boolean;
  was_enabled?: boolean;
  now_enabled?: boolean;
}

export interface MaintenanceStatus {
  success: boolean;
  enabled: boolean;
  output?: string;
  source?: string;
}

export interface LogResult {
  success: boolean;
  file?: string;
  lines?: string[];
  error?: string;
}

export interface CronJob {
  hook: string;
  schedule: string;
  next_run: string;
  next_run_timestamp: number;
  args: unknown[];
}

export interface CronResult {
  success: boolean;
  source?: string;
  cron?: CronJob[];
  error?: string;
}

export interface CleanupScheduleData {
  id?: number;
  enabled: boolean;
  frequency: string;
  hour: number;
  minute: number;
  day_of_week: number | null;
  day_of_month: number | null;
  keep_revisions: number;
  last_run_at?: string | null;
  unsupported_frequency_reason?: string | null;
}
