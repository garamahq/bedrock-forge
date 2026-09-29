import { useEffect, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import {
  CheckCircle2,
  XCircle,
  Clock,
  Loader2,
  ClipboardList,
  Search,
  X,
  AlertTriangle,
  Trash2,
} from "lucide-react";
import { QUEUES } from "@bedrock-forge/shared";
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
import { Input } from "@/components/ui/input";
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
  page: number;
  limit: number;
}

const QUEUE_LABEL_OVERRIDES: Record<string, string> = {
  [QUEUES.BACKUPS]: "Backups",
  [QUEUES.PLUGIN_SCANS]: "Plugin scans",
  [QUEUES.PLUGIN_UPDATES]: "Plugin updates",
  [QUEUES.CUSTOM_PLUGINS]: "Custom plugins",
  [QUEUES.THEME_SCANS]: "Theme scans",
  [QUEUES.SYNC]: "Sync",
  [QUEUES.MONITORS]: "Monitors",
  [QUEUES.DOMAINS]: "Domains",
  [QUEUES.PROJECTS]: "Projects",
  [QUEUES.NOTIFICATIONS]: "Notifications",
  [QUEUES.REPORTS]: "Reports",
  [QUEUES.WP_ACTIONS]: "WordPress actions",
  [QUEUES.SYSTEM_BACKUPS]: "System backups",
  [QUEUES.SECURITY]: "Security",
};

const QUEUE_OPTIONS = Object.values(QUEUES).map((queue) => ({
  value: queue,
  label:
    QUEUE_LABEL_OVERRIDES[queue] ??
    queue
      .split("-")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" "),
}));

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

function queueLabel(queue: string): string {
  return (
    QUEUE_OPTIONS.find((option) => option.value === queue)?.label ??
    queue
      .split("-")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ")
  );
}

