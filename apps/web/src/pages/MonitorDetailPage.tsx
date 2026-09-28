import { useState, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { isHttpStatusWorking } from "@bedrock-forge/shared";
import {
  ArrowLeft,
  Activity,
  Clock,
  TrendingUp,
  Wifi,
  WifiOff,
  Shield,
  Globe,
  Type,
  RefreshCw,
} from "lucide-react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { api } from "@/lib/api-client";
import { toast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorState, Pagination } from "@/components/crud";

// ── Types ────────────────────────────────────────────────────────────────────

interface MonitorDetail {
  id: number;
  enabled: boolean;
  interval_seconds: number;
  uptime_pct: number | string;
  last_status: number | null;
  last_response_ms: number | null;
  last_checked_at: string | null;
  check_ssl: boolean;
  ssl_expires_at: string | null;
  ssl_issuer: string | null;
  ssl_days_remaining: number | null;
  ssl_alert_days: number | null;
  check_dns: boolean;
  dns_resolves: boolean | null;
  check_keyword: boolean;
  keyword: string | null;
  keyword_found: boolean | null;
  environment: { id: number; url: string; type: string };
  monitor_results: MonitorResult[];
}

interface MonitorResult {
  id: number;
  is_up: boolean;
  status_code: number;
  response_ms: number;
  checked_at: string;
  ssl_days_remaining: number | null;
  dns_resolves: boolean | null;
  keyword_found: boolean | null;
}

interface MonitorLog {
  id: number;
  event_type: "down" | "up" | "degraded";
  status_code: number | null;
  response_ms: number | null;
  message: string | null;
  occurred_at: string;
  resolved_at: string | null;
  duration_seconds: number | null;
}

interface PaginatedLogs {
  items: MonitorLog[];
  total: number;
  page: number;
  limit: number;
}

interface PaginatedResults {
  items: MonitorResult[];
  total: number;
  page: number;
  limit: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDuration(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function StatusDot({ statusCode }: { statusCode: number | null }) {
  if (statusCode === null)
    return (
      <span className="inline-block w-2.5 h-2.5 rounded-full bg-muted shrink-0" />
    );
  return (
    <span
      className={`inline-block w-2.5 h-2.5 rounded-full shrink-0 ${
        isHttpStatusWorking(statusCode) ? "bg-green-500" : "bg-red-500"
      }`}
    />
  );
}

// ── Response Time Chart ───────────────────────────────────────────────────────

function ResponseTimeChart({ results }: { results: MonitorResult[] }) {
  const chartData = useMemo(() => {
    // Oldest first for chart
    return [...results].reverse().map((r) => ({
      time: new Date(r.checked_at).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }),
      response_ms: r.response_ms,
      status: r.status_code,
      is_up: r.is_up,
    }));
  }, [results]);

  if (results.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-sm text-muted-foreground">
        No data available yet
      </div>
    );
  }

  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart
          data={chartData}
          margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
        >
          <defs>
            <linearGradient id="colorResponse" x1="0" y1="0" x2="0" y2="1">
              <stop
                offset="5%"
                stopColor="hsl(var(--primary))"
                stopOpacity={0.3}
              />
              <stop
                offset="95%"
                stopColor="hsl(var(--primary))"
                stopOpacity={0}
              />
            </linearGradient>
          </defs>
          <CartesianGrid
            strokeDasharray="3 3"
            vertical={false}
            stroke="hsl(var(--border))"
          />
          <XAxis
            dataKey="time"
            axisLine={false}
            tickLine={false}
            tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
            interval="preserveStartEnd"
            minTickGap={30}
          />
          <YAxis
            axisLine={false}
            tickLine={false}
            tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "hsl(var(--background))",
              border: "1px solid hsl(var(--border))",
              borderRadius: "var(--radius)",
              fontSize: "12px",
            }}
            itemStyle={{ color: "hsl(var(--primary))" }}
            cursor={{ stroke: "hsl(var(--primary))", strokeWidth: 1 }}
          />
          <Area
            type="monotone"
            dataKey="response_ms"
            stroke="hsl(var(--primary))"
            strokeWidth={2}
            fillOpacity={1}
            fill="url(#colorResponse)"
            animationDuration={1500}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── Incident Log ──────────────────────────────────────────────────────────────

