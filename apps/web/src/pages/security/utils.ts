import type { ScanRecord } from "./types";
import {
  ENVIRONMENT_HARDENING_ACTIONS,
  SERVER_HARDENING_ACTIONS,
} from "./constants";

/** Maps scan_type enum values to human-readable labels. */
export function formatScanType(scanType: string): string {
  const labels: Record<string, string> = {
    SSH_AUDIT: "SSH Audit",
    SERVER_HARDENING: "Server Hardening",
    MALWARE_SCAN: "Malware Scan",
    WP_AUDIT: "WP Audit",
    PROJECT_MALWARE: "Project Malware Scan",
  };
  return labels[scanType] ?? scanType.replace(/_/g, " ");
}

/**
 * Groups an ordered-desc list of scans into "runs" — consecutive scans whose
 * created_at timestamps are within 15 minutes of each other belong to one run.
 */
export function groupScansByRun(scans: ScanRecord[]): ScanRecord[][] {
  if (!scans.length) return [];
  const WINDOW_MS = 15 * 60 * 1000;
  const groups: ScanRecord[][] = [[scans[0]]];
  for (let i = 1; i < scans.length; i++) {
    const prev = new Date(scans[i - 1].created_at).getTime();
    const curr = new Date(scans[i].created_at).getTime();
    if (Math.abs(prev - curr) <= WINDOW_MS) {
      groups[groups.length - 1].push(scans[i]);
    } else {
      groups.push([scans[i]]);
    }
  }
  return groups;
}

/**
 * Maps a finding category+title to a hardening action ID that can fix it.
 * Returns null when no automated fix is available.
 */
export function getFixAction(
  category: string,
  title: string,
  targetType: "server" | "environment",
): string | null {
  const t = title.toLowerCase();
  if (targetType === "server") {
    if (category === "SECURITY_TOOLS" && t.includes("auditd"))
      return "INSTALL_AUDITD";
    if (category === "SECURITY_TOOLS" && t.includes("fail2ban"))
      return "INSTALL_FAIL2BAN";
    if (
      category === "FAILED_LOGINS" &&
      (t.includes("brute") || t.includes("brute-force"))
    )
      return "BLOCK_BRUTE_FORCE_IPS";
    if (category === "SSH_CONFIG" && t.includes("password authentication"))
      return null; // DISABLE_PASSWORD_AUTH has been disabled for safety
    if (category === "SSH_CONFIG" && t.includes("maxauthtries"))
      return "SET_MAX_AUTH_TRIES";
    if (category === "SSH_CONFIG" && t.includes("x11forwarding"))
      return "DISABLE_X11_FORWARDING";
    if (category === "WORLD_WRITABLE") return "FIX_WORLD_WRITABLE";
    if (
      category === "SSH_CONFIG" &&
      (t.includes(".ssh") || t.includes("directory permissions"))
    )
      return "FIX_SSH_DIR_PERMS";
    if (category === "LISTENING_PORTS") return "RESTRICT_INTERNAL_PORTS";
    if (category === "SUSPICIOUS_FILES" && t.includes("upload"))
      return "DELETE_PHP_UPLOAD_FILES";
    if (
      category === "HTACCESS" &&
      (t.includes("redirect") || t.includes("suspicious"))
    )
      return "CLEAN_HTACCESS_REDIRECTS";
    if (category === "MALWARE") return "QUARANTINE_MALWARE";
  } else {
    if (category === "SUSPICIOUS_FILES" && t.includes("upload"))
      return "DELETE_PHP_UPLOAD_FILES";
    if (
      category === "HTACCESS" &&
      (t.includes("redirect") ||
        t.includes("suspicious") ||
        t.includes("malicious"))
    )
      return "CLEAN_HTACCESS_REDIRECTS";
    if (category === "WP_CONFIG" && t.includes("xmlrpc")) return "BLOCK_XMLRPC";
    if (
      category === "VERSION_DISCLOSURE" &&
      (t.includes("readme") || t.includes("version disclosure"))
    )
      return "BLOCK_VERSION_DISCLOSURE";
    if (category === "VERSION_DISCLOSURE" && t.includes("debug.log"))
      return "BLOCK_DEBUG_LOG";
    if (
      category === "VERSION_DISCLOSURE" &&
      (t.includes(".env") ||
        t.includes("composer") ||
        t.includes("sensitive") ||
        t.includes("bedrock /app") ||
        t.includes("app path"))
    )
      return "BLOCK_SENSITIVE_FILES";
    if (
      category === "WP_CONFIG" &&
      (t.includes("file editor") || t.includes("disallow_file_edit"))
    )
      return "DISABLE_FILE_EDITOR";
    if (
      category === "VERSION_DISCLOSURE" &&
      (t.includes("author=") ||
        t.includes("user enumeration") ||
        t.includes("username"))
    )
      return "BLOCK_USER_ENUMERATION";
    if (category === "WP_CORE_INTEGRITY") return "FORCE_REINSTALL_CORE";
    if (category === "MALWARE") {
      if (t.includes("vulnerability")) return "UPDATE_ALL_PLUGINS";
      return "QUARANTINE_MALWARE";
    }
  }
  return null;
}

export function getHardeningActionDisplay(actionId: string) {
  const action = [
    ...ENVIRONMENT_HARDENING_ACTIONS,
    ...SERVER_HARDENING_ACTIONS,
  ].find((item) => item.id === actionId) as
    | {
        label: string;
        description: string;
        preview?: string;
        risk?: "safe" | "review" | "risky";
        risky?: boolean;
      }
    | undefined;

  return {
    label: action?.label ?? actionId.replace(/_/g, " "),
    description:
      action?.description ?? "Apply the recommended hardening action.",
    preview:
      action?.preview ??
      action?.description ??
      "Review this action before applying it.",
    risk: action?.risk ?? (action?.risky ? "risky" : "safe"),
  };
}

export function hardeningRiskLabel(risk: string) {
  if (risk === "risky") return "Opt-in";
  if (risk === "review") return "Review";
  return "Safe";
}
