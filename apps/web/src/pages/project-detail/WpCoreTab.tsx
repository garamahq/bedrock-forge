import { useState, useRef, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  RefreshCw,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  ArrowUpCircle,
  Cpu,
} from "lucide-react";
import { api } from "@/lib/api-client";
import { toast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useWebSocketEvent, useSubscribeEnvironment } from "@/lib/websocket";

interface Environment {
  id: number;
  type: string;
  server: { name: string };
}

interface WpCoreStatus {
  current_version: string;
  updates: Array<{ version: string; update_type: string }>;
}

interface WpCoreUpdateResult {
  updated: boolean;
  new_version: string | null;
  update_output: string;
  db_update_output: string;
}

interface WpJobLog<T> {
  id: number;
  status: "queued" | "active" | "completed" | "failed" | "dead_letter" | string;
  execution_log: T | null;
  last_error?: string | null;
  completed_at?: string | null;
}

export function WpCoreTab({ environments }: { environments: Environment[] }) {
  const defaultEnvId =
    environments.find((e) => e.type === "production")?.id ??
    environments[0]?.id ??
    null;

  const [searchParams, setSearchParams] = useSearchParams();
  const envParam = searchParams.get("env");
  const initialEnvId = envParam ? Number(envParam) : null;
  const validInitialEnv = environments.find((e) => e.id === initialEnvId)
    ? initialEnvId
    : defaultEnvId;

  const [selectedEnvId, setSelectedEnvId] = useState<number | null>(
    validInitialEnv,
  );

  useEffect(() => {
    if (selectedEnvId) {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (next.get("env") !== String(selectedEnvId)) {
            next.set("env", String(selectedEnvId));
          }
          return next;
        },
        { replace: true },
      );
    }
  }, [selectedEnvId, setSearchParams]);
  const [coreStatus, setCoreStatus] = useState<WpCoreStatus | null>(null);
  const [updateResult, setUpdateResult] = useState<WpCoreUpdateResult | null>(
    null,
  );
  const [checkJobId, setCheckJobId] = useState<string | null>(null);
  const [updateJobId, setUpdateJobId] = useState<string | null>(null);
  const [checkExecId, setCheckExecId] = useState<number | null>(null);
  const [updateExecId, setUpdateExecId] = useState<number | null>(null);

  const checkJobIdRef = useRef<string | null>(null);
  const updateJobIdRef = useRef<string | null>(null);
  const checkExecIdRef = useRef<number | null>(null);
  const updateExecIdRef = useRef<number | null>(null);

  useSubscribeEnvironment(selectedEnvId);

  useWebSocketEvent("job:completed", (data) => {
    const event = data as {
      queueName: string;
      jobId?: string;
      environmentId?: number;
    };

    if (event.queueName !== "wp-actions") return;

    const isCheckJob =
      event.jobId != null && event.jobId === checkJobIdRef.current;
    if (isCheckJob) {
      const execId = checkExecIdRef.current;
      setCheckJobId(null);
      setCheckExecId(null);
      checkJobIdRef.current = null;
      checkExecIdRef.current = null;

      if (execId) {
        // execution_log is the result object directly (not a step array)
        api
          .get<{ execution_log: WpCoreStatus | null }>(
            `/job-executions/${execId}/log`,
          )
          .then((res) => {
            if (res?.execution_log) {
              setCoreStatus(res.execution_log);
            } else {
              toast({
                title: "No result from core check",
                variant: "destructive",
              });
            }
          })
          .catch(() =>
            toast({
              title: "Failed to load check result",
              variant: "destructive",
            }),
          );
      }
    }

    const isUpdateJob =
      event.jobId != null && event.jobId === updateJobIdRef.current;
    if (isUpdateJob) {
      const execId = updateExecIdRef.current;
      setUpdateJobId(null);
      setUpdateExecId(null);
      updateJobIdRef.current = null;
      updateExecIdRef.current = null;

      if (execId) {
        // execution_log is the result object directly
        api
          .get<{ execution_log: WpCoreUpdateResult | null }>(
            `/job-executions/${execId}/log`,
          )
          .then((res) => {
            const result = res?.execution_log;
            if (result) {
              setUpdateResult(result);
              setCoreStatus((prev) =>
                prev && result.new_version
                  ? {
                      ...prev,
                      current_version: result.new_version,
                      updates: [],
                    }
                  : prev,
              );
              toast({
                title: result.updated
                  ? "WordPress core updated"
                  : "WordPress already up to date",
              });
            } else {
              toast({
                title: "No result from core update",
                variant: "destructive",
              });
            }
          })
          .catch(() =>
            toast({
              title: "Failed to load update result",
              variant: "destructive",
            }),
          );
      }
    }
  });

  useWebSocketEvent("job:failed", (data) => {
    const event = data as {
      queueName: string;
      jobId?: string;
      error?: string;
    };

    if (event.queueName !== "wp-actions") return;

    if (event.jobId != null && event.jobId === checkJobIdRef.current) {
      setCheckJobId(null);
      setCheckExecId(null);
      checkJobIdRef.current = null;
      checkExecIdRef.current = null;
      toast({
        title: "Core check failed",
        description: event.error ?? "An unexpected error occurred",
        variant: "destructive",
      });
    }

    if (event.jobId != null && event.jobId === updateJobIdRef.current) {
      setUpdateJobId(null);
      setUpdateExecId(null);
      updateJobIdRef.current = null;
      updateExecIdRef.current = null;
      toast({
        title: "Core update failed",
        description: event.error ?? "An unexpected error occurred",
        variant: "destructive",
      });
    }
  });

  const checkMutation = useMutation({
    mutationFn: () =>
      api.post<{ jobExecutionId: number; bullJobId: string }>(
        `/environments/${selectedEnvId}/wp-actions/core/check`,
        {},
      ),
    onSuccess: (data) => {
      const jobId = data?.bullJobId ?? null;
      setCheckJobId(jobId);
      checkJobIdRef.current = jobId;
      setCheckExecId(data?.jobExecutionId ?? null);
      checkExecIdRef.current = data?.jobExecutionId ?? null;
      setCoreStatus(null);
      setUpdateResult(null);
      toast({ title: "Core version check queued" });
    },
    onError: () =>
      toast({ title: "Failed to queue check", variant: "destructive" }),
  });

  const updateMutation = useMutation({
    mutationFn: () =>
      api.post<{ jobExecutionId: number; bullJobId: string }>(
        `/environments/${selectedEnvId}/wp-actions/core/update`,
        {},
      ),
    onSuccess: (data) => {
      const jobId = data?.bullJobId ?? null;
      setUpdateJobId(jobId);
      updateJobIdRef.current = jobId;
      setUpdateExecId(data?.jobExecutionId ?? null);
      updateExecIdRef.current = data?.jobExecutionId ?? null;
      toast({ title: "Core update queued" });
    },
    onError: () =>
      toast({ title: "Failed to queue update", variant: "destructive" }),
  });

  const isChecking = !!checkJobId || checkMutation.isPending;
  const isUpdating = !!updateJobId || updateMutation.isPending;
  const isBusy = isChecking || isUpdating;

  const { data: checkJobLog } = useQuery<WpJobLog<WpCoreStatus>>({
    queryKey: ["wp-core-check-job", checkExecId],
    queryFn: () => api.get(`/job-executions/${checkExecId}/log`),
    enabled: checkExecId !== null && !!checkJobId,
    refetchInterval: checkJobId ? 2_000 : false,
    staleTime: 0,
  });

  const { data: updateJobLog } = useQuery<WpJobLog<WpCoreUpdateResult>>({
    queryKey: ["wp-core-update-job", updateExecId],
    queryFn: () => api.get(`/job-executions/${updateExecId}/log`),
    enabled: updateExecId !== null && !!updateJobId,
    refetchInterval: updateJobId ? 2_000 : false,
    staleTime: 0,
  });

  useEffect(() => {
    if (!checkJobLog) return;
    if (checkJobLog.status === "completed") {
      setCheckJobId(null);
      setCheckExecId(null);
      checkJobIdRef.current = null;
      checkExecIdRef.current = null;
      if (checkJobLog.execution_log) {
        setCoreStatus(checkJobLog.execution_log);
      }
    } else if (
      checkJobLog.status === "failed" ||
      checkJobLog.status === "dead_letter"
    ) {
      setCheckJobId(null);
      setCheckExecId(null);
      checkJobIdRef.current = null;
      checkExecIdRef.current = null;
      toast({
        title: "Core check failed",
        description: checkJobLog.last_error ?? "An unexpected error occurred",
        variant: "destructive",
      });
    }
  }, [checkJobLog?.status, checkJobLog?.last_error]);

  useEffect(() => {
    if (!updateJobLog) return;
    if (updateJobLog.status === "completed") {
      setUpdateJobId(null);
      setUpdateExecId(null);
      updateJobIdRef.current = null;
      updateExecIdRef.current = null;
      if (updateJobLog.execution_log) {
        const result = updateJobLog.execution_log;
        setUpdateResult(result);
        setCoreStatus((prev) =>
          prev && result.new_version
            ? { ...prev, current_version: result.new_version, updates: [] }
            : prev,
        );
      }
    } else if (
      updateJobLog.status === "failed" ||
      updateJobLog.status === "dead_letter"
    ) {
      setUpdateJobId(null);
      setUpdateExecId(null);
      updateJobIdRef.current = null;
      updateExecIdRef.current = null;
      toast({
        title: "Core update failed",
        description: updateJobLog.last_error ?? "An unexpected error occurred",
        variant: "destructive",
      });
    }
  }, [updateJobLog?.status, updateJobLog?.last_error]);

  const hasUpdate = coreStatus != null && (coreStatus.updates?.length ?? 0) > 0;
  const latestVersion = coreStatus?.updates?.[0]?.version ?? null;

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={String(selectedEnvId ?? "")}
          onValueChange={(v) => setSelectedEnvId(Number(v))}
        >
          <SelectTrigger className="w-44">
            <SelectValue placeholder="Select environment" />
          </SelectTrigger>
          <SelectContent>
            {environments.map((env) => (
              <SelectItem key={env.id} value={String(env.id)}>
                <span className="capitalize">{env.type}</span>
                <span className="ml-1.5 text-xs text-muted-foreground">
                  {env.server.name}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="flex items-center gap-2 ml-auto">
          <Button
            size="sm"
            variant="outline"
            onClick={() => checkMutation.mutate()}
            disabled={!selectedEnvId || isBusy}
          >
            {isChecking ? (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
            )}
            {isChecking ? "Checking…" : "Check Version"}
          </Button>

          {hasUpdate && (
            <Button
              size="sm"
              onClick={() => updateMutation.mutate()}
              disabled={!selectedEnvId || isBusy}
            >
              {isUpdating ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <ArrowUpCircle className="h-3.5 w-3.5 mr-1.5" />
              )}
              {isUpdating ? "Updating…" : `Update to ${latestVersion}`}
            </Button>
          )}
        </div>
      </div>

      {/* Checking spinner */}
      {isChecking && !coreStatus && (
        <Card>
          <CardContent className="py-8 flex flex-col items-center gap-2 text-muted-foreground">
            <Loader2 className="h-6 w-6 animate-spin" />
            <p className="text-sm">Checking WordPress core version…</p>
          </CardContent>
        </Card>
      )}

      {/* Status card */}
      {coreStatus && (
        <Card
          className={
            hasUpdate
              ? "border-amber-500/40 bg-amber-50/30 dark:bg-amber-950/10"
              : "border-green-500/30 bg-green-50/30 dark:bg-green-950/10"
          }
        >
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Cpu className="h-4 w-4" />
              WordPress Core
            </CardTitle>
            <CardDescription>
              Installed version and update availability across Bedrock & standard environments
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-3">
              <span className="text-sm text-muted-foreground">
                Installed version
              </span>
              <Badge variant="secondary" className="font-mono text-sm">
                {coreStatus.current_version || "Detection in progress"}
              </Badge>
            </div>

            {hasUpdate ? (
              <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span className="text-sm font-medium">
                  Update available: {latestVersion}
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-green-600 dark:text-green-400">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                <span className="text-sm font-medium">Core is up to date</span>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Update result card */}
      {updateResult && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <CheckCircle2
                className={`h-4 w-4 ${updateResult.updated ? "text-green-600" : "text-muted-foreground"}`}
              />
              Update Result
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {updateResult.updated ? (
              <p className="text-sm text-green-700 dark:text-green-400">
                WordPress updated to <strong>{updateResult.new_version}</strong>
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                WordPress was already up to date.
              </p>
            )}
            {updateResult.update_output && (
              <pre className="text-xs font-mono bg-muted rounded p-2 overflow-x-auto whitespace-pre-wrap">
                {updateResult.update_output}
              </pre>
            )}
            {updateResult.db_update_output && (
              <>
                <p className="text-xs font-medium text-muted-foreground">
                  DB update
                </p>
                <pre className="text-xs font-mono bg-muted rounded p-2 overflow-x-auto whitespace-pre-wrap">
                  {updateResult.db_update_output}
                </pre>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* Empty state */}
      {!isChecking && !coreStatus && (
        <Card>
          <CardContent className="py-12 flex flex-col items-center gap-3 text-muted-foreground">
            <Cpu className="h-8 w-8 opacity-40" />
            <p className="text-sm">
              Run a version check to see the current WordPress core status.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
