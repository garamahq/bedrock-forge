import { useState, useRef, useEffect, FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ScanLine,
  RefreshCw,
  ArrowUpCircle,
  CheckCircle2,
  Loader2,
  Plus,
  Trash2,
  Palette,
  Package,
  AlertTriangle,
} from "lucide-react";
import { api } from "@/lib/api-client";
import { toast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useWebSocketEvent, useSubscribeEnvironment } from "@/lib/websocket";
import { ErrorState } from "@/components/crud";

interface Environment {
  id: number;
  type: string;
  server: { name: string };
}

interface ThemeInfo {
  name: string;
  slug: string;
  status: "active" | "inactive";
  version: string;
  update_version: string | null;
  update: "available" | "none" | "none available";
  title: string;
  description: string;
  author: string;
}

interface ThemeScan {
  id: number;
  themes: ThemeInfo[];
  scanned_at: string;
}

interface ThemeScanExecution {
  id: number;
  status: "queued" | "active" | "completed" | "failed" | "dead_letter";
  progress: number | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  last_error: string | null;
}

interface ThemeScansResponse {
  items: ThemeScan[];
  latestExecution: ThemeScanExecution | null;
}

function InstallThemeDialog({
  envId,
  open,
  onClose,
}: {
  envId: number;
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [slug, setSlug] = useState("");

  const mutation = useMutation({
    mutationFn: () =>
      api.post<{ jobExecutionId: number; bullJobId: string }>(
        `/theme-scans/environment/${envId}/themes`,
        { slug: slug.trim() },
      ),
    onSuccess: () => {
      toast({
        title: "Theme install queued",
        description: `${slug} will be installed via WP-CLI.`,
      });
      qc.invalidateQueries({ queryKey: ["theme-scans", envId] });
      setSlug("");
      onClose();
    },
    onError: () =>
      toast({ title: "Failed to queue install", variant: "destructive" }),
  });

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!slug.trim()) return;
    mutation.mutate();
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Install Theme</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 py-2">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Theme Slug</label>
            <Input
              placeholder="e.g. twentytwentyfour"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              disabled={mutation.isPending}
              autoFocus
            />
            <p className="text-xs text-muted-foreground">
              Slug from wordpress.org/themes — installed via{" "}
              <code className="bg-muted px-1 rounded">wp theme install</code>
            </p>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={mutation.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!slug.trim() || mutation.isPending}>
              {mutation.isPending ? (
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
              ) : (
                <Plus className="h-4 w-4 mr-1.5" />
              )}
              Install Theme
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ThemesTab({
  projectId: _projectId,
  environments,
}: {
  projectId: number;
  environments: Environment[];
}) {
  const qc = useQueryClient();

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
  const [scanning, setScanning] = useState(false);
  const [managingJobId, setManagingJobId] = useState<string | null>(null);
  const [showInstallDialog, setShowInstallDialog] = useState(false);

  const scanningEnvIdRef = useRef<number | null>(null);
  const scanJobIdRef = useRef<string | null>(null);
  const scanStartedAtRef = useRef<number>(0);
  const managingJobIdRef = useRef<string | null>(null);

  useSubscribeEnvironment(selectedEnvId);

  useWebSocketEvent("job:completed", (data) => {
    const event = data as {
      queueName: string;
      jobId?: string;
      environmentId?: number;
    };

    if (event.queueName !== "theme-scans") return;

    const isScanJob =
      event.environmentId === scanningEnvIdRef.current ||
      (event.jobId != null && event.jobId === scanJobIdRef.current);
    if (isScanJob) {
      const envId = event.environmentId ?? scanningEnvIdRef.current;
      setScanning(false);
      scanningEnvIdRef.current = null;
      scanJobIdRef.current = null;
      qc.invalidateQueries({ queryKey: ["theme-scans", envId] });
    }

    const isManageJob =
      event.jobId != null && event.jobId === managingJobIdRef.current;
    if (isManageJob) {
      setManagingJobId(null);
      managingJobIdRef.current = null;
      const envId = event.environmentId ?? selectedEnvId;
      qc.invalidateQueries({ queryKey: ["theme-scans", envId] });
    }
  });

  useWebSocketEvent("job:failed", (data) => {
    const event = data as {
      queueName: string;
      jobId?: string;
      environmentId?: number;
      error?: string;
    };

    if (event.queueName !== "theme-scans") return;

    const isScanJob =
      event.environmentId === scanningEnvIdRef.current ||
      (event.jobId != null && event.jobId === scanJobIdRef.current);
    if (isScanJob) {
      const envId = event.environmentId ?? scanningEnvIdRef.current;
      setScanning(false);
      scanningEnvIdRef.current = null;
      scanJobIdRef.current = null;
      qc.invalidateQueries({ queryKey: ["theme-scans", envId] });
      toast({
        title: "Theme scan failed",
        description: event.error ?? "An unexpected error occurred",
        variant: "destructive",
      });
    }

    const isManageJob =
      event.jobId != null && event.jobId === managingJobIdRef.current;
    if (isManageJob) {
      setManagingJobId(null);
      managingJobIdRef.current = null;
      toast({
        title: "Theme operation failed",
        description: event.error ?? "An unexpected error occurred",
        variant: "destructive",
      });
    }
  });

  const {
    data: scans,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ["theme-scans", selectedEnvId],
    enabled: !!selectedEnvId,
    queryFn: () =>
      api.get<ThemeScansResponse>(
        `/theme-scans/environment/${selectedEnvId}?limit=1`,
      ),
    refetchInterval: 15_000,
  });

  const latestScan = scans?.items[0];
  const latestExecution = scans?.latestExecution ?? null;
  const latestScanAttemptFailed =
    latestExecution?.status === "failed" ||
    latestExecution?.status === "dead_letter";
  const latestFailureIsNewerThanScan =
    latestScanAttemptFailed &&
    (!latestScan ||
      new Date(latestExecution.created_at).getTime() >
        new Date(latestScan.scanned_at).getTime());
  const themes: ThemeInfo[] = Array.isArray(latestScan?.themes)
    ? (latestScan.themes as ThemeInfo[])
    : [];
  const activeTheme = themes.find((t) => t.status === "active");
  const inactiveThemes = themes.filter((t) => t.status !== "active");
  const updatableCount = themes.filter((t) => t.update === "available").length;

  useEffect(() => {
    if (scanning && latestScan) {
      const scannedAt = new Date(latestScan.scanned_at).getTime();
      if (scannedAt > scanStartedAtRef.current) {
        setScanning(false);
        scanningEnvIdRef.current = null;
        scanJobIdRef.current = null;
      }
    }
  }, [scanning, latestScan?.scanned_at]);

  const scanMutation = useMutation({
    mutationFn: () =>
      api.post<{ jobExecutionId: number; bullJobId: string }>(
        `/theme-scans/environment/${selectedEnvId}/scan`,
        {},
      ),
    onSuccess: (data) => {
      setScanning(true);
      scanningEnvIdRef.current = selectedEnvId;
      scanJobIdRef.current = data?.bullJobId ?? null;
      scanStartedAtRef.current = Date.now();
      toast({
        title: "Theme scan queued",
        description:
          "Results will appear automatically when the scan completes.",
      });
    },
    onError: () => toast({ title: "Scan failed", variant: "destructive" }),
  });

  const updateAllMutation = useMutation({
    mutationFn: () =>
      api.put<{ jobExecutionId: number; bullJobId: string }>(
        `/theme-scans/environment/${selectedEnvId}/themes`,
        {},
      ),
    onSuccess: (data) => {
      const jobId = data?.bullJobId ?? null;
      setManagingJobId(jobId);
      managingJobIdRef.current = jobId;
      toast({
        title: "Update all themes queued",
        description: "All themes will be updated via WP-CLI.",
      });
    },
    onError: () =>
      toast({ title: "Failed to queue update-all", variant: "destructive" }),
  });

  function enqueueManage(
    action: "activate" | "update" | "delete",
    slug: string,
  ) {
    let promise: Promise<{ jobExecutionId: number; bullJobId: string }>;
    if (action === "activate") {
      promise = api.post(
        `/theme-scans/environment/${selectedEnvId}/themes/${slug}/activate`,
        {},
      );
    } else if (action === "update") {
      promise = api.put(
        `/theme-scans/environment/${selectedEnvId}/themes/${slug}`,
        {},
      );
    } else {
      promise = api.delete(
        `/theme-scans/environment/${selectedEnvId}/themes/${slug}`,
      );
    }
    promise
      .then((data) => {
        const jobId = data?.bullJobId ?? null;
        setManagingJobId(jobId);
        managingJobIdRef.current = jobId;
        toast({
          title:
            action === "activate"
              ? "Activate queued"
              : action === "update"
                ? "Update queued"
                : "Delete queued",
          description: `${slug} — operation queued.`,
        });
      })
      .catch(() =>
        toast({ title: "Operation failed", variant: "destructive" }),
      );
  }

  const isBusy = scanning || !!managingJobId;

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Environment selector */}
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
          {updatableCount > 0 && (
            <span className="text-xs text-amber-600 font-medium">
              {updatableCount} update{updatableCount > 1 ? "s" : ""} available
            </span>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowInstallDialog(true)}
            disabled={!selectedEnvId || isBusy}
          >
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            Install
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => updateAllMutation.mutate()}
            disabled={
              !selectedEnvId ||
              isBusy ||
              updateAllMutation.isPending ||
              updatableCount === 0
            }
          >
            {updateAllMutation.isPending || (managingJobId && !scanning) ? (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : (
              <ArrowUpCircle className="h-3.5 w-3.5 mr-1.5" />
            )}
            Update All
          </Button>
          <Button
            size="sm"
            onClick={() => scanMutation.mutate()}
            disabled={!selectedEnvId || isBusy || scanMutation.isPending}
          >
            {scanning || scanMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : (
              <ScanLine className="h-3.5 w-3.5 mr-1.5" />
            )}
            {scanning ? "Scanning…" : "Scan"}
          </Button>
        </div>
      </div>

      {/* Last scanned at */}
      {latestScan && (
        <p className="text-xs text-muted-foreground">
          Last successful scan:{" "}
          <span className="font-medium text-foreground">
            {new Date(latestScan.scanned_at).toLocaleString()}
          </span>
          {latestFailureIsNewerThanScan && (
            <span className="ml-2 text-destructive font-medium">
              Latest attempt failed; showing stale data.
            </span>
          )}
        </p>
      )}

      {latestFailureIsNewerThanScan && (
        <Card className="border-destructive/40 bg-destructive/[0.03]">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-4 w-4" />
              Latest theme scan failed
            </CardTitle>
            <CardDescription>
              {latestExecution.last_error ?? "An unexpected error occurred."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              size="sm"
              onClick={() => scanMutation.mutate()}
              disabled={!selectedEnvId || isBusy || scanMutation.isPending}
            >
              {scanMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <ScanLine className="h-3.5 w-3.5 mr-1.5" />
              )}
              Retry Scan
            </Button>
          </CardContent>
        </Card>
      )}

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full rounded-lg" />
          ))}
        </div>
      ) : isError ? (
        <ErrorState
          title="Could not load theme scan history"
          onRetry={() => void refetch()}
        />
      ) : !latestScan ? (
        <Card>
          <CardContent className="py-12 flex flex-col items-center gap-3 text-muted-foreground">
            {latestScanAttemptFailed ? (
              <AlertTriangle className="h-8 w-8 text-destructive opacity-80" />
            ) : (
              <Palette className="h-8 w-8 opacity-40" />
            )}
            <div className="space-y-1 text-center">
              <p className="text-sm">
                {latestScanAttemptFailed
                  ? "The latest theme scan failed."
                  : "No theme scan data yet. Run a scan to see installed themes."}
              </p>
              {latestScanAttemptFailed && latestExecution?.last_error && (
                <p className="text-xs text-destructive max-w-xl">
                  {latestExecution.last_error}
                </p>
              )}
            </div>
            <Button
              size="sm"
              onClick={() => scanMutation.mutate()}
              disabled={!selectedEnvId || isBusy || scanMutation.isPending}
            >
              {scanMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <ScanLine className="h-3.5 w-3.5 mr-1.5" />
              )}
              {latestScanAttemptFailed ? "Retry Scan" : "Run First Scan"}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {/* Active theme card */}
          {activeTheme && (
            <Card className="border-primary/30 bg-primary/[0.03]">
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <CardTitle className="text-base flex items-center gap-2">
                      <CheckCircle2 className="h-4 w-4 text-primary" />
                      {activeTheme.name}
                      <Badge variant="default" className="text-xs">
                        Active
                      </Badge>
                      {activeTheme.update === "available" && (
                        <Badge
                          variant="outline"
                          className="text-xs border-amber-500 text-amber-600"
                        >
                          <AlertTriangle className="h-2.5 w-2.5 mr-1" />
                          Update available: {activeTheme.update_version}
                        </Badge>
                      )}
                    </CardTitle>
                    <CardDescription className="mt-0.5">
                      <span className="font-mono text-xs">
                        {activeTheme.slug}
                      </span>
                      {" · "}v{activeTheme.version}
                      {activeTheme.author && ` · ${activeTheme.author}`}
                    </CardDescription>
                  </div>
                  {activeTheme.update === "available" && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => enqueueManage("update", activeTheme.slug)}
                      disabled={isBusy}
                    >
                      {isBusy ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                      )}
                      Update
                    </Button>
                  )}
                </div>
              </CardHeader>
            </Card>
          )}

          {/* Inactive themes */}
          {inactiveThemes.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Package className="h-4 w-4" />
                  Inactive Themes
                  <Badge variant="secondary" className="text-xs">
                    {inactiveThemes.length}
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="divide-y">
                  {inactiveThemes.map((theme) => (
                    <div
                      key={theme.slug}
                      className="flex items-center gap-3 px-4 py-3"
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">
                          {theme.name}
                        </p>
                        <p className="text-xs text-muted-foreground font-mono">
                          {theme.slug} · v{theme.version}
                          {theme.author && ` · ${theme.author}`}
                        </p>
                      </div>

                      {theme.update === "available" && (
                        <Badge
                          variant="outline"
                          className="text-xs border-amber-500 text-amber-600 shrink-0"
                        >
                          <AlertTriangle className="h-2.5 w-2.5 mr-1" />
                          {theme.update_version}
                        </Badge>
                      )}

                      <div className="flex items-center gap-1 shrink-0">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-xs"
                          onClick={() => enqueueManage("activate", theme.slug)}
                          disabled={isBusy}
                        >
                          {isBusy ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <CheckCircle2 className="h-3 w-3 mr-1" />
                          )}
                          Activate
                        </Button>
                        {theme.update === "available" && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-xs"
                            onClick={() => enqueueManage("update", theme.slug)}
                            disabled={isBusy}
                          >
                            {isBusy ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <RefreshCw className="h-3 w-3 mr-1" />
                            )}
                            Update
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                          onClick={() => enqueueManage("delete", theme.slug)}
                          disabled={isBusy}
                        >
                          {isBusy ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Trash2 className="h-3 w-3" />
                          )}
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {themes.length === 0 && (
            <div className="text-center py-8 text-muted-foreground text-sm">
              No themes found in last scan.
            </div>
          )}
        </div>
      )}

      {selectedEnvId && (
        <InstallThemeDialog
          envId={selectedEnvId}
          open={showInstallDialog}
          onClose={() => setShowInstallDialog(false)}
        />
      )}
    </div>
  );
}
