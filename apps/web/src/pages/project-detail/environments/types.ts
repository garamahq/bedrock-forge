export interface ServerOption {
  id: number;
  name: string;
  ip_address: string;
  status: "online" | "offline" | "unknown";
}

export interface DbCredentials {
  dbName: string;
  dbUser: string;
  dbPassword: string;
  dbHost: string;
}

export interface Environment {
  id: number;
  project_id: number;
  type: string;
  url: string;
  root_path: string;
  backup_path: string | null;
  google_drive_folder_id: string | null;
  protected_tables: string[];
  sql_protection_queries?: string[];
  protected_post_types?: string[];
  server: {
    id: number;
    name: string;
    ip_address: string;
    status: "online" | "offline" | "unknown";
  };
  environment_tags?: Array<{
    tag: { id: number; name: string; color: string | null };
  }>;
  latestProvisioningJob?: {
    id: number;
    job_type: string | null;
    status: string;
    progress: number | null;
    last_error: string | null;
  } | null;
}

export interface Tag {
  id: number;
  name: string;
  color: string | null;
}

export interface WpUser {
  id: number;
  user_login: string;
  user_email: string;
  display_name: string;
  user_registered: string;
  roles: string[];
}

export interface QuickLoginResult {
  loginUrl: string;
  expiresAt: string;
}

export interface ScannedSite {
  path: string;
  name: string;
  isBedrock: boolean;
  isWordPress: boolean;
  siteUrl?: string;
  alreadyInThisProject: boolean;
  serverId: number;
  serverName: string;
  hasDbCredentials?: boolean;
  dbCredentials?: {
    dbName: string;
    dbUser: string;
    dbPassword: string;
    dbHost: string;
  };
}
