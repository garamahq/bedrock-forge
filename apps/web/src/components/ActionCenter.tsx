import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  ExternalLink,
  Loader2,
  RotateCw,
  XCircle,
  Wrench,
} from "lucide-react";
import { api } from "@/lib/api-client";
import { useWebSocketEvent } from "@/lib/websocket";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ExecutionLogPanel } from "@/components/ui/execution-log-panel";
import { AlertDialog } from "@/components/ui/alert-dialog";
import { useAuthStore } from "@/store/auth.store";

interface JobExecutionRow {
  id: number;
  queue_name: string;
  bull_job_id: string;
  job_type: string | null;
  status: string;
  progress: number | null;
  last_error: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  environment: {
    id: number;
    type: string;
    url: string | null;
    project: { id: number; name: string; client: { id: number; name: string } };
  } | null;
}

interface PageResult {
  data: JobExecutionRow[];
  total: number;
}

interface RecoveryPreview {
  total: number;
  inspected: number;
  repairable: number;
  held: number;
  hasMore: boolean;
  items: Array<{
    id: number;
    queue_name: string;
    status: string;
    repairStatus: "completed" | "failed" | null;
    reason: string;
  }>;
}

const QUEUE_LABELS: Record<string, string> = {
  backups: "Backup",
  "plugin-scans": "Plugin",
  sync: "Sync",
  monitors: "Monitor",
  domains: "Domain",
  projects: "Project",
  security: "Security",
  notifications: "Notification",
  reports: "Report",
};

const ACTIVE_STATUSES = new Set(["queued", "active"]);

function formatDuration(start?: string | null, end?: string | null) {
  if (!start) return "Waiting";
  const startMs = new Date(start).getTime();
  const endMs = end ? new Date(end).getTime() : Date.now();
  const diff = Math.max(0, endMs - startMs);
  if (diff < 60_000) return `${Math.max(1, Math.floor(diff / 1000))}s`;
  const mins = Math.floor(diff / 60_000);
  const secs = Math.floor((diff % 60_000) / 1000);
  return `${mins}m ${secs.toString().padStart(2, "0")}s`;
}

function useTick(shouldTick: boolean) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!shouldTick) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [shouldTick]);
}

function statusBadge(status: string) {
  if (status === "completed") {
    return (
      <Badge variant="success" className="gap-1">
        <CheckCircle2 className="h-3 w-3" />
        Completed
      </Badge>
    );
  }
  if (status === "failed" || status === "dead_letter") {
    return (
      <Badge variant="destructive" className="gap-1">
        <XCircle className="h-3 w-3" />
        Needs attention
      </Badge>
    );
  }
  return (
    <Badge variant="info" className="gap-1">
      {status === "active" ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <Clock className="h-3 w-3" />
      )}
      {status === "active" ? "Running" : "Queued"}
    </Badge>
  );
}

