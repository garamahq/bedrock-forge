import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/hooks/use-toast";
import { pluginsApi } from "./api";
import {
  PluginScan,
  CustomPlugin,
  EnvironmentCustomPlugin,
  PluginUpdateSchedule,
  JobExecutionLogStatus,
} from "./types";

export function usePluginScans(envId: number | null) {
  return useQuery({
    queryKey: ["plugin-scans", envId],
    enabled: !!envId,
    queryFn: () => pluginsApi.getScans(envId!),
    refetchInterval: 15_000,
  });
}

export function useJobExecutionLog(
  lastJobExecutionId: number | null,
  isEnabled: boolean,
) {
  return useQuery<JobExecutionLogStatus>({
    queryKey: ["execution-log", lastJobExecutionId],
    queryFn: () => pluginsApi.getJobExecutionLog(lastJobExecutionId!),
    enabled: lastJobExecutionId != null && isEnabled,
    staleTime: 0,
    refetchInterval: isEnabled ? 2_000 : false,
  });
}

export function useCustomCatalog() {
  return useQuery<CustomPlugin[]>({
    queryKey: ["custom-plugins"],
    queryFn: () => pluginsApi.getCustomCatalog(),
  });
}

export function useEnvCustomPlugins(envId: number | null) {
  return useQuery<EnvironmentCustomPlugin[]>({
    queryKey: ["env-custom-plugins", envId],
    enabled: !!envId,
    queryFn: () => pluginsApi.getEnvCustomPlugins(envId!),
  });
}

export function usePluginUpdateSchedule(envId: number) {
  return useQuery<PluginUpdateSchedule | null>({
    queryKey: ["plugin-update-schedule", envId],
    queryFn: () => pluginsApi.getPluginUpdateSchedule(envId),
  });
}

export function useScanMutation(
  envId: number,
  options?: {
    onSuccess?: (data: { jobExecutionId: number; bullJobId: string }) => void;
  },
) {
  return useMutation({
    mutationFn: () => pluginsApi.scanEnvironment(envId),
    onSuccess: (data) => {
      toast({
        title: "Plugin scan queued",
        description:
          "Results will appear automatically when the scan completes.",
      });
      options?.onSuccess?.(data);
    },
    onError: () => toast({ title: "Scan failed", variant: "destructive" }),
  });
}

export function useUpdateAllMutation(
  envId: number,
  options?: {
    onSuccess?: (data: { jobExecutionId: number; bullJobId: string }) => void;
  },
) {
  return useMutation({
    mutationFn: (skipSafetyBackup: boolean) =>
      pluginsApi.updateAllPlugins(envId, { skipSafetyBackup }),
    onSuccess: (data) => {
      toast({
        title: "Update all queued",
        description: "All composer-managed plugins will be updated.",
      });
      options?.onSuccess?.(data);
    },
    onError: () =>
      toast({ title: "Failed to queue update-all", variant: "destructive" }),
  });
}

export function useRemovePluginMutation(
  envId: number,
  options?: {
    onSuccess?: (
      data: { jobExecutionId: number; bullJobId: string },
      slug: string,
    ) => void;
  },
) {
  return useMutation({
    mutationFn: ({
      slug,
      skipSafetyBackup,
    }: {
      slug: string;
      skipSafetyBackup: boolean;
    }) => pluginsApi.removePlugin(envId, slug, { skipSafetyBackup }),
    onSuccess: (data, { slug }) => {
      toast({
        title: "Remove queued",
        description: `${slug} will be removed via composer.`,
      });
      options?.onSuccess?.(data, slug);
    },
    onError: () =>
      toast({ title: "Failed to queue removal", variant: "destructive" }),
  });
}

export function useUpdatePluginMutation(
  envId: number,
  options?: {
    onSuccess?: (
      data: { jobExecutionId: number; bullJobId: string },
      slug: string,
    ) => void;
  },
) {
  return useMutation({
    mutationFn: ({
      slug,
      skipSafetyBackup,
    }: {
      slug: string;
      skipSafetyBackup: boolean;
    }) => pluginsApi.updatePlugin(envId, slug, { skipSafetyBackup }),
    onSuccess: (data, { slug }) => {
      toast({
        title: "Update queued",
        description: `${slug} will be updated via composer.`,
      });
      options?.onSuccess?.(data, slug);
    },
    onError: () =>
      toast({ title: "Failed to queue update", variant: "destructive" }),
  });
}

export function useChangeConstraintMutation(
  envId: number,
  options?: {
    onSuccess?: (
      data: { jobExecutionId: number; bullJobId: string },
      slug: string,
    ) => void;
  },
) {
  return useMutation({
    mutationFn: ({ slug, constraint }: { slug: string; constraint: string }) =>
      pluginsApi.changePluginConstraint(envId, slug, { constraint }),
    onSuccess: (data, { slug }) => {
      toast({
        title: "Constraint update queued",
        description: `${slug} constraint will be updated.`,
      });
      options?.onSuccess?.(data, slug);
    },
    onError: () =>
      toast({ title: "Failed to update constraint", variant: "destructive" }),
  });
}