function operationLabel(jobType: string | null): string {
  if (!jobType) return "Job execution";
  return jobType
    .split(/[:._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" · ");
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat([], {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(value));
}

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
  const logId = `execution-log-${row.id}`;
  const logButtonId = `${logId}-toggle`;

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
            {queueLabel(row.queue_name)}
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
            ? formatDateTime(row.started_at)
            : formatDateTime(row.created_at)}
        </td>

        {/* Duration */}
        <td className="py-3 px-2 whitespace-nowrap text-xs text-muted-foreground">
          {durationLabel(row.started_at, row.completed_at)}
        </td>

        {/* Operation and useful active or failed details */}
        <td className="py-3 px-2 whitespace-nowrap text-xs">
          <div className="space-y-1">
            {row.job_type && (
              <div className="space-y-0.5">
                <p className="font-medium text-foreground">
                  {operationLabel(row.job_type)}
                </p>
                <p className="text-muted-foreground">Job #{row.id}</p>
              </div>
            )}
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
          </div>
        </td>

        {/* Log toggle */}
        <td className="py-3 pr-4 pl-2 text-right whitespace-nowrap">
          <ExpandLogButton
            expanded={expanded}
            onToggle={() => setExpanded((v) => !v)}
            id={logButtonId}
            controlsId={logId}
            label={`${expanded ? "Hide" : "Show"} execution log for ${queueLabel(row.queue_name)} job ${row.id}`}
          />
        </td>
      </tr>

      {/* Expandable log row */}
      <tr hidden={!expanded} className="bg-muted/20 border-b last:border-0">
        <td colSpan={8} className="px-4 pb-4 pt-2">
          <div id={logId} role="region" aria-labelledby={logButtonId}>
            {expanded && (
              <ExecutionLogPanel
                jobExecutionId={row.id}
                isActive={isActive}
                targetLabel={
                  row.environment
                    ? `${row.environment.project.name} · ${row.environment.type}`
                    : undefined
                }
              />
            )}
          </div>
        </td>
      </tr>
    </>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function ActivityPage() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const searchFilter = searchParams.get("q")?.trim() ?? "";
  const [searchDraft, setSearchDraft] = useState(searchFilter);
  const requestedQueue = searchParams.get("queue") ?? "all";
  const queueFilter = QUEUE_OPTIONS.some(
    (option) => option.value === requestedQueue,
  )
    ? requestedQueue
    : "all";
  const requestedStatus = searchParams.get("status") ?? "all";
  const statusFilter = STATUS_ORDER.includes(requestedStatus)
    ? requestedStatus
    : "all";
  const requestedPage = Number(searchParams.get("page") ?? "1");
  const page =
    Number.isSafeInteger(requestedPage) && requestedPage > 0
      ? requestedPage
      : 1;
  const jobIdFilter = searchParams.get("job") ?? "";
  const LIMIT = 20;

  useEffect(() => {
    setSearchDraft(searchFilter);
  }, [searchFilter]);

  const queryKey = [
    "job-executions",
    page,
    queueFilter,
    statusFilter,
    jobIdFilter,
    searchFilter,
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
      if (searchFilter) params.set("search", searchFilter);
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

  const totalPages = data ? Math.max(1, Math.ceil(data.total / LIMIT)) : 1;

  useEffect(() => {
    if (!data || page <= totalPages) return;
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (totalPages <= 1) next.delete("page");
        else next.set("page", String(totalPages));
        return next;
      },
      { replace: true },
    );
  }, [data, page, setSearchParams, totalPages]);

  function updateFilter(key: "queue" | "status", value: string) {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (value === "all") next.delete(key);
      else next.set(key, value);
      next.delete("page");
      return next;
    });
  }

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = new URLSearchParams(searchParams);
    const value = searchDraft.trim();
    if (value) next.set("q", value);
    else next.delete("q");
    next.delete("job");
    next.delete("page");
    setSearchParams(next);
  }

  function clearFilters() {
    setSearchDraft("");
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      ["q", "job", "queue", "status", "page"].forEach((key) =>
        next.delete(key),
      );
      return next;
    });
  }

  function goToPage(nextPage: number) {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (nextPage <= 1) next.delete("page");
      else next.set("page", String(nextPage));
      return next;
    });
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <ClipboardList className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-xl font-semibold">Activity Log</h1>
          {data && (
            <span className="text-sm text-muted-foreground" aria-live="polite">
              {data.total} {data.total === 1 ? "job" : "jobs"}
              {searchFilter ||
              jobIdFilter ||
              queueFilter !== "all" ||
              statusFilter !== "all"
                ? " match"
                : " total"}
            </span>
          )}
        </div>

        {/* Filters */}
        <div className="flex flex-col gap-2 md:flex-row md:items-center">
          <form
            onSubmit={submitSearch}
            role="search"
            aria-label="Search activity"
            className="flex w-full gap-2 md:max-w-xl"
          >
            <div className="relative min-w-0 flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                value={searchDraft}
                onChange={(event) => setSearchDraft(event.target.value)}
                maxLength={100}
                placeholder="Search jobs, projects, clients, queues, errors…"
                aria-label="Search jobs by ID, project, client, queue, or error"
                className="h-9 pl-9"
              />
            </div>
            <Button type="submit" variant="outline" size="sm" className="h-9">
              Search
            </Button>
          </form>

          <div className="flex flex-col gap-2 sm:flex-row">
            <Select
              value={queueFilter}
              onValueChange={(value) => updateFilter("queue", value)}
            >
              <SelectTrigger className="h-9 w-full text-xs sm:w-40">
                <SelectValue placeholder="All queues" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All queues</SelectItem>
                {QUEUE_OPTIONS.map(({ value, label }) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={statusFilter}
              onValueChange={(value) => updateFilter("status", value)}
            >
              <SelectTrigger className="h-9 w-full text-xs sm:w-40">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {STATUS_ORDER.map((status) => (
                  <SelectItem key={status} value={status}>
                    {STATUS_LABELS[status] ?? status}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      {(searchFilter ||
        jobIdFilter ||
        queueFilter !== "all" ||
        statusFilter !== "all") && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/20 px-3 py-2">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">Filtered activity</span>
            {searchFilter && (
              <Badge variant="secondary">Search: {searchFilter}</Badge>
            )}
            {jobIdFilter && /^\d+$/.test(jobIdFilter) && (
              <Badge variant="secondary">Job #{jobIdFilter}</Badge>
            )}
            {queueFilter !== "all" && (
              <Badge variant="secondary">{queueLabel(queueFilter)}</Badge>
            )}
            {statusFilter !== "all" && (
              <Badge variant="secondary">{STATUS_LABELS[statusFilter]}</Badge>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={clearFilters}
            className="gap-1"
          >
            <X className="h-3.5 w-3.5" />
            Clear filters
          </Button>
        </div>
      )}

      {isError && data && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-sm"
        >
          <span>
            Could not refresh activity. Showing the last loaded results.
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void refetch()}
          >
            Retry
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
            {isError && !data ? (
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
                  No jobs match these filters
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
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            Showing {(page - 1) * LIMIT + 1}–
            {Math.min(page * LIMIT, data.total)} of {data.total}
          </p>
          <nav
            className="flex items-center gap-2"
            aria-label="Activity pagination"
          >
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => goToPage(page - 1)}
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
              onClick={() => goToPage(page + 1)}
            >
              Next
            </Button>
          </nav>
        </div>
      )}
    </div>
  );
}
