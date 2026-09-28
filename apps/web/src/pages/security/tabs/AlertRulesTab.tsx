import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BellRing,
  Plus,
  Trash2,
  Clock,
  Server as ServerIcon,
  ShieldAlert,
  Flame,
  CheckCircle2,
  Power,
  Layers,
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
import type { ServerSummary, Severity } from "../types";
import { SEVERITY_LEVELS } from "../constants";

export interface SecurityAlertRule {
  id: number;
  name: string;
  enabled: boolean;
  min_severity: Severity | null;
  categories: string[];
  server_ids: number[];
  channel_ids: number[];
  create_incident: boolean;
  cooldown_minutes: number;
  last_fired_at?: string | null;
  created_at: string;
}

export function AlertRulesTab({ servers }: { servers: ServerSummary[] }) {
  const queryClient = useQueryClient();
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [ruleName, setRuleName] = useState("");
  const [minSeverity, setMinSeverity] = useState<Severity>("high");
  const [cooldownMinutes, setCooldownMinutes] = useState<number>(30);
  const [createIncident, setCreateIncident] = useState<boolean>(false);

  const { data: rules = [], isFetching } = useQuery<SecurityAlertRule[]>({
    queryKey: ["security", "alert-rules"],
    queryFn: () => api.get("/security/alert-rules"),
  });

  const createMutation = useMutation({
    mutationFn: (data: Partial<SecurityAlertRule>) =>
      api.post("/security/alert-rules", data),
    onSuccess: () => {
      toast({
        title: "Alert rule created",
        description: "Rule has been registered and is actively monitoring scans.",
      });
      setCreateDialogOpen(false);
      setRuleName("");
      void queryClient.invalidateQueries({ queryKey: ["security", "alert-rules"] });
    },
    onError: (err) => {
      toast({
        title: "Failed to create rule",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const toggleRuleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) =>
      api.put(`/security/alert-rules/${id}`, { enabled }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["security", "alert-rules"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.delete(`/security/alert-rules/${id}`),
    onSuccess: () => {
      toast({ title: "Alert rule deleted" });
      void queryClient.invalidateQueries({ queryKey: ["security", "alert-rules"] });
    },
  });

  return (
    <div className="space-y-4">
      {/* Header Bar */}
      <div className="bg-card p-4 rounded-lg border border-border flex items-center justify-between gap-4">
        <div>
          <h3 className="font-semibold text-sm text-foreground flex items-center gap-2">
            <BellRing className="h-4 w-4 text-primary" />
            Security Alert Rules & Dispatch Policies
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Configure automated notifications and incident creation when security threats trigger.
          </p>
        </div>

        <Button
          size="sm"
          className="text-xs h-8"
          onClick={() => setCreateDialogOpen(true)}
        >
          <Plus className="h-3.5 w-3.5 mr-1" />
          Create Alert Rule
        </Button>
      </div>

      {/* Rules List */}
      {rules.length === 0 && !isFetching && (
        <div className="text-center py-16 bg-card rounded-lg border border-border text-muted-foreground space-y-2">
          <BellRing className="h-10 w-10 mx-auto opacity-30" />
          <p className="font-semibold text-sm text-foreground">No Alert Rules Configured</p>
          <p className="text-xs">
            Create an alert rule to automatically receive notifications for high and critical threats.
          </p>
        </div>
      )}

      <div className="space-y-3">
        {rules.map((rule) => (
          <div
            key={rule.id}
            className="bg-card p-4 rounded-lg border border-border shadow-sm flex items-start justify-between gap-4"
          >
            <div className="space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold text-sm text-foreground">{rule.name}</span>
                {rule.enabled ? (
                  <Badge variant="outline" className="bg-emerald-500/10 text-emerald-400 border-emerald-500/30 text-[10px]">
                    ACTIVE
                  </Badge>
                ) : (
                  <Badge variant="outline" className="bg-muted text-muted-foreground text-[10px]">
                    DISABLED
                  </Badge>
                )}
                {rule.min_severity && (
                  <Badge variant="outline" className="text-[10px] uppercase font-bold text-foreground">
                    Min Severity: {rule.min_severity}
                  </Badge>
                )}
                {rule.create_incident && (
                  <Badge variant="outline" className="bg-red-500/10 text-red-400 border-red-500/30 text-[10px]">
                    AUTO-INCIDENT
                  </Badge>
                )}
              </div>

              <div className="flex items-center gap-4 text-xs text-muted-foreground flex-wrap">
                <span className="flex items-center gap-1">
                  <Clock className="h-3 w-3" /> Cooldown: {rule.cooldown_minutes}m
                </span>
                {rule.last_fired_at ? (
                  <span className="flex items-center gap-1 text-amber-400">
                    <Flame className="h-3 w-3" /> Last Fired: {new Date(rule.last_fired_at).toLocaleString()}
                  </span>
                ) : (
                  <span>Never fired</span>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() =>
                  toggleRuleMutation.mutate({ id: rule.id, enabled: !rule.enabled })
                }
              >
                <Power className={`h-3 w-3 mr-1 ${rule.enabled ? "text-emerald-500" : "text-muted-foreground"}`} />
                {rule.enabled ? "Disable" : "Enable"}
              </Button>

              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-red-500 hover:text-red-600 hover:bg-red-500/10"
                onClick={() => deleteMutation.mutate(rule.id)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        ))}
      </div>

      {/* Create Rule Dialog */}
      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Security Alert Rule</DialogTitle>
            <DialogDescription>
              Define the conditions under which threats will trigger notifications and create incidents.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-1">
              <Label className="text-xs">Rule Name</Label>
              <Input
                placeholder="e.g. Critical Threat Instant Slack Alert"
                value={ruleName}
                onChange={(e) => setRuleName(e.target.value)}
                className="text-xs"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Minimum Severity</Label>
                <Select
                  value={minSeverity}
                  onValueChange={(value) => {
                    const severity = SEVERITY_LEVELS.find((item) => item === value);
                    if (severity) setMinSeverity(severity);
                  }}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="critical">Critical Only</SelectItem>
                    <SelectItem value="high">High & Critical</SelectItem>
                    <SelectItem value="medium">Medium, High & Critical</SelectItem>
                    <SelectItem value="low">Low and above</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1">
                <Label className="text-xs">Cooldown (Minutes)</Label>
                <Input
                  type="number"
                  min={1}
                  max={1440}
                  value={cooldownMinutes}
                  onChange={(e) => setCooldownMinutes(Number(e.target.value))}
                  className="text-xs"
                />
              </div>
            </div>

            <div className="flex items-center gap-2 pt-1">
              <input
                type="checkbox"
                id="createIncidentCheck"
                checked={createIncident}
                onChange={(e) => setCreateIncident(e.target.checked)}
                className="rounded border-border"
              />
              <Label htmlFor="createIncidentCheck" className="text-xs cursor-pointer">
                Automatically escalate matched findings to a Security Incident
              </Label>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCreateDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() =>
                createMutation.mutate({
                  name: ruleName.trim() || "Untitled Alert Rule",
                  min_severity: minSeverity,
                  cooldown_minutes: cooldownMinutes,
                  create_incident: createIncident,
                  enabled: true,
                })
              }
              disabled={createMutation.isPending || !ruleName.trim()}
            >
              {createMutation.isPending ? "Creating..." : "Create Rule"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
