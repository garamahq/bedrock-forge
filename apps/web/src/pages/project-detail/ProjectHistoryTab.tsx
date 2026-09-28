import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Clock3, GitCommitHorizontal, ListChecks, Search } from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "@/lib/api-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Pagination } from "@/components/crud";
import { ErrorState } from "@/components/crud";
import { Skeleton } from "@/components/ui/skeleton";

interface ProjectHistoryEvent {
  id: string;
  kind: "operation" | "audit";
  action: string;
  status: string | null;
  actor: string | null;
  resource_type: string | null;
  resource_id: number | null;
  created_at: string;
  environment: { id: number; type: string; url: string | null } | null;
}

interface ProjectHistoryResponse {
  data: ProjectHistoryEvent[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

function formatAction(event: ProjectHistoryEvent): string {
  if (event.kind === "operation") {
    return event.action
      .replace(/[:._-]+/g, " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  const labels: Record<string, string> = {
    "project.drift.set-baseline": "Baseline set",
    "project.drift.clear-baseline": "Baseline cleared",
    "server.test-connection": "Connection test",
    "environment.quick-login": "Quick login",
  };
  if (labels[event.action]) return labels[event.action];

  const [resource, ...operationParts] = event.action.split(".");
  const operation = operationParts.join(" ").replace(/-/g, " ");
  const lifecycleLabels: Record<string, string> = {
    create: "created",
    update: "updated",
    delete: "deleted",
  };
  if (lifecycleLabels[operation]) return `${resource} ${lifecycleLabels[operation]}`;
  return operation.replace(/\b\w/g, (letter) => letter.toUpperCase()) || event.action;
}

function statusTone(status: string | null): string {
  if (status === "failed" || status === "failure" || status === "dead_letter") {
    return "text-destructive border-destructive/30";
  }
  if (status === "completed" || status === "success") {
    return "text-emerald-500 border-emerald-500/30";
  }
  if (status === "active" || status === "queued") {
    return "text-amber-500 border-amber-500/30";
  }
  return "text-muted-foreground";
}

export function ProjectHistoryTab({ projectId }: { projectId: number }) {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const limit = 25;
  const { data, isLoading, isError, refetch } = useQuery<ProjectHistoryResponse>({
    queryKey: ["project-history", projectId, page, search],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (search.trim()) params.set("search", search.trim());
      return api.get(`/projects/${projectId}/history?${params.toString()}`);
    },
    staleTime: 10_000,
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold">History & recovery</h3>
          <p className="text-sm text-muted-foreground">
            Deploys, backups, syncs, security scans, and changes across this project’s environments.
          </p>
        </div>
        {data && <Badge variant="secondary">{data.total} events</Badge>}
      </div>

      <div className="relative max-w-lg">
        <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(1);
          }}
          placeholder="Search actions, operation types, or IDs…"
          className="pl-9"
        />
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3, 4].map((row) => (
            <Skeleton key={row} className="h-16 rounded-lg" />
          ))}
        </div>
      ) : isError ? (
        <ErrorState
          title="Project history could not be loaded"
          description="Retry to load the latest operations and audit changes."
          onRetry={() => void refetch()}
        />
      ) : data?.data.length ? (
        <div className="divide-y rounded-lg border bg-card">
          {data.data.map((event) => {
            const Icon = event.kind === "operation" ? GitCommitHorizontal : ListChecks;
            return (
              <div key={event.id} className="flex items-start gap-3 px-4 py-3">
                <Icon className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{formatAction(event)}</span>
                    <Badge variant="outline" className="text-[10px] capitalize">
                      {event.kind === "operation" ? "Operation" : "Change"}
                    </Badge>
                    {event.status && (
                      <Badge variant="outline" className={`text-[10px] capitalize ${statusTone(event.status)}`}>
                        {event.status.replace(/_/g, " ")}
                      </Badge>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    {event.actor && <span>By {event.actor}</span>}
                    {event.environment && (
                      <Link
                        to={`/projects/${projectId}?tab=environments&env=${event.environment.id}`}
                        className="hover:text-primary hover:underline"
                      >
                        {event.environment.type} · {event.environment.url ?? "Environment"}
                      </Link>
                    )}
                    <span className="inline-flex items-center gap-1">
                      <Clock3 className="h-3 w-3" />
                      {new Date(event.created_at).toLocaleString()}
                    </span>
                  </div>
                </div>
                {event.kind === "operation" && event.resource_id != null && (
                  <Button asChild variant="ghost" size="sm" className="shrink-0">
                    <Link to={`/activity?job=${event.resource_id}`}>Open job</Link>
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="rounded-lg border bg-card px-4 py-12 text-center">
          <ListChecks className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
          <p className="font-medium">No history entries found</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Project operations and recorded changes will appear here.
          </p>
        </div>
      )}

      {data && data.totalPages > 1 && (
        <Pagination page={page} totalPages={data.totalPages} onPageChange={setPage} />
      )}
    </div>
  );
}
