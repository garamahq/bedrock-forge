import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronUp,
  Clock,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Copy,
  Download,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { api } from "@/lib/api-client";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { toast } from "@/hooks/use-toast";

export interface ExecutionLogEntry {
  ts: string;
  step: string;
  level: "info" | "warn" | "error";
  detail?: string;
  command?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  durationMs?: number;
}

interface JobExecutionLog {
  id: number;
  status: string;
  progress: number | null;
  execution_log: ExecutionLogEntry[] | null;
  last_error?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  created_at?: string | null;
}

function formatDuration(ms: number) {
  if (ms < 1000) return "<1s";
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

function useElapsedLabel(
  start?: string | null,
  end?: string | null,
  active?: boolean,
) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [active]);

  if (!start) return null;
  const startedAt = new Date(start).getTime();
  const endedAt = end ? new Date(end).getTime() : Date.now();
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) return null;
  return formatDuration(Math.max(0, endedAt - startedAt));
}

function LevelIcon({ level }: { level: ExecutionLogEntry["level"] }) {
  if (level === "error")
    return (
      <XCircle className="h-3.5 w-3.5 text-destructive flex-shrink-0 mt-0.5" />
    );
  if (level === "warn")
    return (
      <AlertTriangle className="h-3.5 w-3.5 text-warning flex-shrink-0 mt-0.5" />
    );
  return (
    <CheckCircle2 className="h-3.5 w-3.5 text-success flex-shrink-0 mt-0.5" />
  );
}

function EntryRow({
  entry,
  isLast,
}: {
  entry: ExecutionLogEntry;
  isLast: boolean;
}) {
  const ts = new Date(entry.ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });
  const hasOutput = Boolean(entry.command || entry.stdout || entry.stderr);

  return (
    <li className="flex gap-3">
      {/* timeline spine */}
      <div className="flex flex-col items-center">
        <LevelIcon level={entry.level} />
        {!isLast && <div className="w-px flex-1 bg-border mt-1" />}
      </div>

      <div className="pb-3 min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
          <span
            className={`text-xs font-medium ${
              entry.level === "error"
                ? "text-destructive"
                : entry.level === "warn"
                  ? "text-warning"
                  : "text-foreground"
            }`}
          >
            {entry.step}
          </span>
          <span className="text-xs text-muted-foreground flex items-center gap-1">
            <Clock className="h-2.5 w-2.5" />
            {ts}
          </span>
          {entry.durationMs !== undefined && (
            <span className="text-xs text-muted-foreground">
              {entry.durationMs < 1000
                ? `${entry.durationMs}ms`
                : `${(entry.durationMs / 1000).toFixed(1)}s`}
            </span>
          )}
          {entry.exitCode !== undefined && (
            <span
              className={`text-xs font-mono px-1 rounded ${
                entry.exitCode === 0
                  ? "bg-success/10 text-success"
                  : "bg-destructive/10 text-destructive"
              }`}
            >
              exit {entry.exitCode}
            </span>
          )}
        </div>

        {entry.detail && (
          <p className="text-xs text-muted-foreground mt-0.5 break-all">
            {entry.detail}
          </p>
        )}

        {hasOutput && (
          <details className="mt-1.5 rounded-md border border-border/60 bg-muted/20 px-2 py-1.5">
            <summary className="cursor-pointer text-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              Show command output
            </summary>
            <div className="mt-2 space-y-2">
              {entry.command && (
                <div>
                  <p className="mb-1 text-[11px] font-medium text-muted-foreground">
                    Command
                  </p>
                  <code className="block rounded bg-muted p-2 text-xs font-mono whitespace-pre-wrap break-all">
                    {entry.command}
                  </code>
                </div>
              )}
              {entry.stdout && (
                <div>
                  <p className="mb-1 text-[11px] font-medium text-muted-foreground">
                    stdout
                  </p>
                  <pre className="max-h-40 overflow-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap break-all">
                    {entry.stdout}
                  </pre>
                </div>
              )}
              {entry.stderr && (
                <div>
                  <p
                    className={`mb-1 text-[11px] font-medium ${entry.level === "error" ? "text-destructive" : "text-warning"}`}
                  >
                    stderr
                    {entry.exitCode === 0 ? " · command succeeded" : ""}
                  </p>
                  <pre
                    className={`max-h-40 overflow-auto rounded p-2 text-xs whitespace-pre-wrap break-all ${entry.level === "error" ? "bg-destructive/10 text-destructive" : "bg-warning/10 text-foreground"}`}
                  >
                    {entry.stderr}
                  </pre>
                </div>
              )}
            </div>
          </details>
        )}
      </div>
    </li>
  );
}

