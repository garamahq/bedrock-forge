import { api } from "@/lib/api-client";
import { SshKeyStatus } from "./types";

export interface ActiveSession {
  id: number;
  created_at: string;
  expires_at: string;
  user_agent: string | null;
  ip_address: string | null;
}

export const accountApi = {
  getSshKeyStatus: () => api.get<SshKeyStatus>("/settings/ssh-key"),
  setSshKey: (key: string) => api.put<void>("/settings/ssh-key", { key }),
  deleteSshKey: () => api.delete<void>("/settings/ssh-key"),
  changePassword: (data: Record<string, string>) =>
    api.put<void>("/auth/change-password", data),
  getSessions: () => api.get<ActiveSession[]>("/auth/sessions"),
  revokeSession: (id: number) => api.delete<void>(`/auth/sessions/${id}`),
  revokeAllSessions: () => api.post<void>("/auth/logout-all", {}),
  setupMfa: () =>
    api.post<{ secret: string; qrCodeDataUrl: string }>("/auth/mfa/setup", {}),
  enableMfa: (code: string) => api.post<void>("/auth/mfa/enable", { code }),
  disableMfa: (code: string) => api.post<void>("/auth/mfa/disable", { code }),
};
