import { useState, useRef, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  RotateCcw,
  HardDrive,
  CheckCircle2,
  ChevronDown,
  XCircle,
  Clock,
  Loader2,
} from "lucide-react";
import { api } from "@/lib/api-client";
import { toast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AlertDialog } from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/crud";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useWebSocketEvent, useSubscribeEnvironment } from "@/lib/websocket";
import {
  ExecutionLogPanel,
  ExpandLogButton,
} from "@/components/ui/execution-log-panel";

interface Environment {
  id: number;
  type: string;
  url?: string;
  server: { name: string };
}

interface Backup {
  id: number;
  type: "full" | "db_only" | "files_only";
  status: "pending" | "running" | "completed" | "failed";
  size_bytes: number | null;
  created_at: string;
  completed_at: string | null;
}

interface RestoreJobRow {
  id: number;
  status: string;
  progress: number | null;
  last_error: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

interface RestoreHistoryPage {
  data: RestoreJobRow[];
  total: number;
}

function restoreDuration(
  started?: string | null,
  completed?: string | null,
): string {
  if (!started) return "\u2014";
  const diff =
    (completed ? new Date(completed).getTime() : Date.now()) -
    new Date(started).getTime();
  if (diff < 0) return "\u2014";
  if (diff < 1000) return `${diff}ms`;
  if (diff < 60_000) return `${(diff / 1000).toFixed(1)}s`;
  const mins = Math.floor(diff / 60_000);
  const secs = Math.floor((diff % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}

function RestoreStatusIcon({ status }: { status: string }) {
  if (status === "completed")
    return (
      <CheckCircle2 className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />
    );
  if (status === "failed")
    return <XCircle className="h-3.5 w-3.5 text-destructive" />;
  if (status === "active")
    return <Loader2 className="h-3.5 w-3.5 text-blue-500 animate-spin" />;
  return <Clock className="h-3.5 w-3.5 text-muted-foreground" />;
}

function RestoreHistoryRow({
  row,
  onCancel,
  isCancelling,
}: {
  row: RestoreJobRow;
  onCancel?: (id: number) => void;
  isCancelling?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const isActive = row.status === "active" || row.status === "pending";

  return (
    <>
      <tr className="border-b last:border-0 hover:bg-muted/30 transition-colors">
        <td className="py-2.5 pl-4 pr-2 whitespace-nowrap">
          <div className="flex items-center gap-1.5 text-xs font-medium capitalize">
            <RestoreStatusIcon status={row.status} />
            {row.status}
          </div>
        </td>
        <td className="py-2.5 px-2 text-xs text-muted-foreground whitespace-nowrap">
          {row.started_at
            ? new Date(row.started_at).toLocaleString([], {
                dateStyle: "short",
                timeStyle: "short",
              })
            : new Date(row.created_at).toLocaleString([], {
                dateStyle: "short",
                timeStyle: "short",
              })}
        </td>
        <td className="py-2.5 px-2 text-xs text-muted-foreground whitespace-nowrap">
          {restoreDuration(row.started_at, row.completed_at)}
        </td>
        <td className="py-2.5 px-2 text-xs">
          {row.status === "active" && row.progress != null ? (
            <div className="flex items-center gap-2">
              <div className="w-16 bg-muted rounded-full h-1.5">
                <div
                  className="bg-primary h-1.5 rounded-full"
                  style={{ width: `${row.progress}%` }}
                />
              </div>
              <span className="text-muted-foreground">{row.progress}%</span>
            </div>
          ) : row.status === "failed" && row.last_error ? (
            <span
              className="text-destructive truncate max-w-[200px] block"
              title={row.last_error}
            >
              {row.last_error}
            </span>
          ) : null}
        </td>
        <td className="py-2.5 pr-4 pl-2 text-right whitespace-nowrap flex items-center gap-2">
          <ExpandLogButton
            expanded={expanded}
            onToggle={() => setExpanded((v) => !v)}
          />
          {/* Cancel button for active jobs */}
          {row.status === "active" && (
            <Button
              variant="ghost"
              size="icon"
              disabled={isCancelling}
              onClick={() => onCancel?.(row.id)}
              title="Cancel restore job"
            >
              <XCircle className="h-4 w-4 text-destructive" />
            </Button>
          )}
        </td>
      </tr>
      {expanded && (
        <tr className="bg-muted/20 border-b last:border-0">
          <td colSpan={5} className="px-4 pb-4 pt-2">
            <ExecutionLogPanel jobExecutionId={row.id} isActive={isActive} />
          </td>
        </tr>
      )}
    </>
  );
}

const BACKUP_TYPE_LABELS: Record<string, string> = {
  full: "Full",
  db_only: "Database",
  files_only: "Files",
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

export function RestoreTab({
  environments,
}: {
  projectId: number;
  environments: Environment[];
}) {
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const envParam = searchParams.get("env");
  const initialEnvId = envParam ? Number(envParam) : null;
  const validInitialEnv = environments.find((e) => e.id === initialEnvId)
    ? initialEnvId
    : (environments[0]?.id ?? null);

  const [selectedEnvId, setSelectedEnvId] = useState<number | null>(
    validInitialEnv,
  );

  useEffect(() => {
    if (selectedEnvId) {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (next.get("env") !== String(selectedEnvId)) {
            next.set("env", String(selectedEnvId));
          }
          return next;
        },
        { replace: true },
      );
    }
  }, [selectedEnvId, setSearchParams]);

  const [restoreTarget, setRestoreTarget] = useState<Backup | null>(null);
  const [jobProgress, setJobProgress] = useState<number | null>(null);
  const [jobExecutionId, setJobExecutionId] = useState<number | null>(null);
  const restoreJobIdRef = useRef<string | null>(null);
  const restoreEnvIdRef = useRef<number | null>(null);

  const {
    data: restoreHistory,
    isLoading: restoreHistoryLoading,
    isError: restoreHistoryError,
    refetch: refetchRestoreHistory,
  } = useQuery({
    queryKey: ["restore-history", selectedEnvId],
    queryFn: () =>
      api.get<RestoreHistoryPage>(
        `/job-executions?queue_name=backups&job_type=backup%3Arestore&environment_ids=${selectedEnvId}&limit=10`,
      ),
    enabled: !!selectedEnvId,
    staleTime: 15_000,
    refetchInterval: 30_000,
  });

  useSubscribeEnvironment(selectedEnvId);

  const {
    data,
    isLoading,
    isError: backupsError,
    refetch: refetchBackups,
  } = useQuery({
    queryKey: ["backups", selectedEnvId],
    enabled: !!selectedEnvId,
    queryFn: () =>
      api.get<{ items: Backup[]; total: number }>(
        `/backups/environment/${selectedEnvId}?page=1&limit=50`,
      ),
  });

  const completedBackups =
    data?.items.filter((b) => b.status === "completed") ?? [];

  // WebSocket: track restore job progress
  useWebSocketEvent("job:progress", (raw: unknown) => {
    const event = raw as {
      queueName: string;
      jobId: string;
      progress: number;
      environmentId?: number;
    };
    const isOurs =
      event.queueName === "backups" &&
      (event.environmentId === restoreEnvIdRef.current ||
        (event.jobId != null && event.jobId === restoreJobIdRef.current));
    if (isOurs) setJobProgress(event.progress);
  });

  useWebSocketEvent("job:completed", (raw: unknown) => {
    const event = raw as {
      queueName: string;
      jobId?: string;
      environmentId?: number;
    };
    const isOurs =
      event.queueName === "backups" &&
      (event.environmentId === restoreEnvIdRef.current ||
        (event.jobId != null && event.jobId === restoreJobIdRef.current));
    if (!isOurs) return;
    restoreJobIdRef.current = null;
    restoreEnvIdRef.current = null;
    setJobProgress(null);
    qc.invalidateQueries({ queryKey: ["backups", selectedEnvId] });
    toast({ title: "Restore completed successfully" });
  });

  useWebSocketEvent("job:failed", (raw: unknown) => {
    const event = raw as {
      queueName: string;
      jobId?: string;
      environmentId?: number;
      error?: string;
    };
    const isOurs =
      event.queueName === "backups" &&
      (event.environmentId === restoreEnvIdRef.current ||
        (event.jobId != null && event.jobId === restoreJobIdRef.current));
    if (!isOurs) return;
    restoreJobIdRef.current = null;
    restoreEnvIdRef.current = null;
    setJobProgress(null);
    qc.invalidateQueries({ queryKey: ["backups", selectedEnvId] });
    toast({
      title: "Restore failed",
      description: event.error ?? "An unexpected error occurred",
      variant: "destructive",
    });
  });

  const restoreMutation = useMutation({
    mutationFn: (backupId: number) =>
      api.post<{ jobExecutionId: number; bullJobId: string }>(
        "/backups/restore",
        { backupId },
      ),
    onSuccess: (result, backupId) => {
      restoreJobIdRef.current = result?.bullJobId ?? null;
      restoreEnvIdRef.current = selectedEnvId;
      setJobProgress(0);
      setJobExecutionId(result?.jobExecutionId ?? null);
      setRestoreTarget(null);
      toast({
        title: "Restore queued",
        description: `Backup #${backupId} restore job is running`,
      });
    },
    onError: () =>
      toast({ title: "Restore failed to start", variant: "destructive" }),
  });

  const cancelMutation = useMutation({
    mutationFn: (execId: number) =>
      api.post<{ cancelled: boolean }>(
        `/backups/execution/${execId}/cancel`,
        {},
      ),
    onSuccess: () => {
      setJobProgress(null);
      setJobExecutionId(null);
      restoreJobIdRef.current = null;
      restoreEnvIdRef.current = null;
      qc.invalidateQueries({ queryKey: ["restore-history", selectedEnvId] });
      toast({ title: "Restore job cancelled" });
    },
    onError: () =>
      toast({ title: "Could not cancel restore", variant: "destructive" }),
  });

  if (environments.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <HardDrive className="h-10 w-10 mx-auto mb-3 opacity-40" />
        <p className="font-medium">No environments configured</p>
        <p className="text-sm mt-1">
          Add an environment first to restore backups
        </p>
      </div>
    );
  }

  const selectedEnv = environments.find((e) => e.id === selectedEnvId);
  const isRestoring = jobProgress !== null;

  return (
    <div className="space-y-5">
      {/* Environment selector */}
      <div className="flex flex-wrap items-center gap-3">
        <Select
          value={selectedEnvId?.toString()}
          onValueChange={(v) => {
            setSelectedEnvId(Number(v));
            setJobProgress(null);
            setJobExecutionId(null);
            restoreJobIdRef.current = null;
            restoreEnvIdRef.current = null;
          }}
        >
          <SelectTrigger className="w-56">
            <SelectValue placeholder="Select environment…" />
          </SelectTrigger>
          <SelectContent>
            {environments.map((e) => (
              <SelectItem key={e.id} value={e.id.toString()}>
                <span className="capitalize">{e.type}</span>
                <span className="text-muted-foreground ml-1.5 text-xs">
                  ({e.server.name})
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Active restore progress + live log */}
      {isRestoring && (
        <div className="border rounded-lg p-4 space-y-2 bg-card">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm font-medium">
              <RotateCcw className="h-4 w-4 animate-spin text-primary" />
              Restore in progress…
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs gap-1.5 text-destructive border-destructive/40 hover:bg-destructive/10"
              disabled={cancelMutation.isPending || !jobExecutionId}
              onClick={() =>
                jobExecutionId && cancelMutation.mutate(jobExecutionId)
              }
            >
              <XCircle className="h-3.5 w-3.5" />
              {cancelMutation.isPending ? "Stopping…" : "Stop"}
            </Button>
          </div>
          <div className="h-2 rounded-full bg-muted overflow-hidden">
            <div
              className="h-2 bg-primary rounded-full transition-all duration-300"
              style={{ width: `${jobProgress ?? 0}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground text-right">
            {jobProgress ?? 0}%
          </p>
          {jobExecutionId && (
            <div className="mt-3 border-t pt-3">
              <ExecutionLogPanel
                jobExecutionId={jobExecutionId}
                isActive={isRestoring}
              />
            </div>
          )}
        </div>
      )}

      {/* Backups list */}
      {!selectedEnvId && (
        <p className="text-sm text-muted-foreground">
          Select an environment to see restorable backups.
        </p>
      )}

      {selectedEnvId && isLoading && (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-16 rounded-lg" />
          ))}
        </div>
      )}

      {selectedEnvId && backupsError && (
        <ErrorState
          title="Could not load restorable backups"
          onRetry={() => void refetchBackups()}
        />
      )}

      {selectedEnvId &&
        !isLoading &&
        !backupsError &&
        completedBackups.length === 0 && (
          <div className="text-center py-16 border rounded-xl text-muted-foreground">
            <CheckCircle2 className="h-10 w-10 mx-auto mb-3 opacity-40" />
            <p className="font-medium">No completed backups</p>
            <p className="text-sm mt-1">
              Create a backup first from the{" "}
              <span className="font-medium">Backups</span> tab
            </p>
          </div>
        )}

      {selectedEnvId &&
        !isLoading &&
        !backupsError &&
        completedBackups.length > 0 && (
          <>
            <p className="text-sm text-muted-foreground">
              {completedBackups.length} restorable backup
              {completedBackups.length !== 1 ? "s" : ""} for{" "}
              <span className="font-medium capitalize">
                {selectedEnv?.type ?? `env #${selectedEnvId}`}
              </span>{" "}
              — restoring will overwrite the current site
            </p>

            <div className="border rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/40">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium">Type</th>
                    <th className="text-left px-4 py-3 font-medium">Size</th>
                    <th className="text-left px-4 py-3 font-medium">Created</th>
                    <th className="text-left px-4 py-3 font-medium">
                      Completed
                    </th>
                    <th className="w-24" />
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {completedBackups.map((b) => (
                    <tr
                      key={b.id}
                      className="hover:bg-muted/20 transition-colors"
                    >
                      <td className="px-4 py-3">
                        <Badge variant="outline" className="text-xs">
                          {BACKUP_TYPE_LABELS[b.type]}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground font-mono text-xs">
                        {b.size_bytes ? formatBytes(b.size_bytes) : "—"}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground text-xs">
                        {new Date(b.created_at).toLocaleString()}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground text-xs">
                        {b.completed_at
                          ? new Date(b.completed_at).toLocaleString()
                          : "—"}
                      </td>
                      <td className="px-3 py-3">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs gap-1.5"
                          disabled={isRestoring || restoreMutation.isPending}
                          onClick={() => setRestoreTarget(b)}
                        >
                          <RotateCcw className="h-3 w-3" />
                          Restore
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

      <AlertDialog
        open={!!restoreTarget}
        onOpenChange={(o) => !o && setRestoreTarget(null)}
        title="Restore Backup"
        description={`This will overwrite all current site files and/or database on "${selectedEnv?.type ?? ""}" with the ${restoreTarget ? BACKUP_TYPE_LABELS[restoreTarget.type] : ""} backup from ${restoreTarget ? new Date(restoreTarget.created_at).toLocaleString() : ""}. This cannot be undone.`}
        confirmLabel="Restore"
        confirmVariant="destructive"
        onConfirm={() =>
          restoreTarget && restoreMutation.mutate(restoreTarget.id)
        }
        isPending={restoreMutation.isPending}
      />

      {/* Restore History */}
      {selectedEnvId && (
        <div className="space-y-3 pt-2">
          <h4 className="text-sm font-semibold">Restore History</h4>

          {restoreHistoryError ? (
            <ErrorState
              title="Could not load restore history"
              onRetry={() => void refetchRestoreHistory()}
              className="py-8"
            />
          ) : restoreHistoryLoading ? (
            <div className="border rounded-lg text-center py-8 text-muted-foreground text-sm">
              Loading restore history…
            </div>
          ) : !restoreHistory || restoreHistory.data.length === 0 ? (
            <div className="border rounded-lg text-center py-8 text-muted-foreground text-sm">
              No restore jobs yet for this environment.
            </div>
          ) : (
            <div className="border rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/40">
                  <tr>
                    <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">
                      Status
                    </th>
                    <th className="text-left px-2 py-2.5 text-xs font-medium text-muted-foreground">
                      Started
                    </th>
                    <th className="text-left px-2 py-2.5 text-xs font-medium text-muted-foreground">
                      Duration
                    </th>
                    <th className="text-left px-2 py-2.5 text-xs font-medium text-muted-foreground">
                      Details
                    </th>
                    <th className="py-2.5 pr-4 pl-2 w-16" />
                  </tr>
                </thead>
                <tbody>
                  {restoreHistory.data.map((row) => (
                    <RestoreHistoryRow
                      key={row.id}
                      row={row}
                      onCancel={cancelMutation.mutate}
                      isCancelling={cancelMutation.isPending}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
