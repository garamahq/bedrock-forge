import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  AlertCircle,
  Info,
  ExternalLink,
  Search,
  ShieldAlert,
} from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "@/lib/api-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Pagination } from "@/components/crud";
import { ErrorState } from "@/components/crud";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuthStore } from "@/store/auth.store";

interface AttentionItem {
  id: string;
  severity: "critical" | "warning" | "info";
  type: string;
  title: string;
  description: string;
  environmentId?: number;
  projectId?: number;
  projectName?: string;
  action: string;
  actionPayload: Record<string, unknown>;
}

interface SecurityFindingRecord {
  id: number;
  severity: string;
  status: string;
  title: string;
  description: string;
  category: string;
  resource?: string | null;
  incident_id?: number | null;
  server?: { id: number; name: string } | null;
  environment?: {
    id: number;
    type: string;
    url: string;
    project?: { id: number; name: string } | null;
  } | null;
}

interface SecurityIncidentRecord {
  id: number;
  severity: string;
  status: string;
  title: string;
  summary: string | null;
  detected_at: string;
  server?: { id: number; name: string } | null;
}

interface WorkQueueItem extends AttentionItem {
  source: "Operations" | "Security findings" | "Security incidents";
  status?: string;
  href: string;
  targetName?: string;
}

const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 } as const;

function queueSeverity(severity: string): AttentionItem["severity"] {
  if (severity === "critical") return "critical";
  if (severity === "high" || severity === "medium") return "warning";
  return "info";
}

function attentionHref(item: AttentionItem): string {
  if (
    item.actionPayload.domainName &&
    typeof item.actionPayload.domainName === "string"
  ) {
    return `/domains?search=${encodeURIComponent(item.actionPayload.domainName)}`;
  }
  if (item.projectId && item.environmentId) {
    const tab =
      item.type === "plugin_scan_stale"
        ? "plugins"
        : item.type === "no_security_schedule"
          ? "security"
          : "backups";
    return `/projects/${item.projectId}?tab=${tab}&env=${item.environmentId}`;
  }
  if (item.projectId) return `/projects/${item.projectId}`;
  return "/dashboard";
}

const SEVERITY_CONFIG = {
  critical: {
    icon: AlertCircle,
    label: "Critical",
    badgeVariant: "destructive" as const,
    rowClass: "border-l-4 border-l-destructive",
    iconClass: "text-destructive",
  },
  warning: {
    icon: AlertTriangle,
    label: "Warning",
    badgeVariant: "warning" as const,
    rowClass: "border-l-4 border-l-yellow-500",
    iconClass: "text-yellow-500",
  },
  info: {
    icon: Info,
    label: "Info",
    badgeVariant: "secondary" as const,
    rowClass: "border-l-4 border-l-muted-foreground",
    iconClass: "text-muted-foreground",
  },
};

