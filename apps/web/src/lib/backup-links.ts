const GDRIVE_FOLDER_BASE_URL = "https://drive.google.com/drive/folders";

/**
 * Resolve the Google Drive folder URL from a backup's recorded `file_path`.
 * Falls back to the current configured folder only for legacy records without `file_path`.
 */
export function resolveGdriveFolderUrl(
  filePath?: string | null,
  fallbackFolderId?: string | null,
): string | null {
  const trimmedPath = filePath?.trim();
  if (trimmedPath) {
    if (trimmedPath.startsWith("gdrive:")) {
      const rest = trimmedPath.slice("gdrive:".length).replace(/^\/+/, "");
      const folderId = rest.split("/")[0]?.trim();
      if (!folderId || folderId === "." || folderId === "..") {
        return null;
      }
      return `${GDRIVE_FOLDER_BASE_URL}/${encodeURIComponent(folderId)}`;
    }

    const urlMatch =
      /^https:\/\/drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/([A-Za-z0-9_-]+)/.exec(
        trimmedPath,
      );
    if (urlMatch?.[1]) {
      return `${GDRIVE_FOLDER_BASE_URL}/${encodeURIComponent(urlMatch[1])}`;
    }

    return null;
  }

  const fallback = fallbackFolderId?.trim();
  if (!fallback) {
    return null;
  }
  return `${GDRIVE_FOLDER_BASE_URL}/${encodeURIComponent(fallback)}`;
}
