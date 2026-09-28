import React from "react";
import { useQuery } from "@tanstack/react-query";
import { Clock, User, Info } from "lucide-react";
import { api } from "@/lib/api-client";
import { Badge } from "@/components/ui/badge";

interface AuditLogEntry {
  id: number;
  action: string;
  resource_type: string | null;
  resource_id: number | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  user: { id: number; name: string } | null;
}

interface AuditLogResponse {
  data: AuditLogEntry[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/** Maps an action string to a human-readable label and badge colour. */
function parseAction(
  action: string,
): { label: string; variant: "default" | "secondary" | "destructive" | "outline" } {
  const labels: Record<string, string> = {
    "project.drift.set-baseline": "Baseline set",
    "project.drift.clear-baseline": "Baseline cleared",
    "server.test-connection": "Connection test",
    "environment.quick-login": "Quick login",
  };
  if (labels[action]) return { label: labels[action], variant: "secondary" };

  const [resource, ...operationParts] = action.split(".");
  const operation = operationParts.join(".");
  const lifecycle: Record<string, { label: string; variant: "default" | "secondary" | "destructive" }> = {
    create: { label: `${resource} created`, variant: "default" },
    update: { label: `${resource} updated`, variant: "secondary" },
    delete: { label: `${resource} deleted`, variant: "destructive" },
  };
  if (lifecycle[operation]) return lifecycle[operation];

  return {
    label: operation
      .replace(/[:._-]+/g, " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase()) || action,
    variant: "outline",
  };
}

function metadataOutcome(
  metadata: Record<string, unknown> | null,
): string | null {
  const outcome = metadata?.outcome;
  return typeof outcome === "string" ? outcome : null;
}

function safeMetadataDetails(metadata: Record<string, unknown> | null) {
  if (!metadata) return [];
  return [
    typeof metadata.method === "string" ? `Method: ${metadata.method}` : null,
    typeof metadata.path === "string" ? `Route: ${metadata.path}` : null,
  ].filter((value): value is string => value !== null);
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

interface ResourceActivityFeedProps {
  resourceType: string;
  resourceId: number;
  limit?: number;
  className?: string;
}

/**
 * Reusable activity feed component. Displays filtered audit log entries
 * for a specific resource (server, project, environment, client, etc.).
 */
export function ResourceActivityFeed({
  resourceType,
  resourceId,
  limit = 25,
  className,
}: ResourceActivityFeedProps) {
  const { data, isLoading } = useQuery<AuditLogResponse>({
    queryKey: ["audit-logs", resourceType, resourceId, limit],
    queryFn: () =>
      api.get(
        `/audit-logs?resource_type=${resourceType}&resource_id=${resourceId}&limit=${limit}`,
      ),
    staleTime: 30_000,
  });

  if (isLoading) {
    return (
      <div className={className}>
        <div className="space-y-3">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-14 bg-muted/40 rounded-lg animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  const entries = data?.data ?? [];

  if (entries.length === 0) {
    return (
      <div className={`flex flex-col items-center justify-center py-16 text-center ${className ?? ""}`}>
        <Info className="h-8 w-8 text-muted-foreground mb-3 opacity-50" />
        <p className="font-medium text-sm">No activity recorded</p>
        <p className="text-xs text-muted-foreground mt-1">
          Actions taken on this resource will appear here.
        </p>
      </div>
    );
  }

  return (
    <div className={className}>
      <div className="space-y-1">
        {entries.map((entry) => {
          const { label, variant } = parseAction(entry.action);
          const outcome = metadataOutcome(entry.metadata);
          const details = safeMetadataDetails(entry.metadata);
          return (
            <div
              key={entry.id}
              className="flex items-start gap-3 py-3 px-3 rounded-lg hover:bg-muted/30 transition-colors"
            >
              {/* Action badge */}
              <Badge variant={variant} className="shrink-0 font-mono text-xs mt-0.5">
                {label}
              </Badge>

              {/* Details */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap text-xs text-muted-foreground">
                  {entry.user && (
                    <span className="flex items-center gap-1">
                      <User className="h-3 w-3" />
                      {entry.user.name}
                    </span>
                  )}
                  <span className="flex items-center gap-1 ml-auto shrink-0">
                    <Clock className="h-3 w-3" />
                    {timeAgo(entry.created_at)}
                  </span>
                </div>
                {outcome && (
                  <Badge
                    variant="outline"
                    className={`mt-1 text-[10px] capitalize ${outcome === "failure" ? "text-destructive border-destructive/30" : "text-emerald-500 border-emerald-500/30"}`}
                  >
                    {outcome}
                  </Badge>
                )}
                {details.length > 0 && (
                  <details className="mt-1 text-xs text-muted-foreground">
                    <summary className="w-fit cursor-pointer hover:text-foreground">
                      Request details
                    </summary>
                    <div className="mt-1 space-y-0.5 font-mono">
                      {details.map((detail) => (
                        <p key={detail} className="break-all">{detail}</p>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {data && data.total > limit && (
        <p className="text-xs text-center text-muted-foreground mt-4">
          Showing {limit} of {data.total} events · View all in{" "}
          <a href="/audit-logs" className="underline hover:text-primary">
            Audit Logs
          </a>
        </p>
      )}
    </div>
  );
}
