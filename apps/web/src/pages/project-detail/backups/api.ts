import { api } from "@/lib/api-client";
import { Backup, BackupSchedule, BackupScheduleForm } from "./types";

export const backupsApi = {
  getBackups: async (
    envId: number,
  ): Promise<{ items: Backup[]; total: number }> => {
    return api.get<{ items: Backup[]; total: number }>(
      `/backups/environment/${envId}?page=1&limit=20`,
    );
  },

  createBackup: async (payload: {
    environmentId: number;
    type: "full" | "db_only" | "files_only";
  }): Promise<{ jobExecutionId: number; bullJobId: string }> => {
    return api.post<{ jobExecutionId: number; bullJobId: string }>(
      "/backups/create",
      payload,
    );
  },

  restoreBackup: async (payload: {
    backupId: number;
  }): Promise<{ jobExecutionId: number; bullJobId: string }> => {
    return api.post<{ jobExecutionId: number; bullJobId: string }>(
      "/backups/restore",
      payload,
    );
  },

  cancelBackupExecution: async (
    execId: number,
  ): Promise<{ cancelled: boolean }> => {
    return api.post<{ cancelled: boolean }>(
      `/backups/execution/${execId}/cancel`,
      {},
    );
  },

  deleteBackup: async (id: number): Promise<unknown> => {
    return api.delete(`/backups/${id}`);
  },

  getBackupSchedule: async (envId: number): Promise<BackupSchedule | null> => {
    return api.get<BackupSchedule | null>(
      `/environments/${envId}/backup-schedule`,
    );
  },

  upsertBackupSchedule: async (
    envId: number,
    payload: BackupScheduleForm,
  ): Promise<unknown> => {
    return api.put(`/environments/${envId}/backup-schedule`, payload);
  },

  deleteBackupSchedule: async (envId: number): Promise<unknown> => {
    return api.delete(`/environments/${envId}/backup-schedule`);
  },
};
