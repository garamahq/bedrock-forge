import { api } from "@/lib/api-client";
import {
  GdriveStatus,
  CloudflareStatus,
  CloudflareDnsRecord,
  PagespeedStatus,
} from "./types";

export const integrationsApi = {
  getGdriveStatus: () => api.get<GdriveStatus>("/settings/gdrive"),

  saveGdrive: (token: string) => api.put("/settings/gdrive", { token }),

  testGdrive: () =>
    api.post<{ success: boolean; message: string }>(
      "/settings/gdrive/test",
      {},
    ),

  deleteGdrive: () => api.delete("/settings/gdrive"),

  getCloudflareStatus: () => api.get<CloudflareStatus>("/settings/cloudflare"),

  saveCloudflare: (params: {
    api_token: string;
    zone_id: string;
    zone_name: string;
  }) => api.put("/settings/cloudflare", params),

  testCloudflare: () =>
    api.post<{ success: boolean; message: string }>(
      "/settings/cloudflare/test",
      {},
    ),

  purgeCloudflare: () => api.post("/settings/cloudflare/cache/purge", {}),

  toggleDevelopmentMode: (enabled: boolean) =>
    api.put("/settings/cloudflare/development-mode", { enabled }),

  getDnsRecords: () =>
    api.get<CloudflareDnsRecord[]>("/settings/cloudflare/dns-records"),

  updateDnsRecord: (recordId: string, params: { proxied: boolean }) =>
    api.put(`/settings/cloudflare/dns-records/${recordId}`, params),

  getPagespeedStatus: () => api.get<PagespeedStatus>("/settings/pagespeed"),

  savePagespeed: (params: {
    apiKey?: string;
    provider?: "auto" | "local" | "pagespeed";
  }) => api.put("/settings/pagespeed", params),

  testPagespeed: (url?: string) =>
    api.post<{ success: boolean; message: string; data?: unknown }>(
      "/settings/pagespeed/test",
      { url },
    ),

  deletePagespeed: () => api.delete("/settings/pagespeed"),
};
