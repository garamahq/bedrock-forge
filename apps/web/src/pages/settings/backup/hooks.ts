import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/hooks/use-toast";
import { backupApi } from "./api";
import { SystemBackupSchedule } from "./types";

export function useGdriveStatus() {
  return useQuery({
    queryKey: ["gdrive-status"],
    queryFn: backupApi.getGdriveStatus,
  });
}

export function useSystemBackupFolder() {
  return useQuery({
    queryKey: ["system-backup-folder"],
    queryFn: backupApi.getSystemBackupFolder,
  });
}

export function useSaveBackupFolderMutation(onSuccessCallback?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: backupApi.saveSystemBackupFolder,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["system-backup-folder"] });
      if (onSuccessCallback) onSuccessCallback();
      toast({ title: "Backup folder ID saved" });
    },
    onError: () =>
      toast({ title: "Failed to save folder ID", variant: "destructive" }),
  });
}

export function useSystemBackups() {
  return useQuery({
    queryKey: ["system-backups"],
    queryFn: backupApi.getSystemBackups,
    refetchInterval: (query) => {
      const d = query.state.data;
      if (!d) return 10_000;
      const hasActive = d.items.some(
        (b) => b.status === "pending" || b.status === "running",
      );
      return hasActive ? 5_000 : 30_000;
    },
  });
}

export function useTriggerBackupMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: backupApi.triggerBackup,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["system-backups"] });
      toast({ title: "System backup started" });
    },
    onError: (err) =>
      toast({
        title: "Failed to start backup",
        description: err?.message,
        variant: "destructive",
      }),
  });
}

export function useBackupSchedule() {
  return useQuery({
    queryKey: ["system-backup-schedule"],
    queryFn: backupApi.getBackupSchedule,
  });
}

export function useSaveBackupScheduleMutation(onSuccessCallback?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<SystemBackupSchedule>) =>
      backupApi.saveBackupSchedule(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["system-backup-schedule"] });
      if (onSuccessCallback) onSuccessCallback();
      toast({ title: "Backup schedule saved" });
    },
    onError: (err) =>
      toast({
        title: "Failed to save schedule",
        description: err?.message,
        variant: "destructive",
      }),
  });
}

export function useDeleteBackupScheduleMutation(
  onSuccessCallback?: () => void,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: backupApi.deleteBackupSchedule,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["system-backup-schedule"] });
      if (onSuccessCallback) onSuccessCallback();
      toast({ title: "Backup schedule removed" });
    },
    onError: () =>
      toast({ title: "Failed to remove schedule", variant: "destructive" }),
  });
}
