import React, { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, RefreshCw, Loader2, Trash2, Plus, AlertTriangle } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { ApiError, api } from "@/lib/api-client";
import { toast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import type {
  HardeningResult,
  SecuritySchedule,
  ServerSecurityAlertSetting,
} from "./types";
import {
  DEFAULT_ENVIRONMENT_HARDENING_ACTION_IDS,
  HARDENING_ACTION_GROUP_LABELS,
  HARDENING_PRESETS,
  SERVER_HARDENING_ACTIONS,
  ENVIRONMENT_HARDENING_ACTIONS,
  SCAN_TYPES_BY_KIND,
  SCAN_TYPE_DESCRIPTIONS,
  SCAN_TYPE_LABELS,
  isRiskyEnvironmentHardeningAction,
} from "./constants";
import { hardeningRiskLabel } from "./utils";

// ─── HardenDialog ─────────────────────────────────────────────────────────────

export function HardenDialog({
  open,
  onClose,
  targetType,
  targetId,
  targetName,
  initialActions,
}: {
  open: boolean;
  onClose: () => void;
  targetType: "server" | "environment";
  targetId: number;
  targetName: string;
  initialActions?: string[];
}) {
  const allActions =
    targetType === "server"
      ? SERVER_HARDENING_ACTIONS
      : ENVIRONMENT_HARDENING_ACTIONS;
  const defaultActions =
    targetType === "server"
      ? allActions.map((a) => a.id)
      : DEFAULT_ENVIRONMENT_HARDENING_ACTION_IDS;
  const [selected, setSelected] = useState<string[]>(
    initialActions ?? defaultActions,
  );
  const [execId, setExecId] = useState<number | null>(null);
  const [done, setDone] = useState(false);

  const toggle = (id: string) =>
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );

  const groupedActions =
    targetType === "environment"
      ? Object.entries(HARDENING_ACTION_GROUP_LABELS)
          .map(([group, label]) => ({
            group,
            label,
            actions: ENVIRONMENT_HARDENING_ACTIONS.filter(
              (action) => action.group === group,
            ),
          }))
          .filter((group) => group.actions.length > 0)
      : [{ group: "server", label: "Server protections", actions: allActions }];

  const mutation = useMutation({
    mutationFn: (actions: string[]) => {
      const url =
        targetType === "server"
          ? `/security/servers/${targetId}/harden`
          : `/security/environments/${targetId}/harden`;
      return api.post<{ jobExecutionId: number }>(url, { actions });
    },
    onSuccess: (res) => {
      setExecId(res.jobExecutionId);
    },
    onError: () => {
      toast({ title: "Failed to queue hardening job", variant: "destructive" });
    },
  });

  const { data: jobLog } = useQuery<{
    id: number;
    status: string;
    execution_log: HardeningResult[] | null;
  }>({
    queryKey: ["hardening-job", execId],
    queryFn: () => api.get(`/job-executions/${execId}/log`),
    enabled: execId !== null && !done,
    refetchInterval: done ? false : 2_000,
  });

  useEffect(() => {
    if (jobLog?.status === "completed" || jobLog?.status === "failed") {
      setDone(true);
    }
  }, [jobLog?.status]);

  const results =
    jobLog?.status === "completed" || jobLog?.status === "failed"
      ? (jobLog.execution_log ?? [])
      : null;

  const statusColor = (s: string) => {
    if (s === "applied") return "bg-success/10 text-success";
    if (s === "skipped") return "bg-muted text-muted-foreground";
    return "bg-destructive/10 text-destructive";
  };

  const handleClose = () => {
    setExecId(null);
    setDone(false);
    setSelected(initialActions ?? defaultActions);
    mutation.reset();
    onClose();
  };

  const [riskyActionLabels, setRiskyActionLabels] = useState<string[]>([]);
  const [pendingConfirm, setPendingConfirm] = useState(false);

  const confirmRiskyActions = (): boolean => {
    if (targetType !== "environment") {
      return true;
    }

    const risky = selected.filter(isRiskyEnvironmentHardeningAction);
    if (risky.length === 0) {
      return true;
    }

    const labels = risky.map(
      (id) =>
        ENVIRONMENT_HARDENING_ACTIONS.find((action) => action.id === id)
          ?.label ?? id,
    );

    setRiskyActionLabels(labels);
    setPendingConfirm(true);
    return false; // will be triggered via dialog callback
  };

  const queueHardening = () => {
    if (confirmRiskyActions()) {
      mutation.mutate(selected);
    }
  };

  const handleRiskyConfirmed = () => {
    setPendingConfirm(false);
    setRiskyActionLabels([]);
    mutation.mutate(selected);
  };

  const handleRiskyCancelled = () => {
    setPendingConfirm(false);
    setRiskyActionLabels([]);
  };

  return (
    <>
      <Dialog open={pendingConfirm} onOpenChange={(v) => !v && handleRiskyCancelled()}>
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
                {riskyActionLabels.map((label) => (
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
      <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Harden — {targetName}</DialogTitle>
        </DialogHeader>

        {!execId && (
          <>
            <div className="space-y-3 py-2">
              {targetType === "environment" && (
                <div className="grid grid-cols-1 gap-2">
                  {HARDENING_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      className="rounded-md border bg-muted/20 p-2 text-left transition hover:bg-muted/50"
                      onClick={() => setSelected([...preset.actions])}
                    >
                      <p className="text-xs font-semibold">{preset.label}</p>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        {preset.description}
                      </p>
                    </button>
                  ))}
                </div>
              )}

              {groupedActions.map((group) => (
                <div key={group.group} className="space-y-2">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                    {group.label}
                  </p>
                  {group.actions.map((a) => (
                    <label
                      key={a.id}
                      className="flex cursor-pointer items-start gap-3 rounded-md border p-2.5 transition hover:bg-muted/40"
                    >
                      <input
                        type="checkbox"
                        checked={selected.includes(a.id)}
                        onChange={() => toggle(a.id)}
                        className="mt-1 rounded"
                      />
                      <div className="min-w-0">
                        <p className="flex items-center gap-1.5 text-sm font-medium">
                          <span>{a.label}</span>
                          {"risk" in a ? (
                            <Badge
                              variant={
                                a.risk === "risky"
                                  ? "destructive"
                                  : a.risk === "review"
                                    ? "warning"
                                    : "success"
                              }
                              className="h-4 px-1.5 text-[10px]"
                            >
                              {hardeningRiskLabel(a.risk)}
                            </Badge>
                          ) : null}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {a.description}
                        </p>
                        {"preview" in a && (
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            {a.preview}
                          </p>
                        )}
                      </div>
                    </label>
                  ))}
                </div>
              ))}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={handleClose}>
                Cancel
              </Button>
              <Button
                onClick={queueHardening}
                disabled={selected.length === 0 || mutation.isPending}
              >
                {mutation.isPending ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                    Queuing…
                  </>
                ) : (
                  "Apply"
                )}
              </Button>
            </DialogFooter>
          </>
        )}

        {execId && (
          <div className="py-2 space-y-3">
            {!done && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Running hardening actions…
              </div>
            )}
            {done &&
              results &&
              results.length > 0 &&
              (() => {
                const applied = results.filter(
                  (r) => r.hardenStatus === "applied",
                ).length;
                const skipped = results.filter(
                  (r) => r.hardenStatus === "skipped",
                ).length;
                const failed = results.filter(
                  (r) => r.hardenStatus === "failed",
                ).length;
                return (
                  <p className="text-xs text-muted-foreground">
                    {applied > 0 && (
                      <span className="text-success font-medium">
                        {applied} applied
                      </span>
                    )}
                    {applied > 0 && (skipped > 0 || failed > 0) && " · "}
                    {skipped > 0 && <span>{skipped} skipped</span>}
                    {skipped > 0 && failed > 0 && " · "}
                    {failed > 0 && (
                      <span className="text-destructive font-medium">
                        {failed} failed
                      </span>
                    )}
                  </p>
                );
              })()}
            {results && results.length > 0 && (
              <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                {results.map((r, i) => (
                  <div
                    key={i}
                    className="flex items-start gap-2 text-xs border rounded p-2"
                  >
                    <span
                      className={`shrink-0 px-1.5 py-0.5 rounded text-xs font-medium ${statusColor(r.hardenStatus ?? "info")}`}
                    >
                      {r.hardenStatus ?? r.level}
                    </span>
                    <div className="min-w-0">
                      <p className="font-medium">
                        {(r.step ?? "").replace(/_/g, " ")}
                      </p>
                      <p className="text-muted-foreground break-words">
                        {r.detail}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {done && results?.length === 0 && (
              <p className="text-sm text-muted-foreground">
                {jobLog?.status === "failed"
                  ? "Hardening job failed. Check job execution logs for details."
                  : "No results returned."}
              </p>
            )}
            {done && (
              <DialogFooter>
                <Button onClick={handleClose}>Close</Button>
              </DialogFooter>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
    </>
  );
}

// ─── ScanDialog ───────────────────────────────────────────────────────────────

export function ScanDialog({
  open,
  onClose,
  targetType,
  targetId,
  targetName,
}: {
  open: boolean;
  onClose: () => void;
  targetType: "server" | "environment";
  targetId: number;
  targetName: string;
}) {
  const queryClient = useQueryClient();
  const allTypes = SCAN_TYPES_BY_KIND[targetType];
  const [selected, setSelected] = useState<string[]>([...allTypes]);

  useEffect(() => {
    if (open) {
      setSelected([...allTypes]);
    }
  }, [open, targetType]);

  const mutation = useMutation({
    mutationFn: (types: string[]) => {
      const url =
        targetType === "server"
          ? `/security/servers/${targetId}/scan`
          : `/security/environments/${targetId}/scan`;
      return api.post(url, { types });
    },
    onSuccess: () => {
      toast({
        title: "Scan queued",
        description: `Security scan started for ${targetName}`,
      });
      queryClient.invalidateQueries({ queryKey: ["security"] });
      onClose();
    },
    onError: (err: Error) => {
      toast({
        title: "Failed to queue scan",
        description:
          err instanceof ApiError
            ? err.message
            : "The scan could not be queued. Check the selected scan types.",
        variant: "destructive",
      });
    },
  });

  const toggle = (t: string) =>
    setSelected((prev) =>
      prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t],
    );

  const selectAll = () => setSelected([...allTypes]);
  const clearAll = () => setSelected([]);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Run Security Scan</DialogTitle>
        </DialogHeader>
        <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm flex items-center justify-between">
          <div className="min-w-0 flex-1 mr-2">
            <p className="font-medium truncate">{targetName}</p>
            <p className="text-xs text-muted-foreground">
              {targetType === "server"
                ? "Host, network, process, and system audit suites"
                : "WordPress core, malware, backdoor, and plugin audit suites"}
            </p>
          </div>
          <div className="flex gap-1.5 shrink-0">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={selectAll}
            >
              Select all
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={clearAll}
            >
              Clear
            </Button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto pr-1 grid gap-2 py-2 max-h-[45vh]">
          {allTypes.map((t) => (
            <label
              key={t}
              className={`flex items-start gap-3 cursor-pointer rounded-md border p-3 transition-colors ${
                selected.includes(t)
                  ? "border-primary/40 bg-primary/5"
                  : "hover:bg-muted/40"
              }`}
            >
              <input
                type="checkbox"
                checked={selected.includes(t)}
                onChange={() => toggle(t)}
                className="rounded mt-0.5"
              />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">
                  {SCAN_TYPE_LABELS[t] ?? t.replace(/_/g, " ")}
                </span>
                <span className="block text-xs text-muted-foreground mt-0.5">
                  {SCAN_TYPE_DESCRIPTIONS[t] ?? "Run this security check."}
                </span>
              </span>
            </label>
          ))}
        </div>
        {selected.length === 0 && (
          <div className="flex items-center gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            Select at least one scan type to proceed.
          </div>
        )}
        <DialogFooter className="pt-2 border-t mt-auto">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => mutation.mutate(selected)}
            disabled={selected.length === 0 || mutation.isPending}
          >
            {mutation.isPending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                Queuing…
              </>
            ) : (
              `Start Scan (${selected.length})`
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── ScheduleDialog ───────────────────────────────────────────────────────────

export function ScheduleDialog({
  open,
  onClose,
  targetType,
  targetId,
  targetName,
}: {
  open: boolean;
  onClose: () => void;
  targetType: "server" | "environment";
  targetId: number;
  targetName: string;
}) {
  const queryClient = useQueryClient();
  const plural = targetType === "server" ? "servers" : "environments";
  const scheduleKey = ["security", "schedule", targetType, targetId];

  const { data: existing, isLoading } = useQuery<SecuritySchedule | null>({
    queryKey: scheduleKey,
    queryFn: async () => {
      try {
        return await api.get<SecuritySchedule>(
          `/security/schedules/${plural}/${targetId}`,
        );
      } catch {
        return null;
      }
    },
    enabled: open,
  });

  const allTypes = SCAN_TYPES_BY_KIND[targetType];

  const [form, setForm] = useState<SecuritySchedule>({
    scan_types: [...allTypes],
    frequency: "daily",
    hour: 2,
    minute: 0,
    enabled: true,
    notify_enabled: false,
    notify_threshold: "high",
  });

  const [synced, setSynced] = useState(false);
  if (existing && !synced && !isLoading) {
    setForm(existing);
    setSynced(true);
  }
  if (!open && synced) setSynced(false);

  const upsert = useMutation({
    mutationFn: () =>
      api.put(`/security/schedules/${plural}/${targetId}`, form),
    onSuccess: () => {
      toast({ title: "Schedule saved" });
      queryClient.invalidateQueries({ queryKey: ["security", "schedule"] });
      onClose();
    },
    onError: () =>
      toast({ title: "Failed to save schedule", variant: "destructive" }),
  });

  const remove = useMutation({
    mutationFn: () => api.delete(`/security/schedules/${plural}/${targetId}`),
    onSuccess: () => {
      toast({ title: "Schedule removed" });
      queryClient.invalidateQueries({ queryKey: ["security", "schedule"] });
      onClose();
    },
    onError: () =>
      toast({ title: "Failed to remove schedule", variant: "destructive" }),
  });

  const toggleType = (t: string) =>
    setForm((f) => ({
      ...f,
      scan_types: f.scan_types.includes(t)
        ? f.scan_types.filter((x) => x !== t)
        : [...f.scan_types, t],
    }));

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {existing ? "Edit" : "Create"} Schedule — {targetName}
          </DialogTitle>
        </DialogHeader>
        {isLoading ? (
          <div className="flex justify-center py-8">
            <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Scan types</Label>
              <div className="flex flex-wrap gap-3">
                {allTypes.map((t) => (
                  <label
                    key={t}
                    className="flex items-center gap-2 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={form.scan_types.includes(t)}
                      onChange={() => toggleType(t)}
                      className="rounded"
                    />
                    <span className="text-sm">
                      {SCAN_TYPE_LABELS[t] ?? t.replace(/_/g, " ")}
                    </span>
                  </label>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Frequency</Label>
                <Select
                  value={form.frequency}
                  onValueChange={(v) =>
                    setForm((f) => ({
                      ...f,
                      frequency: v as SecuritySchedule["frequency"],
                    }))
                  }
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="daily">Daily</SelectItem>
                    <SelectItem value="weekly">Weekly</SelectItem>
                    <SelectItem value="monthly">Monthly</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Time (UTC)</Label>
                <div className="flex gap-1">
                  <Input
                    type="number"
                    min={0}
                    max={23}
                    value={form.hour}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, hour: Number(e.target.value) }))
                    }
                    className="h-8 text-xs w-16"
                    placeholder="HH"
                  />
                  <span className="flex items-center text-muted-foreground px-0.5">
                    :
                  </span>
                  <Input
                    type="number"
                    min={0}
                    max={59}
                    step={5}
                    value={form.minute}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, minute: Number(e.target.value) }))
                    }
                    className="h-8 text-xs w-16"
                    placeholder="MM"
                  />
                </div>
              </div>
            </div>

            {form.frequency === "weekly" && (
              <div className="space-y-1">
                <Label className="text-xs">Day of week</Label>
                <Select
                  value={String(form.day_of_week ?? 1)}
                  onValueChange={(v) =>
                    setForm((f) => ({ ...f, day_of_week: Number(v) }))
                  }
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(
                      (d, i) => (
                        <SelectItem key={i} value={String(i)}>
                          {d}
                        </SelectItem>
                      ),
                    )}
                  </SelectContent>
                </Select>
              </div>
            )}

            {form.frequency === "monthly" && (
              <div className="space-y-1">
                <Label className="text-xs">Day of month</Label>
                <Input
                  type="number"
                  min={1}
                  max={28}
                  value={form.day_of_month ?? 1}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      day_of_month: Number(e.target.value),
                    }))
                  }
                  className="h-8 text-xs w-20"
                />
              </div>
            )}

            <div className="flex items-center justify-between">
              <Label className="text-sm">Enabled</Label>
              <Switch
                checked={form.enabled}
                onCheckedChange={(v) => setForm((f) => ({ ...f, enabled: v }))}
              />
            </div>
            <div className="flex items-center justify-between">
              <Label className="text-sm">Notify on findings</Label>
              <Switch
                checked={form.notify_enabled}
                onCheckedChange={(v) =>
                  setForm((f) => ({ ...f, notify_enabled: v }))
                }
              />
            </div>
            {form.notify_enabled && (
              <div className="space-y-1">
                <Label className="text-xs">Notify threshold</Label>
                <Select
                  value={form.notify_threshold}
                  onValueChange={(v) =>
                    setForm((f) => ({ ...f, notify_threshold: v }))
                  }
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {["critical", "high", "medium", "low", "info"].map((t) => (
                      <SelectItem key={t} value={t}>
                        {t.charAt(0).toUpperCase() + t.slice(1)} and above
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
        )}
        <DialogFooter className="flex justify-between">
          <div>
            {existing && (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => remove.mutate()}
                disabled={remove.isPending}
              >
                <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                Remove
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              onClick={() => upsert.mutate()}
              disabled={
                form.scan_types.length === 0 || upsert.isPending || isLoading
              }
            >
              {upsert.isPending ? "Saving…" : "Save Schedule"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── ServerAlertDialog ───────────────────────────────────────────────────────

export function ServerAlertDialog({
  open,
  onClose,
  serverId,
  serverName,
}: {
  open: boolean;
  onClose: () => void;
  serverId: number;
  serverName: string;
}) {
  const queryClient = useQueryClient();
  const queryKey = ["security", "server-alerts", serverId];
  const { data: existing, isLoading } =
    useQuery<ServerSecurityAlertSetting | null>({
      queryKey,
      queryFn: () =>
        api.get<ServerSecurityAlertSetting>(
          `/security/server-alerts/${serverId}`,
        ),
      enabled: open,
    });

  const [form, setForm] = useState<ServerSecurityAlertSetting>({
    server_id: serverId,
    enabled: false,
    ssh_login_alerts_enabled: true,
    file_change_alerts_enabled: true,
    interval_minutes: 5,
    file_watch_paths: [],
  });
  const [pathsText, setPathsText] = useState("");
  const [synced, setSynced] = useState(false);

  if (existing && !synced && !isLoading) {
    setForm(existing);
    setPathsText(existing.file_watch_paths.join("\n"));
    setSynced(true);
  }
  if (!open && synced) setSynced(false);

  const save = useMutation({
    mutationFn: () =>
      api.put(`/security/server-alerts/${serverId}`, {
        enabled: form.enabled,
        ssh_login_alerts_enabled: form.ssh_login_alerts_enabled,
        file_change_alerts_enabled: form.file_change_alerts_enabled,
        interval_minutes: form.interval_minutes,
        file_watch_paths: pathsText
          .split("\n")
          .map((path) => path.trim())
          .filter(Boolean),
      }),
    onSuccess: () => {
      toast({ title: "Security alerts saved" });
      queryClient.invalidateQueries({
        queryKey: ["security", "server-alerts"],
      });
      onClose();
    },
    onError: () =>
      toast({
        title: "Failed to save security alerts",
        variant: "destructive",
      }),
  });

  const test = useMutation({
    mutationFn: () => api.post(`/security/server-alerts/${serverId}/test`, {}),
    onSuccess: () => toast({ title: "Security alert test poll queued" }),
    onError: () =>
      toast({ title: "Failed to queue test poll", variant: "destructive" }),
  });

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Security Alerts — {serverName}</DialogTitle>
        </DialogHeader>
        {isLoading ? (
          <div className="flex justify-center py-8">
            <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-4 py-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm">Enabled</Label>
              <Switch
                checked={form.enabled}
                onCheckedChange={(v) => setForm((f) => ({ ...f, enabled: v }))}
              />
            </div>
            <div className="flex items-center justify-between">
              <Label className="text-sm">SSH login alerts</Label>
              <Switch
                checked={form.ssh_login_alerts_enabled}
                onCheckedChange={(v) =>
                  setForm((f) => ({ ...f, ssh_login_alerts_enabled: v }))
                }
              />
            </div>
            <div className="flex items-center justify-between">
              <Label className="text-sm">File change alerts</Label>
              <Switch
                checked={form.file_change_alerts_enabled}
                onCheckedChange={(v) =>
                  setForm((f) => ({ ...f, file_change_alerts_enabled: v }))
                }
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Interval minutes</Label>
              <Input
                type="number"
                min={1}
                max={1440}
                value={form.interval_minutes}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    interval_minutes: Number(e.target.value),
                  }))
                }
                className="h-8 text-xs w-24"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Watched paths</Label>
              <Textarea
                value={pathsText}
                onChange={(e) => setPathsText(e.target.value)}
                className="min-h-48 font-mono text-xs"
              />
            </div>
            {form.last_checked_at && (
              <p className="text-xs text-muted-foreground">
                Last checked {new Date(form.last_checked_at).toLocaleString()}
              </p>
            )}
          </div>
        )}
        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => test.mutate()}
            disabled={test.isPending || isLoading}
          >
            {test.isPending ? "Queuing…" : "Test"}
          </Button>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => save.mutate()}
            disabled={save.isPending || isLoading}
          >
            {save.isPending ? "Saving…" : "Save Alerts"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Re-export Badge for use by ScheduleTabs without importing shadcn in that file
export { Badge };
