import React from "react";
import { RefreshCw, Download, ExternalLink, Loader2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useSystemBackups, useSystemBackupFolder } from "../hooks";
import { SystemBackupItem } from "../types";
import { triggerAuthenticatedBackupDownload } from "@/lib/download";
import { toast } from "@/hooks/use-toast";

export function BackupHistoryList() {
  const qc = useQueryClient();
  const { data: systemBackups, isLoading: backupsLoading } = useSystemBackups();
  const { data: systemBackupFolder } = useSystemBackupFolder();

  function formatBytes(bytes: string | null): string {
    if (!bytes) return "—";
    const n = Number(bytes);
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  function statusBadge(status: SystemBackupItem["status"]) {
    switch (status) {
      case "completed":
        return <Badge variant="success">Completed</Badge>;
      case "failed":
        return <Badge variant="destructive">Failed</Badge>;
      case "running":
        return (
          <Badge variant="info">
            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
            Running
          </Badge>
        );
      default:
        return <Badge variant="outline">Pending</Badge>;
    }
  }

  return (
    <div className="border rounded-lg bg-card">
      <div className="flex items-center justify-between px-4 py-3 border-b">
        <h3 className="font-medium text-sm">Backup History</h3>
        <Button
          variant="ghost"
          size="sm"
          className="h-7"
          onClick={() => qc.invalidateQueries({ queryKey: ["system-backups"] })}
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>

      {backupsLoading && (
        <p className="px-4 py-3 text-sm text-muted-foreground">Loading…</p>
      )}

      {!backupsLoading && !systemBackups?.items?.length && (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          No backups yet. Click &quot;Backup Now&quot; to create your first
          system backup.
        </p>
      )}

      {(systemBackups?.items ?? []).map((b) => (
        <div
          key={b.id}
          className="flex items-start justify-between px-4 py-3 gap-4 border-b last:border-0"
        >
          <div className="space-y-0.5 min-w-0">
            <div className="flex items-center gap-2">
              {statusBadge(b.status)}
              <span className="text-xs text-muted-foreground">
                {new Date(b.created_at).toLocaleString()}
              </span>
            </div>
            {b.file_path && (
              <p className="text-xs text-muted-foreground font-mono truncate max-w-xs">
                {b.file_path.split("/").pop()}
              </p>
            )}
            {b.error_message && (
              <p className="text-xs text-destructive truncate max-w-sm">
                {b.error_message}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {b.status === "completed" && (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  title="Download backup (stream from Drive)"
                  onClick={() => {
                    void triggerAuthenticatedBackupDownload(
                      `/system-backups/${b.id}/download-ticket`,
                      `/api/system-backups/${b.id}/download`,
                    ).catch((err) => {
                      toast({
                        title: "Download failed",
                        description:
                          err instanceof Error
                            ? err.message
                            : "Could not start system backup download",
                        variant: "destructive",
                      });
                    });
                  }}
                >
                  <Download className="h-3.5 w-3.5" />
                </Button>
                {systemBackupFolder?.folder_id && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-primary"
                    title="Open Google Drive folder"
                    onClick={() =>
                      window.open(
                        `https://drive.google.com/drive/folders/${systemBackupFolder.folder_id}`,
                        "_blank",
                        "noopener",
                      )
                    }
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </Button>
                )}
              </>
            )}
            <div className="text-xs text-muted-foreground tabular-nums text-right">
              {formatBytes(b.size_bytes)}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