export function useToggleStatusMutation(
  envId: number,
  options?: {
    onSuccess?: (
      data: { jobExecutionId: number; bullJobId: string },
      params: { slug: string; status: "active" | "inactive" },
    ) => void;
  },
) {
  return useMutation({
    mutationFn: ({
      slug,
      status,
      skipSafetyBackup,
    }: {
      slug: string;
      status: "active" | "inactive";
      skipSafetyBackup: boolean;
    }) =>
      pluginsApi.togglePluginStatus(envId, slug, {
        active: status === "active",
        skipSafetyBackup,
      }),
    onSuccess: (data, { slug, status }) => {
      toast({
        title: `${status === "active" ? "Activation" : "Deactivation"} queued`,
        description: `${slug} status change has been requested.`,
      });
      options?.onSuccess?.(data, { slug, status });
    },
    onError: () =>
      toast({ title: "Failed to queue status change", variant: "destructive" }),
  });
}

export function useMigrateToComposerMutation(
  envId: number,
  options?: {
    onSuccess?: (
      data: { jobExecutionId: number; bullJobId: string },
      slug: string,
    ) => void;
  },
) {
  return useMutation({
    mutationFn: ({
      slug,
      skipSafetyBackup,
    }: {
      slug: string;
      skipSafetyBackup: boolean;
    }) => pluginsApi.migrateToComposer(envId, slug, { skipSafetyBackup }),
    onSuccess: (data, { slug }) => {
      toast({
        title: "Migration queued",
        description: `${slug} is being migrated to composer-managed wpackagist package.`,
      });
      options?.onSuccess?.(data, slug);
    },
    onError: () =>
      toast({ title: "Failed to queue migration", variant: "destructive" }),
  });
}

export function useUninstallCustomMutation(
  envId: number,
  options?: {
    onSuccess?: (data: { jobExecutionId: number; bullJobId: string }) => void;
  },
) {
  return useMutation({
    mutationFn: (customPluginId: number) =>
      pluginsApi.uninstallCustomPlugin(envId, customPluginId),
    onSuccess: (data) => {
      toast({
        title: "Uninstall queued",
        description: "Plugin will be removed via GitHub source.",
      });
      options?.onSuccess?.(data);
    },
    onError: () => toast({ title: "Uninstall failed", variant: "destructive" }),
  });
}

export function useUpdateCustomMutation(
  envId: number,
  options?: {
    onSuccess?: (data: { jobExecutionId: number; bullJobId: string }) => void;
  },
) {
  return useMutation({
    mutationFn: (customPluginId: number) =>
      pluginsApi.updateCustomPlugin(envId, customPluginId),
    onSuccess: (data) => {
      toast({
        title: "Update queued",
        description: "Plugin will be updated via GitHub source.",
      });
      options?.onSuccess?.(data);
    },
    onError: () => toast({ title: "Update failed", variant: "destructive" }),
  });
}

export function useInstallCustomMutation(
  envId: number,
  options?: {
    onSuccess?: (data: { jobExecutionId: number; bullJobId: string }) => void;
  },
) {
  return useMutation({
    mutationFn: (customPluginId: number) =>
      pluginsApi.installCustomPlugin(envId, customPluginId),
    onSuccess: (data) => {
      toast({
        title: "Install queued",
        description: "Plugin will be installed from the GitHub catalog.",
      });
      options?.onSuccess?.(data);
    },
    onError: () => toast({ title: "Install failed", variant: "destructive" }),
  });
}

export function useCheckVersionsMutation(
  envId: number,
  options?: {
    onSuccess?: () => void;
  },
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => pluginsApi.checkCustomPluginVersions(envId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["env-custom-plugins", envId] });
      toast({ title: "Version check complete" });
      options?.onSuccess?.();
    },
    onError: () =>
      toast({ title: "Version check failed", variant: "destructive" }),
  });
}

export function useComposerReadMutation(
  envId: number,
  options?: {
    onSuccess?: (data: { jobExecutionId: number; bullJobId: string }) => void;
  },
) {
  return useMutation({
    mutationFn: () => pluginsApi.readComposerJson(envId),
    onSuccess: (data) => {
      options?.onSuccess?.(data);
    },
    onError: () =>
      toast({ title: "Failed to read composer.json", variant: "destructive" }),
  });
}

export function useSavePluginUpdateSchedule(
  envId: number,
  options?: {
    onSuccess?: (data: PluginUpdateSchedule) => void;
  },
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      enabled: boolean;
      frequency: "daily" | "weekly" | "monthly";
      hour: number;
      minute: number;
      day_of_week?: number;
      day_of_month?: number;
    }) => pluginsApi.savePluginUpdateSchedule(envId, body),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["plugin-update-schedule", envId] });
      toast({ title: "Auto-update schedule saved" });
      options?.onSuccess?.(data);
    },
    onError: () => toast({ title: "Save failed", variant: "destructive" }),
  });
}

export function useDeletePluginUpdateSchedule(
  envId: number,
  options?: {
    onSuccess?: () => void;
  },
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => pluginsApi.deletePluginUpdateSchedule(envId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["plugin-update-schedule", envId] });
      toast({ title: "Schedule removed" });
      options?.onSuccess?.();
    },
    onError: () => toast({ title: "Delete failed", variant: "destructive" }),
  });
}