function jobTitle(job: JobExecutionRow) {
  const raw = job.job_type ?? job.queue_name;
  return raw
    .replace(/[:_-]/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function JobRow({
  job,
  expanded,
  onToggle,
}: {
  job: JobExecutionRow;
  expanded: boolean;
  onToggle: () => void;
}) {
  const active = ACTIVE_STATUSES.has(job.status);
  const elapsed = formatDuration(
    job.started_at ?? job.created_at,
    job.completed_at,
  );
  const target = job.environment
    ? `${job.environment.project.name} / ${job.environment.type}`
    : "System";

  return (
    <div className="rounded-lg border bg-card">
      <button
        type="button"
        onClick={onToggle}
        className="w-full px-3 py-3 text-left hover:bg-muted/40 transition-colors"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              {statusBadge(job.status)}
              <Badge variant="outline" className="text-[10px]">
                {QUEUE_LABELS[job.queue_name] ?? job.queue_name}
              </Badge>
            </div>
            <p className="mt-1 text-sm font-semibold truncate">
              {jobTitle(job)}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground truncate">
              {target} · #{job.id}
            </p>
          </div>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {active ? `${elapsed} elapsed` : elapsed}
          </span>
        </div>
        {active && job.progress != null && (
          <div className="mt-3 flex items-center gap-2">
            <Progress value={job.progress} className="h-1.5" />
            <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">
              {job.progress}%
            </span>
          </div>
        )}
        {job.last_error && (
          <p className="mt-2 max-h-8 overflow-hidden text-xs text-destructive">
            {job.last_error}
          </p>
        )}
      </button>
      {expanded && (
        <div className="border-t px-3 pb-3">
          <ExecutionLogPanel jobExecutionId={job.id} isActive={active} />
        </div>
      )}
    </div>
  );
}

export function ActionCenter() {
  const queryClient = useQueryClient();
  const isAdmin = useAuthStore(
    (state) => state.user?.roles?.includes("admin") ?? false,
  );
  const [open, setOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [isRecovering, setIsRecovering] = useState(false);
  const [recoveryDialogOpen, setRecoveryDialogOpen] = useState(false);
  const [recoveryMessage, setRecoveryMessage] = useState<string | null>(null);
  const [recoveryFailed, setRecoveryFailed] = useState(false);

  const {
    data: recoveryPreview,
    isPending: isLoadingRecoveryPreview,
    isError: isRecoveryPreviewError,
  } = useQuery<RecoveryPreview>({
    queryKey: ["job-execution-recovery-preview"],
    queryFn: () => api.get("/job-executions/recovery-preview"),
    enabled: recoveryDialogOpen && isAdmin,
    retry: false,
  });

  const recoveryByQueue = (recoveryPreview?.items ?? []).reduce<
    Record<string, { repairable: number; held: number }>
  >((summary, item) => {
    const counts = summary[item.queue_name] ?? { repairable: 0, held: 0 };
    if (item.repairStatus) counts.repairable++;
    else counts.held++;
    summary[item.queue_name] = counts;
    return summary;
  }, {});

  async function handleRecoverQueues() {
    if (!isAdmin || !recoveryPreview?.repairable) return;
    setIsRecovering(true);
    try {
      const res = await api.post<{
        success: boolean;
        message: string;
        reconciled: number;
      }>("/job-executions/recover-stalled", {});
      setRecoveryMessage(res.message);
      setRecoveryFailed(false);
      setRecoveryDialogOpen(false);
      setTimeout(() => setRecoveryMessage(null), 4000);
      queryClient.invalidateQueries({ queryKey: ["action-center"] });
      queryClient.invalidateQueries({ queryKey: ["job-executions"] });
    } catch (err) {
      setRecoveryFailed(true);
      setRecoveryMessage(
        err instanceof Error ? err.message : "Queue reconciliation failed.",
      );
    } finally {
      setIsRecovering(false);
    }
  }

  const { data, isFetching, refetch } = useQuery<PageResult>({
    queryKey: ["action-center", "jobs"],
    queryFn: () => api.get("/job-executions?page=1&limit=12"),
    staleTime: 5_000,
    refetchInterval: open ? 5_000 : 15_000,
  });

  useWebSocketEvent("job:progress", (raw: unknown) => {
    const event = raw as { jobId: string; progress: number; step?: string };
    queryClient.setQueryData<PageResult>(["action-center", "jobs"], (old) => {
      if (!old) return old;
      return {
        ...old,
        data: old.data.map((job) => {
          if (job.bull_job_id === event.jobId) {
            return {
              ...job,
              status: "active",
              progress: event.progress,
            };
          }
          return job;
        }),
      };
    });
  });

  useWebSocketEvent("job:completed", (raw: unknown) => {
    const event = raw as { jobId: string };
    queryClient.setQueryData<PageResult>(["action-center", "jobs"], (old) => {
      if (!old) return old;
      return {
        ...old,
        data: old.data.map((job) => {
          if (job.bull_job_id === event.jobId) {
            return {
              ...job,
              status: "completed",
              progress: 100,
              completed_at: new Date().toISOString(),
            };
          }
          return job;
        }),
      };
    });
    setTimeout(() => {
      void queryClient.invalidateQueries({ queryKey: ["action-center"] });
    }, 1000);
  });

  useWebSocketEvent("job:failed", (raw: unknown) => {
    const event = raw as { jobId: string; error: string };
    queryClient.setQueryData<PageResult>(["action-center", "jobs"], (old) => {
      if (!old) return old;
      return {
        ...old,
        data: old.data.map((job) => {
          if (job.bull_job_id === event.jobId) {
            return {
              ...job,
              status: "failed",
              last_error: event.error,
              completed_at: new Date().toISOString(),
            };
          }
          return job;
        }),
      };
    });
    setTimeout(() => {
      void queryClient.invalidateQueries({ queryKey: ["action-center"] });
    }, 1000);
  });

  const jobs = data?.data ?? [];
  const activeJobs = jobs.filter((job) => ACTIVE_STATUSES.has(job.status));
  const failedJobs = jobs.filter(
    (job) => job.status === "failed" || job.status === "dead_letter",
  );
  useTick(activeJobs.length > 0);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Open Action Center. ${activeJobs.length} running jobs, ${failedJobs.length} failed jobs.`}
        title="Action Center"
        className="relative flex items-center gap-1.5 rounded-lg border h-8 px-2.5 text-xs font-medium bg-card hover:bg-accent transition-colors shrink-0"
      >
        {activeJobs.length > 0 ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
        ) : failedJobs.length > 0 ? (
          <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
        ) : (
          <Activity className="h-3.5 w-3.5 text-muted-foreground" />
        )}
        <span className="hidden md:inline">Action Center</span>
        {activeJobs.length > 0 && (
          <Badge
            variant="info"
            className="h-4 px-1 text-[9px] min-w-4 flex items-center justify-center"
          >
            {activeJobs.length}
          </Badge>
        )}
        {activeJobs.length === 0 && failedJobs.length > 0 && (
          <Badge
            variant="destructive"
            className="h-4 px-1 text-[9px] min-w-4 flex items-center justify-center"
          >
            {failedJobs.length}
          </Badge>
        )}
      </button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="w-full sm:w-[36rem]">
          <SheetHeader>
            <div className="flex items-center justify-between gap-3 pr-8">
              <div>
                <SheetTitle>Action Center</SheetTitle>
                <p className="mt-1 text-xs text-muted-foreground">
                  Live status for scans, hardening, backups, syncs, reports, and
                  provisioning.
                </p>
              </div>
              <div className="flex items-center gap-2">
                {isAdmin && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 gap-1.5 text-xs text-amber-500 border-amber-500/30 hover:bg-amber-500/10 hover:text-amber-400"
                    onClick={() => setRecoveryDialogOpen(true)}
                    disabled={isRecovering}
                    title="Review stale job records before reconciling"
                  >
                    <Wrench
                      className={`h-3.5 w-3.5 ${isRecovering ? "animate-spin" : ""}`}
                    />
                    <span>Recover Queues</span>
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8"
                  onClick={() => refetch()}
                  disabled={isFetching}
                  title="Refresh"
                >
                  <RotateCw
                    className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`}
                  />
                </Button>
              </div>
            </div>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto px-6 py-4">
            {recoveryMessage && (
              <div
                role={recoveryFailed ? "alert" : "status"}
                aria-live={recoveryFailed ? "assertive" : "polite"}
                className={`mb-3 flex items-center gap-2 rounded-md border px-3 py-2 text-xs ${recoveryFailed ? "border-destructive/30 bg-destructive/10 text-destructive" : "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"}`}
              >
                {recoveryFailed ? (
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                ) : (
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                )}
                <span>{recoveryMessage}</span>
              </div>
            )}
            <div className="mb-4 grid grid-cols-3 gap-2">
              <div className="rounded-lg border bg-muted/30 p-3">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Running
                </p>
                <p className="mt-1 text-2xl font-bold">{activeJobs.length}</p>
              </div>
              <div className="rounded-lg border bg-muted/30 p-3">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Failed
                </p>
                <p className="mt-1 text-2xl font-bold text-destructive">
                  {failedJobs.length}
                </p>
              </div>
              <div className="rounded-lg border bg-muted/30 p-3">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Recent
                </p>
                <p className="mt-1 text-2xl font-bold">{jobs.length}</p>
              </div>
            </div>

            {jobs.length === 0 ? (
              <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
                No recent actions yet.
              </div>
            ) : (
              <div className="space-y-3">
                {jobs.map((job) => (
                  <JobRow
                    key={job.id}
                    job={job}
                    expanded={expandedId === job.id}
                    onToggle={() =>
                      setExpandedId((current) =>
                        current === job.id ? null : job.id,
                      )
                    }
                  />
                ))}
              </div>
            )}
          </div>

          <div className="border-t px-6 py-3">
            <Button asChild variant="outline" className="w-full">
              <Link to="/activity" onClick={() => setOpen(false)}>
                Open full activity log
                <ExternalLink className="ml-2 h-3.5 w-3.5" />
              </Link>
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      <AlertDialog
        open={recoveryDialogOpen}
        onOpenChange={setRecoveryDialogOpen}
        title="Reconcile stale job records?"
        description={
          isLoadingRecoveryPreview
            ? "Checking queue and worker state for stale records. No jobs will change until you confirm."
            : isRecoveryPreviewError
              ? "Queue state could not be verified. Nothing will be changed. Close this dialog and try again later."
              : recoveryPreview
                ? `${recoveryPreview.repairable} stale record(s) can be reconciled. ${recoveryPreview.held} record(s) still have active work or an unverified queue state and will be left untouched.`
                : "Queue state could not be verified. Nothing will be changed."
        }
        confirmLabel={`Reconcile ${recoveryPreview?.repairable ?? 0} records`}
        confirmVariant="default"
        onConfirm={handleRecoverQueues}
        isPending={isRecovering}
        confirmDisabled={
          isLoadingRecoveryPreview ||
          isRecoveryPreviewError ||
          !recoveryPreview?.repairable
        }
      >
        {recoveryPreview && (
          <div className="space-y-4 px-6 pb-2 text-sm">
            <section aria-label="Recovery counts by queue">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Queue breakdown
              </h3>
              <div className="space-y-1.5">
                {Object.entries(recoveryByQueue).map(([queue, counts]) => (
                  <div
                    key={queue}
                    className="flex items-center justify-between rounded-md border px-3 py-2 text-xs"
                  >
                    <span className="font-medium">
                      {QUEUE_LABELS[queue] ?? queue}
                    </span>
                    <span className="text-muted-foreground">
                      {counts.repairable} to reconcile · {counts.held} held
                    </span>
                  </div>
                ))}
                {recoveryPreview.hasMore && (
                  <p className="text-xs text-muted-foreground">
                    Showing the first {recoveryPreview.inspected} of{" "}
                    {recoveryPreview.total} stale records. Reconcile this batch,
                    then review the next one.
                  </p>
                )}
              </div>
            </section>
            <section aria-label="Inspected stale jobs">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Inspected jobs
              </h3>
              <div className="max-h-40 space-y-2 overflow-y-auto pr-1">
                {recoveryPreview.items.map((item) => (
                  <div
                    key={item.id}
                    className="rounded-md bg-muted/40 px-3 py-2 text-xs"
                  >
                    <div className="flex justify-between gap-3">
                      <span className="font-medium">
                        {QUEUE_LABELS[item.queue_name] ?? item.queue_name} · #
                        {item.id}
                      </span>
                      <span
                        className={
                          item.repairStatus
                            ? "text-emerald-600"
                            : "text-muted-foreground"
                        }
                      >
                        {item.status} ·{" "}
                        {item.repairStatus ? "reconcile" : "held"}
                      </span>
                    </div>
                    <p className="mt-1 text-muted-foreground">{item.reason}</p>
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}
      </AlertDialog>
    </>
  );
}