function IncidentLog({ logs }: { logs: MonitorLog[] }) {
  if (logs.length === 0) {
    return (
      <div className="text-center py-8 text-sm text-muted-foreground">
        No incidents recorded yet.
      </div>
    );
  }

  return (
    <div className="space-y-0 divide-y divide-border">
      {logs.map((log) => (
        <div key={log.id} className="flex items-start gap-3 py-3 px-1">
          <div className="mt-0.5 shrink-0">
            {log.event_type === "down" ? (
              <WifiOff className="h-4 w-4 text-destructive" />
            ) : log.event_type === "up" ? (
              <Wifi className="h-4 w-4 text-green-500" />
            ) : (
              <Activity className="h-4 w-4 text-yellow-500" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span
                className={`text-sm font-medium ${
                  log.event_type === "down"
                    ? "text-destructive"
                    : log.event_type === "up"
                      ? "text-green-600 dark:text-green-400"
                      : "text-yellow-600 dark:text-yellow-400"
                }`}
              >
                {log.event_type === "down"
                  ? "Down"
                  : log.event_type === "up"
                    ? "Recovered"
                    : "Degraded"}
              </span>
              {log.status_code !== null && (
                <Badge variant="outline" className="text-xs font-mono">
                  HTTP {log.status_code}
                </Badge>
              )}
              {log.event_type === "down" && log.duration_seconds !== null && (
                <span className="text-xs text-muted-foreground">
                  Duration: {formatDuration(log.duration_seconds)}
                </span>
              )}
              {log.event_type === "down" && log.resolved_at === null && (
                <Badge variant="destructive" className="text-xs">
                  Ongoing
                </Badge>
              )}
            </div>
            {log.message && (
              <p className="text-xs text-muted-foreground mt-0.5">
                {log.message}
              </p>
            )}
            <p className="text-xs text-muted-foreground mt-0.5">
              {new Date(log.occurred_at).toLocaleString()}
              {log.resolved_at && (
                <> — resolved {new Date(log.resolved_at).toLocaleString()}</>
              )}
            </p>
          </div>
          {log.response_ms !== null && (
            <span className="text-xs text-muted-foreground font-mono shrink-0">
              {log.response_ms}ms
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export function MonitorDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const monitorId = Number(id);
  const validMonitorId = Number.isInteger(monitorId) && monitorId > 0;
  const [logPage, setLogPage] = useState(1);
  const [resultsPage, setResultsPage] = useState(1);

  const {
    data: monitor,
    isLoading,
    isError: monitorError,
    refetch: refetchMonitor,
  } = useQuery({
    queryKey: ["monitor", monitorId],
    queryFn: () => api.get<MonitorDetail>(`/monitors/${monitorId}`),
    refetchInterval: 30_000,
    enabled: validMonitorId,
  });

  const {
    data: logsData,
    isLoading: logsLoading,
    isError: logsError,
    refetch: refetchLogs,
  } = useQuery({
    queryKey: ["monitor-logs", monitorId, logPage],
    queryFn: () =>
      api.get<PaginatedLogs>(
        `/monitors/${monitorId}/logs?page=${logPage}&limit=10`,
      ),
    refetchInterval: 30_000,
    enabled: validMonitorId,
  });

  const {
    data: chartData,
    isError: chartError,
    refetch: refetchChart,
  } = useQuery({
    queryKey: ["monitor-chart-results", monitorId],
    queryFn: () =>
      api.get<PaginatedResults>(`/monitors/${monitorId}/results?limit=100`),
    refetchInterval: 30_000,
    enabled: validMonitorId,
  });

  const {
    data: resultsData,
    isError: resultsError,
    refetch: refetchResults,
  } = useQuery({
    queryKey: ["monitor-results", monitorId, resultsPage],
    queryFn: () =>
      api.get<PaginatedResults>(
        `/monitors/${monitorId}/results?page=${resultsPage}&limit=10`,
      ),
    refetchInterval: 30_000,
    enabled: validMonitorId,
  });

  const qc = useQueryClient();
  const triggerMutation = useMutation({
    mutationFn: () => api.post(`/monitors/${monitorId}/trigger`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["monitor", monitorId] });
      qc.invalidateQueries({ queryKey: ["monitor-results", monitorId] });
      qc.invalidateQueries({ queryKey: ["monitor-chart-results", monitorId] });
      qc.invalidateQueries({ queryKey: ["monitor-logs", monitorId] });
      toast({ title: "Health check triggered successfully" });
    },
    onError: (err) => {
      toast({
        title: "Failed to trigger health check",
        description: err instanceof Error ? err.message : "Error",
        variant: "destructive",
      });
    },
  });

  if (!validMonitorId) {
    return (
      <div className="space-y-4">
        <ErrorState
          title="Invalid monitor link"
          description="The monitor ID in this address is not valid."
        />
        <div className="flex justify-center">
          <Button variant="outline" onClick={() => navigate("/monitors")}>
            Back to monitors
          </Button>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-24 rounded-lg" />
          ))}
        </div>
        <Skeleton className="h-32 rounded-lg" />
        <Skeleton className="h-64 rounded-lg" />
      </div>
    );
  }

  if (monitorError) {
    return (
      <div className="space-y-4">
        <ErrorState
          title="Could not load monitor"
          description="The monitor may be unavailable, or the request may have failed."
          onRetry={() => void refetchMonitor()}
        />
        <div className="flex justify-center">
          <Button variant="outline" onClick={() => navigate("/monitors")}>
            Back to monitors
          </Button>
        </div>
      </div>
    );
  }

  if (!monitor) {
    return (
      <div className="space-y-4">
        <p className="text-center py-8 text-muted-foreground">
          Monitor not found.
        </p>
        <div className="flex justify-center">
          <Button variant="outline" onClick={() => navigate("/monitors")}>
            Back to monitors
          </Button>
        </div>
      </div>
    );
  }

  const uptimePct = parseFloat(String(monitor.uptime_pct ?? 0));
  const results =
    resultsData?.items ?? monitor.monitor_results?.slice(0, 10) ?? [];
  const chartResults = chartData?.items ?? monitor.monitor_results ?? [];
  const logs = logsData?.items ?? [];

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 flex-1 min-w-0">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 mt-0.5 shrink-0"
            onClick={() => navigate("/monitors")}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <StatusDot statusCode={monitor.last_status} />
              <a
                href={monitor.environment.url}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-sm text-primary hover:underline truncate"
              >
                {monitor.environment.url}
              </a>
              <Badge variant="outline" className="text-xs capitalize">
                {monitor.environment.type}
              </Badge>
              {!monitor.enabled && (
                <Badge variant="secondary" className="text-xs">
                  Paused
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Checks every {monitor.interval_seconds}s ·{" "}
              {monitor.last_checked_at
                ? `Last checked ${new Date(monitor.last_checked_at).toLocaleString()}`
                : "Never checked"}
            </p>
          </div>
        </div>

        <Button
          variant="outline"
          size="sm"
          className="flex items-center gap-1.5 shrink-0"
          onClick={() => triggerMutation.mutate()}
          disabled={triggerMutation.isPending}
        >
          <RefreshCw
            className={`h-4 w-4 ${triggerMutation.isPending ? "animate-spin" : ""}`}
          />
          {triggerMutation.isPending ? "Checking..." : "Ping Now"}
        </Button>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card>
          <CardHeader className="pb-1 pt-3 px-4">
            <CardTitle className="text-xs text-muted-foreground font-normal">
              Status
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-3">
            <p
              className={`text-xl font-semibold ${
                isHttpStatusWorking(monitor.last_status)
                  ? "text-green-600 dark:text-green-400"
                  : monitor.last_status === null
                    ? "text-muted-foreground"
                    : "text-destructive"
              }`}
            >
              {monitor.last_status === null
                ? "Pending"
                : isHttpStatusWorking(monitor.last_status)
                  ? "UP"
                  : "DOWN"}
            </p>
            {monitor.last_status !== null && (
              <p className="text-xs text-muted-foreground font-mono">
                HTTP {monitor.last_status}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-1 pt-3 px-4">
            <CardTitle className="text-xs text-muted-foreground font-normal flex items-center gap-1">
              <TrendingUp className="h-3 w-3" /> Uptime
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-3">
            <p
              className={`text-xl font-semibold font-mono ${
                uptimePct >= 99
                  ? "text-green-600 dark:text-green-400"
                  : uptimePct >= 95
                    ? "text-yellow-600 dark:text-yellow-400"
                    : "text-destructive"
              }`}
            >
              {uptimePct.toFixed(2)}%
            </p>
            <p className="text-xs text-muted-foreground">30-day rolling</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-1 pt-3 px-4">
            <CardTitle className="text-xs text-muted-foreground font-normal flex items-center gap-1">
              <Clock className="h-3 w-3" /> Response
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-3">
            <p className="text-xl font-semibold font-mono">
              {monitor.last_response_ms !== null
                ? `${monitor.last_response_ms}ms`
                : "—"}
            </p>
            <p className="text-xs text-muted-foreground">Last check</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-1 pt-3 px-4">
            <CardTitle className="text-xs text-muted-foreground font-normal flex items-center gap-1">
              <Activity className="h-3 w-3" /> Log entries
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-3">
            <p className="text-xl font-semibold">{logsData?.total ?? "—"}</p>
            <p className="text-xs text-muted-foreground">Monitor history</p>
          </CardContent>
        </Card>
      </div>

      {/* Advanced checks stat cards */}
      {(monitor.check_ssl || monitor.check_dns || monitor.check_keyword) && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {monitor.check_ssl && (
            <Card>
              <CardHeader className="pb-1 pt-3 px-4">
                <CardTitle className="text-xs text-muted-foreground font-normal flex items-center gap-1">
                  <Shield className="h-3 w-3" /> SSL Certificate
                </CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-3">
                {monitor.ssl_days_remaining !== null ? (
                  <>
                    <p
                      className={`text-xl font-semibold font-mono ${
                        monitor.ssl_days_remaining <= 7
                          ? "text-destructive"
                          : monitor.ssl_days_remaining <= 30
                            ? "text-yellow-600 dark:text-yellow-400"
                            : "text-green-600 dark:text-green-400"
                      }`}
                    >
                      {monitor.ssl_days_remaining}d
                    </p>
                    <p className="text-xs text-muted-foreground truncate">
                      {monitor.ssl_issuer ?? "Unknown issuer"}
                      {monitor.ssl_expires_at &&
                        ` · Expires ${new Date(monitor.ssl_expires_at).toLocaleDateString()}`}
                    </p>
                  </>
                ) : (
                  <p className="text-xl font-semibold text-muted-foreground">
                    Pending
                  </p>
                )}
              </CardContent>
            </Card>
          )}
          {monitor.check_dns && (
            <Card>
              <CardHeader className="pb-1 pt-3 px-4">
                <CardTitle className="text-xs text-muted-foreground font-normal flex items-center gap-1">
                  <Globe className="h-3 w-3" /> DNS
                </CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-3">
                <p
                  className={`text-xl font-semibold ${
                    monitor.dns_resolves === null
                      ? "text-muted-foreground"
                      : monitor.dns_resolves
                        ? "text-green-600 dark:text-green-400"
                        : "text-destructive"
                  }`}
                >
                  {monitor.dns_resolves === null
                    ? "Pending"
                    : monitor.dns_resolves
                      ? "Resolves"
                      : "FAILED"}
                </p>
                <p className="text-xs text-muted-foreground">
                  DNS A record lookup
                </p>
              </CardContent>
            </Card>
          )}
          {monitor.check_keyword && monitor.keyword && (
            <Card>
              <CardHeader className="pb-1 pt-3 px-4">
                <CardTitle className="text-xs text-muted-foreground font-normal flex items-center gap-1">
                  <Type className="h-3 w-3" /> Keyword
                </CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-3">
                <p
                  className={`text-xl font-semibold ${
                    monitor.keyword_found === null
                      ? "text-muted-foreground"
                      : monitor.keyword_found
                        ? "text-green-600 dark:text-green-400"
                        : "text-destructive"
                  }`}
                >
                  {monitor.keyword_found === null
                    ? "Pending"
                    : monitor.keyword_found
                      ? "Found"
                      : "Missing"}
                </p>
                <p className="text-xs text-muted-foreground font-mono truncate">
                  "{monitor.keyword}"
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Response time chart */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Response Time History</CardTitle>
        </CardHeader>
        <CardContent>
          {chartError ? (
            <ErrorState
              title="Could not load response time history"
              onRetry={() => void refetchChart()}
              className="py-8"
            />
          ) : (
            <ResponseTimeChart results={chartResults} />
          )}
        </CardContent>
      </Card>

      {/* Incident history */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Incident History</CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          {logsError ? (
            <ErrorState
              title="Could not load monitor history"
              onRetry={() => void refetchLogs()}
              className="py-8"
            />
          ) : logsLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : (
            <>
              <IncidentLog logs={logs} />
              {logsData && logsData.total > 10 && (
                <div className="mt-4">
                  <Pagination
                    page={logPage}
                    totalPages={Math.ceil(logsData.total / 10)}
                    onPageChange={setLogPage}
                  />
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Raw check results table */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Recent Checks</CardTitle>
        </CardHeader>
        <CardContent className="p-0 pb-4">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">
                    Time
                  </th>
                  <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">
                    Status
                  </th>
                  <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">
                    HTTP Code
                  </th>
                  <th className="px-4 py-2.5 text-right font-medium text-muted-foreground">
                    Response
                  </th>
                  {monitor.check_ssl && (
                    <th className="px-4 py-2.5 text-right font-medium text-muted-foreground">
                      SSL days
                    </th>
                  )}
                  {monitor.check_dns && (
                    <th className="px-4 py-2.5 text-center font-medium text-muted-foreground">
                      DNS
                    </th>
                  )}
                  {monitor.check_keyword && (
                    <th className="px-4 py-2.5 text-center font-medium text-muted-foreground">
                      Keyword
                    </th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {resultsError ? (
                  <tr>
                    <td
                      colSpan={
                        4 +
                        Number(monitor.check_ssl) +
                        Number(monitor.check_dns) +
                        Number(monitor.check_keyword)
                      }
                      className="px-4 py-6"
                    >
                      <ErrorState
                        title="Could not load recent checks"
                        onRetry={() => void refetchResults()}
                        className="py-4"
                      />
                    </td>
                  </tr>
                ) : results.length === 0 ? (
                  <tr>
                    <td
                      colSpan={
                        4 +
                        Number(monitor.check_ssl) +
                        Number(monitor.check_dns) +
                        Number(monitor.check_keyword)
                      }
                      className="px-4 py-6 text-center text-muted-foreground"
                    >
                      No checks have been recorded yet.
                    </td>
                  </tr>
                ) : (
                  results.map((r) => (
                    <tr
                      key={r.id}
                      className="hover:bg-muted/30 transition-colors"
                    >
                      <td className="px-4 py-2 text-muted-foreground font-mono">
                        {new Date(r.checked_at).toLocaleString()}
                      </td>
                      <td className="px-4 py-2">
                        <div className="flex items-center gap-1.5">
                          <StatusDot statusCode={r.status_code} />
                          <span
                            className={
                              r.is_up
                                ? "text-green-600 dark:text-green-400 font-medium"
                                : "text-destructive font-medium"
                            }
                          >
                            {r.is_up ? "UP" : "DOWN"}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-2 font-mono text-muted-foreground">
                        {r.status_code || "—"}
                      </td>
                      <td className="px-4 py-2 text-right font-mono">
                        {r.response_ms}ms
                      </td>
                      {monitor.check_ssl && (
                        <td className="px-4 py-2 text-right font-mono text-muted-foreground">
                          {r.ssl_days_remaining != null
                            ? `${r.ssl_days_remaining}d`
                            : "—"}
                        </td>
                      )}
                      {monitor.check_dns && (
                        <td className="px-4 py-2 text-center">
                          {r.dns_resolves == null ? (
                            <span className="text-muted-foreground">—</span>
                          ) : r.dns_resolves ? (
                            <Globe className="h-3 w-3 text-green-500 mx-auto" />
                          ) : (
                            <Globe className="h-3 w-3 text-destructive mx-auto" />
                          )}
                        </td>
                      )}
                      {monitor.check_keyword && (
                        <td className="px-4 py-2 text-center">
                          {r.keyword_found == null ? (
                            <span className="text-muted-foreground">—</span>
                          ) : r.keyword_found ? (
                            <Type className="h-3 w-3 text-green-500 mx-auto" />
                          ) : (
                            <Type className="h-3 w-3 text-destructive mx-auto" />
                          )}
                        </td>
                      )}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          {resultsData && resultsData.total > 10 && (
            <div className="mt-4 px-4">
              <Pagination
                page={resultsPage}
                totalPages={Math.ceil(resultsData.total / 10)}
                onPageChange={setResultsPage}
              />
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
