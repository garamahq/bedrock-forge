import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  AlertTriangle,
  Database,
  ShieldOff,
  Files,
  Upload,
} from "lucide-react";
import { useWebSocketEvent } from "@/lib/websocket";
import { toast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AlertDialog } from "@/components/ui/alert-dialog";
import { Environment, JobProgress, JobResult, Scope } from "../types";
import { syncApi } from "../api";
import { EnvCard } from "./EnvCard";
import { JobProgressPanel } from "./JobProgressPanel";

const SCOPE_OPTIONS = [
  {
    value: "database",
    label: "Database only",
    icon: Database,
    desc: "mysqldump + import + URL search-replace (DROP & recreate)",
  },
  {
    value: "files",
    label: "Files only",
    icon: Files,
    desc: "Full site via rsync — excludes .env, wp-config.php, .htaccess",
  },
  {
    value: "both",
    label: "Database + Files",
    icon: Upload,
    desc: "Database first (clean slate), then full site files",
  },
] as const;

export function PushPanel({
  projectId,
  environments,
}: {
  projectId: number;
  environments: Environment[];
}) {
  const qc = useQueryClient();
  const [sourceId, setSourceId] = useState<string>("");
  const [targetId, setTargetId] = useState<string>("");
  const [scope, setScope] = useState<Scope>("database");
  const [skipSafetyBackup, setSkipSafetyBackup] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobExecutionId, setJobExecutionId] = useState<number | null>(null);
  const [progress, setProgress] = useState<JobProgress | null>(null);
  const [jobDone, setJobDone] = useState<JobResult | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const source = environments.find((e) => e.id.toString() === sourceId) ?? null;
  const target = environments.find((e) => e.id.toString() === targetId) ?? null;

  const pushMutation = useMutation({
    mutationFn: () =>
      syncApi.pushEnvironment({
        sourceEnvironmentId: Number(sourceId),
        targetEnvironmentId: Number(targetId),
        scope,
        skipSafetyBackup,
      }),
    onSuccess: (res) => {
      setJobId(res.jobId);
      setJobExecutionId(res.jobExecutionId);
      setJobDone(null);
      setProgress(null);
      qc.invalidateQueries({ queryKey: ["sync-history", projectId] });
      toast({ title: "Sync job queued", description: `Job ${res.jobId}` });
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : "Failed to queue sync";
      toast({
        title: "Sync failed to queue",
        description: msg,
        variant: "destructive",
      });
    },
  });

  const cancelPushMutation = useMutation({
    mutationFn: (execId: number) => syncApi.cancelSyncExecution(execId),
    onSuccess: () => {
      setJobId(null);
      setJobExecutionId(null);
      setProgress(null);
      setJobDone({ jobId: "", status: "failed", message: "Cancelled by user" });
      qc.invalidateQueries({ queryKey: ["sync-history", projectId] });
      toast({ title: "Sync job cancelled" });
    },
    onError: () =>
      toast({ title: "Could not cancel sync", variant: "destructive" }),
  });

  useWebSocketEvent("job:progress", (raw: unknown) => {
    const p = raw as JobProgress;
    if (p.jobId === jobId) setProgress(p);
  });
  useWebSocketEvent("job:completed", (raw: unknown) => {
    const r = raw as JobResult;
    if (r.jobId === jobId) {
      setJobDone({ ...r, status: "completed" });
      qc.invalidateQueries({ queryKey: ["sync-history", projectId] });
      toast({ title: "Sync completed successfully" });
    }
  });
  useWebSocketEvent("job:failed", (raw: unknown) => {
    const r = raw as JobResult;
    if (r.jobId === jobId) {
      setJobDone({ ...r, status: "failed" });
      qc.invalidateQueries({ queryKey: ["sync-history", projectId] });
      toast({
        title: "Sync failed",
        description: r.message,
        variant: "destructive",
      });
    }
  });

  const needsGdrive = scope !== "files";
  const hasGdrive =
    !needsGdrive ||
    skipSafetyBackup ||
    !target ||
    !!target.google_drive_folder_id;
  const canPush = sourceId && targetId && sourceId !== targetId && hasGdrive;
  const isBusy = pushMutation.isPending || (!!jobId && !jobDone);

  const ScopeIcon =
    SCOPE_OPTIONS.find((o) => o.value === scope)?.icon ?? Upload;

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        Sync data from one environment to another — choose database, files
        (wp-content/), or both. Uses rsync for fast file transfer with a tar
        relay fallback.
      </p>

      {/* Scope selector */}
      <div className="space-y-1.5">
        <label className="text-sm font-medium">What to sync</label>
        <div className="grid grid-cols-3 gap-2">
          {SCOPE_OPTIONS.map(({ value, label, icon: Icon, desc }) => (
            <button
              key={value}
              type="button"
              onClick={() => setScope(value as Scope)}
              className={`rounded-lg border p-3 text-left transition-colors space-y-0.5 ${
                scope === value
                  ? "border-primary bg-primary/5"
                  : "hover:border-muted-foreground/40"
              }`}
            >
              <div className="flex items-center gap-1.5 text-sm font-medium">
                <Icon className="h-3.5 w-3.5" />
                {label}
              </div>
              <p className="text-xs text-muted-foreground">{desc}</p>
            </button>
          ))}
        </div>
      </div>

      {/* Source / target selectors */}
      <div className="grid grid-cols-[1fr_auto_1fr] gap-4 items-end">
        <div className="space-y-1.5">
          <label className="text-sm font-medium">Source</label>
          <Select value={sourceId} onValueChange={setSourceId}>
            <SelectTrigger>
              <SelectValue placeholder="Select source…" />
            </SelectTrigger>
            <SelectContent>
              {environments.map((e) => (
                <SelectItem
                  key={e.id}
                  value={e.id.toString()}
                  disabled={e.id.toString() === targetId}
                >
                  <span className="capitalize">{e.type}</span>
                  <span className="text-muted-foreground ml-1.5 text-xs">
                    ({e.server.name})
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="pb-2">
          <ArrowRight className="h-5 w-5 text-muted-foreground" />
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium">
            Target (will be overwritten)
          </label>
          <Select value={targetId} onValueChange={setTargetId}>
            <SelectTrigger>
              <SelectValue placeholder="Select target…" />
            </SelectTrigger>
            <SelectContent>
              {environments.map((e) => (
                <SelectItem
                  key={e.id}
                  value={e.id.toString()}
                  disabled={e.id.toString() === sourceId}
                >
                  <span className="capitalize">{e.type}</span>
                  <span className="text-muted-foreground ml-1.5 text-xs">
                    ({e.server.name})
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <EnvCard env={source} label="Source" />
        <div className="flex flex-col items-center gap-1 flex-none">
          <ArrowRight className="h-6 w-6 text-muted-foreground" />
          <ScopeIcon className="h-3.5 w-3.5 text-muted-foreground" />
        </div>
        <EnvCard env={target} label="Target" />
      </div>

      {(scope === "database" || scope === "both") &&
        target?.protected_tables &&
        target.protected_tables.length > 0 && (
          <div className="flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm dark:border-blue-800 dark:bg-blue-950/40">
            <Database className="h-4 w-4 mt-0.5 flex-none text-blue-500" />
            <div>
              <p className="font-medium text-blue-700 dark:text-blue-400">
                Protected tables will be preserved
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {target.protected_tables.join(", ")} — these tables on the
                target will not be overwritten or URL-replaced
              </p>
            </div>
          </div>
        )}

      {(scope === "database" || scope === "both") &&
        target?.protected_post_types &&
        target.protected_post_types.length > 0 && (
          <div className="flex items-start gap-2 rounded-lg border border-purple-200 bg-purple-50 p-3 text-sm dark:border-purple-800 dark:bg-purple-950/40">
            <Database className="h-4 w-4 mt-0.5 flex-none text-purple-500" />
            <div>
              <p className="font-medium text-purple-700 dark:text-purple-400">
                Protected custom post types will be preserved
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {target.protected_post_types.join(", ")} — target data for these
                post types will be backed up and restored during database sync.
              </p>
            </div>
          </div>
        )}

      {(scope === "database" || scope === "both") &&
        target?.sql_protection_queries &&
        target.sql_protection_queries.length > 0 && (
          <div className="flex items-start gap-2 rounded-lg border border-indigo-200 bg-indigo-50 p-3 text-sm dark:border-indigo-800 dark:bg-indigo-950/40">
            <Database className="h-4 w-4 mt-0.5 flex-none text-indigo-500" />
            <div>
              <p className="font-medium text-indigo-700 dark:text-indigo-400">
                SQL protection queries will run
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {target.sql_protection_queries.length} query/queries will
                execute on target database immediately after import:
              </p>
              <ul className="list-disc pl-4 mt-1 text-xs text-muted-foreground font-mono space-y-0.5">
                {target.sql_protection_queries.map((q, idx) => (
                  <li key={idx} className="truncate max-w-[500px]" title={q}>
                    {q}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

      {needsGdrive &&
        target &&
        !target.google_drive_folder_id &&
        !skipSafetyBackup && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/40">
            <AlertTriangle className="h-4 w-4 mt-0.5 flex-none text-amber-500" />
            <div>
              <p className="font-medium text-amber-700 dark:text-amber-400">
                Google Drive folder required for safety backup
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Database operations require a backup before overwriting. Set a
                Google Drive folder on the <strong>{target.type}</strong>{" "}
                environment, or enable "Skip safety backup" below.
              </p>
            </div>
          </div>
        )}

      {needsGdrive && (
        <div className="flex items-start gap-2.5">
          <Switch
            id="push-skip-backup"
            checked={skipSafetyBackup}
            onCheckedChange={setSkipSafetyBackup}
            className="mt-0.5 shrink-0"
          />
          <div className="space-y-0.5">
            <Label
              htmlFor="push-skip-backup"
              className="flex items-center gap-1.5 cursor-pointer text-sm font-medium"
            >
              <ShieldOff className="h-3.5 w-3.5 text-amber-500" />
              Skip safety backup
            </Label>
            <p className="text-xs text-muted-foreground">
              Sync database without a prior snapshot. Use when target has no
              Google Drive folder or you accept data-loss risk.
            </p>
          </div>
        </div>
      )}

      {skipSafetyBackup && needsGdrive && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 flex-none" />
          <span>
            <strong>No backup will be taken.</strong> If the push fails there
            will be no automatic recovery point.
          </span>
        </div>
      )}

      <Button
        disabled={!canPush || isBusy}
        variant="destructive"
        onClick={() => setConfirmOpen(true)}
      >
        <Upload className={`h-4 w-4 mr-1.5 ${isBusy ? "animate-pulse" : ""}`} />
        {isBusy ? "Syncing…" : "Start Sync"}
      </Button>

      <AlertDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Confirm Sync — This will overwrite data"
        description={`The ${target?.type ?? ""} environment on ${target?.server.name ?? ""} will have its ${scope === "both" ? "database and files" : scope === "database" ? "database" : "wp-content files"} overwritten with data from ${source?.type ?? ""}.${skipSafetyBackup && needsGdrive ? " No backup will be taken." : ""}`}
        confirmLabel="Yes, start sync"
        confirmVariant="destructive"
        onConfirm={() => {
          setConfirmOpen(false);
          pushMutation.mutate();
        }}
      />

      <JobProgressPanel
        progress={progress}
        jobDone={jobDone}
        jobExecutionId={jobExecutionId}
        isBusy={isBusy}
        onCancel={
          jobExecutionId && !jobDone
            ? () => cancelPushMutation.mutate(jobExecutionId)
            : undefined
        }
        isCancelling={cancelPushMutation.isPending}
      />
    </div>
  );
}
