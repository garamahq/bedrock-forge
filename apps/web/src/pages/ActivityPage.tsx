import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import {
  CheckCircle2,
  XCircle,
  Clock,
  Loader2,
  ClipboardList,
  ChevronDown,
  ChevronUp,
  AlertTriangle,
  Trash2,
} from "lucide-react";
import { api } from "@/lib/api-client";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ExecutionLogPanel,
  ExpandLogButton,
} from "@/components/ui/execution-log-panel";
import { useWebSocketEvent } from "@/lib/websocket";
import { ErrorState } from "@/components/crud";

// ─── Types ───────────────────────────────────────────────────────────────────

interface JobExecutionRow {
  id: number;
  queue_name: string;
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
  page: number;
  limit: number;
}

const QUEUE_LABELS: Record<string, string> = {
  backups: "Backups",
  "plugin-scans": "Plugin Scans",
  sync: "Sync",
  monitors: "Monitors",
  domains: "Domains",
  projects: "Projects",
};

const STATUS_ORDER = [
  "active",
  "queued",
  "completed",
  "failed",
  "dead_letter",
  "discarded",
];

const STATUS_LABELS: Record<string, string> = {
  active: "Running",
  queued: "Queued",
  completed: "Completed",
  failed: "Failed",
  dead_letter: "Dead Letter",
  discarded: "Removed from queue",
};

// ─── Sub-components ──────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  if (status === "completed")
    return (
      <Badge variant="success" className="gap-1">
        <CheckCircle2 className="h-3 w-3" />
        Completed
      </Badge>
    );
  if (status === "failed")
    return (
      <Badge variant="destructive" className="gap-1">
        <XCircle className="h-3 w-3" />
        Failed
      </Badge>
    );
  if (status === "dead_letter")
    return (
      <Badge
        variant="destructive"
        className="gap-1 bg-red-950/70 text-red-300 border-red-800 hover:bg-red-950/70"
      >
        <AlertTriangle className="h-3 w-3" />
        Dead Letter
      </Badge>
    );
  if (status === "active")
    return (
      <Badge variant="info" className="gap-1">
        <Loader2 className="h-3 w-3 animate-spin" />
        Running
      </Badge>
    );
  if (status === "queued")
    return (
      <Badge variant="secondary" className="gap-1">
        <Clock className="h-3 w-3" />
        Queued
      </Badge>
    );
  if (status === "discarded")
    return (
      <Badge variant="secondary" className="gap-1">
        <Trash2 className="h-3 w-3" />
        Removed
      </Badge>
    );
  return (
    <Badge variant="secondary" className="gap-1">
      <Clock className="h-3 w-3" />
      Pending
    </Badge>
  );
}

