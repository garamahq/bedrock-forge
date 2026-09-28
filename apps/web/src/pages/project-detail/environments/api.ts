import { ApiError, api } from "@/lib/api-client";
import {
  DbCredentials,
  Environment,
  Tag,
  WpUser,
  QuickLoginResult,
  ScannedSite,
  ServerOption,
} from "./types";

export const environmentsApi = {
  getDbTables: async (projectId: number, envId: number): Promise<string[]> => {
    return api.get<string[]>(
      `/projects/${projectId}/environments/${envId}/db-tables`,
    );
  },

  createEnvironment: async (
    projectId: number,
    payload: Record<string, unknown>,
  ): Promise<Environment> => {
    return api.post<Environment>(
      `/projects/${projectId}/environments`,
      payload,
    );
  },

  updateEnvironment: async (
    projectId: number,
    envId: number,
    payload: Record<string, unknown>,
  ): Promise<Environment> => {
    return api.put<Environment>(
      `/projects/${projectId}/environments/${envId}`,
      payload,
    );
  },

  getWpUsers: async (projectId: number, envId: number): Promise<WpUser[]> => {
    return api.get<WpUser[]>(
      `/projects/${projectId}/environments/${envId}/wp-users`,
    );
  },

  generateQuickLogin: async (
    projectId: number,
    envId: number,
    userId: number,
  ): Promise<QuickLoginResult> => {
    return api.post<QuickLoginResult>(
      `/projects/${projectId}/environments/${envId}/wp-quick-login`,
      { userId },
    );
  },

  getDbCredentials: async (
    projectId: number,
    envId: number,
  ): Promise<DbCredentials | null> => {
    try {
      return await api.get<DbCredentials | null>(
        `/projects/${projectId}/environments/${envId}/db-credentials`,
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },

  saveDbCredentials: async (
    projectId: number,
    envId: number,
    data: unknown,
  ): Promise<void> => {
    return api.put(
      `/projects/${projectId}/environments/${envId}/db-credentials`,
      data,
    );
  },

  getTags: async (): Promise<Tag[]> => {
    return api.get<Tag[]>("/tags");
  },

  addTag: async (envId: number, tagId: number): Promise<void> => {
    return api.post(`/environments/${envId}/tags/${tagId}`, {});
  },

  removeTag: async (envId: number, tagId: number): Promise<void> => {
    return api.delete(`/environments/${envId}/tags/${tagId}`);
  },

  createBackup: async (envId: number): Promise<void> => {
    return api.post("/backups/create", { environmentId: envId, type: "full" });
  },

  runPluginScan: async (envId: number): Promise<void> => {
    return api.post(`/plugin-scans/environment/${envId}/scan`, {});
  },

  scanServer: async (
    projectId: number,
    serverId: number,
  ): Promise<ScannedSite[]> => {
    return api.post<ScannedSite[]>(
      `/projects/${projectId}/environments/scan-server`,
      { server_id: serverId },
    );
  },

  getEnvironments: async (projectId: number): Promise<Environment[]> => {
    type ApiEnv = Omit<Environment, "latestProvisioningJob"> & {
      job_executions: Array<{
        id: number;
        status: string;
        progress: number | null;
        last_error: string | null;
      }>;
    };
    const items = await api.get<ApiEnv[]>(
      `/projects/${projectId}/environments`,
    );
    return items.map((e) => ({
      ...e,
      latestProvisioningJob: e.job_executions?.[0] ?? null,
    })) satisfies Environment[];
  },

  getServers: async (): Promise<ServerOption[]> => {
    return api
      .get<{ items: ServerOption[] }>("/servers?limit=100")
      .then((r) => r.items);
  },

  deleteEnvironment: async (
    projectId: number,
    envId: number,
  ): Promise<void> => {
    return api.delete(`/projects/${projectId}/environments/${envId}`);
  },
};
