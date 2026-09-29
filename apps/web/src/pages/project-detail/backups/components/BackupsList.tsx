import { useState, Fragment } from "react";
import {
  Trash2,
  RotateCcw,
  Download,
  XCircle,
  ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ExecutionLogPanel,
  ExpandLogButton,
} from "@/components/ui/execution-log-panel";
import { Backup, Environment } from "../types";
import { BACKUP_TYPE_LABELS, STATUS_VARIANT, formatBytes } from "../utils";

export function BackupsList({
  data,
  isLoading,
  selectedEnv,
  onRestoreClick,
  onDeleteClick,
  canDelete,
  cancelBackupMutation,
}: {
  data?: { items: Backup[]; total: number };
  isLoading: boolean;
  selectedEnv?: Environment;
  onRestoreClick: (b: Backup) => void;
  onDeleteClick: (b: Backup) => void;
  canDelete: boolean;
  cancelBackupMutation: { isPending: boolean; mutate: (id: number) => void };
}) {
  const [expandedLogId, setExpandedLogId] = useState<number | null>(null);

  if (isLoading) {
    return (
      <div className="space-y-2">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-12 rounded-lg" />
        ))}
      </div>
    );
  }

  return (
    <div className="border rounded-lg overflow-hidden">
      <table className="w-full text-sm">
        <thead className="border-b bg-muted/40">
          <tr>
            <th className="text-left px-4 py-3 font-medium">Type</th>
            <th className="text-left px-4 py-3 font-medium">Size</th>
            <th className="text-left px-4 py-3 font-medium">Status</th>
            <th className="text-left px-4 py-3 font-medium">Created</th>
            <th className="w-36" />
          </tr>
        </thead>
        <tbody className="divide-y">
          {data?.items.map((b) => (
            <Fragment key={b.id}>
              <tr>
                <td className="px-4 py-3">
                  <Badge variant="outline" className="text-xs">
                    {BACKUP_TYPE_LABELS[b.type]}
                  </Badge>
                </td>
                <td className="px-4 py-3 text-muted-foreground">
                  {b.size_bytes ? formatBytes(b.size_bytes) : "—"}
                </td>
                <td className="px-4 py-3">
                  <Badge variant={STATUS_VARIANT[b.status] ?? "secondary"}>
                    {b.status}
                  </Badge>{" "}
                  {b.status === "failed" &&
                    (b.error_message ?? b.jobExecution?.last_error) && (
                      <p
                        className="text-xs text-destructive mt-0.5 max-w-xs truncate"
                        title={
                          b.error_message ??
                          b.jobExecution?.last_error ??
                          undefined
                        }
                      >
                        {b.error_message ?? b.jobExecution?.last_error}
                      </p>
                    )}{" "}
                </td>
                <td className="px-4 py-3 text-muted-foreground text-xs">
                  {new Date(b.created_at).toLocaleString()}
                </td>
                <td className="px-2 py-3">
                  <div className="flex items-center gap-1 justify-end">
                    <ExpandLogButton
                      expanded={expandedLogId === b.jobExecution?.id}
                      onToggle={() =>
                        setExpandedLogId((prev) =>
                          prev === b.jobExecution?.id
                            ? null
                            : (b.jobExecution?.id ?? null),
                        )
                      }
                      disabled={!b.jobExecution?.id}
                    />{" "}
                    {b.status === "running" && b.jobExecution?.id && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        title="Force stop backup"
                        disabled={cancelBackupMutation.isPending}
                        onClick={() =>
                          cancelBackupMutation.mutate(b.jobExecution!.id)
                        }
                      >
                        <XCircle className="h-3.5 w-3.5 text-destructive" />
                      </Button>
                    )}{" "}
                    {b.status === "completed" && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        title="Restore"
                        onClick={() => onRestoreClick(b)}
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    {b.status === "completed" && (
                      <>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          title="Download backup (stream from Drive)"
                          onClick={() =>
                            window.open(
                              `/api/backups/${b.id}/download`,
                              "_blank",
                            )
                          }
                        >
                          <Download className="h-3.5 w-3.5" />
                        </Button>
                        {selectedEnv?.google_drive_folder_id && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-muted-foreground hover:text-primary"
                            title="Open in Google Drive"
                            onClick={() =>
                              window.open(
                                `https://drive.google.com/drive/folders/${selectedEnv.google_drive_folder_id}`,
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
                    {canDelete && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-destructive hover:text-destructive"
                        title="Delete"
                        aria-label="Delete backup"
                        onClick={() => onDeleteClick(b)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
              {expandedLogId === b.jobExecution?.id && (
                <tr key={`log-${b.id}`}>
                  <td colSpan={5} className="px-4 pb-3 bg-muted/30">
                    <ExecutionLogPanel
                      jobExecutionId={b.jobExecution?.id ?? null}
                    />
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
      {!data?.items.length && (
        <p className="text-center text-muted-foreground py-10 text-sm">
          No backups for this environment yet.
        </p>
      )}
    </div>
  );
}
