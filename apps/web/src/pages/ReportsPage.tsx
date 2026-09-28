import { useState, useEffect, Fragment } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  FileBarChart,
  CheckCircle2,
  XCircle,
  Clock,
  Loader2,
  Send,
  CalendarClock,
  ChevronDown,
  ChevronUp,
  Bell,
} from "lucide-react";
import { api } from "@/lib/api-client";
import { toast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { ErrorState } from "@/components/crud";
import {
  ExecutionLogPanel,
  ExpandLogButton,
} from "@/components/ui/execution-log-panel";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ReportChannel {
  id: number;
  name: string;
  type: "slack" | "google_chat";
  slack_channel_id: string | null;
  has_token: boolean;
  has_webhook: boolean;
  active: boolean;
  subscribed: boolean;
}

interface ReportScheduleConfig {
  enabled: boolean;
  day_of_week: number;
  hour: number;
  minute: number;
  period?: string;
}

interface ReportExecutionRow {
  id: string;
  status: string;
  progress: number | null;
  last_error: string | null;
  payload: { period?: string; periodLabel?: string; dateRange?: string } | null;
  execution_log: unknown[] | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const PERIOD_OPTIONS = [
  { value: "last_7d", label: "Last 7 days" },
  { value: "last_30d", label: "Last 30 days" },
  { value: "last_90d", label: "Last 90 days" },
  { value: "this_month", label: "This month" },
  { value: "last_month", label: "Last month" },
] as const;

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
  if (status === "active")
    return (
      <Badge variant="info" className="gap-1">
        <Loader2 className="h-3 w-3 animate-spin" />
        Running
      </Badge>
    );
  return (
    <Badge variant="secondary" className="gap-1">
      <Clock className="h-3 w-3" />
      Pending
    </Badge>
  );
}

function durationLabel(started?: string | null, completed?: string | null) {
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

function fmtTime(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function ReportsPage() {
  const qc = useQueryClient();

  // ── Generate form state ──────────────────────────────────────────────────
  const [period, setPeriod] = useState<string>("last_7d");
  const [selectedChannelIds, setSelectedChannelIds] = useState<number[]>([]);

  // ── Schedule state ───────────────────────────────────────────────────────
  const [reportDayOfWeek, setReportDayOfWeek] = useState(1);
  const [reportHour, setReportHour] = useState(8);
  const [reportMinute, setReportMinute] = useState(0);
  const [reportEnabled, setReportEnabled] = useState(true);
  const [reportPeriod, setReportPeriod] = useState<string>("last_7d");

  // ── History expand state ─────────────────────────────────────────────────
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

  // ── Queries ──────────────────────────────────────────────────────────────

  const {
    data: channels = [],
    isLoading: channelsLoading,
    isError: channelsError,
    refetch: refetchChannels,
  } = useQuery({
    queryKey: ["report-channels"],
    queryFn: () => api.get<ReportChannel[]>("/reports/channels"),
  });

  const {
    data: history = [],
    isLoading: historyLoading,
    isError: historyError,
    refetch: refetchHistory,
  } = useQuery({
    queryKey: ["report-history"],
    queryFn: () => api.get<ReportExecutionRow[]>("/reports/history"),
    refetchInterval: 15_000,
  });

  const {
    data: scheduleConfig,
    isLoading: scheduleLoading,
    isError: scheduleError,
    refetch: refetchSchedule,
  } = useQuery({
    queryKey: ["report-config"],
    queryFn: () => api.get<ReportScheduleConfig | null>("/reports/config"),
  });

  // Sync schedule config into local state when loaded
  useEffect(() => {
    if (scheduleConfig) {
      setReportEnabled(scheduleConfig.enabled);
      setReportDayOfWeek(scheduleConfig.day_of_week);
      setReportHour(scheduleConfig.hour);
      setReportMinute(scheduleConfig.minute);
      setReportPeriod(scheduleConfig.period ?? "last_7d");
    }
  }, [scheduleConfig]);

  // ── Mutations ────────────────────────────────────────────────────────────

  const generateMutation = useMutation({
    mutationFn: () =>
      api.post<{ jobId: string }>("/reports/generate", {
        period,
        channelIds:
          selectedChannelIds.length > 0 ? selectedChannelIds : undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["report-history"] });
      toast({
        title: "Report queued",
        description: "It will be sent to the selected channels shortly.",
      });
    },
    onError: () =>
      toast({ title: "Failed to queue report", variant: "destructive" }),
  });

  const scheduleMutation = useMutation({
    mutationFn: () =>
      api.put("/reports/config", {
        enabled: reportEnabled,
        day_of_week: reportDayOfWeek,
        hour: reportHour,
        minute: reportMinute,
        period: reportPeriod,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["report-config"] });
      toast({ title: "Schedule saved" });
    },
    onError: () =>
      toast({ title: "Failed to save schedule", variant: "destructive" }),
  });
  const toggleSubscriptionMutation = useMutation({
    mutationFn: ({ id, subscribed }: { id: number; subscribed: boolean }) =>
      api.patch(`/reports/channels/${id}/subscribe`, { subscribed }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["report-channels"] });
    },
    onError: () =>
      toast({
        title: "Failed to update subscription",
        variant: "destructive",
      }),
  });
  // ── Helpers ──────────────────────────────────────────────────────────────

  function toggleChannel(id: number) {
    setSelectedChannelIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  function toggleRow(id: string) {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6 p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3">
        <FileBarChart className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-bold tracking-tight">Reports</h1>
      </div>

      {/* ── Generate Report Card ───────────────────────────────────────── */}
      <div className="border rounded-lg p-5 bg-card space-y-4">
        <h2 className="font-semibold text-base">Generate Report</h2>
        <p className="text-sm text-muted-foreground">
          Generate a PDF backup and monitor status report and send it
          immediately to selected messaging channels.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* Period picker */}
          <div className="space-y-1.5">
            <Label>Period</Label>
            <Select value={period} onValueChange={setPeriod}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PERIOD_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Channel override picker */}
          <div className="space-y-1.5">
            <Label>
              Override channels{" "}
              <span className="text-muted-foreground font-normal">
                (leave empty to send to all subscribed)
              </span>
            </Label>
            {channelsError ? (
              <ErrorState
                title="Could not load report channels"
                onRetry={() => void refetchChannels()}
                className="py-8"
              />
            ) : channelsLoading ? (
              <div className="text-sm text-muted-foreground flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
              </div>
            ) : channels.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No channels found. Subscribe channels below.
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {channels.map((ch) => {
                  const selected = selectedChannelIds.includes(ch.id);
                  return (
                    <button
                      key={ch.id}
                      type="button"
                      onClick={() => toggleChannel(ch.id)}
                      className={`px-3 py-1.5 rounded-md border text-sm font-medium transition-colors ${
                        selected
                          ? "bg-primary text-primary-foreground border-primary"
                          : ch.subscribed
                            ? "bg-background text-foreground border-border hover:bg-accent"
                            : "bg-background text-muted-foreground border-dashed border-border hover:bg-accent"
                      }`}
                    >
                      {ch.name}
                      {!ch.subscribed && (
                        <span className="ml-1 text-xs opacity-50">
                          (not subscribed)
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <Button
          onClick={() => generateMutation.mutate()}
          disabled={generateMutation.isPending}
          className="gap-2"
        >
          {generateMutation.isPending ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Queuing…
            </>
          ) : (
            <>
              <Send className="h-4 w-4" />
              Generate &amp; Send
            </>
          )}
        </Button>
      </div>
      {/* ── Channel Subscriptions ──────────────────────────────────────── */}
      <div className="border rounded-lg p-5 bg-card space-y-4">
        <h2 className="font-semibold text-base flex items-center gap-2">
          <Bell className="h-4 w-4" />
          Channel Subscriptions
        </h2>
        <p className="text-sm text-muted-foreground">
          Toggle which messaging channels automatically receive scheduled weekly
          reports.
        </p>
        {channelsError ? (
          <ErrorState
            title="Could not load channel subscriptions"
            onRetry={() => void refetchChannels()}
            className="py-8"
          />
        ) : channelsLoading ? (
          <div className="text-sm text-muted-foreground flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : channels.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No active notification channels.{" "}
            <a href="/notifications" className="underline">
              Add one here.
            </a>
          </p>
        ) : (
          <div className="divide-y border rounded-md">
            {channels.map((ch) => (
              <div key={ch.id} className="flex items-center gap-3 px-4 py-3">
                <Switch
                  checked={ch.subscribed}
                  onCheckedChange={(checked) =>
                    toggleSubscriptionMutation.mutate({
                      id: ch.id,
                      subscribed: checked,
                    })
                  }
                  disabled={toggleSubscriptionMutation.isPending}
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{ch.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {ch.type === "google_chat"
                      ? "Google Chat"
                      : ch.slack_channel_id
                        ? `#${ch.slack_channel_id}`
                        : "Slack"}
                  </p>
                </div>
                {ch.type === "slack" && !ch.has_token && (
                  <Badge variant="warning" className="text-xs shrink-0">
                    No token
                  </Badge>
                )}
                {ch.type === "google_chat" && !ch.has_webhook && (
                  <Badge variant="warning" className="text-xs shrink-0">
                    No webhook
                  </Badge>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      {/* ── Report History ─────────────────────────────────────────────── */}
      <div className="border rounded-lg bg-card overflow-hidden">
        <div className="px-5 py-4 border-b flex items-center justify-between">
          <h2 className="font-semibold text-base">Report History</h2>
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              qc.invalidateQueries({ queryKey: ["report-history"] })
            }
          >
            Refresh
          </Button>
        </div>

        {historyError ? (
          <ErrorState
            title="Could not load report history"
            onRetry={() => void refetchHistory()}
            className="py-8"
          />
        ) : historyLoading ? (
          <div className="flex items-center gap-2 px-5 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading history…
          </div>
        ) : history.length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted-foreground">
            No report runs yet. Use "Generate &amp; Send" above to create one.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground font-medium">
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Period</th>
                  <th className="px-4 py-3">Date Range</th>
                  <th className="px-4 py-3">Started</th>
                  <th className="px-4 py-3">Duration</th>
                  <th className="px-4 py-3">Error</th>
                  <th className="px-4 py-3 w-8"></th>
                </tr>
              </thead>
              <tbody>
                {history.map((row) => {
                  const isExpanded = expandedRows.has(row.id);
                  const hasLogs =
                    Array.isArray(row.execution_log) &&
                    row.execution_log.length > 0;
                  const periodLabel =
                    row.payload?.periodLabel ??
                    PERIOD_OPTIONS.find((o) => o.value === row.payload?.period)
                      ?.label ??
                    "Weekly";
                  return (
                    <Fragment key={row.id}>
                      <tr className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                        <td className="px-4 py-3">
                          <StatusBadge status={row.status} />
                        </td>
                        <td className="px-4 py-3 font-medium">{periodLabel}</td>
                        <td className="px-4 py-3 text-muted-foreground font-mono text-xs">
                          {row.payload?.dateRange ?? "—"}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground text-xs">
                          {fmtTime(row.started_at ?? row.created_at)}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {durationLabel(row.started_at, row.completed_at)}
                        </td>
                        <td className="px-4 py-3 max-w-xs">
                          {row.last_error ? (
                            <span
                              className="text-destructive text-xs truncate block"
                              title={row.last_error}
                            >
                              {row.last_error}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          {hasLogs && (
                            <ExpandLogButton
                              expanded={isExpanded}
                              onToggle={() => toggleRow(row.id)}
                            />
                          )}
                        </td>
                      </tr>
                      {isExpanded && hasLogs && (
                        <tr className="bg-muted/20">
                          <td colSpan={7} className="px-4 py-3">
                            <ExecutionLogPanel
                              jobExecutionId={Number(row.id)}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Separator />

      {/* ── Schedule Card ──────────────────────────────────────────────── */}
      <div className="border rounded-lg p-5 bg-card space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-base flex items-center gap-2">
            <CalendarClock className="h-4 w-4" />
            Automatic Schedule
          </h2>
          <label className="flex items-center gap-2 cursor-pointer select-none text-sm">
            <input
              type="checkbox"
              checked={scheduleConfig ? reportEnabled : false}
              onChange={(e) => setReportEnabled(e.target.checked)}
              className="h-4 w-4"
            />
            Enabled
          </label>
        </div>
        <p className="text-sm text-muted-foreground">
          Automatically sends a PDF report to all channels subscribed to{" "}
          <span className="font-mono">report.weekly</span>. Manage subscriptions
          in the Channel Subscriptions card above.
        </p>

        {scheduleError ? (
          <ErrorState
            title="Could not load report schedule"
            onRetry={() => void refetchSchedule()}
            className="py-8"
          />
        ) : scheduleLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading schedule…
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="space-y-1">
              <Label>Period</Label>
              <Select value={reportPeriod} onValueChange={setReportPeriod}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PERIOD_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Day of week</Label>
              <select
                value={reportDayOfWeek}
                onChange={(e) => setReportDayOfWeek(Number(e.target.value))}
                className="w-full h-9 rounded-md border bg-background px-3 text-sm"
              >
                {DAY_NAMES.map((d, i) => (
                  <option key={i} value={i}>
                    {d}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label>Hour (UTC)</Label>
              <Input
                type="number"
                min={0}
                max={23}
                value={reportHour}
                onChange={(e) =>
                  setReportHour(
                    Math.min(23, Math.max(0, Number(e.target.value))),
                  )
                }
              />
            </div>
            <div className="space-y-1">
              <Label>Minute</Label>
              <Input
                type="number"
                min={0}
                max={59}
                value={reportMinute}
                onChange={(e) =>
                  setReportMinute(
                    Math.min(59, Math.max(0, Number(e.target.value))),
                  )
                }
              />
            </div>
          </div>
        )}

        <Button
          onClick={() => scheduleMutation.mutate()}
          disabled={
            scheduleMutation.isPending || scheduleLoading || scheduleError
          }
        >
          {scheduleMutation.isPending ? (
            <>
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              Saving…
            </>
          ) : (
            "Save Schedule"
          )}
        </Button>
      </div>
    </div>
  );
}
