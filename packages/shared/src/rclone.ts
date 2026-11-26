export interface RcloneOAuthTokenPayload {
  access_token?: string;
  token_type?: string;
  refresh_token?: string;
  expiry?: string;
  [key: string]: unknown;
}

export interface ParsedRcloneRemoteToken {
  accessToken: string | null;
  refreshToken: string | null;
  expiryMs: number | null;
  valid: boolean;
}

export type RcloneReconcileDecision =
  | "in_sync"
  | "keep_disk_and_sync_db"
  | "write_db_to_disk";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Parse the `token = {...}` line inside an rclone INI section `[remoteName]`.
 * Never logs or returns secrets directly in errors.
 */
export function parseRcloneRemoteToken(
  confContent: string,
  remoteName: string,
): ParsedRcloneRemoteToken {
  const lines = confContent.split(/\r?\n/);
  const sectionHeaderRe = new RegExp(`^\\s*\\[${escapeRegExp(remoteName)}\\]\\s*$`);
  let inSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) {
      continue;
    }
    if (/^\[.+\]$/.test(trimmed)) {
      if (sectionHeaderRe.test(trimmed)) {
        inSection = true;
      } else if (inSection) {
        break;
      }
      continue;
    }
    if (!inSection) continue;

    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (key !== "token") continue;

    const rawJson = trimmed.slice(eqIdx + 1).trim();
    try {
      const parsed = JSON.parse(rawJson) as RcloneOAuthTokenPayload;
      const accessToken =
        typeof parsed.access_token === "string" && parsed.access_token.length > 0
          ? parsed.access_token
          : null;
      const refreshToken =
        typeof parsed.refresh_token === "string" && parsed.refresh_token.length > 0
          ? parsed.refresh_token
          : null;
      const expiryMs =
        typeof parsed.expiry === "string" && Number.isFinite(Date.parse(parsed.expiry))
          ? Date.parse(parsed.expiry)
          : null;
      const valid = Boolean(accessToken && refreshToken);
      return { accessToken, refreshToken, expiryMs, valid };
    } catch {
      return { accessToken: null, refreshToken: null, expiryMs: null, valid: false };
    }
  }

  return { accessToken: null, refreshToken: null, expiryMs: null, valid: false };
}

/**
 * Determine whether an existing on-disk rclone config reflects a newer local OAuth
 * token refresh (keep disk & sync back to DB) or whether the DB record is newer
 * (intentional relink / rotation -> overwrite disk from DB).
 */
export function reconcileRcloneConfigState(opts: {
  dbContent: string;
  dbUpdatedAt: Date | null | undefined;
  diskContent: string;
  diskMtimeMs: number;
  remoteName: string;
}): RcloneReconcileDecision {
  const { dbContent, dbUpdatedAt, diskContent, diskMtimeMs, remoteName } = opts;

  if (diskContent.trim() === dbContent.trim()) {
    return "in_sync";
  }

  const diskToken = parseRcloneRemoteToken(diskContent, remoteName);
  if (!diskToken.valid) {
    return "write_db_to_disk";
  }

  const dbToken = parseRcloneRemoteToken(dbContent, remoteName);
  const dbUpdatedMs = dbUpdatedAt instanceof Date ? dbUpdatedAt.getTime() : null;

  // If the DB entry was intentionally saved/relinked strictly after the disk file was touched, DB wins.
  if (dbUpdatedMs !== null && Number.isFinite(dbUpdatedMs) && dbUpdatedMs > diskMtimeMs) {
    return "write_db_to_disk";
  }

  // Otherwise disk mtime is >= DB updated_at: accept valid local refresh if tokens/expiry advanced.
  if (
    dbToken.expiryMs !== null &&
    diskToken.expiryMs !== null &&
    diskToken.expiryMs > dbToken.expiryMs
  ) {
    return "keep_disk_and_sync_db";
  }

  if (
    diskToken.accessToken !== null &&
    diskToken.accessToken !== dbToken.accessToken
  ) {
    return "keep_disk_and_sync_db";
  }

  return "write_db_to_disk";
}
