import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  ExternalLink,
  FolderKanban,
  Globe,
  Loader2,
  MonitorSmartphone,
  RefreshCw,
  Zap,
} from "lucide-react";
import { api } from "@/lib/api-client";
import { toast } from "@/hooks/use-toast";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { PageHeader, Pagination } from "@/components/crud";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";

interface Environment {
  id: number;
  type: string;
  url: string;
  project?: { id: number; name: string };
}

interface LighthouseAudit {
  id: number;
  environment_id: number;
  job_execution_id: number | null;
  url: string;
  strategy: "mobile" | "desktop";
  status: "queued" | "running" | "completed" | "failed";
  performance_score: number | null;
  accessibility_score: number | null;
  best_practices_score: number | null;
  seo_score: number | null;
  fcp_ms: number | null;
  lcp_ms: number | null;
  cls: number | null;
  tbt_ms: number | null;
  speed_index_ms: number | null;
  opportunities: Array<{
    id: string;
    title: string;
    displayValue?: string;
    score?: number | null;
  }> | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
  environment?: Environment | null;
}

const scoreTone = (score: number | null) => {
  if (score === null) return "text-muted-foreground";
  if (score >= 90) return "text-success";
  if (score >= 50) return "text-warning";
  return "text-destructive";
};

const metric = (value: number | null, suffix: string) =>
  value === null ? "n/a" : `${value.toLocaleString()}${suffix}`;