export function ProblemsPage() {
  const [page, setPage] = useState(1);
  const [severityFilter, setSeverityFilter] = useState<string | null>(null);
  const [sourceFilter, setSourceFilter] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const PAGE_SIZE = 20;
  const roles = useAuthStore((state) => state.user?.roles ?? []);
  const canViewSecurity = roles.includes("admin") || roles.includes("manager");
  const attentionQuery = useQuery<AttentionItem[]>({
    queryKey: ["attention"],
    queryFn: () => api.get("/dashboard/attention"),
    staleTime: 30_000,
  });

  const findingsQuery = useQuery<{
    data: SecurityFindingRecord[];
    total: number;
  }>({
    queryKey: ["work-queue", "security-findings"],
    queryFn: () => api.get("/security/findings?limit=100"),
    enabled: canViewSecurity,
    staleTime: 30_000,
  });

  const incidentsQuery = useQuery<{
    items: SecurityIncidentRecord[];
    truncated: boolean;
  }>({
    queryKey: ["work-queue", "security-incidents"],
    queryFn: async () => {
      const statuses = ["open", "investigating", "contained"];
      const results = await Promise.all(
        statuses.map((status) =>
          api.get<{ data: SecurityIncidentRecord[]; total: number }>(
            `/security/incidents?status=${status}&limit=100`,
          ),
        ),
      );
      return {
        items: results.flatMap((result) => result.data),
        truncated: results.some((result) => result.total > result.data.length),
      };
    },
    enabled: canViewSecurity,
    staleTime: 30_000,
  });

  const operations: WorkQueueItem[] = (attentionQuery.data ?? []).map((item) => ({
    ...item,
    source: "Operations",
    href: attentionHref(item),
  }));
  const findingItems: WorkQueueItem[] = (findingsQuery.data?.data ?? [])
    .filter(
      (finding) =>
        !finding.incident_id &&
        (!finding.status ||
          ["new", "investigating", "acknowledged"].includes(finding.status)),
    )
    .map((finding) => {
      const project = finding.environment?.project;
      const environment = finding.environment;
      const target = project
        ? `${project.name} · ${environment?.type ?? "environment"}`
        : finding.server?.name ?? "Security finding";
      return {
        id: `security-finding-${finding.id}`,
        severity: queueSeverity(finding.severity),
        type: `security_${finding.category}`,
        title: finding.title,
        description: [finding.description, finding.resource, target]
          .filter(Boolean)
          .join(" · "),
        projectId: project?.id,
        projectName: project?.name,
        environmentId: environment?.id,
        action: "review-security-finding",
        actionPayload: { findingId: finding.id },
        source: "Security findings",
        status: finding.status,
        targetName: project ? undefined : finding.server?.name,
        href: project && environment
          ? `/projects/${project.id}?tab=security&env=${environment.id}`
          : "/security?tab=findings",
      };
    });
  const incidentItems: WorkQueueItem[] = (incidentsQuery.data?.items ?? []).map((incident) => ({
      id: `security-incident-${incident.id}`,
      severity: queueSeverity(incident.severity),
      type: "security_incident",
      title: incident.title,
      description: incident.summary ?? "Security incident needs review.",
      projectId: undefined,
      action: "review-security-incident",
      actionPayload: { incidentId: incident.id },
      source: "Security incidents",
      status: incident.status,
      targetName: incident.server?.name,
      href: "/security?tab=incidents",
    }));

  const items = [...operations, ...findingItems, ...incidentItems];
  const isLoading =
    attentionQuery.isLoading ||
    (canViewSecurity && (findingsQuery.isLoading || incidentsQuery.isLoading));
  const isError = attentionQuery.isError;
  const securityError =
    canViewSecurity && (findingsQuery.isError || incidentsQuery.isError);
  const securityQueueTruncated =
    (findingsQuery.data?.total ?? 0) > (findingsQuery.data?.data.length ?? 0) ||
    incidentsQuery.data?.truncated === true;

  const query = searchQuery.trim().toLowerCase();
  const filtered = items.filter((item) => {
    if (severityFilter && item.severity !== severityFilter) return false;
    if (sourceFilter !== "all" && item.source !== sourceFilter) return false;
    if (!query) return true;
    return [
      item.title,
      item.description,
      item.projectName,
      item.targetName,
      item.type,
      item.status,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(query);
  });

  const sorted = [...filtered].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );

  const totalPages = Math.ceil(sorted.length / PAGE_SIZE);
  const paged = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const counts = {
    critical: items.filter((i) => i.severity === "critical").length,
    warning: items.filter((i) => i.severity === "warning").length,
    info: items.filter((i) => i.severity === "info").length,
  };

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold">Work Queue</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Open operational issues and security work, with links to their source records.
        </p>
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={(event) => {
              setSearchQuery(event.target.value);
              setPage(1);
            }}
            placeholder="Search issues, sites, resources…"
            className="pl-9"
          />
        </div>
        <Select
          value={sourceFilter}
          onValueChange={(value) => {
            setSourceFilter(value);
            setPage(1);
          }}
        >
          <SelectTrigger className="sm:w-52">
            <SelectValue placeholder="All sources" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All sources</SelectItem>
            <SelectItem value="Operations">Operations</SelectItem>
            {canViewSecurity && (
              <>
                <SelectItem value="Security findings">Security findings</SelectItem>
                <SelectItem value="Security incidents">Security incidents</SelectItem>
              </>
            )}
          </SelectContent>
        </Select>
      </div>

      {securityError && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
          <p className="text-muted-foreground">
            Security findings or incidents could not be loaded. Operational issues are still available.
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void findingsQuery.refetch();
              void incidentsQuery.refetch();
            }}
          >
            Retry
          </Button>
        </div>
      )}
      {securityQueueTruncated && (
        <p className="text-xs text-muted-foreground">
          The queue shows up to 100 findings and incidents per status. Open Security to review the full lists.
        </p>
      )}

      {/* Summary badges and filters */}
      {!isLoading && !isError && items.length > 0 && (
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex gap-1 bg-muted p-1 rounded-md">
            <Button
              variant={severityFilter === null ? "secondary" : "ghost"}
              size="sm"
              className="h-7 text-xs px-2"
              onClick={() => {
                setSeverityFilter(null);
                setPage(1);
              }}
            >
              All
            </Button>
            <Button
              variant={severityFilter === "critical" ? "secondary" : "ghost"}
              size="sm"
              className="h-7 text-xs px-2"
              onClick={() => {
                setSeverityFilter("critical");
                setPage(1);
              }}
            >
              Critical
            </Button>
            <Button
              variant={severityFilter === "warning" ? "secondary" : "ghost"}
              size="sm"
              className="h-7 text-xs px-2"
              onClick={() => {
                setSeverityFilter("warning");
                setPage(1);
              }}
            >
              Warning
            </Button>
            <Button
              variant={severityFilter === "info" ? "secondary" : "ghost"}
              size="sm"
              className="h-7 text-xs px-2"
              onClick={() => {
                setSeverityFilter("info");
                setPage(1);
              }}
            >
              Info
            </Button>
          </div>

          <div className="flex gap-3 flex-wrap">
            {counts.critical > 0 && (
              <Badge variant="destructive">{counts.critical} critical</Badge>
            )}
            {counts.warning > 0 && (
              <Badge variant="warning">
                {counts.warning} warning{counts.warning !== 1 ? "s" : ""}
              </Badge>
            )}
            {counts.info > 0 && (
              <Badge variant="secondary">{counts.info} info</Badge>
            )}
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-16 rounded-lg" />
          ))}
        </div>
      ) : isError ? (
        <ErrorState
          title="Problems could not be loaded"
          description="The attention feed is unavailable. Retry to check current status."
          onRetry={() => void attentionQuery.refetch()}
        />
      ) : sorted.length === 0 ? (
        <div className="border rounded-lg p-8 text-center">
          <AlertTriangle className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
          <p className="font-medium">No queue items match</p>
          <p className="text-sm text-muted-foreground mt-1">
            Try another search or clear the selected filters.
          </p>
        </div>
      ) : (
        <>
          <div className="border rounded-lg divide-y overflow-hidden">
            {paged.map((item) => {
              const cfg = SEVERITY_CONFIG[item.severity];
              const SeverityIcon = cfg.icon;
              return (
                <div
                  key={item.id}
                  className={`flex items-start gap-4 px-4 py-3 bg-card ${cfg.rowClass}`}
                >
                  <SeverityIcon
                    className={`h-4 w-4 shrink-0 mt-0.5 ${cfg.iconClass}`}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm">{item.title}</span>
                      <Badge variant={cfg.badgeVariant} className="text-xs">
                        {item.type
                          .replace(/^(security_|backup_|monitor_)/, "")
                          .replace(/_/g, " ")}
                      </Badge>
                      <Badge variant="outline" className="text-xs">
                        {item.source}
                      </Badge>
                      {item.status && (
                        <Badge
                          variant="secondary"
                          className="text-xs capitalize"
                        >
                          {item.status.replace(/_/g, " ")}
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                      {item.description}
                    </p>
                    {item.projectName && (
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Project:{" "}
                        {item.projectId ? (
                          <Link
                            to={`/projects/${item.projectId}`}
                            className="text-primary hover:underline inline-flex items-center gap-0.5"
                          >
                            {item.projectName}
                            <ExternalLink className="h-2.5 w-2.5" />
                          </Link>
                        ) : (
                          item.projectName
                        )}
                      </p>
                    )}
                    {item.targetName && (
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Target: {item.targetName}
                      </p>
                    )}
                  </div>
                  <Button
                    asChild
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                  >
                    <Link to={item.href}>
                      <ShieldAlert className="h-3.5 w-3.5 mr-1.5" />
                      Review
                    </Link>
                  </Button>
                  <Badge
                    variant={cfg.badgeVariant}
                    className="shrink-0 text-xs capitalize"
                  >
                    {item.severity}
                  </Badge>
                </div>
              );
            })}
          </div>
          <Pagination
            page={page}
            totalPages={totalPages}
            onPageChange={setPage}
          />
        </>
      )}
    </div>
  );
}
