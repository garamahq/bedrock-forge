import { api } from "./api-client";

/**
 * Request an opaque, single-use download ticket via the authenticated API client
 * (attaching the Authorization header and performing transparent token refresh if needed),
 * then initiate a native browser download using `?ticket=` so the JWT access token is
 * never leaked in URLs and multi-GB archives stream directly without JS memory buffering.
 */
export async function triggerAuthenticatedBackupDownload(
  ticketApiPath: string,
  downloadPath: string,
): Promise<void> {
  const { ticket } = await api.post<{ ticket: string }>(ticketApiPath, {});
  const sep = downloadPath.includes("?") ? "&" : "?";
  const url = `${downloadPath}${sep}ticket=${encodeURIComponent(ticket)}`;

  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "";
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}
