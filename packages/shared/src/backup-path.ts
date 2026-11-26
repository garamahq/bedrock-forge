export type RestorableBackupFormat = "gdrive_tar_gz" | "gdrive_sql";

const CANONICAL_DRIVE_ID_RE = /^[a-zA-Z0-9_-]{3,128}$/;

function extractFolderId(raw: string): string {
  const trimmed = raw.trim();
  if (CANONICAL_DRIVE_ID_RE.test(trimmed)) {
    return trimmed;
  }
  const urlCandidate = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : /^drive\.google\.com\//i.test(trimmed) || /^docs\.google\.com\//i.test(trimmed)
      ? `https://${trimmed}`
      : null;
  if (!urlCandidate) {
    throw new Error("Invalid Google Drive folder identifier in backup file_path");
  }
  const url = new URL(urlCandidate);
  const host = url.hostname.toLowerCase();
  if (host !== "drive.google.com" && host !== "docs.google.com") {
    throw new Error(`Unsupported Google Drive host "${url.hostname}" in backup file_path`);
  }
  const folderMatch =
    url.pathname.match(/^\/drive\/(?:u\/\d+\/)?folders\/([a-zA-Z0-9_-]{3,128})(?:\/.*)?$/) ??
    url.pathname.match(/^\/folders\/([a-zA-Z0-9_-]{3,128})(?:\/.*)?$/);
  const queryId = url.searchParams.get("id")?.trim();
  const id = folderMatch?.[1] ?? (queryId && CANONICAL_DRIVE_ID_RE.test(queryId) ? queryId : null);
  if (!id) {
    throw new Error("Could not extract canonical Drive folder ID from backup file_path");
  }
  return id;
}

/**
 * Validate a completed Backup's `file_path` and classify its restorable format:
 * - `"gdrive_tar_gz"`: regular site backup archive (`*.tar.gz` / `*.tgz`)
 * - `"gdrive_sql"`: Sync database safety dump (`*.sql`)
 * Rejects empty, temporary placeholder (`"temp"`), unsupported protocols, or unknown extensions.
 */
export function classifyRestorableBackupFormat(
  filePath: string | null | undefined,
): RestorableBackupFormat {
  if (!filePath || typeof filePath !== "string" || !filePath.trim()) {
    throw new Error("Backup has no file_path — cannot restore.");
  }

  const trimmed = filePath.trim();
  if (!trimmed.startsWith("gdrive:")) {
    throw new Error(
      `Unsupported backup file_path "${trimmed}" — only Google Drive backups (gdrive:{folderId}/{filename}) can be restored.`,
    );
  }

  const rest = trimmed.slice("gdrive:".length);
  const slashIdx = rest.lastIndexOf("/");
  if (slashIdx < 1) {
    throw new Error(
      `Invalid gdrive backup file_path — expected gdrive:{folderId}/{filename}, got: ${trimmed}`,
    );
  }

  const folderRaw = rest.slice(0, slashIdx);
  const filename = rest.slice(slashIdx + 1).trim();
  if (!filename || filename.includes("/") || filename.includes("\\")) {
    throw new Error(`Invalid filename in backup file_path: ${trimmed}`);
  }

  extractFolderId(folderRaw);

  const lower = filename.toLowerCase();
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) {
    return "gdrive_tar_gz";
  }
  if (lower.endsWith(".sql")) {
    return "gdrive_sql";
  }

  throw new Error(
    `Unsupported backup archive extension for "${filename}" — expected .tar.gz, .tgz, or .sql`,
  );
}
