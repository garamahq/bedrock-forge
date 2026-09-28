import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ShieldCheck,
  Search,
  Filter,
  Eye,
  CheckCircle2,
  AlertTriangle,
  Server as ServerIcon,
  Globe,
  Wrench,
  XCircle,
  Clock,
  ChevronRight,
} from "lucide-react";
import { Switch } from "@/components/ui/switch";
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
import { api } from "@/lib/api-client";
import { toast } from "@/hooks/use-toast";
import type {
  ServerSummary,
  EnvironmentSummary,
  FindingStatus,
  Severity,
  SecurityFindingItem,
} from "../types";
import { SEVERITY_LEVELS, SCAN_TYPE_LABELS } from "../constants";
import { FindingDetailDrawer } from "./FindingDetailDrawer";
import { RemediationModal } from "./RemediationModal";
import { HardenDialog } from "../dialogs";

const SEVERITY_CLASSES: Record<Severity, string> = {
  critical: "bg-red-500/15 text-red-400 border-red-500/30",
  high: "bg-orange-500/15 text-orange-400 border-orange-500/30",
  medium: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30",
  low: "bg-blue-500/15 text-blue-400 border-blue-500/30",
  info: "bg-slate-500/15 text-slate-400 border-slate-500/30",
};

const STATUS_CLASSES: Record<FindingStatus, string> = {
  new: "bg-red-500/10 text-red-400 border-red-500/30",
  investigating: "bg-blue-500/10 text-blue-400 border-blue-500/30",
  acknowledged: "bg-amber-500/10 text-amber-400 border-amber-500/30",
  remediated: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
  resolved: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
  ignored: "bg-slate-500/10 text-slate-400 border-slate-500/30",
  false_positive: "bg-purple-500/10 text-purple-400 border-purple-500/30",
};

type FindingListItem = SecurityFindingItem & {
  server_name?: string | null;
  project_name?: string | null;
};

