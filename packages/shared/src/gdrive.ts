export interface GdriveFilePath {
  folderId: string;
  filename: string;
}

const CANONICAL_DRIVE_FOLDER_ID_RE = /^[a-zA-Z0-9_-]{3,128}$/;
const ALLOWED_DRIVE_HOSTS = new Set(["drive.google.com", "docs.google.com"]);
const DRIVE_FOLDER_PATH_PATTERNS = [
  /^\/drive\/(?:u\/\d+\/)?folders\/([a-zA-Z0-9_-]{3,128})(?:\/.*)?$/,
  /^\/folders\/([a-zA-Z0-9_-]{3,128})(?:\/.*)?$/,
];

/**
 * Normalize either a canonical Google Drive folder ID or a supported Google Drive
 * folder URL (e.g. `https://drive.google.com/drive/folders/<id>?usp=sharing` or
 * `https://drive.google.com/open?id=<id>`) into the bare canonical folder ID.
 * Throws if the input is empty, contains unsupported domains/syntax, or cannot be parsed.
 */
export function normalizeGoogleDriveFolderId(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Invalid Google Drive folder ID: value must not be empty");
  }

  if (CANONICAL_DRIVE_FOLDER_ID_RE.test(trimmed)) {
    return trimmed;
  }

  // Reject anything containing whitespace or shell/path metacharacters unless it parses as a Google Drive URL
  const candidateUrl = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : /^drive\.google\.com\//i.test(trimmed) || /^docs\.google\.com\//i.test(trimmed)
      ? `https://${trimmed}`
      : null;

  if (!candidateUrl) {
    throw new Error(
      `Invalid Google Drive folder ID or URL: expected canonical ID or drive.google.com folder URL`,
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(candidateUrl);
  } catch {
    throw new Error(`Invalid Google Drive folder URL`);
  }

  if (!ALLOWED_DRIVE_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error(
      `Invalid Google Drive folder URL: unsupported host "${parsed.hostname}"`,
    );
  }

  for (const re of DRIVE_FOLDER_PATH_PATTERNS) {
    const match = parsed.pathname.match(re);
    if (match?.[1] && CANONICAL_DRIVE_FOLDER_ID_RE.test(match[1])) {
      return match[1];
    }
  }

  const queryId = parsed.searchParams.get("id")?.trim();
  if (queryId && CANONICAL_DRIVE_FOLDER_ID_RE.test(queryId)) {
    return queryId;
  }

  throw new Error(
    `Invalid Google Drive folder URL: could not extract canonical folder ID`,
  );
}

/**
 * Returns true if the value is a canonical Drive folder ID or supported Drive folder URL.
 */
export function isValidGoogleDriveFolderId(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  try {
    normalizeGoogleDriveFolderId(raw);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse a stored `gdrive:{folderId}/{filename}` path into canonical components.
 * Uses `lastIndexOf("/")` so legacy stored Drive folder URLs can still be recovered
 * and normalized cleanly while rejecting malformed or empty components.
 */
export function parseGdriveFilePath(filePath: string): GdriveFilePath {
  if (!filePath.startsWith("gdrive:")) {
    throw new Error(`Invalid gdrive file_path format: ${filePath}`);
  }
  const rest = filePath.slice("gdrive:".length);
  const slashIdx = rest.lastIndexOf("/");
  if (slashIdx < 1) {
    throw new Error(
      `Invalid gdrive file_path — expected gdrive:{folderId}/{filename}, got: ${filePath}`,
    );
  }
  const rawFolder = rest.slice(0, slashIdx);
  const filename = rest.slice(slashIdx + 1).trim();
  if (!filename || filename.includes("/")) {
    throw new Error(
      `Invalid gdrive file_path — missing or invalid filename in: ${filePath}`,
    );
  }
  const folderId = normalizeGoogleDriveFolderId(rawFolder);
  return { folderId, filename };
}
