export interface Environment {
  id: number;
  type: string;
  url?: string;
  google_drive_folder_id: string | null;
  server: { name: string };
}

export interface Backup {
  id: number;
  type: "full" | "db_only" | "files_only";
  status: "pending" | "running" | "completed" | "failed";
  file_path?: string | null;
  size_bytes: number | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
  jobExecution: {
    id: number;
    bull_job_id: string;
    status: string;
    progress: number;
    last_error: string | null;
    execution_log: unknown[] | null;
  } | null;
}

export interface BackupSchedule {
  id: number;
  type: "full" | "db_only" | "files_only";
  frequency: string;
  hour: number;
  minute: number;
  day_of_week: number | null;
  day_of_month: number | null;
  enabled: boolean;
  last_run_at: string | null;
  retention_count: number | null;
  retention_days: number | null;
}

export interface BackupScheduleForm {
  type: "full" | "db_only" | "files_only";
  frequency: "daily" | "weekly" | "monthly";
  hour: number;
  minute: number;
  day_of_week: number;
  day_of_month: number;
  enabled: boolean;
  retention_count: number | null;
  retention_days: number | null;
}
