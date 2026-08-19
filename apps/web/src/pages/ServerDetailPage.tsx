import { useParams, useNavigate, Link } from "react-router-dom";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Server as ServerIcon,
  FolderKanban,
  Globe,
  Plug,
  ExternalLink,
  Pencil,
  RefreshCw,
  Activity,
  HardDrive,
  Terminal,
  Cpu,
  MemoryStick,
  History,
  Copy,
  Eye,
  EyeOff,
  Lock,
  User,
} from "lucide-react";
import { api } from "@/lib/api-client";
import { toast } from "@/hooks/use-toast";
import { useAuthStore } from "@/store/auth.store";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ServerFormDialog } from "./ServersPage";
import { ResourceActivityFeed } from "@/components/ResourceActivityFeed";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";


import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
} from "recharts";

interface Environment {
  id: number;
  type: string;
  url: string | null;
  root_path: string;
  google_drive_folder_id: string | null;
  project: {
    id: number;
    name: string;
    client: { id: number; name: string };
  };
}

interface ServerDetail {
  id: number;
  name: string;
  ip_address: string;
  ssh_port: number;
  ssh_user: string;
  provider: string | null;
  status: "online" | "offline" | "unknown";
  cyberpanel_version: string | null;
  created_at: string;
  environments: Environment[];
  _count: { environments: number };
}

interface SshHealth {
  active: number;
  idle: number;
  total: number;
  maxConnections: number;
  status: "healthy" | "busy" | "empty";
}

interface TopProcess {
  pid: string;
  user: string;
  cpu: string;
  mem: string;
  command: string;
}

interface ServerAlert {
  type: "cpu" | "memory" | "disk" | "offline";
  level: "warning" | "critical";
  message: string;
}

interface SystemStats {
  cpu_usage: number | null;
  memory_used_mb: number | null;
  memory_total_mb: number | null;
  disk_used_gb: number | null;
  disk_total_gb: number | null;
  uptime_seconds: number | null;
  load_average: [number, number, number] | null;
  ping_ms: number | null;
  top_processes?: TopProcess[];
  alerts?: ServerAlert[];
}

interface MetricPoint {
  timestamp: string;
  cpu_usage: number | null;
  memory_pct: number | null;
  disk_pct: number | null;
  load_1m: number | null;
  ping_ms: number | null;
}

const STATUS_VARIANT: Record<string, "success" | "destructive" | "secondary"> =
  {
    online: "success",
    offline: "destructive",
    unknown: "secondary",
  };

function fmtUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function parseCyberPanelVersion(version: string | null | undefined): string | null {
  if (!version) return null;
  let trimmed = version.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "string") {
        trimmed = parsed.trim();
      }
    } catch {
      // fallback
    }
  }
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && parsed.version) {
        return parsed.version;
      }
    } catch {
      // fallback
    }
  }
  return trimmed;
}

function StatCard({
  label,
  value,
  unit,
  icon: Icon,
  percent,
  subtext,
}: {
  label: string;
  value: string | number;
  unit?: string;
  icon: React.ElementType;
  percent?: number;
  subtext?: string;
}) {
  return (
    <div className="bg-card border rounded-lg p-4 space-y-2">
      <div className="flex items-center justify-between text-muted-foreground text-xs font-medium uppercase tracking-wide">
        <span className="flex items-center gap-1.5">
          <Icon className="h-3.5 w-3.5" />
          {label}
        </span>
        {percent !== undefined && (
          <Badge
            variant={
              percent > 90
                ? "destructive"
                : percent > 75
                  ? "warning"
                  : "secondary"
            }
            className="text-[10px] h-4 px-1.5"
          >
            {percent}%
          </Badge>
        )}
      </div>
      <div className="flex items-end gap-1">
        <span className="text-2xl font-bold tabular-nums">{value}</span>
        {unit && (
          <span className="text-xs text-muted-foreground mb-0.5">{unit}</span>
        )}
      </div>
      {percent !== undefined && (
        <div className="w-full bg-muted rounded-full h-1.5 overflow-hidden">
          <div
            className={`h-1.5 rounded-full transition-all duration-500 ${
              percent > 90
                ? "bg-destructive"
                : percent > 75
                  ? "bg-amber-500"
                  : "bg-primary"
            }`}
            style={{ width: `${Math.min(percent, 100)}%` }}
          />
        </div>
      )}
      {subtext && (
        <p className="text-[11px] text-muted-foreground truncate">{subtext}</p>
      )}
    </div>
  );
}

