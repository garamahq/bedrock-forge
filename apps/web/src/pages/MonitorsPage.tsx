import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useWebSocketEvent } from "@/lib/websocket";
import { isHttpStatusWorking, WS_EVENTS } from "@bedrock-forge/shared";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Trash2,
  Pencil,
  Search,
  Shield,
  Globe,
  Type,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Activity,
  RefreshCw,
  Play,
  Pause,
} from "lucide-react";
import { api } from "@/lib/api-client";
import { toast } from "@/hooks/use-toast";
import { useAuthStore } from "@/store/auth.store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { AlertDialog } from "@/components/ui/alert-dialog";
import {
  PageHeader,
  DataTable,
  type Column,
  SearchBar,
  Pagination,
} from "@/components/crud";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { BulkActionsBar } from "@/components/ui/bulk-actions-bar";
import { EmptyState } from "@/components/ui/EmptyState";

// Types

interface Environment {
  id: number;
  type: string;
  url: string;
  project: { name: string };
}

interface Monitor {
  id: number;
  enabled: boolean;
  interval_seconds: number;
  last_checked_at: string | null;
  last_status: number | null;
  last_response_ms: number | null;
  uptime_pct: number | string | null;
  check_ssl: boolean;
  ssl_expires_at: string | null;
  ssl_issuer: string | null;
  ssl_days_remaining: number | null;
  ssl_alert_days: number | null;
  check_dns: boolean;
  dns_resolves: boolean | null;
  check_keyword: boolean;
  keyword: string | null;
  keyword_found: boolean | null;
  environment: { id: number; url: string; type: string };
}

interface PaginatedMonitors {
  items: Monitor[];
  total: number;
}

const PAGE_LIMIT = 10;

const INTERVALS = [
  { value: "30", label: "30 seconds" },
  { value: "60", label: "1 minute" },
  { value: "300", label: "5 minutes" },
  { value: "600", label: "10 minutes" },
  { value: "1800", label: "30 minutes" },
];

const monitorSchema = z
  .object({
    environment_id: z.coerce
      .number({ invalid_type_error: "Environment is required" })
      .positive("Environment is required"),
    interval_seconds: z.coerce.number().default(60),
    check_ssl: z.boolean().default(false),
    ssl_alert_days: z.coerce
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .nullable(),
    check_dns: z.boolean().default(false),
    check_keyword: z.boolean().default(false),
    keyword: z.string().max(200).optional().nullable(),
  })
  .refine(
    (d) => !d.check_keyword || (d.keyword && d.keyword.trim().length > 0),
    {
      message: "Keyword is required when keyword check is enabled",
      path: ["keyword"],
    },
  );
type MonitorForm = z.infer<typeof monitorSchema>;