export function LighthousePage() {
  const queryClient = useQueryClient();
  const [projectId, setProjectId] = useState<string>("all");
  const [environmentId, setEnvironmentId] = useState<string>("");
  const [strategy, setStrategy] = useState<"mobile" | "desktop">("mobile");
  const [urlOverride, setUrlOverride] = useState("");
  const [page, setPage] = useState(1);

  const { data: environments = [] } = useQuery<Environment[]>({
    queryKey: ["environments"],
    queryFn: () => api.get("/environments"),
  });

  const projects = useMemo(() => {
    const map = new Map<number, { id: number; name: string; envCount: number }>();
    for (const env of environments) {
      if (env.project) {
        const existing = map.get(env.project.id);
        if (existing) {
          existing.envCount++;
        } else {
          map.set(env.project.id, {
            id: env.project.id,
            name: env.project.name,
            envCount: 1,
          });
        }
      }
    }
    return Array.from(map.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }, [environments]);

  const filteredEnvs = useMemo(() => {
    if (projectId === "all") return environments;
    return environments.filter((env) => String(env.project?.id) === projectId);
  }, [environments, projectId]);

  const selectedEnv = useMemo(
    () => environments.find((env) => String(env.id) === environmentId),
    [environmentId, environments],
  );

  const { data: latest = [], isFetching } = useQuery<LighthouseAudit[]>({
    queryKey: ["lighthouse", "latest"],
    queryFn: () => api.get("/lighthouse"),
    refetchInterval: 30_000,
  });

  const { data: historyData } = useQuery<{
    items: LighthouseAudit[];
    total: number;
  }>({
    queryKey: ["lighthouse", "history", environmentId, page],
    queryFn: () =>
      api.get(
        `/lighthouse/history?page=${page}&limit=10${environmentId ? `&environment_id=${environmentId}` : ""}`,
      ),
    refetchInterval: 30_000,
  });

  const history = historyData?.items ?? [];
  const totalPages = historyData ? Math.ceil(historyData.total / 10) : 1;

  const trigger = useMutation({
    mutationFn: () =>
      api.post("/lighthouse/audits", {
        environment_id: Number(environmentId),
        strategy,
        ...(urlOverride.trim() ? { url: urlOverride.trim() } : {}),
      }),
    onSuccess: () => {
      toast({ title: "Lighthouse audit queued" });
      queryClient.invalidateQueries({ queryKey: ["lighthouse"] });
    },
    onError: (err: Error) => {
      toast({
        title: "Failed to queue Lighthouse audit",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const topAudits = latest.slice(0, 4);
  const trendData = [...history]
    .filter((audit) => audit.status === "completed")
    .reverse()
    .map((audit) => ({
      date: new Date(audit.created_at).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      }),
      performance: audit.performance_score,
      accessibility: audit.accessibility_score,
      seo: audit.seo_score,
      lcp: audit.lcp_ms,
      cls: audit.cls === null ? null : Number(audit.cls),
      tbt: audit.tbt_ms,
    }));

  return (
    <div className="space-y-5">
      <PageHeader title="Lighthouse">
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            queryClient.invalidateQueries({ queryKey: ["lighthouse"] })
          }
          disabled={isFetching}
        >
          <RefreshCw
            className={`h-3.5 w-3.5 mr-1.5 ${isFetching ? "animate-spin" : ""}`}
          />
          Refresh
        </Button>
      </PageHeader>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[200px_220px_160px_1fr_auto] items-end border rounded-lg p-4 bg-card shadow-sm">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground flex items-center gap-1">
            <FolderKanban className="h-3.5 w-3.5 text-muted-foreground" />
            Project
          </label>
          <Select
            value={projectId}
            onValueChange={(val) => {
              setProjectId(val);
              setPage(1);
              if (val === "all") {
                setEnvironmentId("");
              } else {
                const pEnvs = environments.filter(
                  (e) => String(e.project?.id) === val,
                );
                if (pEnvs.length > 0) {
                  setEnvironmentId(String(pEnvs[0].id));
                } else {
                  setEnvironmentId("");
                }
              }
            }}
          >
            <SelectTrigger>
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

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground flex items-center gap-1">
            <Globe className="h-3.5 w-3.5 text-muted-foreground" />
            Environment
          </label>
          <Select
            value={environmentId}
            onValueChange={(val) => {
              setEnvironmentId(val);
              setPage(1);
              if (val) {
                const found = environments.find((e) => String(e.id) === val);
                if (
                  found?.project &&
                  projectId !== "all" &&
                  String(found.project.id) !== projectId
                ) {
                  setProjectId(String(found.project.id));
                }
              }
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select environment" />
            </SelectTrigger>
            <SelectContent>
              {filteredEnvs.map((env) => (
                <SelectItem key={env.id} value={String(env.id)}>
                  <span className="font-medium">{env.project?.name}</span> ·{" "}
                  <span className="capitalize">{env.type}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">
            Strategy
          </label>
          <Select
            value={strategy}
            onValueChange={(v) => setStrategy(v as "mobile" | "desktop")}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="mobile">Mobile</SelectItem>
              <SelectItem value="desktop">Desktop</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">
            URL override
          </label>
          <Input
            value={urlOverride}
            onChange={(e) => setUrlOverride(e.target.value)}
            placeholder={selectedEnv?.url ?? "https://example.com"}
          />
        </div>

        <Button
          onClick={() => trigger.mutate()}
          disabled={!environmentId || trigger.isPending}
        >
          {trigger.isPending ? (
            <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
          ) : (
            <Zap className="h-4 w-4 mr-1.5" />
          )}
          Run audit
        </Button>
      </section>

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {topAudits.map((audit) => (
          <div
            key={`${audit.environment_id}-${audit.strategy}`}
            className="border rounded-lg p-4"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">
                  {audit.environment?.project?.name ?? audit.url}
                </p>
                <p className="text-xs text-muted-foreground truncate">
                  {audit.strategy} · {audit.environment?.type ?? audit.url}
                </p>
              </div>
              <Badge
                variant={
                  audit.status === "failed" ? "destructive" : "secondary"
                }
              >
                {audit.status}
              </Badge>
            </div>
            <div className="mt-5 flex items-end gap-3">
              <p
                className={`text-4xl font-semibold ${scoreTone(audit.performance_score)}`}
              >
                {audit.performance_score ?? "--"}
              </p>
              <p className="pb-1 text-xs text-muted-foreground">performance</p>
            </div>
            <div className="mt-4 grid grid-cols-3 gap-2 text-xs">
              <div>
                <p className="text-muted-foreground">LCP</p>
                <p className="font-medium">{metric(audit.lcp_ms, "ms")}</p>
              </div>
              <div>
                <p className="text-muted-foreground">CLS</p>
                <p className="font-medium">{audit.cls ?? "n/a"}</p>
              </div>
              <div>
                <p className="text-muted-foreground">TBT</p>
                <p className="font-medium">{metric(audit.tbt_ms, "ms")}</p>
              </div>
            </div>
          </div>
        ))}
        {topAudits.length === 0 && (
          <div className="md:col-span-2 xl:col-span-4 border rounded-lg p-8 text-center text-muted-foreground">
            <MonitorSmartphone className="h-10 w-10 mx-auto mb-3 opacity-50" />
            No Lighthouse audits yet.
          </div>
        )}
      </section>

      <section className="grid gap-3 xl:grid-cols-2">
        <div className="border rounded-lg p-4">
          <div className="mb-4">
            <h2 className="text-sm font-semibold">Score trends</h2>
          </div>
          <div className="h-72">
            {trendData.length ? (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={trendData}>
                  <CartesianGrid
                    strokeDasharray="3 3"
                    className="stroke-muted"
                  />
                  <XAxis
                    dataKey="date"
                    tickLine={false}
                    axisLine={false}
                    fontSize={12}
                  />
                  <YAxis
                    domain={[0, 100]}
                    tickLine={false}
                    axisLine={false}
                    fontSize={12}
                  />
                  <Tooltip />
                  <Line
                    type="monotone"
                    dataKey="performance"
                    stroke="hsl(var(--primary))"
                    strokeWidth={2}
                    dot={false}
                    connectNulls
                  />
                  <Line
                    type="monotone"
                    dataKey="accessibility"
                    stroke="hsl(var(--success))"
                    strokeWidth={2}
                    dot={false}
                    connectNulls
                  />
                  <Line
                    type="monotone"
                    dataKey="seo"
                    stroke="hsl(var(--warning))"
                    strokeWidth={2}
                    dot={false}
                    connectNulls
                  />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                No completed audits to chart.
              </div>
            )}
          </div>
        </div>

        <div className="border rounded-lg p-4">
          <div className="mb-4">
            <h2 className="text-sm font-semibold">Core web vitals</h2>
          </div>
          <div className="h-72">
            {trendData.length ? (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={trendData}>
                  <CartesianGrid
                    strokeDasharray="3 3"
                    className="stroke-muted"
                  />
                  <XAxis
                    dataKey="date"
                    tickLine={false}
                    axisLine={false}
                    fontSize={12}
                  />
                  <YAxis tickLine={false} axisLine={false} fontSize={12} />
                  <Tooltip />
                  <Line
                    type="monotone"
                    dataKey="lcp"
                    stroke="hsl(var(--primary))"
                    strokeWidth={2}
                    dot={false}
                    connectNulls
                  />
                  <Line
                    type="monotone"
                    dataKey="tbt"
                    stroke="hsl(var(--destructive))"
                    strokeWidth={2}
                    dot={false}
                    connectNulls
                  />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                No completed audits to chart.
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="border rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Audit history</h2>
        </div>
        <div className="divide-y">
          {history.map((audit) => (
            <div
              key={audit.id}
              className="p-4 grid gap-3 lg:grid-cols-[1fr_360px]"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="font-medium truncate">{audit.url}</p>
                  <Badge variant="outline">{audit.strategy}</Badge>
                  <Badge
                    variant={
                      audit.status === "failed" ? "destructive" : "secondary"
                    }
                  >
                    {audit.status}
                  </Badge>
                  <a
                    href={audit.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  {new Date(audit.created_at).toLocaleString()}
                  {audit.error_message ? ` · ${audit.error_message}` : ""}
                </p>
                {audit.opportunities && audit.opportunities.length > 0 && (
                  <p className="text-xs text-muted-foreground mt-2 truncate">
                    Top opportunity: {audit.opportunities[0].title}
                    {audit.opportunities[0].displayValue
                      ? ` · ${audit.opportunities[0].displayValue}`
                      : ""}
                  </p>
                )}
              </div>
              <div className="grid grid-cols-4 gap-2 text-center">
                <Score label="Perf" value={audit.performance_score} />
                <Score label="A11y" value={audit.accessibility_score} />
                <Score label="Best" value={audit.best_practices_score} />
                <Score label="SEO" value={audit.seo_score} />
              </div>
            </div>
          ))}
          {history.length === 0 && (
            <div className="p-8 text-center text-sm text-muted-foreground">
              No matching audit history.
            </div>
          )}
        </div>
        {totalPages > 1 && (
          <div className="border-t p-4">
            <Pagination
              page={page}
              totalPages={totalPages}
              onPageChange={setPage}
            />
          </div>
        )}
      </section>
    </div>
  );
}

function Score({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="rounded-md bg-muted/50 px-2 py-2">
      <p className={`text-lg font-semibold ${scoreTone(value)}`}>
        {value ?? "--"}
      </p>
      <p className="text-[11px] text-muted-foreground">{label}</p>
    </div>
  );
}
