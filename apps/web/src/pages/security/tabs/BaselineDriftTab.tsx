import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  GitCompare,
  Camera,
  History,
  ShieldCheck,
  AlertTriangle,
  Server as ServerIcon,
  Globe,
  Clock,
  User,
  Key,
  Layers,
  Terminal,
  Activity,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/lib/api-client";
import { toast } from "@/hooks/use-toast";
import type { ServerSummary, EnvironmentSummary } from "../types";

export interface BaselineData {
  id: number;
  label: string | null;
  created_at: string;
  created_by?: { id: number; name: string; email: string } | null;
  items: {
    id: number;
    category: string;
    key: string;
    value: any;
    created_at: string;
  }[];
}

export interface DriftEventItem {
  id: number;
  category: string;
  key: string;
  change_type: "added" | "removed" | "modified" | string;
  old_value?: any;
  new_value?: any;
  detected_at: string;
  finding_id?: number | null;
  server?: { id: number; name: string };
  environment?: { id: number; type: string; project?: { id: number; name: string } };
}

const CHANGE_TYPE_STYLES: Record<string, string> = {
  added: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
  removed: "bg-red-500/10 text-red-400 border-red-500/30",
  modified: "bg-amber-500/10 text-amber-400 border-amber-500/30",
};

export function BaselineDriftTab({
  servers,
  environments,
}: {
  servers: ServerSummary[];
  environments: EnvironmentSummary[];
}) {
  const queryClient = useQueryClient();
  const [targetType, setTargetType] = useState<"server" | "environment">("server");
  const [selectedId, setSelectedId] = useState<number>(
    servers.length > 0 ? servers[0].id : environments.length > 0 ? environments[0].id : 0,
  );
  const [captureDialogOpen, setCaptureDialogOpen] = useState(false);
  const [captureLabel, setCaptureLabel] = useState("");
  const [expandedDriftId, setExpandedDriftId] = useState<number | null>(null);

  // Fetch active baseline
  const { data: baseline, isFetching: isBaselineFetching } = useQuery<BaselineData | null>({
    queryKey: ["security", "baseline", targetType, selectedId],
    queryFn: () =>
      selectedId
        ? api.get(
            targetType === "server"
              ? `/security/servers/${selectedId}/baseline`
              : `/security/environments/${selectedId}/baseline`,
          )
        : Promise.resolve(null),
    enabled: selectedId > 0,
  });

  // Fetch drift events
  const { data: driftData, isFetching: isDriftFetching } = useQuery<{
    data: DriftEventItem[];
    total: number;
    page: number;
    totalPages: number;
  }>({
    queryKey: ["security", "drift", targetType, selectedId],
    queryFn: () =>
      selectedId
        ? api.get(
            targetType === "server"
              ? `/security/servers/${selectedId}/drift?limit=20`
              : `/security/environments/${selectedId}/drift?limit=20`,
          )
        : Promise.resolve({ data: [], total: 0, page: 1, totalPages: 1 }),
    enabled: selectedId > 0,
  });

  // Capture baseline mutation
  const captureMutation = useMutation({
    mutationFn: () => {
      const url =
        targetType === "server"
          ? `/security/servers/${selectedId}/baseline`
          : `/security/environments/${selectedId}/baseline`;
      return api.post<{ jobExecutionId: number }>(url, {
        label: captureLabel.trim() || undefined,
      });
    },
    onSuccess: () => {
      toast({
        title: "Baseline capture initiated",
        description: "Worker is currently capturing the known-good state.",
      });
      setCaptureDialogOpen(false);
      setCaptureLabel("");
      setTimeout(() => {
        void queryClient.invalidateQueries({
          queryKey: ["security", "baseline", targetType, selectedId],
        });
      }, 3000);
    },
    onError: (err: any) => {
      toast({
        title: "Failed to capture baseline",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  // Compare live state mutation
  const compareMutation = useMutation({
    mutationFn: () => {
      const url =
        targetType === "server"
          ? `/security/servers/${selectedId}/baseline/compare`
          : `/security/environments/${selectedId}/baseline/compare`;
      return api.post<{ jobExecutionId: number }>(url, {});
    },
    onSuccess: () => {
      toast({
        title: "Comparison job queued",
        description: "Checking live state for drift against active baseline.",
      });
      setTimeout(() => {
        void queryClient.invalidateQueries({
          queryKey: ["security", "drift", targetType, selectedId],
        });
        void queryClient.invalidateQueries({ queryKey: ["security", "findings"] });
      }, 3000);
    },
    onError: (err: any) => {
      toast({
        title: "Failed to run comparison",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  // Aggregate items by category
  const itemCategoryCounts = (baseline?.items || []).reduce<Record<string, number>>(
    (acc, item) => {
      acc[item.category] = (acc[item.category] || 0) + 1;
      return acc;
    },
    {},
  );

  return (
    <div className="space-y-6">
      {/* Target Selector Bar */}
      <div className="bg-card p-4 rounded-lg border border-border flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="space-y-1">
            <Label className="text-xs font-semibold">Target Type</Label>
            <div className="flex rounded-md border border-border overflow-hidden">
              <button
                type="button"
                className={`px-3 py-1 text-xs font-medium flex items-center gap-1.5 transition-colors ${targetType === "server" ? "bg-primary text-primary-foreground" : "bg-card hover:bg-muted text-muted-foreground"}`}
                onClick={() => {
                  setTargetType("server");
                  if (servers.length > 0) setSelectedId(servers[0].id);
                }}
              >
                <ServerIcon className="h-3 w-3" />
                Server
              </button>
              <button
                type="button"
                className={`px-3 py-1 text-xs font-medium flex items-center gap-1.5 transition-colors ${targetType === "environment" ? "bg-primary text-primary-foreground" : "bg-card hover:bg-muted text-muted-foreground"}`}
                onClick={() => {
                  setTargetType("environment");
                  if (environments.length > 0) setSelectedId(environments[0].id);
                }}
              >
                <Globe className="h-3 w-3" />
                Environment
              </button>
            </div>
          </div>

          <div className="space-y-1 w-64">
            <Label className="text-xs font-semibold">
              Select {targetType === "server" ? "Server" : "Environment"}
            </Label>
            <Select
              value={String(selectedId)}
              onValueChange={(val) => setSelectedId(Number(val))}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {targetType === "server"
                  ? servers.map((s) => (
                      <SelectItem key={s.id} value={String(s.id)}>
                        {s.name} ({s.ip_address})
                      </SelectItem>
                    ))
                  : environments.map((e) => (
                      <SelectItem key={e.id} value={String(e.id)}>
                        {e.project?.name || "Project"} / {e.type}
                      </SelectItem>
                    ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Primary Baseline Action Buttons */}
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="text-xs h-8"
            onClick={() => setCaptureDialogOpen(true)}
            disabled={!selectedId}
          >
            <Camera className="h-3.5 w-3.5 mr-1.5 text-primary" />
            Capture Baseline
          </Button>

          <Button
            size="sm"
            className="text-xs h-8"
            onClick={() => compareMutation.mutate()}
            disabled={!baseline || compareMutation.isPending}
          >
            <GitCompare className={`h-3.5 w-3.5 mr-1.5 ${compareMutation.isPending ? "animate-spin" : ""}`} />
            Compare Live State
          </Button>
        </div>
      </div>

      {/* Active Baseline Status Banner */}
      <div className="bg-card p-5 rounded-lg border border-border space-y-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 pb-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-sm text-foreground">
                Active Security Baseline
              </span>
              {baseline ? (
                <Badge variant="outline" className="bg-emerald-500/10 text-emerald-400 border-emerald-500/30 text-[10px]">
                  ACTIVE
                </Badge>
              ) : (
                <Badge variant="outline" className="bg-yellow-500/10 text-yellow-400 border-yellow-500/30 text-[10px]">
                  NOT CONFIGURED
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {baseline?.label || "Canonical snapshot used for zero-drift security enforcement."}
            </p>
          </div>

          {baseline && (
            <div className="text-xs text-muted-foreground flex items-center gap-3">
              <span className="flex items-center gap-1">
                <Clock className="h-3.5 w-3.5" />
                {new Date(baseline.created_at).toLocaleString()}
              </span>
              {baseline.created_by && (
                <span className="flex items-center gap-1">
                  <User className="h-3.5 w-3.5" />
                  {baseline.created_by.name}
                </span>
              )}
            </div>
          )}
        </div>

        {baseline ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3">
            {Object.entries(itemCategoryCounts).map(([cat, count]) => (
              <div key={cat} className="bg-muted/30 p-2.5 rounded border border-border/40 text-center space-y-1">
                <div className="text-lg font-bold text-foreground">{count}</div>
                <div className="text-[11px] font-medium text-muted-foreground capitalize">
                  {cat.replace("_", " ")}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="py-6 text-center text-muted-foreground space-y-2">
            <Camera className="h-8 w-8 mx-auto opacity-30" />
            <p className="text-sm font-medium">No baseline captured yet</p>
            <p className="text-xs">
              Capture a baseline to lock in the expected SSH keys, users, services, ports, and configuration.
            </p>
          </div>
        )}
      </div>

      {/* Drift Detection Events Feed */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <History className="h-4 w-4 text-primary" />
            <h3 className="font-semibold text-sm text-foreground">Drift Detection Events</h3>
            <span className="text-xs text-muted-foreground">({driftData?.total ?? 0} recorded)</span>
          </div>
        </div>

        {driftData?.data.length === 0 && !isDriftFetching && (
          <div className="text-center py-12 bg-card rounded-lg border border-border text-muted-foreground space-y-2">
            <ShieldCheck className="h-10 w-10 mx-auto text-emerald-500 opacity-80" />
            <p className="font-semibold text-sm text-foreground">Zero Configuration Drift</p>
            <p className="text-xs">
              Live server state matches the active baseline. No unauthorized keys, ports, or accounts detected.
            </p>
          </div>
        )}

        <div className="space-y-2.5">
          {driftData?.data.map((event) => {
            const isExpanded = expandedDriftId === event.id;
            const style = CHANGE_TYPE_STYLES[event.change_type] || CHANGE_TYPE_STYLES.modified;

            return (
              <div
                key={event.id}
                className="bg-card p-3.5 rounded-lg border border-border shadow-sm space-y-2"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant="outline" className={`text-[10px] font-bold uppercase tracking-wide ${style}`}>
                        {event.change_type}
                      </Badge>
                      <span className="text-xs font-semibold text-foreground uppercase tracking-wider">
                        {event.category}
                      </span>
                      <span className="text-xs text-muted-foreground">•</span>
                      <code className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded text-foreground">
                        {event.key}
                      </code>
                    </div>
                  </div>

                  <div className="text-right shrink-0">
                    <span className="text-xs text-muted-foreground">
                      {new Date(event.detected_at).toLocaleString()}
                    </span>
                  </div>
                </div>

                {/* Value Details Toggle */}
                {(event.old_value || event.new_value) && (
                  <div>
                    <button
                      type="button"
                      onClick={() => setExpandedDriftId(isExpanded ? null : event.id)}
                      className="text-xs text-primary hover:underline flex items-center gap-1 font-medium"
                    >
                      {isExpanded ? (
                        <>
                          <ChevronUp className="h-3 w-3" /> Hide Values Diff
                        </>
                      ) : (
                        <>
                          <ChevronDown className="h-3 w-3" /> Inspect Changed Values
                        </>
                      )}
                    </button>

                    {isExpanded && (
                      <div className="mt-2.5 grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
                        {event.old_value && (
                          <div className="space-y-1">
                            <span className="text-[11px] font-semibold text-muted-foreground">
                              Baseline Value:
                            </span>
                            <pre className="bg-muted/60 p-2 rounded text-[11px] font-mono overflow-x-auto border border-border/50 text-foreground">
                              {typeof event.old_value === "object"
                                ? JSON.stringify(event.old_value, null, 2)
                                : String(event.old_value)}
                            </pre>
                          </div>
                        )}
                        {event.new_value && (
                          <div className="space-y-1">
                            <span className="text-[11px] font-semibold text-muted-foreground">
                              Live Detected Value:
                            </span>
                            <pre className="bg-muted/60 p-2 rounded text-[11px] font-mono overflow-x-auto border border-border/50 text-foreground">
                              {typeof event.new_value === "object"
                                ? JSON.stringify(event.new_value, null, 2)
                                : String(event.new_value)}
                            </pre>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Capture Baseline Modal */}
      <Dialog open={captureDialogOpen} onOpenChange={setCaptureDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Capture Security Baseline</DialogTitle>
            <DialogDescription>
              This snapshot records current authorized SSH keys, system accounts, listening ports, enabled services, cron jobs, and configuration.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <Label className="text-xs">Baseline Label / Note (Optional)</Label>
              <Input
                placeholder="e.g. Post-deployment v2.4 or Clean Hardened Baseline"
                value={captureLabel}
                onChange={(e) => setCaptureLabel(e.target.value)}
                className="text-xs"
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCaptureDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => captureMutation.mutate()}
              disabled={captureMutation.isPending}
            >
              {captureMutation.isPending ? "Capturing..." : "Capture Now"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
