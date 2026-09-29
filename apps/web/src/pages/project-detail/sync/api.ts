import { api } from "@/lib/api-client";
import { SyncHistoryPage, Scope } from "./types";

export const syncApi = {
  cloneEnvironment: async (payload: {
    sourceEnvironmentId: number;
    targetEnvironmentId: number;
    skipSafetyBackup: boolean;
  }): Promise<{ jobId: string; jobExecutionId: number }> => {
    return api.post<{ jobId: string; jobExecutionId: number }>(
      "/sync/clone",
      payload,
    );
  },

  cancelSyncExecution: async (
    execId: number,
  ): Promise<{ cancelled: boolean }> => {
    return api.post<{ cancelled: boolean }>(
      `/sync/execution/${execId}/cancel`,
      {},
    );
  },

  pushEnvironment: async (payload: {
    sourceEnvironmentId: number;
    targetEnvironmentId: number;
    scope: Scope;
    skipSafetyBackup: boolean;
  }): Promise<{ jobId: string; jobExecutionId: number }> => {
    return api.post<{ jobId: string; jobExecutionId: number }>(
      "/sync/push",
      payload,
    );
  },

  getSyncHistory: async (
    envIds: string,
    page: number,
  ): Promise<SyncHistoryPage> => {
    return api.get<SyncHistoryPage>(
      `/job-executions?queue_name=sync&environment_ids=${envIds}&page=${page}&limit=10`,
    );
  },
};
