import React, { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Flame,
  ShieldAlert,
  Server as ServerIcon,
  Clock,
  CheckCircle2,
  AlertTriangle,
  FileSearch,
  ExternalLink,
  ChevronDown,
  ChevronUp,
  Filter,
} from "lucide-react";
import { Button } from "@/components/ui/button";
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
import type { ServerSummary, Severity } from "../types";
import { ErrorState, Pagination } from "@/components/crud";

export interface CorrelatedIncident {
  id: number;
  server_id: number;
  server?: { id: number; name: string; ip_address: string };
  title: string;
  summary: string;
  severity: Severity;
  confidence: "high" | "medium" | "low";
  status:
    "open" | "investigating" | "contained" | "resolved" | "false_positive";
  detected_at: string;
  resolved_at?: string | null;
  findings: {
    id: number;
    category: string;
    severity: Severity;
    status: string;
    title: string;
    resource?: string | null;
  }[];
}

const INCIDENT_STATUS_STYLES: Record<string, string> = {
  open: "bg-red-500/10 text-red-400 border-red-500/30",
  investigating: "bg-amber-500/10 text-amber-400 border-amber-500/30",
  contained: "bg-blue-500/10 text-blue-400 border-blue-500/30",
  resolved: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
  false_positive: "bg-muted text-muted-foreground border-border",
};

const SEVERITY_STYLES: Record<Severity, string> = {
  critical: "bg-red-600 text-white font-bold",
  high: "bg-orange-500 text-white font-semibold",
  medium: "bg-amber-500/10 text-amber-400 border-amber-500/30",
  low: "bg-blue-500/10 text-blue-400 border-blue-500/30",
  info: "bg-slate-500/10 text-slate-400 border-slate-500/30",
};

