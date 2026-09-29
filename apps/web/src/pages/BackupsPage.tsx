import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, Fragment, useEffect, useMemo } from "react";
import {
  Trash2,
  Download,
  RotateCcw,
  AlertCircle,
  ExternalLink,
  FolderKanban,
  Globe,
} from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "@/lib/api-client";
import { useAuthStore } from "@/store/auth.store";
import { useWebSocketEvent, useSubscribeEnvironment } from "@/lib/websocket";
import { WS_EVENTS } from "@bedrock-forge/shared";
import { toast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AlertDialog } from "@/components/ui/alert-dialog";
import { Pagination } from "@/components/crud";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ExecutionLogPanel,
  ExpandLogButton,
} from "@/components/ui/execution-log-panel";
import { BulkActionsBar } from "@/components/ui/bulk-actions-bar";

interface Environment {
  id: number;
  type: string;
  url: string;
  google_drive_folder_id: string | null;
  project: { id: number; name: string };
  server: { name: string };
}

interface Backup {
  id: number;
  type: string;
  status: string;
  size_bytes: number | null;
  error_message: string | null;
  created_at: string;
  environment: { id: number; project: { id: number; name: string } };
  jobExecution: {
    id: number;
    bull_job_id: string;
    status: string;
    progress: number;
    last_error: string | null;
    execution_log: unknown[] | null;
  } | null;
}

interface PaginatedBackups {
  items: Backup[];
  total: number;
}