function StatusDot({ status }: { status: number | null }) {
  if (status === null)
    return <span className="inline-block w-2 h-2 rounded-full bg-muted" />;
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full ${
        isHttpStatusWorking(status) ? "bg-green-500" : "bg-red-500"
      }`}
    />
  );
}

function SslBadge({ monitor }: { monitor: Monitor }) {
  if (!monitor.check_ssl) return null;
  const days = monitor.ssl_days_remaining;
  if (days === null)
    return (
      <span title="SSL check pending">
        <Shield className="h-3 w-3 text-muted-foreground" />
      </span>
    );
  const color =
    days <= 7
      ? "text-red-500"
      : days <= 30
        ? "text-yellow-500"
        : "text-green-500";
  return (
    <span
      title={`SSL: ${days}d remaining${monitor.ssl_issuer ? " · " + monitor.ssl_issuer : ""}`}
      className={`flex items-center gap-0.5 text-[10px] font-medium ${color}`}
    >
      <Shield className="h-3 w-3" />
      {days}d
    </span>
  );
}

function DnsBadge({ monitor }: { monitor: Monitor }) {
  if (!monitor.check_dns) return null;
  if (monitor.dns_resolves === null)
    return (
      <span title="DNS check pending">
        <Globe className="h-3 w-3 text-muted-foreground" />
      </span>
    );
  return (
    <span title={`DNS: ${monitor.dns_resolves ? "resolves" : "FAILED"}`}>
      <Globe
        className={`h-3 w-3 ${monitor.dns_resolves ? "text-green-500" : "text-red-500"}`}
      />
    </span>
  );
}

function KeywordBadge({ monitor }: { monitor: Monitor }) {
  if (!monitor.check_keyword || !monitor.keyword) return null;
  if (monitor.keyword_found === null)
    return (
      <span title="Keyword check pending">
        <Type className="h-3 w-3 text-muted-foreground" />
      </span>
    );
  return (
    <span
      title={`Keyword "${monitor.keyword}": ${monitor.keyword_found ? "found" : "NOT FOUND"}`}
    >
      <Type
        className={`h-3 w-3 ${monitor.keyword_found ? "text-green-500" : "text-red-500"}`}
      />
    </span>
  );
}

function AdvancedChecksSection({
  values,
  onChange,
}: {
  values: Partial<MonitorForm>;
  onChange: (field: keyof MonitorForm, value: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border rounded-md overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium bg-muted/50 hover:bg-muted transition-colors"
      >
        <span>Advanced checks</span>
        {open ? (
          <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        )}
      </button>
      {open && (
        <div className="px-3 py-3 space-y-4 text-sm">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="flex items-center gap-1.5">
                <Shield className="h-3.5 w-3.5" />
                SSL certificate check
              </Label>
              <Switch
                checked={!!values.check_ssl}
                onCheckedChange={(v) => onChange("check_ssl", v)}
              />
            </div>
            {values.check_ssl && (
              <div className="ml-5 space-y-1">
                <Label className="text-xs text-muted-foreground">
                  Alert when expiring within (days) — leave blank to disable
                </Label>
                <Input
                  type="number"
                  min={1}
                  max={365}
                  placeholder="e.g. 30"
                  className="h-7 text-xs w-32"
                  value={values.ssl_alert_days ?? ""}
                  onChange={(e) =>
                    onChange(
                      "ssl_alert_days",
                      e.target.value === "" ? null : Number(e.target.value),
                    )
                  }
                />
              </div>
            )}
          </div>
          <div className="flex items-center justify-between">
            <Label className="flex items-center gap-1.5">
              <Globe className="h-3.5 w-3.5" />
              DNS resolution check
            </Label>
            <Switch
              checked={!!values.check_dns}
              onCheckedChange={(v) => onChange("check_dns", v)}
            />
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="flex items-center gap-1.5">
                <Type className="h-3.5 w-3.5" />
                Content keyword check
              </Label>
              <Switch
                checked={!!values.check_keyword}
                onCheckedChange={(v) => onChange("check_keyword", v)}
              />
            </div>
            {values.check_keyword && (
              <div className="ml-5">
                <Input
                  placeholder="Keyword to search in page body…"
                  className="h-7 text-xs"
                  value={values.keyword ?? ""}
                  onChange={(e) => onChange("keyword", e.target.value)}
                />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function CreateMonitorDialog({
  open,
  onOpenChange,
  environments,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  environments: Environment[];
  onSuccess: () => void;
}) {
  const {
    handleSubmit,
    setValue,
    watch,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<MonitorForm>({
    resolver: zodResolver(monitorSchema),
    defaultValues: {
      interval_seconds: 60,
      check_ssl: false,
      check_dns: false,
      check_keyword: false,
    },
  });
  const watchedValues = watch();

  async function onSubmit(data: MonitorForm) {
    try {
      await api.post("/monitors", data);
      toast({ title: "Monitor created" });
      reset();
      onSuccess();
      onOpenChange(false);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Create failed. Please try again.";
      setError("root", { message });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New Monitor</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-1">
            <Label>Environment *</Label>
            <Select
              onValueChange={(v) => setValue("environment_id", Number(v))}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select environment…" />
              </SelectTrigger>
              <SelectContent>
                {environments.map((e) => (
                  <SelectItem key={e.id} value={e.id.toString()}>
                    {e.project.name} — {e.url}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.environment_id && (
              <p className="text-xs text-destructive">
                {errors.environment_id.message}
              </p>
            )}
          </div>
          <div className="space-y-1">
            <Label>Check interval</Label>
            <Select
              defaultValue="60"
              onValueChange={(v) => setValue("interval_seconds", Number(v))}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INTERVALS.map((i) => (
                  <SelectItem key={i.value} value={i.value}>
                    {i.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <AdvancedChecksSection
            values={watchedValues}
            onChange={(field, value) =>
              setValue(field as keyof MonitorForm, value as never)
            }
          />
          {errors.keyword && (
            <p className="text-xs text-destructive">{errors.keyword.message}</p>
          )}
          <DialogFooter>
            {errors.root && (
              <p className="text-xs text-destructive w-full text-left">
                {errors.root.message}
              </p>
            )}
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditMonitorDialog({
  monitor,
  onOpenChange,
  onSave,
}: {
  monitor: Monitor | null;
  onOpenChange: (o: boolean) => void;
  onSave: (id: number, data: Partial<MonitorForm>) => void;
}) {
  const [interval, setInterval] = useState(
    String(monitor?.interval_seconds ?? 60),
  );
  const [checkSsl, setCheckSsl] = useState(monitor?.check_ssl ?? false);
  const [sslAlertDays, setSslAlertDays] = useState<number | null>(
    monitor?.ssl_alert_days ?? null,
  );
  const [checkDns, setCheckDns] = useState(monitor?.check_dns ?? false);
  const [checkKeyword, setCheckKeyword] = useState(
    monitor?.check_keyword ?? false,
  );
  const [keyword, setKeyword] = useState(monitor?.keyword ?? "");
  if (!monitor) return null;
  return (
    <Dialog open={!!monitor} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit Monitor</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1">
            <Label>URL</Label>
            <p className="text-sm font-mono text-muted-foreground truncate">
              {monitor.environment.url}
            </p>
          </div>
          <div className="space-y-1">
            <Label>Check interval</Label>
            <Select value={interval} onValueChange={setInterval}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INTERVALS.map((i) => (
                  <SelectItem key={i.value} value={i.value}>
                    {i.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <AdvancedChecksSection
            values={{
              check_ssl: checkSsl,
              ssl_alert_days: sslAlertDays,
              check_dns: checkDns,
              check_keyword: checkKeyword,
              keyword,
            }}
            onChange={(field, value) => {
              if (field === "check_ssl") setCheckSsl(value as boolean);
              else if (field === "ssl_alert_days")
                setSslAlertDays(value as number | null);
              else if (field === "check_dns") setCheckDns(value as boolean);
              else if (field === "check_keyword")
                setCheckKeyword(value as boolean);
              else if (field === "keyword") setKeyword(value as string);
            }}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() =>
              onSave(monitor.id, {
                interval_seconds: Number(interval),
                check_ssl: checkSsl,
                ssl_alert_days: sslAlertDays,
                check_dns: checkDns,
                check_keyword: checkKeyword,
                keyword: keyword || null,
              })
            }
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function MonitorsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const isAdmin = useAuthStore(
    (state) => state.user?.roles?.includes("admin") ?? false,
  );
  const [searchParams, setSearchParams] = useSearchParams();
  const searchParam = searchParams.get("search") ?? "";
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState(searchParam);
  const [searchInput, setSearchInput] = useState(searchParam);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Monitor | null>(null);
  const [editTarget, setEditTarget] = useState<Monitor | null>(null);

  useEffect(() => {
    setSearch(searchParam);
    setSearchInput(searchParam);
    setPage(1);
  }, [searchParam]);

  // ── Selection State ──────────────────────────────────────────────────────
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["monitors", page, search],
    queryFn: () => {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(PAGE_LIMIT),
      });
      if (search) params.set("search", search);
      return api.get<PaginatedMonitors>(`/monitors?${params.toString()}`);
    },
    refetchInterval: 30_000,
  });

  const monitors = data?.items ?? [];

  useEffect(() => {
    const visibleIds = new Set(monitors.map((monitor) => monitor.id));
    setSelectedIds((previous) => {
      const next = new Set(
        [...previous].filter((monitorId) => visibleIds.has(monitorId)),
      );
      return next.size === previous.size ? previous : next;
    });
  }, [monitors]);
  const totalPages = data ? Math.ceil(data.total / PAGE_LIMIT) : 1;

  const { data: environments = [] } = useQuery({
    queryKey: ["environments-all"],
    queryFn: () => api.get<Environment[]>("/environments"),
  });

  useWebSocketEvent(WS_EVENTS.MONITOR_RESULT, () => {
    qc.invalidateQueries({ queryKey: ["monitors"] });
  });

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) =>
      enabled
        ? api.put(`/monitors/${id}/deactivate`, {})
        : api.put(`/monitors/${id}/activate`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["monitors"] }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.delete(`/monitors/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["monitors"] });
      setDeleteTarget(null);
      toast({ title: "Monitor deleted" });
    },
    onError: () => toast({ title: "Delete failed", variant: "destructive" }),
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: async (ids: number[]) => {
      const results = await Promise.allSettled(
        ids.map((id) => api.delete(`/monitors/${id}`)),
      );
      return {
        succeeded:
          results.length -
          results.filter((result) => result.status === "rejected").length,
        failedIds: ids.filter(
          (_, index) => results[index]?.status === "rejected",
        ),
      };
    },
    onSuccess: ({ succeeded, failedIds }) => {
      qc.invalidateQueries({ queryKey: ["monitors"] });
      setSelectedIds(new Set(failedIds));
      toast({
        title: failedIds.length
          ? "Some monitors could not be deleted"
          : "Monitors deleted",
        description: `${succeeded} deleted, ${failedIds.length} failed. Failed items remain selected for review.`,
        variant: failedIds.length ? "destructive" : undefined,
      });
    },
  });

  const bulkActivateMutation = useMutation({
    mutationFn: async (ids: number[]) => {
      for (const id of ids) {
        await api.put(`/monitors/${id}/activate`, {});
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["monitors"] });
      clearSelection();
      toast({ title: "Monitors activated" });
    },
    onError: () =>
      toast({ title: "Activation failed", variant: "destructive" }),
  });

  const bulkDeactivateMutation = useMutation({
    mutationFn: async (ids: number[]) => {
      for (const id of ids) {
        await api.put(`/monitors/${id}/deactivate`, {});
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["monitors"] });
      clearSelection();
      toast({ title: "Monitors deactivated" });
    },
    onError: () =>
      toast({ title: "Deactivation failed", variant: "destructive" }),
  });

  const editMutation = useMutation({
    mutationFn: ({ id, ...rest }: { id: number } & Partial<MonitorForm>) =>
      api.put(`/monitors/${id}`, rest),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["monitors"] });
      setEditTarget(null);
      toast({ title: "Monitor updated" });
    },
    onError: () => toast({ title: "Update failed", variant: "destructive" }),
  });

  const triggerMutation = useMutation({
    mutationFn: (id: number) => api.post(`/monitors/${id}/trigger`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["monitors"] });
      toast({ title: "Health check triggered successfully" });
    },
    onError: (err) => {
      toast({
        title: "Failed to trigger check",
        description: err instanceof Error ? err.message : "Error",
        variant: "destructive",
      });
    },
  });

  // ── Selection Logic ──────────────────────────────────────────────────────
  const toggleSelect = (id: number) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  };

  const clearSelection = () => setSelectedIds(new Set());

  const isAllSelected =
    monitors.length > 0 && monitors.every((m) => selectedIds.has(m.id));

  const toggleAll = () => {
    if (isAllSelected) {
      const next = new Set(selectedIds);
      monitors.forEach((m) => next.delete(m.id));
      setSelectedIds(next);
    } else {
      const next = new Set(selectedIds);
      monitors.forEach((m) => next.add(m.id));
      setSelectedIds(next);
    }
  };

  const columns: Column<Monitor>[] = [
    {
      header: "",
      headerClassName: "w-10 px-4 py-3",
      render: (m) => (
        <Checkbox
          checked={selectedIds.has(m.id)}
          onCheckedChange={() => toggleSelect(m.id)}
        />
      ),
    },
    {
      header: "Status",
      render: (m) => (
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="flex items-center gap-1.5"
            onClick={() => navigate(`/monitors/${m.id}`)}
          >
            <StatusDot status={m.last_status} />
            <span
              className={`text-xs font-medium ${
                m.last_status === null
                  ? "text-muted-foreground"
                  : isHttpStatusWorking(m.last_status)
                    ? "text-green-600 dark:text-green-400"
                    : "text-red-600 dark:text-red-400"
              }`}
            >
              {m.last_status ?? "pending"}
            </span>
          </button>
          <div className="flex items-center gap-1">
            <SslBadge monitor={m} />
            <DnsBadge monitor={m} />
            <KeywordBadge monitor={m} />
          </div>
        </div>
      ),
    },
    {
      header: "URL",
      render: (m) => (
        <button
          type="button"
          className="font-mono text-xs text-primary underline truncate max-w-[200px] block text-left"
          onClick={() => navigate(`/monitors/${m.id}`)}
        >
          {m.environment.url}
        </button>
      ),
    },
    {
      header: "Type",
      render: (m) => (
        <span className="capitalize">{m.environment.type.toLowerCase()}</span>
      ),
    },
    { header: "Interval", render: (m) => <span>{m.interval_seconds}s</span> },
    {
      header: "Uptime",
      render: (m) => {
        const pct = parseFloat(String(m.uptime_pct ?? 0));
        return (
          <span
            className={`font-mono ${pct >= 99 ? "text-green-600 dark:text-green-400" : pct >= 95 ? "text-yellow-600 dark:text-yellow-400" : "text-red-600 dark:text-red-400"}`}
          >
            {pct.toFixed(2)}%
          </span>
        );
      },
    },
    {
      header: "Last Check",
      render: (m) => (
        <span className="text-muted-foreground text-xs">
          {m.last_checked_at
            ? new Date(m.last_checked_at).toLocaleString()
            : "—"}
        </span>
      ),
    },
    {
      header: "Active",
      render: (m) => (
        <button
          onClick={() => toggle.mutate({ id: m.id, enabled: m.enabled })}
          disabled={toggle.isPending}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:opacity-50 ${m.enabled ? "bg-primary" : "bg-muted"}`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 transform rounded-full bg-card shadow-sm transition-transform ${m.enabled ? "translate-x-4" : "translate-x-1"}`}
          />
        </button>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Monitors"
        onCreate={() => setCreateOpen(true)}
        createLabel="New Monitor"
      />

      <SearchBar
        value={searchInput}
        onChange={setSearchInput}
        onSearch={() => {
          setSearch(searchInput.trim());
          setPage(1);
          setSearchParams((previous) => {
            const next = new URLSearchParams(previous);
            if (searchInput.trim()) next.set("search", searchInput.trim());
            else next.delete("search");
            return next;
          });
        }}
        onClear={() => {
          setSearch("");
          setSearchInput("");
          setPage(1);
          setSearchParams((previous) => {
            const next = new URLSearchParams(previous);
            next.delete("search");
            return next;
          });
        }}
        placeholder="Search by URL…"
        totalCount={data?.total ?? 0}
        totalLabel="total monitors"
      />

      {!isLoading && monitors.length === 0 ? (
        <EmptyState
          icon={Activity}
          title="No monitors found"
          description="You haven’t added any monitors yet. Add your first monitor to start tracking your project uptime."
          action={{
            label: "Add Monitor",
            onClick: () => setCreateOpen(true),
            icon: Activity,
          }}
          className="py-20"
        />
      ) : (
        <DataTable
          columns={columns}
          data={monitors}
          isLoading={isLoading}
          isError={isError}
          onRetry={refetch}
          rowKey={(m) => m.id}
          actionsHeader={
            <Checkbox checked={isAllSelected} onCheckedChange={toggleAll} />
          }
          renderActions={(m) => {
            const isPending =
              triggerMutation.isPending && triggerMutation.variables === m.id;
            return (
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-foreground"
                  onClick={() => triggerMutation.mutate(m.id)}
                  disabled={triggerMutation.isPending}
                  title="Trigger check now"
                >
                  <RefreshCw
                    className={`h-4 w-4 ${isPending ? "animate-spin" : ""}`}
                  />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-foreground"
                  onClick={() => setEditTarget(m)}
                  title="Edit monitor"
                >
                  <Pencil className="h-4 w-4" />
                </Button>
                {isAdmin && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-destructive hover:text-destructive"
                    onClick={() => setDeleteTarget(m)}
                    title="Delete monitor"
                    aria-label="Delete monitor"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            );
          }}
        />
      )}

      {totalPages > 1 && (
        <Pagination
          page={page}
          totalPages={totalPages}
          onPageChange={setPage}
        />
      )}

      <CreateMonitorDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        environments={environments}
        onSuccess={() => qc.invalidateQueries({ queryKey: ["monitors"] })}
      />

      <EditMonitorDialog
        monitor={editTarget}
        onOpenChange={(o) => !o && setEditTarget(null)}
        onSave={(id, data) => editMutation.mutate({ id, ...data })}
      />

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title="Delete Monitor"
        description={`The monitor for "${deleteTarget?.environment.url}" will be permanently deleted.`}
        confirmLabel="Delete"
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
        isPending={deleteMutation.isPending}
      />

      <BulkActionsBar
        selectedCount={selectedIds.size}
        onClear={clearSelection}
        actions={[
          {
            label: "Activate",
            icon: Play,
            onClick: () => {
              bulkActivateMutation.mutate(Array.from(selectedIds));
            },
          },
          {
            label: "Deactivate",
            icon: Pause,
            onClick: () => {
              bulkDeactivateMutation.mutate(Array.from(selectedIds));
            },
          },
          ...(isAdmin
            ? [
                {
                  label: "Delete",
                  icon: Trash2,
                  variant: "destructive" as const,
                  onClick: () => {
                    if (
                      confirm(
                        `Are you sure you want to delete ${selectedIds.size} monitors?`,
                      )
                    ) {
                      bulkDeleteMutation.mutate(Array.from(selectedIds));
                    }
                  },
                },
              ]
            : []),
        ]}
      />
    </div>
  );
}