export function IncidentsTab({ servers }: { servers: ServerSummary[] }) {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedIncidentId = searchParams.get("incidentId") ?? "";
  const incidentId = /^[1-9]\d*$/.test(requestedIncidentId)
    ? Number(requestedIncidentId)
    : null;
  const [selectedStatus, setSelectedStatus] = useState<string>("all");
  const [selectedServerId, setSelectedServerId] = useState<string>("all");
  const [page, setPage] = useState(1);
  const [expandedIncidentId, setExpandedIncidentId] = useState<number | null>(
    null,
  );

  const { data, isFetching, isError, refetch } = useQuery<{
    data: CorrelatedIncident[];
    total: number;
    page: number;
    totalPages: number;
  }>({
    queryKey: ["security", "incidents", selectedStatus, selectedServerId, page],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), limit: "10" });
      if (selectedStatus !== "all") params.append("status", selectedStatus);
      if (selectedServerId !== "all")
        params.append("serverId", selectedServerId);
      return api.get(`/security/incidents?${params.toString()}`);
    },
    refetchInterval: 15_000,
  });

  const { data: linkedIncident } = useQuery<CorrelatedIncident>({
    queryKey: ["security", "incident", incidentId],
    queryFn: () => api.get(`/security/incidents/${incidentId}`),
    enabled: incidentId !== null,
  });

  useEffect(() => {
    setExpandedIncidentId(
      /^[1-9]\d*$/.test(requestedIncidentId)
        ? Number(requestedIncidentId)
        : null,
    );
  }, [requestedIncidentId]);

  function toggleIncident(id: number) {
    const nextId = expandedIncidentId === id ? null : id;
    setExpandedIncidentId(nextId);
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      if (nextId) next.set("incidentId", String(nextId));
      else next.delete("incidentId");
      return next;
    });
  }

  const updateStatusMutation = useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) =>
      api.patch(`/security/incidents/${id}/status`, { status }),
    onSuccess: (_, vars) => {
      toast({
        title: "Incident status updated",
        description: `Incident marked as ${vars.status}.`,
      });
      void queryClient.invalidateQueries({
        queryKey: ["security", "incidents"],
      });
      void queryClient.invalidateQueries({
        queryKey: ["security", "findings"],
      });
    },
    onError: (err) => {
      toast({
        title: "Failed to update status",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const listedIncidents = data?.data || [];
  const incidents =
    linkedIncident &&
    !listedIncidents.some((incident) => incident.id === linkedIncident.id)
      ? [linkedIncident, ...listedIncidents]
      : listedIncidents;

  return (
    <div className="space-y-4">
      {/* Filters Bar */}
      <div className="bg-card p-4 rounded-lg border border-border flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-medium">
            <Filter className="h-3.5 w-3.5" />
            <span>Filter By:</span>
          </div>

          <Select
            value={selectedStatus}
            onValueChange={(value) => {
              setSelectedStatus(value);
              setPage(1);
            }}
          >
            <SelectTrigger className="h-8 text-xs w-36">
              <SelectValue placeholder="All Statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="open">Open</SelectItem>
              <SelectItem value="investigating">Investigating</SelectItem>
              <SelectItem value="contained">Contained</SelectItem>
              <SelectItem value="resolved">Resolved</SelectItem>
              <SelectItem value="false_positive">False Positive</SelectItem>
            </SelectContent>
          </Select>

          <Select
            value={selectedServerId}
            onValueChange={(value) => {
              setSelectedServerId(value);
              setPage(1);
            }}
          >
            <SelectTrigger className="h-8 text-xs w-48">
              <SelectValue placeholder="All Servers" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Servers</SelectItem>
              {servers.map((s) => (
                <SelectItem key={s.id} value={String(s.id)}>
                  {s.name} ({s.ip_address})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="text-xs text-muted-foreground">
          Showing {incidents.length} of {data?.total ?? 0} correlated
          incident(s)
        </div>
      </div>

      {/* Incidents Feed */}
      {isError && (
        <ErrorState
          title="Incidents could not be loaded"
          description="The request failed. This does not mean there are no security incidents."
          onRetry={() => void refetch()}
        />
      )}

      {!isError && incidents.length === 0 && !isFetching && (
        <div className="text-center py-16 bg-card rounded-lg border border-border text-muted-foreground space-y-2">
          <CheckCircle2 className="h-10 w-10 mx-auto text-emerald-500 opacity-80" />
          <p className="font-semibold text-sm text-foreground">
            No Security Incidents
          </p>
          <p className="text-xs">
            No correlated multi-signal attack patterns or active compromises
            detected.
          </p>
        </div>
      )}

      <div className="space-y-3">
        {incidents.map((incident) => {
          const isExpanded = expandedIncidentId === incident.id;
          const statusStyle =
            INCIDENT_STATUS_STYLES[incident.status] ||
            INCIDENT_STATUS_STYLES.open;

          return (
            <div
              key={incident.id}
              className="bg-card p-4 rounded-lg border border-border shadow-sm space-y-3 hover:border-border/80 transition-colors"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge
                      className={`text-[10px] uppercase font-bold px-2 py-0.5 ${SEVERITY_STYLES[incident.severity]}`}
                    >
                      {incident.severity}
                    </Badge>
                    <Badge
                      variant="outline"
                      className={`text-[10px] font-bold uppercase tracking-wide ${statusStyle}`}
                    >
                      {incident.status}
                    </Badge>
                    <Badge
                      variant="outline"
                      className="text-[10px] text-muted-foreground border-border"
                    >
                      Confidence: {incident.confidence.toUpperCase()}
                    </Badge>
                  </div>

                  <h3 className="font-semibold text-sm text-foreground flex items-center gap-2">
                    <Flame className="h-4 w-4 text-red-500 shrink-0" />
                    {incident.title}
                  </h3>

                  <p className="text-xs text-muted-foreground leading-relaxed">
                    {incident.summary}
                  </p>
                </div>

                <div className="text-right shrink-0 space-y-1">
                  <div className="text-xs text-muted-foreground flex items-center gap-1.5 justify-end">
                    <ServerIcon className="h-3.5 w-3.5" />
                    <span className="font-medium text-foreground">
                      {incident.server?.name || "Server"}
                    </span>
                  </div>
                  <div className="text-[11px] text-muted-foreground flex items-center gap-1 justify-end">
                    <Clock className="h-3 w-3" />
                    {new Date(incident.detected_at).toLocaleString()}
                  </div>
                </div>
              </div>

              {/* Action Buttons & Expand Toggle */}
              <div className="flex items-center justify-between pt-2 border-t border-border/60 flex-wrap gap-2">
                <div className="flex items-center gap-2">
                  {incident.status === "open" && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      onClick={() =>
                        updateStatusMutation.mutate({
                          id: incident.id,
                          status: "investigating",
                        })
                      }
                      disabled={updateStatusMutation.isPending}
                    >
                      <FileSearch className="h-3 w-3 mr-1 text-amber-500" />
                      Investigate
                    </Button>
                  )}

                  {(incident.status === "open" ||
                    incident.status === "investigating") && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      onClick={() =>
                        updateStatusMutation.mutate({
                          id: incident.id,
                          status: "contained",
                        })
                      }
                      disabled={updateStatusMutation.isPending}
                    >
                      <ShieldAlert className="h-3 w-3 mr-1 text-blue-500" />
                      Contain
                    </Button>
                  )}

                  {incident.status !== "resolved" && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      onClick={() =>
                        updateStatusMutation.mutate({
                          id: incident.id,
                          status: "resolved",
                        })
                      }
                      disabled={updateStatusMutation.isPending}
                    >
                      <CheckCircle2 className="h-3 w-3 mr-1 text-emerald-500" />
                      Mark Resolved
                    </Button>
                  )}

                  {incident.status !== "false_positive" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs text-muted-foreground"
                      onClick={() =>
                        updateStatusMutation.mutate({
                          id: incident.id,
                          status: "false_positive",
                        })
                      }
                      disabled={updateStatusMutation.isPending}
                    >
                      False Positive
                    </Button>
                  )}
                </div>

                <button
                  type="button"
                  onClick={() => toggleIncident(incident.id)}
                  className="text-xs text-primary hover:underline flex items-center gap-1 font-medium ml-auto"
                >
                  {isExpanded ? (
                    <>
                      <ChevronUp className="h-3.5 w-3.5" />
                      Hide Correlated Findings ({incident.findings?.length || 0}
                      )
                    </>
                  ) : (
                    <>
                      <ChevronDown className="h-3.5 w-3.5" />
                      View Correlated Findings ({incident.findings?.length || 0}
                      )
                    </>
                  )}
                </button>
              </div>

              {/* Correlated Findings List */}
              {isExpanded && (
                <div className="bg-muted/40 p-3 rounded-md border border-border/60 space-y-2 mt-2">
                  <div className="text-xs font-semibold text-foreground">
                    Correlated Security Findings:
                  </div>
                  {incident.findings?.map((finding) => (
                    <div
                      key={finding.id}
                      className="bg-card p-2.5 rounded border border-border flex items-center justify-between gap-3 text-xs"
                    >
                      <div className="flex items-center gap-2">
                        <Badge
                          variant="outline"
                          className="text-[10px] uppercase font-mono"
                        >
                          {finding.category}
                        </Badge>
                        <span className="font-medium text-foreground">
                          {finding.title}
                        </span>
                      </div>
                      {finding.resource && (
                        <code className="text-[11px] font-mono text-muted-foreground bg-muted px-1 py-0.5 rounded">
                          {finding.resource}
                        </code>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {data && data.totalPages > 1 && (
        <Pagination
          page={page}
          totalPages={data.totalPages}
          onPageChange={setPage}
        />
      )}
    </div>
  );
}