function OverviewTab({ server }: { server: ServerDetail }) {
  const qc = useQueryClient();
  const [metricRange, setMetricRange] = useState<"1h" | "24h" | "7d">("24h");
  const [showProcsModal, setShowProcsModal] = useState(false);

  const { data: sshHealth } = useQuery<SshHealth>({
    queryKey: ["ssh-health", server.id],
    queryFn: () => api.get(`/servers/${server.id}/ssh-health`),
    staleTime: 30_000,
    retry: false,
  });

  const {
    data: stats,
    isLoading: statsLoading,
    refetch: refetchStats,
    isRefetching: statsRefetching,
  } = useQuery<SystemStats>({
    queryKey: ["server-stats", server.id],
    queryFn: () => api.get(`/servers/${server.id}/stats`),
    staleTime: 30_000,
    retry: false,
  });

  const { data: metricsHistory } = useQuery<MetricPoint[]>({
    queryKey: ["server-metrics", server.id, metricRange],
    queryFn: () => api.get(`/servers/${server.id}/metrics?range=${metricRange}`),
    staleTime: 60_000,
  });

  const testPingMutation = useMutation({
    mutationFn: () =>
      api.post<{ latencyMs: number; success: boolean; message: string }>(
        `/servers/${server.id}/test-ping`,
        {},
      ),
    onSuccess: (res) => {
      if (res.success) {
        toast({
          title: `Ping Response: ${res.latencyMs}ms`,
          description: `Server ${server.name} responded promptly.`,
        });
      } else {
        toast({
          title: "Ping Failed",
          description: res.message,
          variant: "destructive",
        });
      }
      qc.invalidateQueries({ queryKey: ["server-stats", server.id] });
    },
    onError: (err) => {
      toast({
        title: "Ping Error",
        description: err instanceof Error ? err.message : "Unreachable",
        variant: "destructive",
      });
    },
  });

  const cpuPct = stats?.cpu_usage !== null && stats?.cpu_usage !== undefined ? Math.round(stats.cpu_usage) : null;
  const memPct =
    stats?.memory_used_mb && stats?.memory_total_mb
      ? Math.round((stats.memory_used_mb / stats.memory_total_mb) * 100)
      : null;
  const diskPct =
    stats?.disk_used_gb && stats?.disk_total_gb
      ? Math.round((stats.disk_used_gb / stats.disk_total_gb) * 100)
      : null;

  return (
    <div className="space-y-6">
      {/* Alert Banners for Runaway Resources / Server Issues */}
      {stats?.alerts && stats.alerts.length > 0 && (
        <div className="space-y-2">
          {stats.alerts.map((alert, i) => (
            <div
              key={i}
              className={`flex items-center gap-3 p-3 rounded-lg border text-sm font-medium ${
                alert.level === "critical"
                  ? "bg-destructive/10 border-destructive/30 text-destructive dark:text-red-400"
                  : "bg-amber-500/10 border-amber-500/30 text-amber-700 dark:text-amber-400"
              }`}
            >
              <Activity className="h-4 w-4 shrink-0 animate-pulse" />
              <span className="flex-1">{alert.message}</span>
              {stats.top_processes && stats.top_processes.length > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => setShowProcsModal(true)}
                >
                  View Processes
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Connection & Diagnostics Action Bar */}
      <div className="bg-card border rounded-lg divide-y">
        <div className="px-4 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <p className="text-xs text-muted-foreground uppercase tracking-wide font-semibold mb-1">
              Connection & Credentials
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
              <div>
                <p className="text-muted-foreground text-xs">IP Address</p>
                <p className="font-mono font-medium mt-0.5">
                  {server.ip_address}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground text-xs">SSH Port</p>
                <p className="font-mono font-medium mt-0.5">{server.ssh_port}</p>
              </div>
              <div>
                <p className="text-muted-foreground text-xs">SSH User</p>
                <p className="font-mono font-medium mt-0.5">{server.ssh_user}</p>
              </div>
              <div>
                <p className="text-muted-foreground text-xs">Provider</p>
                <p className="font-medium mt-0.5">{server.provider ?? "—"}</p>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0 self-start sm:self-center">
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              onClick={() => testPingMutation.mutate()}
              disabled={testPingMutation.isPending}
            >
              {testPingMutation.isPending ? (
                <RefreshCw className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <Activity className="h-3.5 w-3.5 mr-1.5 text-primary" />
              )}
              {stats?.ping_ms ? `Ping: ${stats.ping_ms}ms` : "Test Ping"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              onClick={() => refetchStats()}
              disabled={statsRefetching}
            >
              <RefreshCw
                className={`h-3.5 w-3.5 mr-1.5 ${statsRefetching ? "animate-spin" : ""}`}
              />
              Refresh
            </Button>
          </div>
        </div>

        {sshHealth && (
          <div className="px-4 py-3 flex items-center justify-between flex-wrap gap-2 text-sm">
            <div className="flex items-center gap-4 flex-wrap">
              <span className="text-xs text-muted-foreground uppercase tracking-wide font-semibold">
                SSH Pool:
              </span>
              <div>
                <span className="text-muted-foreground text-xs">Active </span>
                <span className="font-mono font-medium">
                  {sshHealth.active}
                </span>
              </div>
              <div>
                <span className="text-muted-foreground text-xs">Idle </span>
                <span className="font-mono font-medium">{sshHealth.idle}</span>
              </div>
              <div>
                <span className="text-muted-foreground text-xs">Max </span>
                <span className="font-mono font-medium">
                  {sshHealth.maxConnections}
                </span>
              </div>
            </div>
            <Badge
              variant={
                sshHealth.status === "healthy"
                  ? "success"
                  : sshHealth.status === "busy"
                    ? "warning"
                    : "secondary"
              }
              className="text-xs"
            >
              {sshHealth.status}
            </Badge>
          </div>
        )}

        {server.cyberpanel_version && (
          <div className="px-4 py-3 flex items-center gap-2">
            <span className="text-xs text-muted-foreground uppercase tracking-wide font-semibold">
              Control Panel:
            </span>
            <Badge variant="info">
              CyberPanel {parseCyberPanelVersion(server.cyberpanel_version)}
            </Badge>
          </div>
        )}
      </div>

      {/* Live System Stats Grid */}
      {statsLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-28 rounded-lg" />
          ))}
        </div>
      ) : stats ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            label="CPU Usage"
            value={cpuPct !== null ? `${cpuPct}%` : "—"}
            icon={Cpu}
            percent={cpuPct ?? undefined}
            subtext={
              stats.load_average
                ? `Load avg: ${stats.load_average.map((v) => v.toFixed(2)).join(", ")}`
                : undefined
            }
          />
          <StatCard
            label="Memory"
            value={
              stats.memory_used_mb && stats.memory_total_mb
                ? `${(stats.memory_used_mb / 1024).toFixed(1)} GB`
                : "—"
            }
            unit={
              stats.memory_total_mb
                ? `/ ${(stats.memory_total_mb / 1024).toFixed(1)} GB`
                : undefined
            }
            icon={MemoryStick}
            percent={memPct ?? undefined}
            subtext={memPct !== null ? `${memPct}% allocated` : undefined}
          />
          <StatCard
            label="Root Disk"
            value={
              stats.disk_used_gb !== null && stats.disk_used_gb !== undefined
                ? `${stats.disk_used_gb.toFixed(1)} GB`
                : "—"
            }
            unit={
              stats.disk_total_gb
                ? `/ ${stats.disk_total_gb.toFixed(1)} GB`
                : undefined
            }
            icon={HardDrive}
            percent={diskPct ?? undefined}
            subtext={diskPct !== null ? `${diskPct}% capacity used` : undefined}
          />
          <StatCard
            label="Server Uptime"
            value={
              stats.uptime_seconds !== null
                ? fmtUptime(stats.uptime_seconds)
                : "—"
            }
            icon={Activity}
            subtext={
              stats.ping_ms !== null
                ? `Ping response: ${stats.ping_ms}ms`
                : "Operational"
            }
          />
        </div>
      ) : null}

      {/* Historical Resource Graphs & Top Processes */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Resource Graphs Card */}
        <div className="lg:col-span-2 bg-card border rounded-lg p-4 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-foreground">
                Resource Usage History
              </h3>
              <p className="text-xs text-muted-foreground">
                CPU, Memory, and Disk trends recorded over time
              </p>
            </div>
            <div className="flex items-center gap-1 bg-muted p-0.5 rounded-md self-start sm:self-auto">
              {(["1h", "24h", "7d"] as const).map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setMetricRange(r)}
                  className={`px-2.5 py-1 text-xs font-medium rounded transition-colors ${
                    metricRange === r
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>

          <div className="h-64 w-full">
            {metricsHistory && metricsHistory.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={metricsHistory}>
                  <defs>
                    <linearGradient id="cpuGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.4} />
                      <stop offset="95%" stopColor="#3b82f6" stopOpacity={0.0} />
                    </linearGradient>
                    <linearGradient id="memGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#10b981" stopOpacity={0.4} />
                      <stop offset="95%" stopColor="#10b981" stopOpacity={0.0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
                  <XAxis
                    dataKey="timestamp"
                    tickFormatter={(val) => {
                      try {
                        const d = new Date(val);
                        return metricRange === "7d"
                          ? d.toLocaleDateString([], { month: "short", day: "numeric" })
                          : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
                      } catch {
                        return "";
                      }
                    }}
                    tick={{ fontSize: 11 }}
                  />
                  <YAxis unit="%" domain={[0, 100]} tick={{ fontSize: 11 }} />
                  <RechartsTooltip
                    contentStyle={{
                      backgroundColor: "hsl(var(--card))",
                      borderColor: "hsl(var(--border))",
                      borderRadius: "8px",
                      fontSize: "12px",
                    }}
                  />
                  <Area
                    type="monotone"
                    dataKey="cpu_usage"
                    name="CPU %"
                    stroke="#3b82f6"
                    strokeWidth={2}
                    fill="url(#cpuGrad)"
                  />
                  <Area
                    type="monotone"
                    dataKey="memory_pct"
                    name="Memory %"
                    stroke="#10b981"
                    strokeWidth={2}
                    fill="url(#memGrad)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-full flex flex-col items-center justify-center text-center text-muted-foreground text-xs p-6 border border-dashed rounded-lg">
                <Activity className="h-8 w-8 mb-2 opacity-40 text-primary" />
                <p className="font-medium">Metrics recording in progress</p>
                <p className="text-[11px] max-w-sm mt-1">
                  Resource snapshots are recorded during health probes and scans. Click &ldquo;Refresh&rdquo; or run a diagnostic to log data points.
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Top Processes Card */}
        <div className="bg-card border rounded-lg p-4 space-y-3 flex flex-col">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-foreground">
              Top Running Processes
            </h3>
            {stats?.top_processes && stats.top_processes.length > 0 && (
              <Badge variant="outline" className="text-[10px]">
                {stats.top_processes.length} Active
              </Badge>
            )}
          </div>

          {stats?.top_processes && stats.top_processes.length > 0 ? (
            <div className="space-y-2 flex-1 overflow-y-auto max-h-64 text-xs font-mono">
              {stats.top_processes.map((p, idx) => (
                <div
                  key={idx}
                  className="flex items-center justify-between p-2 rounded bg-muted/40 hover:bg-muted/70 transition-colors"
                >
                  <div className="min-w-0 flex-1 pr-2">
                    <p className="font-semibold text-foreground truncate">
                      {p.command}
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                      PID {p.pid} · {p.user}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <span className="font-semibold text-primary">{p.cpu}</span>
                    <span className="text-[10px] text-muted-foreground ml-1.5">
                      {p.mem}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-center text-muted-foreground text-xs p-4 border border-dashed rounded-lg">
              <Cpu className="h-6 w-6 mb-2 opacity-40" />
              <p>No runaway processes detected</p>
            </div>
          )}
        </div>
      </div>

      {/* Full Running Processes Dialog */}
      <Dialog open={showProcsModal} onOpenChange={setShowProcsModal}>
        <DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Cpu className="h-5 w-5 text-primary" />
              Active Server Processes ({server.name})
            </DialogTitle>
            <DialogDescription>
              Processes sorted by CPU utilization. Inspect for high memory or runaway CPU spikes.
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto space-y-2 py-2">
            {stats?.top_processes && stats.top_processes.length > 0 ? (
              <div className="border rounded-md divide-y font-mono text-xs">
                <div className="grid grid-cols-12 gap-2 px-3 py-2 bg-muted/60 font-semibold text-muted-foreground text-[11px]">
                  <span className="col-span-2">PID</span>
                  <span className="col-span-2">USER</span>
                  <span className="col-span-2 text-right">CPU</span>
                  <span className="col-span-2 text-right">MEM</span>
                  <span className="col-span-4">COMMAND</span>
                </div>
                {stats.top_processes.map((p, idx) => (
                  <div
                    key={idx}
                    className="grid grid-cols-12 gap-2 px-3 py-2 hover:bg-muted/30 items-center"
                  >
                    <span className="col-span-2 text-muted-foreground">{p.pid}</span>
                    <span className="col-span-2 truncate">{p.user}</span>
                    <span className="col-span-2 text-right font-semibold text-primary">{p.cpu}</span>
                    <span className="col-span-2 text-right text-muted-foreground">{p.mem}</span>
                    <span className="col-span-4 truncate font-medium text-foreground" title={p.command}>
                      {p.command}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground text-center py-6">No processes reported.</p>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setShowProcsModal(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EnvironmentsTab({ environments }: { environments: Environment[] }) {
  const envsByProject = environments.reduce<
    Record<number, { project: Environment["project"]; envs: Environment[] }>
  >((acc, env) => {
    const pid = env.project.id;
    if (!acc[pid]) acc[pid] = { project: env.project, envs: [] };
    acc[pid].envs.push(env);
    return acc;
  }, {});

  if (environments.length === 0) {
    return (
      <div className="border rounded-lg p-8 text-center text-muted-foreground">
        <FolderKanban className="h-8 w-8 mx-auto mb-3 opacity-50" />
        <p className="font-medium">No environments</p>
        <p className="text-sm mt-1">
          No environments are deployed on this server yet.
        </p>
      </div>
    );
  }

  const ENV_TYPE_VARIANT: Record<string, "default" | "secondary" | "outline"> =
    {
      production: "default",
      staging: "secondary",
      development: "outline",
    };

  return (
    <div className="space-y-4">
      {Object.values(envsByProject).map(({ project, envs }) => (
        <div key={project.id} className="border rounded-lg overflow-hidden">
          <div className="bg-muted/40 px-4 py-2.5 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <FolderKanban className="h-4 w-4 text-muted-foreground" />
              <Link
                to={`/projects/${project.id}`}
                className="font-medium text-sm hover:text-primary transition-colors"
              >
                {project.name}
              </Link>
              <span className="text-muted-foreground text-xs">
                · {project.client.name}
              </span>
            </div>
            <Badge variant="outline" className="text-xs">
              {envs.length} env{envs.length !== 1 ? "s" : ""}
            </Badge>
          </div>
          <div className="divide-y">
            {envs.map((env) => (
              <div
                key={env.id}
                className="px-4 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-4"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <Badge
                    variant={ENV_TYPE_VARIANT[env.type] ?? "secondary"}
                    className="shrink-0 capitalize"
                  >
                    {env.type}
                  </Badge>
                  {env.url && (
                    <a
                      href={env.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-muted-foreground hover:text-primary transition-colors flex items-center gap-1 min-w-0 truncate"
                    >
                      <Globe className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{env.url}</span>
                      <ExternalLink className="h-3 w-3 shrink-0" />
                    </a>
                  )}
                </div>
                <code className="text-xs text-muted-foreground font-mono truncate max-w-none sm:max-w-xs">
                  {env.root_path}
                </code>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function ServerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const isAdmin = useAuthStore(
    (s) => s.user?.roles?.includes("admin") ?? false,
  );
  const [editOpen, setEditOpen] = useState(false);
  const [credsDialogOpen, setCredsDialogOpen] = useState(false);
  const [creds, setCreds] = useState<{
    url?: string;
    username: string;
    password?: string;
  } | null>(null);
  const [showPassword, setShowPassword] = useState(false);

  const {
    data: server,
    isLoading,
    isError,
  } = useQuery<ServerDetail>({
    queryKey: ["server", id],
    queryFn: () => api.get(`/servers/${id}?include=environments`),
    enabled: !!id,
  });

  const testConnection = useMutation({
    mutationFn: () =>
      api.post<{
        success: boolean;
        message: string;
        cyberpanelVersion?: string;
      }>(`/servers/${id}/test-connection`, {}),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["server", id] });
      qc.invalidateQueries({ queryKey: ["servers"] });
      const versionLine = result.cyberpanelVersion
        ? ` · CyberPanel ${result.cyberpanelVersion}`
        : "";
      toast({ title: `Server is reachable${versionLine}` });
    },
    onError: () =>
      toast({ title: "Connection test failed", variant: "destructive" }),
  });

  async function handleOpenPanel() {
    try {
      const credsData = await api.get<{
        url?: string;
        username: string;
        password?: string;
      }>(`/servers/${id}/cyberpanel/credentials`);
      setCreds(credsData);
      setShowPassword(false);
      setCredsDialogOpen(true);
      if (credsData?.password) {
        try {
          await navigator.clipboard.writeText(credsData.password);
        } catch {
          /* clipboard not available */
        }
      }
    } catch {
      toast({
        title: "No panel credentials configured",
        description: "Add them via Edit server → Panel Credentials",
        variant: "destructive",
      });
    }
  }

  if (isLoading) {
    return (
      <div className="space-y-6 max-w-5xl">
        <Skeleton className="h-8 w-32" />
        <div className="flex items-start justify-between">
          <Skeleton className="h-10 w-64" />
          <Skeleton className="h-9 w-32" />
        </div>
        <Skeleton className="h-10 w-full rounded-lg" />
        <Skeleton className="h-48 w-full rounded-lg" />
      </div>
    );
  }

  if (isError || !server) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <ServerIcon className="h-12 w-12 text-muted-foreground mb-4" />
        <h2 className="text-lg font-semibold mb-1">Server not found</h2>
        <p className="text-muted-foreground text-sm mb-4">
          This server may have been deleted or you don't have access.
        </p>
        <Button variant="outline" onClick={() => navigate("/servers")}>
          <ArrowLeft className="h-4 w-4 mr-1.5" />
          Back to Servers
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-5xl">
      {/* Back */}
      <Button
        variant="ghost"
        size="sm"
        className="-ml-1"
        onClick={() => navigate("/servers")}
      >
        <ArrowLeft className="h-4 w-4 mr-1.5" />
        All Servers
      </Button>

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-3xl font-bold tracking-tight">{server.name}</h1>
            <Badge
              variant={STATUS_VARIANT[server.status] ?? "secondary"}
              className="text-sm"
            >
              {server.status}
            </Badge>
          </div>
          <div className="flex items-center gap-2 text-muted-foreground text-sm mt-1.5">
            <Terminal className="h-3.5 w-3.5" />
            <span className="font-mono">
              {server.ssh_user}@{server.ip_address}:{server.ssh_port}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <Button
            variant="outline"
            size="sm"
            onClick={() => testConnection.mutate()}
            disabled={testConnection.isPending}
          >
            {testConnection.isPending ? (
              <RefreshCw className="h-4 w-4 mr-1.5 animate-spin" />
            ) : (
              <Plug className="h-4 w-4 mr-1.5" />
            )}
            Test Connection
          </Button>
          {server.cyberpanel_version && (
            <Button variant="outline" size="sm" onClick={handleOpenPanel}>
              <ExternalLink className="h-4 w-4 mr-1.5" />
              Open Panel
            </Button>
          )}
          {isAdmin && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEditOpen(true)}
            >
              <Pencil className="h-4 w-4 mr-1.5" />
              Edit
            </Button>
          )}
        </div>
      </div>

      {/* Stats strip */}
      <div className="flex flex-wrap gap-3">
        <div className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2">
          <FolderKanban className="h-4 w-4 text-muted-foreground" />
          <div>
            <p className="text-xs text-muted-foreground">Environments</p>
            <p className="text-sm font-medium">
              {server.environments?.length ?? 0}
            </p>
          </div>
        </div>
        {server.provider && (
          <div className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2">
            <ServerIcon className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Provider</p>
              <p className="text-sm font-medium">{server.provider}</p>
            </div>
          </div>
        )}
        {server.cyberpanel_version && (
          <div className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2">
            <Globe className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">CyberPanel</p>
              <p className="text-sm font-medium">{parseCyberPanelVersion(server.cyberpanel_version)}</p>
            </div>
          </div>
        )}
      </div>

      {/* Tabs */}
      <Tabs defaultValue="overview">
        <TabsList className="w-full sm:w-auto overflow-x-auto no-scrollbar flex-nowrap justify-start h-auto gap-1 p-1 border">
          <TabsTrigger value="overview">Overview & Metrics</TabsTrigger>
          <TabsTrigger value="environments">
            Environments
            {server.environments?.length > 0 && (
              <span className="ml-1.5 text-xs opacity-70">
                ({server.environments.length})
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="activity">
            <History className="h-3.5 w-3.5 mr-1.5" />
            Activity
          </TabsTrigger>
        </TabsList>

        <div className="mt-4">
          <TabsContent value="overview">
            <OverviewTab server={server} />
          </TabsContent>
          <TabsContent value="environments">
            <EnvironmentsTab environments={server.environments ?? []} />
          </TabsContent>
          <TabsContent value="activity">
            <div className="border rounded-lg p-4">
              <h3 className="text-sm font-semibold mb-3 text-muted-foreground uppercase tracking-wide">Server Activity Log</h3>
              <ResourceActivityFeed resourceType="server" resourceId={server.id} />
            </div>
          </TabsContent>
        </div>
      </Tabs>

      {/* Edit dialog — re-use the form from ServersPage */}
      {isAdmin && editOpen && (
        <ServerFormDialog
          open={editOpen}
          onOpenChange={setEditOpen}
          initial={server}
          onSuccess={() => {
            qc.invalidateQueries({ queryKey: ["server", id] });
            qc.invalidateQueries({ queryKey: ["servers"] });
          }}
        />
      )}

      {/* Credentials Dialog */}
      {creds && (
        <Dialog open={credsDialogOpen} onOpenChange={setCredsDialogOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Lock className="h-5 w-5 text-primary" />
                Control Panel Credentials
              </DialogTitle>
              <DialogDescription>
                Credentials for accessing the control panel on {server.name}.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-3">
              {creds.url && (
                <div className="space-y-1.5">
                  <Label htmlFor="panel-creds-url" className="text-xs font-semibold text-muted-foreground">Panel URL</Label>
                  <div className="flex gap-2">
                    <Input
                      id="panel-creds-url"
                      value={creds.url}
                      readOnly
                      className="font-mono text-xs bg-muted/40 select-all"
                    />
                    <Button
                      variant="outline"
                      size="icon"
                      className="shrink-0"
                      onClick={() => {
                        navigator.clipboard.writeText(creds.url || "");
                        toast({ title: "URL copied to clipboard" });
                      }}
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="panel-creds-user" className="text-xs font-semibold text-muted-foreground">Username</Label>
                <div className="flex gap-2">
                  <Input
                    id="panel-creds-user"
                    value={creds.username}
                    readOnly
                    className="font-mono text-xs bg-muted/40 select-all"
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    className="shrink-0"
                    onClick={() => {
                      navigator.clipboard.writeText(creds.username);
                      toast({ title: "Username copied to clipboard" });
                    }}
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              {creds.password && (
                <div className="space-y-1.5">
                  <Label htmlFor="panel-creds-pass" className="text-xs font-semibold text-muted-foreground">Password</Label>
                  <div className="flex gap-2">
                    <Input
                      id="panel-creds-pass"
                      type={showPassword ? "text" : "password"}
                      value={creds.password}
                      readOnly
                      className="font-mono text-xs bg-muted/40 select-all"
                    />
                    <Button
                      variant="outline"
                      size="icon"
                      className="shrink-0"
                      onClick={() => setShowPassword((prev) => !prev)}
                    >
                      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </Button>
                    <Button
                      variant="outline"
                      size="icon"
                      className="shrink-0"
                      onClick={() => {
                        navigator.clipboard.writeText(creds.password || "");
                        toast({ title: "Password copied to clipboard" });
                      }}
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )}
            </div>
            <DialogFooter className="flex sm:justify-between items-center gap-2">
              <div className="text-xs text-muted-foreground italic sm:text-left flex-1">
                Copy credentials before proceeding.
              </div>
              <div className="flex gap-2 shrink-0">
                <Button variant="ghost" size="sm" onClick={() => setCredsDialogOpen(false)}>
                  Dismiss
                </Button>
                {creds.url && (
                  <Button
                    size="sm"
                    className="gap-1.5 bg-gradient-to-r from-primary to-primary/95 hover:from-primary/95 hover:to-primary/90 text-primary-foreground border-0 transition-all duration-200"
                    onClick={() => {
                      window.open(creds.url, "_blank", "noopener,noreferrer");
                      setCredsDialogOpen(false);
                    }}
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    Go to Panel
                  </Button>
                )}
              </div>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
