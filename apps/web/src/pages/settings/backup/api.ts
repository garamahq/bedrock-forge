import { api } from "@/lib/api-client";
import { GdriveStatus, SystemBackupList, SystemBackupSchedule } from "./types";

export const backupApi = {
  getGdriveStatus: () => api.get<GdriveStatus>("/settings/gdrive"),
  getSystemBackupFolder: () =>
    api.get<{ folder_id: string | null }>("/settings/system-backup-folder"),
  saveSystemBackupFolder: (value: string) =>
    api.put<void>("/settings/system-backup-folder", { value }),
  getSystemBackups: (page = 1, limit = 20) =>
    api.get<SystemBackupList>(`/system-backups?page=${page}&limit=${limit}`),
  triggerBackup: () =>
    api.post<{ systemBackupId: number }>("/system-backups", {}),
  getBackupSchedule: () =>
    api.get<SystemBackupSchedule | null>("/system-backups/schedule"),
  saveBackupSchedule: (data: Partial<SystemBackupSchedule>) =>
    api.put<SystemBackupSchedule>("/system-backups/schedule", data),
  deleteBackupSchedule: () => api.delete<void>("/system-backups/schedule"),
};
