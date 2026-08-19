export interface GdriveStatus {
  configured: boolean;
}

export interface CloudflareStatus {
  configured: boolean;
  zone_id: string | null;
  zone_name: string | null;
}

export interface CloudflareDnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
  ttl?: number;
}

export interface PagespeedStatus {
  configured: boolean;
  provider: "auto" | "local" | "pagespeed";
  hasApiKey: boolean;
  apiKeyPreview: string | null;
}
