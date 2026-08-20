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
  const [open, setOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [isRecovering, setIsRecovering] = useState(false);
  const [recoveryMessage, setRecoveryMessage] = useState<string | null>(null);

  async function handleRecoverQueues() {
    setIsRecovering(true);
    try {
      const res = await api.post<{ success: boolean; message: string; dbCleaned: number }>(
        "/job-executions/recover-stalled",
        {},
      );
      setRecoveryMessage(
        res.dbCleaned > 0
          ? `Recovered ${res.dbCleaned} stalled jobs`
          : "Queues inspected & recovered",
      );
      setTimeout(() => setRecoveryMessage(null), 4000);
      queryClient.invalidateQueries({ queryKey: ["action-center"] });
      queryClient.invalidateQueries({ queryKey: ["job-executions"] });
    } catch (err) {
      console.error("Failed to recover queues:", err);
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
          <Badge variant="info" className="h-4 px-1 text-[9px] min-w-4 flex items-center justify-center">
            {activeJobs.length}
          </Badge>
        )}
        {activeJobs.length === 0 && failedJobs.length > 0 && (
          <Badge variant="destructive" className="h-4 px-1 text-[9px] min-w-4 flex items-center justify-center">
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
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 gap-1.5 text-xs text-amber-500 border-amber-500/30 hover:bg-amber-500/10 hover:text-amber-400"
                  onClick={handleRecoverQueues}
                  disabled={isRecovering}
                  title="Unstick and recover all queues and stalled jobs"
                >
                  <Wrench
                    className={`h-3.5 w-3.5 ${isRecovering ? "animate-spin" : ""}`}
                  />
                  <span>Recover Queues</span>
                </Button>
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
              <div className="mb-3 rounded-md bg-emerald-500/10 border border-emerald-500/30 px-3 py-2 text-xs text-emerald-400 flex items-center gap-2">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
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
    </>
  );
}
