import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/hooks/use-toast";
import { backupsApi } from "./api";
import { BackupScheduleForm } from "./types";

export function useBackupsQuery(envId: number | null) {
  return useQuery({
    queryKey: ["backups", envId],
    enabled: !!envId,
    queryFn: () => backupsApi.getBackups(envId!),
    refetchInterval: 15_000,
  });
}

export function useBackupScheduleQuery(envId: number | null) {
  return useQuery({
    queryKey: ["backup-schedule", envId],
    enabled: !!envId,
    queryFn: () => backupsApi.getBackupSchedule(envId!),
    staleTime: 30_000,
  });
}

export function useCancelBackupMutation(envId: number | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (execId: number) => backupsApi.cancelBackupExecution(execId),
    onSuccess: (res) => {
      if (envId) {
        qc.invalidateQueries({ queryKey: ["backups", envId] });
      }
      toast({
        title: res?.terminated
          ? "Backup job cancelled"
          : "Cancellation requested — waiting for worker to stop",
      });
    },
    onError: () => {
      toast({ title: "Could not cancel job", variant: "destructive" });
    },
  });
}

export function useDeleteBackupMutation(envId: number | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => backupsApi.deleteBackup(id),
    onSuccess: () => {
      if (envId) {
        qc.invalidateQueries({ queryKey: ["backups", envId] });
      }
      toast({ title: "Backup deleted" });
    },
    onError: () => {
      toast({ title: "Delete failed", variant: "destructive" });
    },
  });
}

export function useUpsertScheduleMutation(envId: number | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: BackupScheduleForm) =>
      backupsApi.upsertBackupSchedule(envId!, payload),
    onSuccess: () => {
      if (envId) {
        qc.invalidateQueries({ queryKey: ["backup-schedule", envId] });
      }
      toast({ title: "Schedule saved" });
    },
    onError: () => {
      toast({ title: "Failed to save schedule", variant: "destructive" });
    },
  });
}

export function useDeleteScheduleMutation(envId: number | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => backupsApi.deleteBackupSchedule(envId!),
    onSuccess: () => {
      if (envId) {
        qc.invalidateQueries({ queryKey: ["backup-schedule", envId] });
      }
      toast({ title: "Schedule removed" });
    },
    onError: () => {
      toast({ title: "Failed to remove schedule", variant: "destructive" });
    },
  });
}
