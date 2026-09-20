import React, { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Shield,
  ShieldAlert,
  ShieldCheck,
  Loader2,
  RefreshCw,
  Play,
  Lock,
  Clock,
  AlertCircle,
  Check,
  ChevronDown,
  Info,
  Server,
  Terminal,
  AlertTriangle,
  Settings,
  ExternalLink,
} from "lucide-react";
import { api } from "@/lib/api-client";
import { toast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FindingItem, AcknowledgeFindingDialog } from "../security/components";
import {
  DEFAULT_ENVIRONMENT_HARDENING_ACTION_IDS,
  HARDENING_ACTION_GROUP_LABELS,
  HARDENING_PRESETS,
  ENVIRONMENT_HARDENING_ACTIONS,
  SCAN_TYPES_BY_KIND,
  isRiskyEnvironmentHardeningAction,
} from "../security/constants";
import type {
  FindingRow,
  FindingsResponse,
  SecuritySchedule,
  HardeningResult,
  EnvironmentSummary,
} from "../security/types";

interface Environment {
  id: number;
  type: string;
  url?: string;
  root_path?: string;
  backup_path?: string;
  google_drive_folder_id: string | null;
  server: {
    id: number;
    name: string;
    ip_address: string;
  };
}

export function SecurityTab({
  projectId,
  environments,
}: {
  projectId: number;
  environments: Environment[];
}) {
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const envParam = searchParams.get("env");
  const initialEnvId =
    envParam && environments.some((e) => e.id === Number(envParam))
      ? Number(envParam)
      : (environments[0]?.id ?? null);

  const [selectedEnvId, setSelectedEnvId] = useState<number | null>(
    initialEnvId,
  );

  // Keep in sync with URL search params
  useEffect(() => {
    const envId = Number(searchParams.get("env"));
    if (envId && environments.some((e) => e.id === envId)) {
      setSelectedEnvId(envId);
    }
  }, [searchParams, environments]);

  // Selected hardening actions to apply
  const [selectedHardening, setSelectedHardening] = useState<string[]>(
    DEFAULT_ENVIRONMENT_HARDENING_ACTION_IDS,
  );

  // Hardening job execution tracking
  const [hardenExecId, setHardenExecId] = useState<number | null>(null);
  const [hardenDone, setHardenDone] = useState(false);

  // Selected schedule state
  const [scheduleForm, setScheduleForm] = useState<SecuritySchedule>({
    scan_types: [
      "WP_AUDIT",
      "PROJECT_MALWARE",
      "BACKDOOR_SEARCH",
      "PLUGIN_AUDIT",
    ],
    frequency: "daily",
    hour: 2,
    minute: 0,
    enabled: true,
    notify_enabled: false,
    notify_threshold: "high",
  });
  const [scheduleSynced, setScheduleSynced] = useState(false);

  // Finding acknowledgment state
  const [ackDialog, setAckDialog] = useState<FindingRow | null>(null);

  const activeEnv = environments.find((e) => e.id === selectedEnvId);

  // 1. Fetch Environment Security Summary
  const {
    data: securityOverview,
    isLoading: isOverviewLoading,
    refetch: refetchOverview,
  } = useQuery<{
    environments: EnvironmentSummary[];
  }>({
    queryKey: ["security-overview"],
    queryFn: () => api.get("/security/overview"),
  });

  const envSummary = securityOverview?.environments?.find(
    (e) => e.id === selectedEnvId,
  );

  // 2. Fetch Findings for the selected environment
  const {
    data: findingsRes,
    isFetching: isFindingsFetching,
    refetch: refetchFindings,
  } = useQuery<FindingsResponse>({
    queryKey: ["security-findings", selectedEnvId],
    queryFn: () =>
      api.get(`/security/findings?environment_id=${selectedEnvId}&limit=50`),
    enabled: selectedEnvId !== null,
  });

  // 3. Fetch Scan Schedule for the selected environment
  const { data: scheduleData, isLoading: isScheduleLoading } =
    useQuery<SecuritySchedule | null>({
      queryKey: ["security-schedule-env", selectedEnvId],
      queryFn: async () => {
        try {
          return await api.get<SecuritySchedule>(
            `/security/schedules/environments/${selectedEnvId}`,
          );
        } catch {
          return null;
        }
      },
      enabled: selectedEnvId !== null,
    });

  // Sync loaded schedule data to form state
  useEffect(() => {
    if (scheduleData && !scheduleSynced) {
      setScheduleForm(scheduleData);
      setScheduleSynced(true);
    }
  }, [scheduleData, scheduleSynced]);

  // Reset sync indicator on environment change
  useEffect(() => {
    setScheduleSynced(false);
  }, [selectedEnvId]);

  // 4. Trigger Scan Mutation
  const scanMutation = useMutation({
    mutationFn: () =>
      api.post(`/security/environments/${selectedEnvId}/scan`, {
        types: SCAN_TYPES_BY_KIND.environment,
      }),
    onSuccess: () => {
      toast({
        title: "Scan initiated",
        description:
          "Security scan has been queued for execution on the server.",
      });
      void refetchOverview();
      void refetchFindings();
    },
    onError: () => {
      toast({
        title: "Scan failed",
        description:
          "Could not queue the security scan. Please check server logs.",
        variant: "destructive",
      });
    },
  });

  // 5. Trigger Hardening Mutation
  const hardenMutation = useMutation({
    mutationFn: (actions: string[]) =>
      api.post<{ jobExecutionId: number }>(
        `/security/environments/${selectedEnvId}/harden`,
        { actions },
      ),
    onSuccess: (res) => {
      setHardenExecId(res.jobExecutionId);
      setHardenDone(false);
      toast({
        title: "Hardening queued",
        description: "Starting environment hardening execution...",
      });
    },
    onError: () => {
      toast({
        title: "Hardening failed",
        description: "Could not apply hardening actions.",
        variant: "destructive",
      });
    },
  });

  // 6. Track Hardening Job Execution
  const { data: hardenJobLog } = useQuery<{
    id: number;
    status: string;
    execution_log: HardeningResult[] | null;
  }>({
    queryKey: ["hardening-job-log", hardenExecId],
    queryFn: () => api.get(`/job-executions/${hardenExecId}/log`),
    enabled: hardenExecId !== null && !hardenDone,
    refetchInterval: hardenDone ? false : 2000,
  });

  useEffect(() => {
    if (
      hardenJobLog?.status === "completed" ||
      hardenJobLog?.status === "failed"
    ) {
      setHardenDone(true);
      void refetchOverview();
      void refetchFindings();
      toast({
        title:
          hardenJobLog.status === "completed"
            ? "Hardening Applied"
            : "Hardening Job Failed",
        description:
          hardenJobLog.status === "completed"
            ? "Selected environment security settings updated successfully."
            : "Some hardening actions failed to apply. Check execution log.",
        variant:
          hardenJobLog.status === "completed" ? "default" : "destructive",
      });
    }
  }, [hardenJobLog?.status]);

  // 7. Update Schedule Mutation
  const updateScheduleMutation = useMutation({
    mutationFn: () =>
      api.put(
        `/security/schedules/environments/${selectedEnvId}`,
        scheduleForm,
      ),
    onSuccess: () => {
      toast({ title: "Scan schedule saved" });
      qc.invalidateQueries({
        queryKey: ["security-schedule-env", selectedEnvId],
      });
    },
    onError: () => {
      toast({
        title: "Failed to save schedule",
        description: "Please check schedule inputs and try again.",
        variant: "destructive",
      });
    },
  });

  // 8. Remove Schedule Mutation
  const deleteScheduleMutation = useMutation({
    mutationFn: () =>
      api.delete(`/security/schedules/environments/${selectedEnvId}`),
    onSuccess: () => {
      toast({ title: "Scan schedule removed" });
      setScheduleForm({
        scan_types: [
          "WP_AUDIT",
          "PROJECT_MALWARE",
          "BACKDOOR_SEARCH",
          "PLUGIN_AUDIT",
        ],
        frequency: "daily",
        hour: 2,
        minute: 0,
        enabled: false,
        notify_enabled: false,
        notify_threshold: "high",
      });
      qc.invalidateQueries({
        queryKey: ["security-schedule-env", selectedEnvId],
      });
    },
    onError: () => {
      toast({ title: "Failed to remove schedule", variant: "destructive" });
    },
  });

  // 9. Secure Guard Mutations
  const [secureGuardPreset, setSecureGuardPreset] = useState<
    "beginner" | "balanced" | "maximum" | "custom"
  >("balanced");

  const installSecureGuardMutation = useMutation({
    mutationFn: async () => {
      if (!selectedEnvId) throw new Error("No environment selected");
      return api.post(
        `/projects/${projectId}/environments/${selectedEnvId}/secure-guard/install`,
        { preset: secureGuardPreset, deployWatchdog: true },
      );
    },
    onSuccess: (data: any) => {
      toast({
        title: "Secure Guard Installation Queued",
        description: `Installation job #${data.jobId} is in progress.`,
      });
      qc.invalidateQueries({
        queryKey: ["environment-findings", selectedEnvId],
      });
      qc.invalidateQueries({ queryKey: ["security-scans"] });
    },
    onError: (err: any) => {
      toast({
        title: "Installation Failed",
        description: err.response?.data?.message || err.message,
        variant: "destructive",
      });
    },
  });

  const deployWatchdogMutation = useMutation({
    mutationFn: async () => {
      if (!selectedEnvId) throw new Error("No environment selected");
      return api.post(
        `/projects/${projectId}/environments/${selectedEnvId}/secure-guard/watchdog`,
        {},
      );
    },
    onSuccess: (data: any) => {
      toast({
        title: "Watchdog MU-Plugin Queued",
        description: `Deployment job #${data.jobId} is in progress.`,
      });
      qc.invalidateQueries({
        queryKey: ["environment-findings", selectedEnvId],
      });
    },
    onError: (err: any) => {
      toast({
        title: "Watchdog Deployment Failed",
        description: err.response?.data?.message || err.message,
        variant: "destructive",
      });
    },
  });

  const toggleHardening = (id: string) => {
    setSelectedHardening((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const groupedHardeningActions = Object.entries(HARDENING_ACTION_GROUP_LABELS)
    .map(([group, label]) => ({
      group,
      label,
      actions: ENVIRONMENT_HARDENING_ACTIONS.filter(
        (action) => action.group === group,
      ),
    }))
    .filter((group) => group.actions.length > 0);

  const handleFixFinding = (actionId: string) => {
    if (!confirmRiskyHardeningActions([actionId])) {
      return;
    }

    setSelectedHardening((prev) =>
      prev.includes(actionId) ? prev : [...prev, actionId],
    );
    hardenMutation.mutate([actionId]);
  };

  const [riskyLabels, setRiskyLabels] = useState<string[]>([]);
  const [confirmRiskyOpen, setConfirmRiskyOpen] = useState(false);

  const confirmRiskyHardeningActions = (actions: string[]): boolean => {
    const risky = actions.filter(isRiskyEnvironmentHardeningAction);
    if (risky.length === 0) {
      return true;
    }

    const labels = risky.map(
      (id) =>
        ENVIRONMENT_HARDENING_ACTIONS.find((action) => action.id === id)
          ?.label ?? id,
    );

    setRiskyLabels(labels);
    setConfirmRiskyOpen(true);
    return false; // will complete via dialog callback
  };

  const applySelectedHardening = () => {
    if (confirmRiskyHardeningActions(selectedHardening)) {
      hardenMutation.mutate(selectedHardening);
    }
  };

  const handleRiskyConfirmed = () => {
    setConfirmRiskyOpen(false);
    setRiskyLabels([]);
    hardenMutation.mutate(selectedHardening);
  };

  const handleRiskyCancelled = () => {
    setConfirmRiskyOpen(false);
    setRiskyLabels([]);
  };

  if (environments.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-muted-foreground">
          <Shield className="h-12 w-12 mx-auto opacity-20 mb-3" />
          <p>No environments configured for this project.</p>
        </CardContent>
      </Card>
    );
  }

  const score = envSummary?.score ?? null;
  const scoreColor =
    score === null
      ? "text-muted-foreground border-muted-foreground/30"
      : score >= 80
        ? "text-success border-success/40"
        : score >= 50
          ? "text-warning border-warning/40"
          : "text-destructive border-destructive/40";

  return (
    <>
      <Dialog open={confirmRiskyOpen} onOpenChange={(v) => !v && handleRiskyCancelled()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-warning" />
              Confirm destructive actions
            </DialogTitle>
            <DialogDescription className="space-y-2">
              <p>
                The following actions can modify files or update code on the
                server. Apply them only if you understand the consequences.
              </p>
              <ul className="list-disc pl-4 space-y-1">
                {riskyLabels.map((label) => (
                  <li key={label} className="font-medium text-foreground">
                    {label}
                  </li>
                ))}
              </ul>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={handleRiskyCancelled}>
              Cancel
            </Button>
            <Button
              onClick={handleRiskyConfirmed}
              className="bg-warning text-warning-foreground hover:bg-warning/90"
            >
              Apply anyway
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="space-y-6">
      {/* 1. Header controls */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 bg-muted/30 border p-4 rounded-xl">
        <div className="space-y-1">
          <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Select Environment
          </Label>
          <Select
            value={selectedEnvId ? String(selectedEnvId) : ""}
            onValueChange={(v) => {
              const id = Number(v);
              setSelectedEnvId(id);
              setHardenExecId(null);
              setHardenDone(false);
              setSearchParams((prev) => {
                const next = new URLSearchParams(prev);
                next.set("env", String(id));
                return next;
              });
            }}
          >
            <SelectTrigger className="w-64 bg-background">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {environments.map((e) => (
                <SelectItem key={e.id} value={String(e.id)}>
                  <span className="capitalize font-medium">{e.type}</span>
                  <span className="text-xs text-muted-foreground ml-2">
                    — {e.url}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {activeEnv && (
          <div className="flex flex-wrap items-center gap-2.5 sm:mt-5">
            <Button
              variant="outline"
              onClick={() => scanMutation.mutate()}
              disabled={scanMutation.isPending || isOverviewLoading}
            >
              {scanMutation.isPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4 mr-2" />
              )}
              Scan Now
            </Button>
            <Button
              onClick={applySelectedHardening}
              disabled={
                hardenMutation.isPending || selectedHardening.length === 0
              }
            >
              {hardenMutation.isPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Lock className="h-4 w-4 mr-2" />
              )}
              Apply Hardening
            </Button>
          </div>
        )}
      </div>

      {/* 2. Visual score and details */}
      {activeEnv && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <Card className="md:col-span-2 overflow-hidden border-border/50">
            <CardHeader className="pb-3 bg-muted/10 border-b border-border/30">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Shield className="h-4 w-4 text-primary" />
                Security Posture Assessment
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-6">
              <div className="flex flex-col sm:flex-row items-center gap-6">
                <div
                  className={`w-28 h-28 rounded-full border-[6px] flex flex-col items-center justify-center ${scoreColor} bg-background shadow-inner`}
                >
                  <span className="text-3xl font-extrabold tracking-tight">
                    {score !== null ? score : "—"}
                  </span>
                  <span className="text-[10px] font-bold uppercase tracking-widest opacity-80 mt-[-2px]">
                    SCORE
                  </span>
                </div>

                <div className="flex-1 space-y-3 text-center sm:text-left">
                  <div>
                    <h4 className="text-base font-bold capitalize">
                      {activeEnv.type} Environment Security
                    </h4>
                    <p className="text-xs text-muted-foreground mt-0.5 font-mono">
                      Target server: {activeEnv.server.name} (
                      {activeEnv.server.ip_address})
                    </p>
                  </div>

                  <div className="flex flex-wrap justify-center sm:justify-start gap-1.5">
                    {envSummary?.findings_summary && (
                      <>
                        {envSummary.findings_summary.critical > 0 && (
                          <Badge
                            variant="destructive"
                            className="font-semibold text-xs"
                          >
                            {envSummary.findings_summary.critical} Critical
                          </Badge>
                        )}
                        {envSummary.findings_summary.high > 0 && (
                          <Badge
                            variant="destructive"
                            className="font-semibold text-xs opacity-90"
                          >
                            {envSummary.findings_summary.high} High
                          </Badge>
                        )}
                        {envSummary.findings_summary.medium > 0 && (
                          <Badge className="bg-warning text-warning-foreground font-semibold text-xs">
                            {envSummary.findings_summary.medium} Medium
                          </Badge>
                        )}
                        {envSummary.findings_summary.low > 0 && (
                          <Badge className="bg-info text-info-foreground font-medium text-xs">
                            {envSummary.findings_summary.low} Low
                          </Badge>
                        )}
                        {envSummary.findings_summary.critical === 0 &&
                          envSummary.findings_summary.high === 0 &&
                          envSummary.findings_summary.medium === 0 &&
                          envSummary.findings_summary.low === 0 && (
                            <Badge className="bg-success text-success-foreground font-semibold text-xs">
                              No Vulnerabilities Found
                            </Badge>
                          )}
                      </>
                    )}
                  </div>

                  {envSummary?.last_scanned_at && (
                    <p className="text-xs text-muted-foreground flex items-center gap-1 justify-center sm:justify-start">
                      <Clock className="h-3.5 w-3.5" />
                      Last completed audit:{" "}
                      {new Date(envSummary.last_scanned_at).toLocaleString()}
                    </p>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Secure Guard Official Plugin Card */}
          <Card className="border-border/50 bg-gradient-to-br from-background to-muted/20 flex flex-col justify-between">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-xs font-bold uppercase tracking-widest text-primary flex items-center gap-1.5">
                  <ShieldCheck className="h-4 w-4" />
                  Secure Guard Integration
                </CardTitle>
                <a
                  href="https://github.com/garamahq/wp-secure-guard"
                  target="_blank"
                  rel="noreferrer"
                  className="text-[11px] text-muted-foreground hover:text-foreground flex items-center gap-1"
                >
                  garamahq/wp-secure-guard
                  <ExternalLink className="h-3 w-3" />
                </a>
              </div>
              <CardDescription className="text-xs">
                Official default security plugin for Bedrock Forge environments
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 pt-1 text-xs">
              <div className="rounded-lg bg-muted/40 p-3 border border-border/40 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Plugin Status:</span>
                  {findingsRes?.data.some(
                    (f: FindingRow) =>
                      f.category === "SECURE_GUARD" &&
                      f.title.toLowerCase().includes("not active"),
                  ) ? (
                    <Badge variant="warning" className="text-[10px]">
                      Not Active
                    </Badge>
                  ) : (
                    <Badge variant="success" className="text-[10px]">
                      Active & Protected
                    </Badge>
                  )}
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Watchdog MU-Plugin:</span>
                  {findingsRes?.data.some(
                    (f: FindingRow) =>
                      f.category === "SECURE_GUARD" &&
                      f.title.toLowerCase().includes("watchdog"),
                  ) ? (
                    <Badge variant="secondary" className="text-[10px]">
                      Not Deployed
                    </Badge>
                  ) : (
                    <Badge variant="success" className="text-[10px]">
                      Deployed & Enforcing
                    </Badge>
                  )}
                </div>
              </div>

              {/* Actions & Preset */}
              <div className="space-y-2 pt-1">
                <div className="flex items-center gap-2">
                  <Label className="text-[11px] shrink-0 text-muted-foreground">
                    Preset:
                  </Label>
                  <Select
                    value={secureGuardPreset}
                    onValueChange={(val: any) => setSecureGuardPreset(val)}
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="beginner">Beginner (Permissive)</SelectItem>
                      <SelectItem value="balanced">
                        Balanced (Recommended)
                      </SelectItem>
                      <SelectItem value="maximum">Maximum (Strict JWT)</SelectItem>
                      <SelectItem value="custom">Custom</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex flex-wrap gap-2 pt-1">
                  <Button
                    size="sm"
                    className="h-8 text-xs flex-1 gap-1.5"
                    onClick={() => installSecureGuardMutation.mutate()}
                    disabled={installSecureGuardMutation.isPending}
                  >
                    {installSecureGuardMutation.isPending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Shield className="h-3.5 w-3.5" />
                    )}
                    Install / Update Plugin
                  </Button>

                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs gap-1.5"
                    onClick={() => deployWatchdogMutation.mutate()}
                    disabled={deployWatchdogMutation.isPending}
                  >
                    {deployWatchdogMutation.isPending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <ShieldCheck className="h-3.5 w-3.5" />
                    )}
                    Deploy Watchdog
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* 3. Hardening actions checklist & live job executor logs */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="border-border/50 shadow-sm">
          <CardHeader>
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Lock className="h-4 w-4 text-primary" />
              Environment Hardening Actions
            </CardTitle>
            <CardDescription className="text-xs">
              Select environment and web-root protections to deploy. Destructive
              cleanup and update actions are opt-in.
            </CardDescription>
          </CardHeader>
          <CardContent className="max-h-[520px] space-y-4 overflow-y-auto pr-1">
            <div className="grid grid-cols-1 gap-2">
              {HARDENING_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  disabled={hardenMutation.isPending}
                  className="rounded-lg border border-border/50 bg-muted/20 p-2.5 text-left transition hover:bg-muted/50 disabled:opacity-60"
                  onClick={() => setSelectedHardening([...preset.actions])}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold">
                      {preset.label}
                    </span>
                    <Badge variant="outline" className="text-[10px]">
                      {preset.actions.length} actions
                    </Badge>
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {preset.description}
                  </p>
                </button>
              ))}
            </div>

            {groupedHardeningActions.map((group) => (
              <div key={group.group} className="space-y-2">
                <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                  {group.label}
                </p>
                {group.actions.map((action) => (
                  <label
                    key={action.id}
                    className="flex cursor-pointer items-start gap-3 rounded-lg border border-border/40 p-2.5 transition-colors hover:bg-muted/40"
                  >
                    <input
                      type="checkbox"
                      checked={selectedHardening.includes(action.id)}
                      onChange={() => toggleHardening(action.id)}
                      disabled={hardenMutation.isPending}
                      className="mt-1 h-3.5 w-3.5 rounded accent-primary"
                    />
                    <div className="space-y-0.5">
                      <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                        <span>{action.label}</span>
                        <Badge
                          variant={
                            action.risk === "risky"
                              ? "destructive"
                              : action.risk === "review"
                                ? "warning"
                                : "success"
                          }
                          className="h-4 px-1.5 text-[10px]"
                        >
                          {action.risk === "risky"
                            ? "Opt-in"
                            : action.risk === "review"
                              ? "Review"
                              : "Safe"}
                        </Badge>
                      </span>
                      <span className="block text-[11px] leading-normal text-muted-foreground">
                        {action.description}
                      </span>
                      <span className="block text-[11px] leading-normal text-muted-foreground/80">
                        {action.preview}
                      </span>
                    </div>
                  </label>
                ))}
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Live Hardening Logs / Job execution state */}
        <Card className="border-border/50 shadow-sm flex flex-col">
          <CardHeader>
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Terminal className="h-4 w-4 text-primary" />
              Hardening Executor Log
            </CardTitle>
            <CardDescription className="text-xs">
              Monitor remote server execution details and command results in
              real time.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex-1 flex flex-col min-h-[300px]">
            {!hardenExecId ? (
              <div className="flex-1 flex flex-col items-center justify-center border-2 border-dashed rounded-lg p-6 text-center text-muted-foreground">
                <Terminal className="h-8 w-8 opacity-25 mb-2" />
                <p className="text-xs font-medium">
                  No active hardening execution running.
                </p>
                <p className="text-[11px] opacity-75 mt-0.5">
                  Select hardening actions and click &quot;Apply Hardening&quot;
                  to begin.
                </p>
              </div>
            ) : (
              <div className="flex-1 flex flex-col space-y-4">
                <div className="flex items-center justify-between border bg-muted/40 px-3 py-2 rounded-lg text-xs">
                  <div className="flex items-center gap-2">
                    {!hardenDone ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                    ) : hardenJobLog?.status === "completed" ? (
                      <ShieldCheck className="h-4 w-4 text-success" />
                    ) : (
                      <ShieldAlert className="h-4 w-4 text-destructive" />
                    )}
                    <span className="font-semibold capitalize">
                      Status: {hardenJobLog?.status ?? "Queued"}
                    </span>
                  </div>
                  <span className="text-muted-foreground font-mono text-[10px]">
                    Job ID: #{hardenExecId}
                  </span>
                </div>

                {hardenDone && hardenJobLog?.status === "completed" && (
                  <div className="rounded-lg border border-success/30 bg-success/10 p-3 text-xs">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <p className="font-semibold text-success">
                          Hardening finished. Verify the result next.
                        </p>
                        <p className="mt-0.5 text-muted-foreground">
                          Run a fresh security scan to confirm exposed paths,
                          XML-RPC, logs, and sensitive files are now blocked.
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 shrink-0"
                        onClick={() => scanMutation.mutate()}
                        disabled={scanMutation.isPending}
                      >
                        {scanMutation.isPending ? (
                          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                        )}
                        Verify with scan
                      </Button>
                    </div>
                  </div>
                )}

                <div className="flex-1 bg-black text-green-400 font-mono text-xs p-3 rounded-lg overflow-y-auto max-h-[320px] space-y-2.5 border">
                  {hardenJobLog?.execution_log &&
                  hardenJobLog.execution_log.length > 0 ? (
                    hardenJobLog.execution_log.map((log, index) => {
                      const statusColor =
                        log.hardenStatus === "applied"
                          ? "text-success font-semibold"
                          : log.hardenStatus === "failed"
                            ? "text-destructive font-semibold"
                            : "text-muted-foreground";
                      return (
                        <div
                          key={index}
                          className="border-b border-zinc-800/80 pb-2 last:border-b-0"
                        >
                          <div className="flex justify-between items-center text-[10px] text-zinc-500 mb-0.5">
                            <span>{log.step.replace(/_/g, " ")}</span>
                            <span className={statusColor}>
                              {(log.hardenStatus ?? "info").toUpperCase()}
                            </span>
                          </div>
                          <p className="text-[11px] text-zinc-300 break-words leading-relaxed">
                            {log.detail}
                          </p>
                        </div>
                      );
                    })
                  ) : (
                    <div className="text-center text-zinc-500 py-12">
                      <Loader2 className="h-4 w-4 animate-spin mx-auto mb-2" />
                      Establishing SSH tunnel and resolving site layout...
                    </div>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* 4. Active Findings from the last scan */}
      {selectedEnvId && (
        <Card className="border-border/50 shadow-sm">
          <CardHeader className="pb-3 border-b border-border/30">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-primary" />
              Open Security Findings
            </CardTitle>
            <CardDescription className="text-xs">
              Vulnerabilities detected during the last automated
              server/environment audit.
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-4 space-y-3">
            {isFindingsFetching ? (
              <div className="py-12 text-center text-muted-foreground">
                <Loader2 className="h-6 w-6 animate-spin mx-auto mb-2 text-primary" />
                <p className="text-xs">Loading environment findings...</p>
              </div>
            ) : !findingsRes || findingsRes.data.length === 0 ? (
              <div className="py-12 text-center text-muted-foreground space-y-1">
                <ShieldCheck className="h-10 w-10 text-success mx-auto opacity-40 mb-1" />
                <p className="text-xs font-semibold text-foreground">
                  Clean Health Check
                </p>
                <p className="text-[11px] opacity-75">
                  No vulnerabilities or configuration weaknesses detected.
                </p>
              </div>
            ) : (
              <div className="space-y-2 max-h-[400px] overflow-y-auto pr-1">
                {findingsRes.data.map((row) => (
                  <FindingItem
                    key={`${row.scan_id}-${row.finding_id}`}
                    finding={{
                      id: row.finding_id,
                      severity: row.severity,
                      category: row.category,
                      title: row.title,
                      description: row.description,
                      remediation: row.remediation,
                      resource: row.resource,
                      metadata: row.metadata,
                    }}
                    row={row}
                    targetType="environment"
                    onFix={handleFixFinding}
                    onAck={(r) => setAckDialog(r)}
                  />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* 5. Scan schedule configuration */}
      {selectedEnvId && (
        <Card className="border-border/50 shadow-sm">
          <CardHeader>
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Clock className="h-4 w-4 text-primary" />
              Scan Schedule Settings
            </CardTitle>
            <CardDescription className="text-xs">
              Automate routine audits to capture configuration drift, malware
              uploads, or backdoor insertions.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {isScheduleLoading ? (
              <div className="py-6 text-center text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin mx-auto text-primary" />
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <Label
                      htmlFor="sched-enabled"
                      className="text-xs font-semibold text-foreground cursor-pointer"
                    >
                      Enable Automated Scans
                    </Label>
                    <Switch
                      id="sched-enabled"
                      checked={scheduleForm.enabled}
                      onCheckedChange={(v) =>
                        setScheduleForm((f) => ({ ...f, enabled: v }))
                      }
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <Label className="text-xs font-medium text-muted-foreground">
                        Frequency
                      </Label>
                      <Select
                        value={scheduleForm.frequency}
                        disabled={!scheduleForm.enabled}
                        onValueChange={(v) =>
                          setScheduleForm((f) => ({
                            ...f,
                            frequency: v as SecuritySchedule["frequency"],
                          }))
                        }
                      >
                        <SelectTrigger className="h-9 bg-background text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="daily">Daily</SelectItem>
                          <SelectItem value="weekly">Weekly</SelectItem>
                          <SelectItem value="monthly">Monthly</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-1.5">
                      <Label className="text-xs font-medium text-muted-foreground">
                        Hour (UTC)
                      </Label>
                      <Input
                        type="number"
                        min={0}
                        max={23}
                        value={scheduleForm.hour}
                        disabled={!scheduleForm.enabled}
                        onChange={(e) =>
                          setScheduleForm((f) => ({
                            ...f,
                            hour: Math.min(
                              23,
                              Math.max(0, Number(e.target.value)),
                            ),
                          }))
                        }
                        className="h-9 bg-background text-xs font-mono"
                      />
                    </div>
                  </div>

                  <div className="flex items-center justify-between border-t pt-3.5">
                    <Label
                      htmlFor="sched-notify"
                      className="text-xs font-semibold text-foreground cursor-pointer"
                    >
                      Send Alerts on Findings
                    </Label>
                    <Switch
                      id="sched-notify"
                      disabled={!scheduleForm.enabled}
                      checked={scheduleForm.notify_enabled}
                      onCheckedChange={(v) =>
                        setScheduleForm((f) => ({ ...f, notify_enabled: v }))
                      }
                    />
                  </div>

                  {scheduleForm.notify_enabled && (
                    <div className="space-y-1.5 animate-fadeIn">
                      <Label className="text-xs font-medium text-muted-foreground">
                        Notification Threshold
                      </Label>
                      <Select
                        value={scheduleForm.notify_threshold}
                        disabled={!scheduleForm.enabled}
                        onValueChange={(v) =>
                          setScheduleForm((f) => ({
                            ...f,
                            notify_threshold: v,
                          }))
                        }
                      >
                        <SelectTrigger className="h-9 bg-background text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {["critical", "high", "medium", "low", "info"].map(
                            (t) => (
                              <SelectItem key={t} value={t}>
                                {t.toUpperCase()} and above
                              </SelectItem>
                            ),
                          )}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </div>

                <div className="space-y-4 flex flex-col justify-between border-t md:border-t-0 md:border-l md:pl-6 pt-4 md:pt-0">
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium text-muted-foreground">
                      Scan Types Included
                    </Label>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      {[
                        "WP_AUDIT",
                        "PROJECT_MALWARE",
                        "BACKDOOR_SEARCH",
                        "PLUGIN_AUDIT",
                      ].map((type) => {
                        const label =
                          type === "WP_AUDIT"
                            ? "WP Config & Core"
                            : type === "PROJECT_MALWARE"
                              ? "Malware Signature"
                              : type === "BACKDOOR_SEARCH"
                                ? "PHP Backdoor Check"
                                : "Plugin Vulnerabilities";
                        return (
                          <label
                            key={type}
                            className="flex items-center gap-2 cursor-pointer p-1.5 rounded border border-border/30 bg-muted/10"
                          >
                            <input
                              type="checkbox"
                              checked={scheduleForm.scan_types.includes(type)}
                              disabled={!scheduleForm.enabled}
                              onChange={() =>
                                setScheduleForm((f) => ({
                                  ...f,
                                  scan_types: f.scan_types.includes(type)
                                    ? f.scan_types.filter((x) => x !== type)
                                    : [...f.scan_types, type],
                                }))
                              }
                              className="rounded accent-primary"
                            />
                            <span className="text-[11px] truncate">
                              {label}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </div>

                  <div className="flex justify-end gap-2 border-t pt-4">
                    {scheduleData && (
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        disabled={deleteScheduleMutation.isPending}
                        onClick={() => deleteScheduleMutation.mutate()}
                      >
                        Delete Schedule
                      </Button>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      disabled={
                        updateScheduleMutation.isPending ||
                        scheduleForm.scan_types.length === 0
                      }
                      onClick={() => updateScheduleMutation.mutate()}
                    >
                      {updateScheduleMutation.isPending
                        ? "Saving..."
                        : "Save Schedule"}
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Acknowledge findings dialog */}
      {ackDialog && (
        <AcknowledgeFindingDialog
          open={ackDialog !== null}
          onClose={() => {
            setAckDialog(null);
            void refetchFindings();
          }}
          finding={ackDialog}
        />
      )}
    </div>
    </>
  );
}
