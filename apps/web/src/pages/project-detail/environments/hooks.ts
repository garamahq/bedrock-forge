import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/hooks/use-toast";
import { environmentsApi } from "./api";
import { DbCredentials, Environment, Tag, WpUser } from "./types";

export function useEnvironmentsQuery(projectId: number) {
  return useQuery<Environment[]>({
    queryKey: ["environments", projectId],
    queryFn: () => environmentsApi.getEnvironments(projectId),
    refetchInterval: (query) => {
      const data = query.state.data;
      const hasActive = data?.some(
        (e) =>
          e.latestProvisioningJob?.status === "queued" ||
          e.latestProvisioningJob?.status === "active",
      );
      return hasActive ? 5000 : false;
    },
  });
}

export function useServersQuery() {
  return useQuery({
    queryKey: ["servers-list"],
    queryFn: () => environmentsApi.getServers(),
  });
}

export function useWpUsersQuery(
  projectId: number,
  envId: number,
  enabled: boolean,
) {
  return useQuery<WpUser[]>({
    queryKey: ["wp-users", envId],
    queryFn: () => environmentsApi.getWpUsers(projectId, envId),
    enabled,
    retry: false,
  });
}

export function useDbCredentialsQuery(
  projectId: number,
  envId: number,
  enabled: boolean,
) {
  return useQuery<DbCredentials | null>({
    queryKey: ["db-credentials", envId],
    queryFn: () => environmentsApi.getDbCredentials(projectId, envId),
    enabled,
  });
}

export function useSaveDbCredentialsMutation(projectId: number, envId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: unknown) =>
      environmentsApi.saveDbCredentials(projectId, envId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["db-credentials", envId] });
      toast({ title: "DB credentials saved" });
    },
  });
}

export function useAllTagsQuery() {
  return useQuery<Tag[]>({
    queryKey: ["tags"],
    queryFn: () => environmentsApi.getTags(),
    staleTime: 60_000,
  });
}

export function useAddTagMutation(projectId: number, envId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (tagId: number) => environmentsApi.addTag(envId, tagId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["environments", projectId] });
    },
    onError: () => {
      toast({ title: "Failed to add tag", variant: "destructive" });
    },
  });
}

export function useRemoveTagMutation(projectId: number, envId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (tagId: number) => environmentsApi.removeTag(envId, tagId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["environments", projectId] });
    },
    onError: () => {
      toast({ title: "Failed to remove tag", variant: "destructive" });
    },
  });
}

export function useDeleteEnvironmentMutation(projectId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (envId: number) =>
      environmentsApi.deleteEnvironment(projectId, envId),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["environments", projectId] });
      qc.invalidateQueries({ queryKey: ["project", projectId] });
      qc.invalidateQueries({ queryKey: ["job-executions"] });
      toast({
        title: "Environment decommission queued",
        description: result.message,
      });
    },
    onError: () => {
      toast({ title: "Delete failed", variant: "destructive" });
    },
  });
}

export function useBackupMutation() {
  return useMutation({
    mutationFn: (envId: number) => environmentsApi.createBackup(envId),
    onSuccess: () => {
      toast({ title: "Backup started" });
    },
    onError: () => {
      toast({ title: "Failed to start backup", variant: "destructive" });
    },
  });
}

export function usePluginScanMutation() {
  return useMutation({
    mutationFn: (envId: number) => environmentsApi.runPluginScan(envId),
    onSuccess: () => {
      toast({ title: "Plugin scan queued" });
    },
    onError: () => {
      toast({ title: "Failed to start scan", variant: "destructive" });
    },
  });
}