function fmt(bytes: number | null) {
  if (!bytes) return "—";
  if (bytes > 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

const BACKUP_TYPES = [
  { value: "full", label: "Full (files + DB)" },
  { value: "db_only", label: "Database only" },
  { value: "files_only", label: "Files only" },
  { value: "incremental", label: "Incremental (files + DB)" },
];

export function BackupsPage() {
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const projectId = searchParams.get("project_id") ?? "all";
  const requestedEnvId = Number(searchParams.get("environment_id"));
  const envId =
    Number.isSafeInteger(requestedEnvId) && requestedEnvId > 0
      ? requestedEnvId
      : null;
  const [backupType, setBackupType] = useState<string>("full");
  const [page, setPage] = useState(1);
  const [restoreTarget, setRestoreTarget] = useState<Backup | null>(null);
  const [restoreTargetEnvId, setRestoreTargetEnvId] = useState<number | null>(
    null,
  );
  const [deleteTarget, setDeleteTarget] = useState<Backup | null>(null);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);
  const isAdmin = useAuthStore(
    (s) => s.user?.roles?.includes("admin") ?? false,
  );
  const [jobProgress, setJobProgress] = useState<Record<string, number>>({});

  const {
    data: envs,
    isError: envsError,
    refetch: refetchEnvs,
  } = useQuery({
    queryKey: ["environments-all"],
    queryFn: () => api.get<Environment[]>("/environments"),
  });

  const projects = useMemo(() => {
    const map = new Map<
      number,
      { id: number; name: string; envCount: number }
    >();
    for (const e of envs ?? []) {
      if (e.project) {
        const existing = map.get(e.project.id);
        if (existing) {
          existing.envCount++;
        } else {
          map.set(e.project.id, {
            id: e.project.id,
            name: e.project.name,
            envCount: 1,
          });
        }
      }
    }
    return Array.from(map.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }, [envs]);

  const filteredEnvs = useMemo(() => {
    if (!envs) return [];
    if (projectId === "all") return envs;
    return envs.filter((e) => String(e.project.id) === projectId);
  }, [envs, projectId]);

  useEffect(() => {
    if (!envs || projectId === "all") return;
    const currentEnv = envs.find((environment) => environment.id === envId);
    if (currentEnv && String(currentEnv.project.id) === projectId) return;
    const nextEnv = envs.find(
      (environment) => String(environment.project.id) === projectId,
    );
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (nextEnv) next.set("environment_id", String(nextEnv.id));
        else next.delete("environment_id");
        return next;
      },
      { replace: true },
    );
  }, [envs, envId, projectId, setSearchParams]);

  const {
    data: backupsData,
    isLoading,
    isError: backupsError,
    refetch: refetchBackups,
  } = useQuery({
    queryKey: ["backups", envId, page],
    queryFn: () =>
      api.get<PaginatedBackups>(
        `/backups/environment/${envId}?page=${page}&limit=10`,
      ),
    enabled: !!envId,
    refetchInterval: 15_000,
  });

  useEffect(() => {
    const visibleIds = new Set(
      backupsData?.items.map((backup) => backup.id) ?? [],
    );
    setSelectedIds((previous) => {
      const next = previous.filter((backupId) => visibleIds.has(backupId));
      return next.length === previous.length ? previous : next;
    });
  }, [backupsData?.items]);

  const createBackup = useMutation({
    mutationFn: () =>
      api.post("/backups/create", {
        environmentId: envId,
        type: backupType,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["backups", envId] });
      toast({ title: "Backup started" });
    },
    onError: () =>
      toast({ title: "Backup failed to start", variant: "destructive" }),
  });

  const restoreBackup = useMutation({
    mutationFn: ({
      backupId,
      targetEnvironmentId,
    }: {
      backupId: number;
      targetEnvironmentId?: number;
    }) => api.post("/backups/restore", { backupId, targetEnvironmentId }),
    onSuccess: () => {
      setRestoreTarget(null);
      setRestoreTargetEnvId(null);
      toast({ title: "Restore job queued" });
    },
    onError: () => toast({ title: "Restore failed", variant: "destructive" }),
  });

  const deleteBackup = useMutation({
    mutationFn: (id: number) => api.delete(`/backups/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["backups", envId] });
      setDeleteTarget(null);
      toast({ title: "Backup deleted" });
    },
    onError: () => toast({ title: "Delete failed", variant: "destructive" }),
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: async (ids: number[]) => {
      const results = await Promise.allSettled(
        ids.map((id) => api.delete(`/backups/${id}`)),
      );
      return {
        succeeded:
          results.length -
          results.filter((result) => result.status === "rejected").length,
        failedIds: ids.filter(
          (_, index) => results[index]?.status === "rejected",
        ),
      };
    },
    onSuccess: ({ succeeded, failedIds }) => {
      qc.invalidateQueries({ queryKey: ["backups", envId] });
      setSelectedIds(failedIds);
      setIsBulkDeleting(false);
      toast({
        title: failedIds.length
          ? "Some backups could not be deleted"
          : "Backups deleted",
        description: `${succeeded} deleted, ${failedIds.length} failed. Failed items remain selected for review.`,
        variant: failedIds.length ? "destructive" : undefined,
      });
    },
    onError: () => {
      setIsBulkDeleting(false);
      toast({ title: "Bulk delete failed", variant: "destructive" });
    },
  });

  // Sync running jobs from database query on mount or data load
  useEffect(() => {
    if (!backupsData?.items) return;
    const running = backupsData.items.filter(
      (b) =>
        (b.status === "running" || b.status === "pending") &&
        b.jobExecution?.bull_job_id,
    );
    if (running.length > 0) {
      setJobProgress((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const b of running) {
          const bullId = b.jobExecution!.bull_job_id;
          const current = next[bullId];
          const newProgress = b.jobExecution!.progress ?? 0;
          if (current !== newProgress) {
            next[bullId] = newProgress;
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }
  }, [backupsData?.items]);

  // Subscribe to environment WS room
  useSubscribeEnvironment(envId);

  useWebSocketEvent(WS_EVENTS.JOB_PROGRESS, (data) => {
    const d = data as { queueName: string; jobId: string; progress: number };
    if (d.queueName !== "backups") return;
    setJobProgress((p) => ({ ...p, [d.jobId]: d.progress }));
  });

  useWebSocketEvent(WS_EVENTS.JOB_COMPLETED, (data) => {
    const d = data as { queueName: string };
    if (d.queueName !== "backups") return;
    qc.invalidateQueries({ queryKey: ["backups", envId] });
    setJobProgress({});
  });

  useWebSocketEvent(WS_EVENTS.JOB_FAILED, (data) => {
    const d = data as { jobId: string; error?: string; queueName: string };
    if (d.queueName !== "backups") return;
    setJobProgress((p) => {
      const next = { ...p };
      delete next[d.jobId];
      return next;
    });
    qc.invalidateQueries({ queryKey: ["backups", envId] });
    toast({
      title: "Backup failed",
      description: d.error ?? "An unexpected error occurred",
      variant: "destructive",
    });
  });

  const selectedEnv = envs?.find((e) => e.id === envId);
  const missingFolderId = !!selectedEnv && !selectedEnv.google_drive_folder_id;
  const totalPages = backupsData ? Math.ceil(backupsData.total / 10) : 1;
  const [expandedLogId, setExpandedLogId] = useState<number | null>(null);

  const toggleSelectAll = () => {
    if (selectedIds.length === (backupsData?.items.length ?? 0)) {
      setSelectedIds([]);
    } else {
      setSelectedIds(backupsData?.items.map((b) => b.id) ?? []);
    }
  };

  const toggleSelect = (id: number) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  if (envsError) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">Backups</h1>
        <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
          <AlertCircle className="h-8 w-8 text-destructive" />
          <p className="text-sm font-medium">Failed to load environments</p>
          <button
            onClick={() => refetchEnvs()}
            className="text-xs text-primary underline underline-offset-2"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 pb-20">
      <h1 className="text-2xl font-bold">Backups</h1>

      {/* Project + Environment + type selector */}
      <div className="flex flex-wrap items-end gap-3 bg-card border rounded-lg p-4 shadow-sm">
        <div className="space-y-1">
          <Label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
            <FolderKanban className="h-3.5 w-3.5 text-muted-foreground" />
            Project
          </Label>
          <Select
            value={projectId}
            onValueChange={(v) => {
              const pEnvs = (envs ?? []).filter(
                (e) => String(e.project.id) === v,
              );
              setSearchParams((previous) => {
                const next = new URLSearchParams(previous);
                if (v === "all") {
                  next.delete("project_id");
                  next.delete("environment_id");
                } else {
                  next.set("project_id", v);
                  if (pEnvs[0]) next.set("environment_id", String(pEnvs[0].id));
                  else next.delete("environment_id");
                }
                return next;
              });
              setPage(1);
              setSelectedIds([]);
            }}
          >
            <SelectTrigger className="w-56">
              <SelectValue placeholder="All Projects" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">
                All Projects ({projects.length})
              </SelectItem>
              {projects.map((p) => (
                <SelectItem key={p.id} value={String(p.id)}>
                  {p.name} ({p.envCount} {p.envCount === 1 ? "env" : "envs"})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <Label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
            <Globe className="h-3.5 w-3.5 text-muted-foreground" />
            Environment
          </Label>
          <Select
            value={envId?.toString() ?? ""}
            onValueChange={(v) => {
              const newId = v ? Number(v) : null;
              const found = (envs ?? []).find((e) => e.id === newId);
              setSearchParams((previous) => {
                const next = new URLSearchParams(previous);
                if (newId) next.set("environment_id", String(newId));
                else next.delete("environment_id");
                if (found) next.set("project_id", String(found.project.id));
                return next;
              });
              if (newId) {
                setPage(1);
              }
              setPage(1);
              setSelectedIds([]);
            }}
          >
            <SelectTrigger className="w-64">
              <SelectValue placeholder="Select environment…" />
            </SelectTrigger>
            <SelectContent>
              {filteredEnvs.map((e) => (
                <SelectItem key={e.id} value={e.id.toString()}>
                  <span className="font-medium">{e.project.name}</span> —{" "}
                  <span className="capitalize">{e.type}</span> ({e.server.name})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <Label className="text-xs font-medium text-muted-foreground">
            Backup type
          </Label>
          <Select value={backupType} onValueChange={setBackupType}>
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {BACKUP_TYPES.map((t) => (
                <SelectItem key={t.value} value={t.value}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Button
          onClick={() => createBackup.mutate()}
          disabled={!envId || createBackup.isPending || missingFolderId}
          className="shadow-sm"
        >
          {createBackup.isPending ? "Starting…" : "Create Backup"}
        </Button>
      </div>

      {missingFolderId && (
        <div className="flex items-start gap-2.5 rounded-lg border border-warning/20 bg-warning/10 p-3 text-sm text-warning">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            <p className="font-medium">No Google Drive folder configured</p>
            <p className="text-xs mt-0.5 opacity-80">
              This environment has no Google Drive Folder ID set. Go to the
              project’s{" "}
              <Link
                to={`/projects/${selectedEnv.project.id}?tab=environments`}
                className="underline font-medium"
              >
                Environments tab
              </Link>{" "}
              to add it.
            </p>
          </div>
        </div>
      )}

      {/* Active job progress */}
      {Object.keys(jobProgress).length > 0 && (
        <div className="space-y-2 bg-card border rounded-lg p-4 shadow-sm">
          <p className="text-sm font-medium">Active jobs</p>
          {Object.entries(jobProgress).map(([jobId, progress]) => (
            <div key={jobId}>
              <div className="flex justify-between text-xs mb-1">
                <span className="font-mono text-muted-foreground">{jobId}</span>
                <span>{progress}%</span>
              </div>
              <div className="h-1.5 bg-muted rounded-full">
                <div
                  className="h-1.5 bg-primary rounded-full transition-all"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {!envId && (
        <p className="text-muted-foreground text-sm py-10 text-center border-2 border-dashed rounded-lg">
          Select an environment above to view and manage backups.
        </p>
      )}

      {envId && (
        <>
          {backupsData && (
            <p className="text-sm text-muted-foreground">
              {backupsData.total} backups for{" "}
              <span className="font-medium">
                {selectedEnv?.project.name ?? `env #${envId}`}
              </span>
            </p>
          )}
          {backupsError ? (
            <div className="flex flex-col items-center justify-center gap-3 py-12 text-center border rounded-lg bg-card">
              <AlertCircle className="h-6 w-6 text-destructive" />
              <p className="text-sm font-medium">Failed to load backups</p>
              <button
                onClick={() => refetchBackups()}
                className="text-xs text-primary underline underline-offset-2"
              >
                Retry
              </button>
            </div>
          ) : (
            <div className="border rounded-lg overflow-hidden bg-card shadow-sm">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/40">
                  <tr>
                    <th className="w-10 px-4 py-3">
                      <Checkbox
                        checked={
                          selectedIds.length > 0 &&
                          selectedIds.length === backupsData?.items.length
                        }
                        onCheckedChange={toggleSelectAll}
                      />
                    </th>
                    <th className="text-left px-4 py-3 font-medium">Type</th>
                    <th className="text-left px-4 py-3 font-medium">Size</th>
                    <th className="text-left px-4 py-3 font-medium">Status</th>
                    <th className="text-left px-4 py-3 font-medium">Created</th>
                    <th className="w-44" />
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {isLoading &&
                    [1, 2, 3, 4, 5].map((i) => (
                      <tr key={i}>
                        <td colSpan={6} className="px-4 py-3">
                          <Skeleton className="h-5 w-full" />
                        </td>
                      </tr>
                    ))}
                  {!isLoading &&
                    backupsData?.items.map((b) => (
                      <Fragment key={b.id}>
                        <tr
                          className={
                            selectedIds.includes(b.id) ? "bg-muted/30" : ""
                          }
                        >
                          <td className="px-4 py-3">
                            <Checkbox
                              checked={selectedIds.includes(b.id)}
                              onCheckedChange={() => toggleSelect(b.id)}
                            />
                          </td>
                          <td className="px-4 py-3 capitalize">{b.type}</td>
                          <td className="px-4 py-3 font-mono text-muted-foreground">
                            {fmt(b.size_bytes)}
                          </td>
                          <td className="px-4 py-3">
                            <Badge
                              variant={
                                b.status === "completed"
                                  ? "success"
                                  : b.status === "failed"
                                    ? "destructive"
                                    : "warning"
                              }
                            >
                              {b.status}
                            </Badge>
                            {b.status === "failed" &&
                              (b.error_message ??
                                b.jobExecution?.last_error) && (
                                <p
                                  className="text-xs text-destructive mt-0.5 max-w-xs truncate"
                                  title={
                                    b.error_message ??
                                    b.jobExecution?.last_error ??
                                    undefined
                                  }
                                >
                                  {b.error_message ??
                                    b.jobExecution?.last_error}
                                </p>
                              )}
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
                              />
                              {b.status === "completed" && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-7 text-xs shadow-sm"
                                  onClick={() => {
                                    setRestoreTarget(b);
                                    setRestoreTargetEnvId(envId);
                                  }}
                                  disabled={restoreBackup.isPending}
                                >
                                  <RotateCcw className="h-3 w-3 mr-1" />
                                  Restore
                                </Button>
                              )}
                              {b.status === "completed" && (
                                <>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-7 w-7 text-muted-foreground hover:text-foreground"
                                    title="Download backup"
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
                                      title="Open Drive"
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
                              {isAdmin && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7 text-muted-foreground hover:text-destructive"
                                  onClick={() => setDeleteTarget(b)}
                                  disabled={deleteBackup.isPending}
                                  title="Delete"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              )}
                            </div>
                          </td>
                        </tr>
                        {expandedLogId === b.jobExecution?.id && (
                          <tr>
                            <td colSpan={6} className="px-4 pb-3 bg-muted/30">
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
              {!isLoading && !backupsData?.items.length && (
                <p className="text-center text-muted-foreground py-10 text-sm">
                  No backups yet for this environment.
                </p>
              )}
            </div>
          )}
          <Pagination
            page={page}
            totalPages={totalPages}
            onPageChange={setPage}
          />
        </>
      )}

      <BulkActionsBar
        selectedCount={selectedIds.length}
        actions={
          isAdmin
            ? [
                {
                  label: "Delete Selected",
                  icon: Trash2,
                  variant: "destructive",
                  onClick: () => setIsBulkDeleting(true),
                },
              ]
            : []
        }
        onClear={() => setSelectedIds([])}
      />

      <Dialog
        open={!!restoreTarget}
        onOpenChange={(o) => {
          if (!o) {
            setRestoreTarget(null);
            setRestoreTargetEnvId(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Restore Backup</DialogTitle>
            <DialogDescription>
              Restore the {restoreTarget?.type} backup from{" "}
              {restoreTarget
                ? new Date(restoreTarget.created_at).toLocaleString()
                : ""}
              .
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="restore-target-env">Target Environment</Label>
              <Select
                value={restoreTargetEnvId?.toString() ?? ""}
                onValueChange={(v) =>
                  setRestoreTargetEnvId(v ? Number(v) : null)
                }
              >
                <SelectTrigger id="restore-target-env" className="w-full">
                  <SelectValue placeholder="Select target environment…" />
                </SelectTrigger>
                <SelectContent>
                  {envs
                    ?.filter(
                      (environment) =>
                        environment.project.id ===
                        restoreTarget?.environment.project.id,
                    )
                    .map((e) => (
                      <SelectItem key={e.id} value={e.id.toString()}>
                        {e.project.name} — {e.type} ({e.server.name})
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>

            {restoreTarget &&
              restoreTargetEnvId &&
              restoreTargetEnvId !== envId && (
                <div className="rounded-lg border border-warning/20 bg-warning/10 p-3.5 text-warning space-y-1">
                  <p className="font-semibold text-sm">
                    Cross-Environment Restore Detected
                  </p>
                  <p className="text-xs opacity-90 leading-relaxed">
                    You are restoring this backup to a different environment.
                    The system will automatically:
                  </p>
                  <ul className="list-disc list-inside text-xs opacity-90 pl-1 space-y-0.5">
                    <li>
                      Rewrite URLs in options, posts, metadata, comments, and
                      links
                    </li>
                    <li>
                      Perform a deep search-replace across all assets in the
                      files
                    </li>
                    <li>Update on-server DB credentials and settings</li>
                    <li>Flush the WordPress cache and rewrite rules</li>
                  </ul>
                </div>
              )}

            <div className="rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-destructive">
              <p className="font-medium text-sm">
                Warning: Destructive Operation
              </p>
              <p className="text-xs mt-0.5 opacity-80">
                This will overwrite the target site's files and database. This
                action cannot be undone.
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setRestoreTarget(null);
                setRestoreTargetEnvId(null);
              }}
              disabled={restoreBackup.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (restoreTarget && restoreTargetEnvId) {
                  restoreBackup.mutate({
                    backupId: restoreTarget.id,
                    targetEnvironmentId: restoreTargetEnvId,
                  });
                }
              }}
              disabled={restoreBackup.isPending || !restoreTargetEnvId}
            >
              {restoreBackup.isPending ? "Restoring…" : "Restore Backup"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title="Delete Backup"
        description={`Permanently delete this backup from ${deleteTarget ? new Date(deleteTarget.created_at).toLocaleString() : ""}? This cannot be undone.`}
        confirmLabel="Delete"
        confirmVariant="destructive"
        onConfirm={() => deleteTarget && deleteBackup.mutate(deleteTarget.id)}
        isPending={deleteBackup.isPending}
      />

      <AlertDialog
        open={isBulkDeleting}
        onOpenChange={(o) => !o && setIsBulkDeleting(false)}
        title="Delete Backups"
        description={`Are you sure you want to delete ${selectedIds.length} selected backups? This action cannot be undone.`}
        confirmLabel="Delete All"
        confirmVariant="destructive"
        onConfirm={() => bulkDeleteMutation.mutate(selectedIds)}
        isPending={bulkDeleteMutation.isPending}
      />
    </div>
  );
}