function durationLabel(
  started?: string | null,
  completed?: string | null,
): string {
  if (!started) return "—";
  const startMs = new Date(started).getTime();
  const endMs = completed ? new Date(completed).getTime() : Date.now();
  const diff = endMs - startMs;
  if (diff < 0) return "—";
  if (diff < 1000) return `${diff}ms`;
  if (diff < 60_000) return `${(diff / 1000).toFixed(1)}s`;
  const mins = Math.floor(diff / 60_000);
  const secs = Math.floor((diff % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}

function ExecutionRow({ row }: { row: JobExecutionRow }) {
  const [expanded, setExpanded] = useState(false);
  const isActive = row.status === "active" || row.status === "queued";

  return (
    <>
      <tr className="border-b last:border-0 hover:bg-muted/40 transition-colors">
        {/* Status */}
        <td className="py-3 pl-4 pr-2 whitespace-nowrap">
          <StatusBadge status={row.status} />
        </td>

        {/* Queue */}
        <td className="py-3 px-2 whitespace-nowrap">
          <Badge variant="outline" className="text-xs font-normal">
            {QUEUE_LABELS[row.queue_name] ?? row.queue_name}
          </Badge>
        </td>

        {/* Environment / Project */}
        <td className="py-3 px-2 max-w-[240px]">
          {row.environment ? (
            <div className="space-y-0.5">
              <Link
                to={`/projects/${row.environment.project.id}`}
                className="text-sm font-medium hover:underline text-foreground"
              >
                {row.environment.project.name}
              </Link>
              <p className="text-xs text-muted-foreground capitalize">
                {row.environment.type}
                {row.environment.url && (
                  <span className="ml-1 truncate">— {row.environment.url}</span>
                )}
              </p>
            </div>
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          )}
        </td>

        {/* Client */}
        <td className="py-3 px-2 whitespace-nowrap text-sm text-muted-foreground">
          {row.environment?.project.client.name ?? "—"}
        </td>

        {/* Started */}
        <td className="py-3 px-2 whitespace-nowrap text-xs text-muted-foreground">
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

        {/* Duration */}
        <td className="py-3 px-2 whitespace-nowrap text-xs text-muted-foreground">
          {durationLabel(row.started_at, row.completed_at)}
        </td>

        {/* Progress (only for active) */}
        <td className="py-3 px-2 whitespace-nowrap text-xs">
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
              className="text-destructive truncate max-w-[160px] block"
              title={row.last_error}
            >
              {row.last_error}
            </span>
          ) : null}
        </td>

        {/* Log toggle */}
        <td className="py-3 pr-4 pl-2 text-right whitespace-nowrap">
          <ExpandLogButton
            expanded={expanded}
            onToggle={() => setExpanded((v) => !v)}
          />
        </td>
      </tr>

      {/* Expandable log row */}
      {expanded && (
        <tr className="bg-muted/20 border-b last:border-0">
          <td colSpan={8} className="px-4 pb-4 pt-2">
            <ExecutionLogPanel jobExecutionId={row.id} isActive={isActive} />
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function ActivityPage() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [page, setPage] = useState(1);
  const [queueFilter, setQueueFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState(() => {
    const status = searchParams.get("status");
    return status && STATUS_ORDER.includes(status) ? status : "all";
  });
  const jobIdFilter = searchParams.get("job") ?? "";
  const LIMIT = 10;

  useEffect(() => {
    const status = searchParams.get("status");
    setStatusFilter(status && STATUS_ORDER.includes(status) ? status : "all");
    setPage(1);
  }, [searchParams]);

  const queryKey = [
    "job-executions",
    page,
    queueFilter,
    statusFilter,
    jobIdFilter,
  ];

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey,
    queryFn: () => {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(LIMIT),
      });
      if (queueFilter !== "all") params.set("queue_name", queueFilter);
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (/^\d+$/.test(jobIdFilter)) params.set("job_id", jobIdFilter);
      return api.get<PageResult>(`/job-executions?${params.toString()}`);
    },
    staleTime: 10_000,
    refetchInterval: 15_000,
  });

  // Invalidate on any job completion/failure so the list stays fresh
  useWebSocketEvent("job:completed", () => {
    queryClient.invalidateQueries({ queryKey: ["job-executions"] });
  });
  useWebSocketEvent("job:failed", () => {
    queryClient.invalidateQueries({ queryKey: ["job-executions"] });
  });

  const totalPages = data ? Math.ceil(data.total / LIMIT) : 1;

  function resetPage() {
    setPage(1);
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="flex items-center gap-2">
          <ClipboardList className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-xl font-semibold">Activity Log</h1>
          {data && (
            <Badge variant="secondary" className="text-xs">
              {data.total} total
            </Badge>
          )}
        </div>

        {/* Filters */}
        <div className="flex items-center gap-2">
          <Select
            value={queueFilter}
            onValueChange={(v) => {
              setQueueFilter(v);
              resetPage();
            }}
          >
            <SelectTrigger className="h-8 text-xs w-36">
              <SelectValue placeholder="All queues" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All queues</SelectItem>
              {Object.entries(QUEUE_LABELS).map(([k, label]) => (
                <SelectItem key={k} value={k}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={statusFilter}
            onValueChange={(v) => {
              setStatusFilter(v);
              const next = new URLSearchParams(searchParams);
              if (v === "all") next.delete("status");
              else next.set("status", v);
              setSearchParams(next);
              resetPage();
            }}
          >
            <SelectTrigger className="h-8 text-xs w-32">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {STATUS_ORDER.map((s) => (
                <SelectItem key={s} value={s}>
                  {STATUS_LABELS[s] ?? s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {jobIdFilter && /^\d+$/.test(jobIdFilter) && (
        <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/20 px-3 py-2">
          <span className="text-sm">Showing operation #{jobIdFilter}</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              const next = new URLSearchParams(searchParams);
              next.delete("job");
              setSearchParams(next);
              setPage(1);
            }}
          >
            Clear filter
          </Button>
        </div>
      )}

      {/* Table */}
      <div className="border rounded-lg overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left py-2.5 pl-4 pr-2 text-xs font-medium text-muted-foreground whitespace-nowrap">
                Status
              </th>
              <th className="text-left py-2.5 px-2 text-xs font-medium text-muted-foreground whitespace-nowrap">
                Queue
              </th>
              <th className="text-left py-2.5 px-2 text-xs font-medium text-muted-foreground">
                Environment / Project
              </th>
              <th className="text-left py-2.5 px-2 text-xs font-medium text-muted-foreground whitespace-nowrap">
                Client
              </th>
              <th className="text-left py-2.5 px-2 text-xs font-medium text-muted-foreground whitespace-nowrap">
                Started
              </th>
              <th className="text-left py-2.5 px-2 text-xs font-medium text-muted-foreground whitespace-nowrap">
                Duration
              </th>
              <th className="text-left py-2.5 px-2 text-xs font-medium text-muted-foreground">
                Details
              </th>
              <th className="py-2.5 pr-4 pl-2" />
            </tr>
          </thead>

          <tbody>
            {isError ? (
              <tr>
                <td colSpan={8} className="px-4 py-2">
                  <ErrorState
                    title="Could not load activity"
                    onRetry={() => void refetch()}
                    className="py-8"
                  />
                </td>
              </tr>
            ) : isLoading ? (
              <tr>
                <td colSpan={8} className="py-12 text-center">
                  <Loader2 className="h-6 w-6 animate-spin mx-auto text-muted-foreground" />
                </td>
              </tr>
            ) : !data || data.data.length === 0 ? (
              <tr>
                <td
                  colSpan={8}
                  className="py-12 text-center text-muted-foreground text-sm"
                >
                  <ClipboardList className="h-8 w-8 mx-auto mb-2 opacity-40" />
                  No job executions found
                </td>
              </tr>
            ) : (
              data.data.map((row) => <ExecutionRow key={row.id} row={row} />)
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {data && data.total > LIMIT && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            Showing {(page - 1) * LIMIT + 1}–
            {Math.min(page * LIMIT, data.total)} of {data.total}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              Previous
            </Button>
            <span className="text-xs text-muted-foreground">
              {page} / {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