export function FindingsTab({
  servers,
  environments,
}: {
  servers: ServerSummary[];
  environments: EnvironmentSummary[];
}) {
  const queryClient = useQueryClient();
  const [sevFilter, setSevFilter] = useState<Severity[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [sourceFilter, setSourceFilter] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedFindingId, setSelectedFindingId] = useState<number | null>(null);
  const [remediatingFinding, setRemediatingFinding] = useState<SecurityFindingItem | null>(null);
  const [page, setPage] = useState(1);
  const [fixDialog, setFixDialog] = useState<{
    targetType: "server" | "environment";
    targetId: number;
    targetName: string;
    initialActions: string[];
  } | null>(null);

  const params = new URLSearchParams({ page: String(page), limit: "15" });
  if (sevFilter.length > 0) params.set("severity", sevFilter.join(","));
  if (statusFilter !== "all") params.set("status", statusFilter);
  if (searchQuery.trim()) params.set("search", searchQuery.trim());
  if (sourceFilter.startsWith("server:"))
    params.set("server_id", sourceFilter.slice(7));
  if (sourceFilter.startsWith("environment:"))
    params.set("environment_id", sourceFilter.slice(12));

  const { data, isFetching } = useQuery<{
    data: FindingListItem[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }>({
    queryKey: [
      "security",
      "findings",
      sevFilter,
      statusFilter,
      sourceFilter,
      searchQuery,
      page,
    ],
    queryFn: () => api.get<{ data: FindingListItem[]; total: number; page: number; limit: number; totalPages: number }>(`/security/findings?${params}`),
  });

  const toggleSev = (s: Severity) => {
    setSevFilter((prev) =>
      prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s],
    );
    setPage(1);
  };

  const quickStatusMutation = useMutation<{ status?: FindingStatus }, Error, { id: number; status: FindingStatus }>({
    mutationFn: ({ id, status }: { id: number; status: FindingStatus }) =>
      api.post(`/security/findings/${id}/transition`, { status }),
    onSuccess: (res) => {
      toast({ title: `Finding marked as ${res?.status || "updated"}` });
      void queryClient.invalidateQueries({ queryKey: ["security", "findings"] });
      void queryClient.invalidateQueries({ queryKey: ["security", "overview"] });
    },
    onError: (err) =>
      toast({
        title: "Failed to update finding",
        description: err.message,
        variant: "destructive",
      }),
  });

  return (
    <div className="space-y-4">
      {/* Filter Bar */}
      <div className="bg-card p-4 rounded-lg border border-border space-y-3">
        <div className="flex flex-wrap gap-3 items-end justify-between">
          <div className="flex flex-wrap gap-3 items-end">
            {/* Search Input */}
            <div className="space-y-1 w-64">
              <Label className="text-xs font-medium">Search Findings</Label>
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  placeholder="Title, resource, description..."
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setPage(1);
                  }}
                  className="pl-8 h-8 text-xs"
                />
              </div>
            </div>

            {/* Status Filter */}
            <div className="space-y-1">
              <Label className="text-xs font-medium">Status</Label>
              <Select
                value={statusFilter}
                onValueChange={(v) => {
                  setStatusFilter(v);
                  setPage(1);
                }}
              >
                <SelectTrigger className="w-36 h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Statuses</SelectItem>
                  <SelectItem value="new">New</SelectItem>
                  <SelectItem value="investigating">Investigating</SelectItem>
                  <SelectItem value="acknowledged">Acknowledged</SelectItem>
                  <SelectItem value="remediated">Remediated</SelectItem>
                  <SelectItem value="resolved">Resolved</SelectItem>
                  <SelectItem value="ignored">Ignored</SelectItem>
                  <SelectItem value="false_positive">False Positive</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Source Target */}
            <div className="space-y-1">
              <Label className="text-xs font-medium">Target</Label>
              <Select
                value={sourceFilter || "all"}
                onValueChange={(v) => {
                  setSourceFilter(v === "all" ? "" : v);
                  setPage(1);
                }}
              >
                <SelectTrigger className="w-48 h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Targets</SelectItem>
                  {servers.length > 0 && (
                    <>
                      <div className="px-2 pt-1.5 pb-0.5 text-[10px] text-muted-foreground font-semibold uppercase tracking-wide">
                        Servers
                      </div>
                      {servers.map((s) => (
                        <SelectItem key={`server:${s.id}`} value={`server:${s.id}`}>
                          {s.name}
                        </SelectItem>
                      ))}
                    </>
                  )}
                  {environments.length > 0 && (
                    <>
                      <div className="px-2 pt-1.5 pb-0.5 text-[10px] text-muted-foreground font-semibold uppercase tracking-wide">
                        Environments
                      </div>
                      {environments.map((e) => (
                        <SelectItem
                          key={`environment:${e.id}`}
                          value={`environment:${e.id}`}
                        >
                          {e.project?.name || "Project"} ({e.type})
                        </SelectItem>
                      ))}
                    </>
                  )}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Severity Badges Filter */}
          <div className="space-y-1">
            <Label className="text-xs font-medium">Severity</Label>
            <div className="flex gap-1 flex-wrap">
              {SEVERITY_LEVELS.map((s) => (
                <button
                  key={s}
                  onClick={() => toggleSev(s)}
                  className={`px-2 py-0.5 rounded text-xs font-semibold border transition-all ${SEVERITY_CLASSES[s]} ${sevFilter.length > 0 && !sevFilter.includes(s) ? "opacity-35" : "opacity-100 ring-1 ring-border"}`}
                >
                  {s.toUpperCase()}
                </button>
              ))}
              {sevFilter.length > 0 && (
                <button
                  onClick={() => {
                    setSevFilter([]);
                    setPage(1);
                  }}
                  className="px-2 py-0.5 rounded text-xs border border-muted text-muted-foreground hover:text-foreground"
                >
                  Clear
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Header Info */}
      <div className="flex items-center justify-between text-xs text-muted-foreground px-1">
        <span>
          {isFetching
            ? "Loading findings..."
            : `${data?.total ?? 0} finding${(data?.total ?? 0) !== 1 ? "s" : ""}`}
        </span>
      </div>

      {/* Empty State */}
      {data?.data.length === 0 && !isFetching && (
        <div className="text-center py-16 text-muted-foreground bg-card rounded-lg border border-border">
          <ShieldCheck className="h-12 w-12 mx-auto mb-3 opacity-40 text-emerald-500" />
          <p className="font-semibold text-base text-foreground">No open findings match criteria</p>
          <p className="text-sm mt-1">
            All findings in this category are resolved or no matching scans were detected.
          </p>
        </div>
      )}

      {/* Findings List */}
      <div className="space-y-2.5">
        {data?.data.map((item) => {
          const findingId = item.id;
          const severity = (item.severity || "info") as Severity;
          const status = (item.status || "new") as FindingStatus;

          const targetName =
            item.server?.name ||
            (item.environment
              ? `${item.environment.project?.name || "Project"} (${item.environment.type})`
              : item.server_name || item.project_name || "Unknown");

          const targetType = item.server_id || item.server ? "server" : "environment";

          return (
            <div
              key={findingId || `${item.scan_id}-${item.title}`}
              className="bg-card p-4 rounded-lg border border-border hover:border-border/80 transition-all shadow-sm space-y-3 cursor-pointer group"
              onClick={() => typeof findingId === "number" && setSelectedFindingId(findingId)}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1.5 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge
                      variant="outline"
                      className={`text-[10px] font-bold uppercase tracking-wider ${SEVERITY_CLASSES[severity] || SEVERITY_CLASSES.info}`}
                    >
                      {severity}
                    </Badge>
                    <Badge
                      variant="outline"
                      className={`text-[10px] capitalize ${STATUS_CLASSES[status] || STATUS_CLASSES.new}`}
                    >
                      {status.replace("_", " ")}
                    </Badge>
                    <span className="text-xs font-semibold text-muted-foreground">
                      {item.category}
                    </span>
                    <span className="text-xs text-muted-foreground">•</span>
                    <span className="text-xs text-muted-foreground flex items-center gap-1">
                      {targetType === "server" ? (
                        <ServerIcon className="h-3 w-3" />
                      ) : (
                        <Globe className="h-3 w-3" />
                      )}
                      {targetName}
                    </span>
                  </div>

                  <h3 className="text-sm font-semibold text-foreground group-hover:text-primary transition-colors">
                    {item.title}
                  </h3>
                  <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
                    {item.description}
                  </p>
                </div>

                <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-foreground shrink-0 mt-1" />
              </div>

              {/* Resource & Quick Actions footer */}
              <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-border/50 text-xs">
                <div className="text-muted-foreground truncate max-w-md font-mono text-[11px]">
                  {item.resource ? (
                    <span className="bg-muted/40 px-1.5 py-0.5 rounded border border-border/40">
                      {item.resource}
                    </span>
                  ) : item.first_seen_at ? (
                    <span>Seen: {new Date(item.last_seen_at || item.first_seen_at).toLocaleDateString()}</span>
                  ) : null}
                </div>

                <div
                  className="flex items-center gap-1.5"
                  onClick={(e) => e.stopPropagation()}
                >
                  {typeof findingId === "number" && status !== "investigating" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs px-2 text-muted-foreground hover:text-foreground"
                      onClick={() => quickStatusMutation.mutate({ id: findingId, status: "investigating" })}
                    >
                      <Eye className="h-3 w-3 mr-1 text-blue-400" />
                      Investigate
                    </Button>
                  )}
                  {typeof findingId === "number" && status !== "resolved" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs px-2 text-muted-foreground hover:text-foreground"
                      onClick={() => quickStatusMutation.mutate({ id: findingId, status: "resolved" })}
                    >
                      <CheckCircle2 className="h-3 w-3 mr-1 text-emerald-400" />
                      Resolve
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs px-2.5"
                    onClick={() => typeof findingId === "number" && setSelectedFindingId(findingId)}
                  >
                    View Details
                  </Button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Pagination */}
      {data && data.totalPages > 1 && (
        <div className="flex items-center justify-between text-xs text-muted-foreground pt-2">
          <span>
            Page {page} of {data.totalPages}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              disabled={page >= data.totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}

      {/* Detail & Lifecycle Drawer */}
      <FindingDetailDrawer
        findingId={selectedFindingId}
        onClose={() => setSelectedFindingId(null)}
        onRemediateClick={(f) => {
          setRemediatingFinding(f);
        }}
      />

      {/* Safe Remediation Execution Modal (Lamah-Staging Safety Policy) */}
      <RemediationModal
        finding={remediatingFinding}
        open={!!remediatingFinding}
        onOpenChange={(isOpen) => {
          if (!isOpen) setRemediatingFinding(null);
        }}
      />

      {/* Hardening & Remediation Dialog */}
      {fixDialog && (
        <HardenDialog
          open
          onClose={() => setFixDialog(null)}
          targetType={fixDialog.targetType}
          targetId={fixDialog.targetId}
          targetName={fixDialog.targetName}
          initialActions={fixDialog.initialActions}
        />
      )}
    </div>
  );
}