/**
 * ExecutionLogPanel
 *
 * Lazy-fetches and renders the execution_log timeline for a given
 * JobExecution. Pass `jobExecutionId=null` to render nothing.
 * Pass `isActive=true` while a job is running to poll every 2 s.
 */
export function ExecutionLogPanel({
  jobExecutionId,
  isActive = false,
  targetLabel,
}: {
  jobExecutionId: number | null;
  isActive?: boolean;
  targetLabel?: string;
}) {
  const [copied, setCopied] = useState(false);
  const queryClient = useQueryClient();
  const [isActionPending, setIsActionPending] = useState(false);

  async function handleRetry() {
    if (!jobExecutionId) return;
    setIsActionPending(true);
    try {
      await api.post(`/job-executions/${jobExecutionId}/retry`, {});
      queryClient.invalidateQueries({ queryKey: ["job-executions"] });
      queryClient.invalidateQueries({
        queryKey: ["execution-log", jobExecutionId],
      });
      toast({ title: "Job retry queued" });
    } catch (err) {
      toast({
        title: "Could not retry job",
        description: err instanceof Error ? err.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsActionPending(false);
    }
  }

  async function handleRemoveFromQueue() {
    if (!jobExecutionId) return;
    setIsActionPending(true);
    try {
      await api.post(`/job-executions/${jobExecutionId}/discard`, {});
      queryClient.invalidateQueries({ queryKey: ["job-executions"] });
      queryClient.invalidateQueries({
        queryKey: ["execution-log", jobExecutionId],
      });
      toast({
        title:
          data?.status === "queued"
            ? "Queued job removed from queue"
            : "Queue job removed",
      });
    } catch (err) {
      toast({
        title: "Could not remove queued job",
        description: err instanceof Error ? err.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsActionPending(false);
    }
  }

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["execution-log", jobExecutionId],
    queryFn: () =>
      api.get<JobExecutionLog>(`/job-executions/${jobExecutionId}/log`),
    enabled: jobExecutionId != null,
    staleTime: isActive ? 0 : 10_000,
    refetchInterval: isActive ? 2_000 : false,
  });

  const entries = data?.execution_log ?? [];
  const active =
    isActive || data?.status === "queued" || data?.status === "active";
  const elapsed = useElapsedLabel(
    data?.started_at ?? data?.created_at,
    data?.completed_at,
    active,
  );
  const latest = entries[entries.length - 1];

  if (!jobExecutionId) return null;

  if (isLoading) {
    return (
      <div className="space-y-2 py-3">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-4 w-64" />
        <Skeleton className="h-4 w-56" />
      </div>
    );
  }

  if (isError && !data) {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3">
        <p role="alert" className="text-sm font-medium">
          Could not load this execution log.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void refetch()}
          className="mt-2"
        >
          Try again
        </Button>
      </div>
    );
  }

  function formatAsText(): string {
    const lines = [
      `Execution log #${jobExecutionId}`,
      `Status: ${data?.status ?? "unknown"}`,
      `Started: ${data?.started_at ?? data?.created_at ?? "unknown"}`,
      `Completed: ${data?.completed_at ?? "in progress or unavailable"}`,
      ...(targetLabel ? [`Target: ${targetLabel}`] : []),
      "",
    ];

    for (const entry of entries) {
      lines.push(`[${entry.ts}] [${entry.level.toUpperCase()}] ${entry.step}`);
      if (entry.detail) lines.push(`  Detail: ${entry.detail}`);
      if (entry.command) lines.push(`  Command: ${entry.command}`);
      if (entry.exitCode !== undefined)
        lines.push(`  Exit code: ${entry.exitCode}`);
      if (entry.durationMs !== undefined)
        lines.push(`  Duration: ${entry.durationMs}ms`);
      if (entry.stdout) lines.push(`  stdout:\n${entry.stdout}`);
      if (entry.stderr) lines.push(`  stderr:\n${entry.stderr}`);
      lines.push("");
    }
    return lines.join("\n");
  }

  async function handleCopy() {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard access is unavailable in this browser.");
      }
      await navigator.clipboard.writeText(formatAsText());
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
      toast({ title: "Execution log copied" });
    } catch (err) {
      toast({
        title: "Could not copy execution log",
        description: err instanceof Error ? err.message : "Please try again.",
        variant: "destructive",
      });
    }
  }

  function handleDownload() {
    const blob = new Blob([formatAsText()], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `execution-log-${jobExecutionId}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const directionEntry = entries.find(
    (entry) => entry.step === "Sync direction",
  );
  const legacyDirectionEntry = entries.find((entry) =>
    /sync (?:push )?started/i.test(entry.step),
  );
  const direction =
    directionEntry?.detail ??
    legacyDirectionEntry?.detail?.replace(/,\s*scope=.*$/i, "");
  const safetyEntries = entries.filter((entry) =>
    entry.step.toLowerCase().includes("safety backup"),
  );
  const safetySkipped = safetyEntries.some((entry) =>
    entry.step.toLowerCase().includes("skipped"),
  );
  const safetyFailed = safetyEntries.some(
    (entry) =>
      entry.level === "error" ||
      (entry.exitCode != null && entry.exitCode !== 0),
  );
  const safetyComplete = safetyEntries.some((entry) =>
    [
      "safety backup recorded",
      "safety backup uploaded to google drive",
    ].includes(entry.step.toLowerCase()),
  );
  const safetyStatus = safetySkipped
    ? "Skipped"
    : safetyFailed
      ? "Failed"
      : safetyComplete
        ? "Completed"
        : "In progress";
  const stderrCount = entries.filter((entry) => Boolean(entry.stderr)).length;

  const summary = (
    <div className="mb-3 rounded-md border bg-muted/30 p-3">
      <div className="flex flex-wrap items-center gap-2" aria-live="polite">
        <Badge
          variant={
            data?.status === "failed" || data?.status === "dead_letter"
              ? "destructive"
              : data?.status === "completed"
                ? "success"
                : "secondary"
          }
          className="capitalize"
        >
          {active && (
            <span className="mr-1.5 h-2 w-2 animate-pulse rounded-full bg-current" />
          )}
          {data?.status === "discarded"
            ? "Removed from queue"
            : (data?.status?.replace("_", " ") ?? "queued")}
        </Badge>
        {elapsed && (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Clock className="h-3 w-3" />
            {active ? `${elapsed} elapsed` : elapsed}
          </span>
        )}
        {data?.progress != null && (
          <span className="text-xs font-medium tabular-nums">
            {data.progress}%
          </span>
        )}
        {stderrCount > 0 && (
          <Badge variant="warning">
            {stderrCount} stderr {stderrCount === 1 ? "message" : "messages"}
          </Badge>
        )}
        {safetyEntries.length > 0 && (
          <Badge
            variant={
              safetySkipped || safetyFailed
                ? "warning"
                : safetyComplete
                  ? "success"
                  : "secondary"
            }
          >
            Safety backup: {safetyStatus}
          </Badge>
        )}
      </div>
      {data?.progress != null && data.status !== "completed" && (
        <Progress value={data.progress} className="mt-2 h-1.5" />
      )}
      {latest && (
        <p className="mt-2 truncate text-xs text-muted-foreground">
          {latest.step}
        </p>
      )}
      {direction && (
        <div className="mt-2 border-t border-border/40 pt-2">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Source → target
          </p>
          <p className="mt-0.5 text-sm">{direction}</p>
        </div>
      )}
      {targetLabel && (
        <p className="mt-2 text-xs text-muted-foreground">
          Target environment: {targetLabel}
        </p>
      )}
      {data?.last_error && (
        <p className="mt-2 break-all text-xs text-destructive">
          {data.last_error}
        </p>
      )}
      {(data?.status === "failed" ||
        data?.status === "dead_letter" ||
        data?.status === "queued" ||
        data?.status === "active") && (
        <div className="mt-3 flex items-center gap-2 border-t border-border/40 pt-3">
          {(data?.status === "failed" || data?.status === "dead_letter") && (
            <Button
              size="sm"
              variant="outline"
              onClick={handleRetry}
              disabled={isActionPending}
              className="h-7 px-2.5 text-xs gap-1 border-emerald-800 text-emerald-400 hover:bg-emerald-950/20 hover:text-emerald-300"
            >
              <RefreshCw className="h-3 w-3" />
              Retry Job
            </Button>
          )}
          {data?.status === "queued" ? (
            <Button
              size="sm"
              variant="outline"
              onClick={handleRemoveFromQueue}
              disabled={isActionPending}
              className="h-7 px-2.5 text-xs gap-1 border-rose-800 text-rose-400 hover:bg-rose-950/20 hover:text-rose-300"
            >
              <Trash2 className="h-3 w-3" />
              Remove from queue
            </Button>
          ) : data?.status === "active" ? (
            <p className="text-xs text-muted-foreground" role="status">
              This job is running. Wait for it to finish; it cannot be cancelled
              here.
            </p>
          ) : null}
        </div>
      )}
    </div>
  );

  if (entries.length === 0) {
    return (
      <div className="pt-2">
        {summary}
        <p className="text-xs text-muted-foreground py-2">
          No execution log available for this job yet.
        </p>
      </div>
    );
  }

  return (
    <div className="pt-2">
      {summary}
      <div className="flex items-center justify-end gap-2 mb-2">
        <button
          type="button"
          onClick={() => void handleCopy()}
          className="inline-flex min-h-8 items-center gap-1 rounded px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Copy complete execution log"
        >
          <Copy className="h-3.5 w-3.5" />
          {copied ? "Copied!" : "Copy"}
        </button>
        <button
          type="button"
          onClick={handleDownload}
          className="inline-flex min-h-8 items-center gap-1 rounded px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Download complete execution log"
        >
          <Download className="h-3.5 w-3.5" />
          Download
        </button>
      </div>
      <ol aria-label="Execution steps" className="space-y-0">
        {entries.map((entry, i) => (
          <EntryRow
            key={`${entry.ts}-${entry.step}-${i}`}
            entry={entry}
            isLast={i === entries.length - 1}
          />
        ))}
      </ol>
    </div>
  );
}

/**
 * ExpandLogButton
 *
 * Toggle button that controls whether the ExecutionLogPanel is shown.
 */
export function ExpandLogButton({
  expanded,
  onToggle,
  disabled,
  id,
  controlsId,
  label,
}: {
  expanded: boolean;
  onToggle: () => void;
  disabled?: boolean;
  id?: string;
  controlsId?: string;
  label?: string;
}) {
  const accessibleLabel =
    label ?? `${expanded ? "Hide" : "Show"} execution log`;
  return (
    <button
      type="button"
      id={id}
      onClick={onToggle}
      disabled={disabled}
      aria-label={accessibleLabel}
      aria-expanded={expanded}
      aria-controls={controlsId}
      className="inline-flex min-h-8 items-center gap-1 rounded px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40 disabled:pointer-events-none"
      title={accessibleLabel}
    >
      {expanded ? (
        <ChevronUp className="h-3.5 w-3.5" />
      ) : (
        <ChevronDown className="h-3.5 w-3.5" />
      )}
      Log
    </button>
  );
}
