import { useState, useMemo, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Pencil,
  Trash2,
  MoreHorizontal,
  Server as ServerIcon,
  Globe,
  Layers,
  ExternalLink,
  History,
  HardDrive,
  FolderPlus,
  Archive,
  RotateCcw,
  BookmarkPlus,
} from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { isHttpStatusWorking } from "@bedrock-forge/shared";
import { api } from "@/lib/api-client";
import { useAuthStore } from "@/store/auth.store";
import { toast } from "@/hooks/use-toast";
import {
  ArchiveDialog,
  RestoreDialog,
} from "@/components/ProjectArchiveDialogs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { AlertDialog } from "@/components/ui/alert-dialog";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  ErrorState,
  PageHeader,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Checkbox } from "@/components/ui/checkbox";
import { BulkActionsBar } from "@/components/ui/bulk-actions-bar";
import { EmptyState } from "@/components/ui/EmptyState";
import { ImportFromServerDialog } from "./projects/ImportFromServerDialog";
import { CreateBedrockDialog } from "./projects/CreateBedrockDialog";
import { useServersList } from "@/hooks/useServersList";
import {
  ExecutionLogPanel,
  ExpandLogButton,
} from "@/components/ui/execution-log-panel";
import { useWebSocketEvent } from "@/lib/websocket";

interface Client {
  id: number;
  name: string;
}

interface Package {
  id: number;
  name: string;
}

interface ProjectEnvironment {
  id: number;
  url: string;
  type: string;
  server: { id: number; name: string; ip_address: string };
  monitors: { last_status: number | null; uptime_pct: string | null }[];
  backups: { created_at: string; status: string }[];
}

interface Project {
  id: number;
  name: string;
  status: "active" | "inactive" | "archived";
  client: { id: number; name: string };
  hosting_package: { name: string } | null;
  support_package: { name: string } | null;
  _count: { environments: number };
  environments: ProjectEnvironment[];
}

const projectSchema = z.object({
  name: z.string().min(1, "Name is required").max(150),
  status: z.enum(["active", "inactive"], {
    required_error: "Status is required",
  }),
  client_id: z.coerce
    .number({ invalid_type_error: "Client is required" })
    .positive("Client is required"),
  hosting_package_id: z.coerce.number().optional(),
  support_package_id: z.coerce.number().optional(),
});
type ProjectForm = z.infer<typeof projectSchema>;

const STATUS_OPTIONS = ["active", "inactive"] as const;
const SAVED_PROJECT_VIEWS_KEY = "bedrock-forge:saved-project-views:v1";
const SAVED_VIEW_STATUS_OPTIONS = [
  "exclude:archived",
  "active",
  "inactive",
  "archived",
  "all",
] as const;
const SAVED_VIEW_COVERAGE_OPTIONS = [
  "all-coverage",
  "no_backup",
  "stale_backup",
  "down",
  "unmonitored",
  "never_scanned",
] as const;

function validProjectFilter(
  value: string | null,
  allowed: readonly string[],
  fallback: string,
): string {
  return value && allowed.includes(value) ? value : fallback;
}

function validResourceId(value: string | null): string {
  return value && /^[1-9]\d*$/.test(value) ? value : "";
}

interface SavedProjectView {
  id: string;
  name: string;
  search: string;
  clientId: string;
  serverId: string;
  status: string;
  coverage: string;
}

function loadSavedProjectViews(): SavedProjectView[] {
  try {
    const raw: unknown = JSON.parse(
      window.localStorage.getItem(SAVED_PROJECT_VIEWS_KEY) ?? "null",
    );
    if (!Array.isArray(raw)) return [];
    return raw
      .flatMap((item): SavedProjectView[] => {
        if (typeof item !== "object" || item === null) return [];
        const view = item as Record<string, unknown>;
        if (
          typeof view.id !== "string" ||
          typeof view.name !== "string" ||
          typeof view.search !== "string" ||
          typeof view.clientId !== "string" ||
          typeof view.serverId !== "string" ||
          typeof view.status !== "string" ||
          !SAVED_VIEW_STATUS_OPTIONS.includes(
            view.status as (typeof SAVED_VIEW_STATUS_OPTIONS)[number],
          ) ||
          typeof view.coverage !== "string" ||
          !SAVED_VIEW_COVERAGE_OPTIONS.includes(
            view.coverage as (typeof SAVED_VIEW_COVERAGE_OPTIONS)[number],
          ) ||
          (view.clientId !== "" && !/^[1-9]\d*$/.test(view.clientId)) ||
          (view.serverId !== "" && !/^[1-9]\d*$/.test(view.serverId))
        ) {
          return [];
        }
        return [
          {
            id: view.id,
            name: view.name,
            search: view.search,
            clientId: view.clientId,
            serverId: view.serverId,
            status: view.status,
            coverage: view.coverage,
          },
        ];
      })
      .slice(0, 20);
  } catch {
    return [];
  }
}

export function ProjectFormDialog({
  open,
  onOpenChange,
  initial,
  clients,
  hostingPackages,
  supportPackages,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  initial?: Project;
  clients: Client[];
  hostingPackages: Package[];
  supportPackages: Package[];
  onSuccess: () => void;
}) {
  const {
    register,
    handleSubmit,
    setValue,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ProjectForm>({
    resolver: zodResolver(projectSchema),
    defaultValues: {
      name: initial?.name ?? "",
      status:
        initial?.status === "archived"
          ? "inactive"
          : (initial?.status ?? "active"),
      client_id: initial?.client.id ?? undefined,
      hosting_package_id: undefined,
      support_package_id: undefined,
    },
  });

  async function onSubmit(data: ProjectForm) {
    try {
      const payload = {
        name: data.name,
        client_id: data.client_id,
        hosting_package_id: data.hosting_package_id || undefined,
        support_package_id: data.support_package_id || undefined,
      };
      if (initial) {
        await api.put(`/projects/${initial.id}`, {
          ...payload,
          ...(initial.status === "archived" ? {} : { status: data.status }),
        });
        toast({ title: "Project updated" });
      } else {
        await api.post("/projects", { ...payload, status: data.status });
        toast({ title: "Project created" });
      }
      reset();
      onSuccess();
      onOpenChange(false);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Save failed. Please try again.";
      setError("root", { message });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{initial ? "Edit Project" : "New Project"}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="p-name">Name *</Label>
            <Input id="p-name" {...register("name")} placeholder="My Website" />
            {errors.name && (
              <p className="text-xs text-destructive">{errors.name.message}</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Client *</Label>
              <Select
                defaultValue={initial?.client.id?.toString()}
                onValueChange={(v) => setValue("client_id", Number(v))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select client…" />
                </SelectTrigger>
                <SelectContent>
                  {clients.map((c) => (
                    <SelectItem key={c.id} value={c.id.toString()}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.client_id && (
                <p className="text-xs text-destructive">
                  {errors.client_id.message}
                </p>
              )}
            </div>
            <div className="space-y-1">
              <Label>Status</Label>
              {initial?.status === "archived" ? (
                <div className="flex min-h-10 items-center">
                  <Badge variant="secondary">
                    Archived — restore from the project actions
                  </Badge>
                </div>
              ) : (
                <Select
                  defaultValue={initial?.status ?? "active"}
                  onValueChange={(v) =>
                    setValue("status", v as "active" | "inactive")
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STATUS_OPTIONS.map((s) => (
                      <SelectItem key={s} value={s}>
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          </div>

          {hostingPackages.length > 0 && (
            <div className="space-y-1">
              <Label>Hosting Package</Label>
              <Select
                onValueChange={(v) =>
                  setValue("hosting_package_id", v ? Number(v) : undefined)
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  {hostingPackages.map((p) => (
                    <SelectItem key={p.id} value={p.id.toString()}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {supportPackages.length > 0 && (
            <div className="space-y-1">
              <Label>Support Package</Label>
              <Select
                onValueChange={(v) =>
                  setValue("support_package_id", v ? Number(v) : undefined)
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  {supportPackages.map((p) => (
                    <SelectItem key={p.id} value={p.id.toString()}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
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
              {isSubmitting ? "Saving…" : initial ? "Update" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const STATUS_VARIANT: Record<
  string,
  "success" | "destructive" | "secondary" | "warning"
> = {
  active: "success",
  inactive: "secondary",
  archived: "secondary",
  pending: "warning",
  suspended: "destructive",
  cancelled: "destructive",
};

function ProjectCard({
  project,
  onEdit,
  onDelete,
  onArchive,
  onRestore,
  onClick,
  onBackupNow,
  selected,
  onSelect,
  isAdmin,
}: {
  project: Project;
  onEdit: () => void;
  onDelete: () => void;
  onArchive: () => void;
  onRestore: () => void;
  onClick: () => void;
  onBackupNow: (envId: number) => void;
  selected: boolean;
  onSelect: (val: boolean) => void;
  isAdmin: boolean;
}) {
  const servers = [
    ...new Map(
      project.environments.map((e) => [e.server.id, e.server]),
    ).values(),
  ];

  function relativeTime(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    const h = Math.floor(diff / 3_600_000);
    if (h < 1) return `${Math.floor(diff / 60_000)}m ago`;
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }

  function MonitorDot({ env }: { env: ProjectEnvironment }) {
    const monitor = env.monitors?.[0] ?? null;
    if (!monitor)
      return (
        <span
          className="h-2 w-2 rounded-full bg-muted-foreground/40 shrink-0"
          title="No monitor"
          role="img"
          aria-label="No monitor configured"
        />
      );
    const s = monitor.last_status;
    if (s === null)
      return (
        <span
          className="h-2 w-2 rounded-full bg-muted-foreground/40 shrink-0"
          title="Pending"
          role="img"
          aria-label="Monitor check pending"
        />
      );
    if (isHttpStatusWorking(s))
      return (
        <span
          className="h-2 w-2 rounded-full bg-green-500 shrink-0"
          title={`Working (HTTP ${s})`}
          role="img"
          aria-label={`Working, HTTP ${s}`}
        />
      );
    return (
      <span
        className="h-2 w-2 rounded-full bg-red-500 shrink-0"
        title={`Down (${s})`}
        role="img"
        aria-label={`Down, HTTP ${s}`}
      />
    );
  }

  return (
    <Card
      className={`group relative cursor-pointer hover:border-primary/50 transition-all duration-200 ${selected ? "border-primary bg-primary/5 ring-1 ring-primary" : ""}`}
      onClick={onClick}
    >
      {isAdmin && (
        <div
          className="absolute top-3 left-3 z-10"
          onClick={(e) => e.stopPropagation()}
        >
          <Checkbox
            checked={selected}
            onCheckedChange={(v) => onSelect(!!v)}
            className={`transition-opacity ${selected ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
          />
        </div>
      )}

      <CardHeader className="pb-3 pl-10">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold text-sm truncate leading-tight">
              {project.name}
            </h3>
            <p className="text-xs text-muted-foreground mt-0.5 truncate">
              {project.client.name}
            </p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <Badge
              variant={STATUS_VARIANT[project.status] ?? "secondary"}
              className="text-xs"
            >
              {project.status}
            </Badge>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={(e) => e.stopPropagation()}
                >
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation();
                    onEdit();
                  }}
                >
                  <Pencil className="h-4 w-4 mr-2" />
                  Edit
                </DropdownMenuItem>

                {project.status === "archived" ? (
                  <DropdownMenuItem
                    className="text-emerald-600 dark:text-emerald-400 focus:text-emerald-600 dark:focus:text-emerald-400 font-medium"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRestore();
                    }}
                  >
                    <RotateCcw className="h-4 w-4 mr-2" />
                    Restore Archive
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem
                    className="text-amber-600 dark:text-amber-400 focus:text-amber-600 dark:focus:text-amber-400 font-medium"
                    onClick={(e) => {
                      e.stopPropagation();
                      onArchive();
                    }}
                  >
                    <Archive className="h-4 w-4 mr-2" />
                    Archive Project
                  </DropdownMenuItem>
                )}

                {isAdmin && (
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete();
                    }}
                  >
                    <Trash2 className="h-4 w-4 mr-2" />
                    Delete
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </CardHeader>

      <CardContent className="pt-0 pl-10 space-y-1.5">
        {project.environments.map((env) => {
          const lastBackup = env.backups[0];
          return (
            <div
              key={env.id}
              className="flex items-center gap-1.5 min-w-0 group/env"
            >
              <MonitorDot env={env} />
              <a
                href={env.url}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-primary hover:underline truncate flex items-center gap-1 flex-1 min-w-0"
                onClick={(e) => e.stopPropagation()}
              >
                {env.url.replace(/^https?:\/\//, "")}
                <ExternalLink className="h-2.5 w-2.5 shrink-0" />
              </a>
              <Badge
                variant="outline"
                className="text-[10px] px-1.5 py-0 shrink-0"
              >
                {env.type}
              </Badge>
              {lastBackup ? (
                <span
                  className="text-[10px] text-muted-foreground shrink-0"
                  title={`Last backup: ${lastBackup.status}`}
                >
                  {relativeTime(lastBackup.created_at)}
                </span>
              ) : (
                <span className="text-[10px] text-amber-500 shrink-0">
                  no backup
                </span>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5 opacity-0 group-hover/env:opacity-100 transition-opacity shrink-0"
                title="Backup now"
                onClick={(e) => {
                  e.stopPropagation();
                  onBackupNow(env.id);
                }}
              >
                <HardDrive className="h-3 w-3" />
              </Button>
            </div>
          );
        })}
        {servers.length > 0 && (
          <div className="flex items-center gap-1.5 min-w-0 pt-1 border-t border-border/50">
            <ServerIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="text-xs text-muted-foreground truncate">
              {servers.map((s) => s.name).join(", ")}
            </span>
          </div>
        )}
        <div className="flex items-center gap-1.5">
          <Layers className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">
            {project._count.environments}{" "}
            {project._count.environments === 1 ? "environment" : "environments"}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Bedrock Jobs Dialog ─────────────────────────────────────────────────────

interface BedrockJobRow {
  id: number;
  status: string;
  progress: number | null;
  last_error: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  environment: {
    id: number;
    type: string;
    url: string | null;
    project: { id: number; name: string; client: { id: number; name: string } };
  } | null;
}

const BEDROCK_JOB_STATUS_VARIANT: Record<
  string,
  "success" | "destructive" | "info" | "secondary"
> = {
  completed: "success",
  failed: "destructive",
  active: "info",
  pending: "secondary",
};

function bedrockDuration(
  started?: string | null,
  completed?: string | null,
): string {
  if (!started) return "—";
  const diff =
    (completed ? new Date(completed).getTime() : Date.now()) -
    new Date(started).getTime();
  if (diff < 1000) return `${diff}ms`;
  if (diff < 60_000) return `${(diff / 1000).toFixed(1)}s`;
  return `${Math.floor(diff / 60_000)}m ${Math.floor((diff % 60_000) / 1000)}s`;
}

function BedrockJobsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const qc = useQueryClient();
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["bedrock-jobs"],
    queryFn: () =>
      api.get<{ data: BedrockJobRow[]; total: number }>(
        "/job-executions?queue_name=projects&limit=10",
      ),
    enabled: open,
    staleTime: 10_000,
    refetchInterval: open ? 10_000 : false,
  });

  useWebSocketEvent("job:completed", () => {
    qc.invalidateQueries({ queryKey: ["bedrock-jobs"] });
  });
  useWebSocketEvent("job:failed", () => {
    qc.invalidateQueries({ queryKey: ["bedrock-jobs"] });
  });

  const rows = data?.data ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Bedrock Provisioning Jobs</DialogTitle>
        </DialogHeader>

        <div className="mt-2 max-h-[60vh] overflow-y-auto">
          {isLoading ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              Loading…
            </div>
          ) : rows.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              No Bedrock provisioning jobs found.
            </div>
          ) : (
            <div className="divide-y rounded-md border">
              {rows.map((row) => {
                const isActive =
                  row.status === "active" || row.status === "pending";
                const isExpanded = expandedId === row.id;
                return (
                  <div key={row.id}>
                    <div className="flex items-center gap-3 px-4 py-3">
                      <Badge
                        variant={
                          BEDROCK_JOB_STATUS_VARIANT[row.status] ?? "secondary"
                        }
                        className="shrink-0 capitalize"
                      >
                        {row.status}
                      </Badge>
                      <div className="min-w-0 flex-1">
                        {row.environment ? (
                          <p className="text-sm font-medium truncate">
                            {row.environment.project.name}
                          </p>
                        ) : (
                          <p className="text-sm text-muted-foreground">—</p>
                        )}
                        {row.environment?.url && (
                          <p className="text-xs text-muted-foreground truncate">
                            {row.environment.url}
                          </p>
                        )}
                        {row.last_error && (
                          <p
                            className="text-xs text-destructive truncate"
                            title={row.last_error}
                          >
                            {row.last_error}
                          </p>
                        )}
                      </div>
                      <div className="shrink-0 text-right text-xs text-muted-foreground space-y-0.5">
                        <p>
                          {new Date(
                            row.started_at ?? row.created_at,
                          ).toLocaleString([], {
                            dateStyle: "short",
                            timeStyle: "short",
                          })}
                        </p>
                        <p>
                          {bedrockDuration(row.started_at, row.completed_at)}
                        </p>
                      </div>
                      <ExpandLogButton
                        expanded={isExpanded}
                        onToggle={() =>
                          setExpandedId(isExpanded ? null : row.id)
                        }
                      />
                    </div>
                    {isExpanded && (
                      <div className="px-4 pb-4 bg-muted/20">
                        <ExecutionLogPanel
                          jobExecutionId={row.id}
                          isActive={isActive}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────

function ProjectCardSkeleton() {
  return (
    <Card className="animate-pulse">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="space-y-1.5 flex-1">
            <div className="h-4 bg-muted rounded w-3/4" />
            <div className="h-3 bg-muted rounded w-1/2" />
          </div>
          <div className="h-5 bg-muted rounded w-14" />
        </div>
      </CardHeader>
      <CardContent className="pt-0 space-y-2">
        <div className="h-3 bg-muted rounded w-full" />
        <div className="h-3 bg-muted rounded w-2/3" />
        <div className="h-3 bg-muted rounded w-1/3" />
      </CardContent>
    </Card>
  );
}

export function ProjectsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const isAdmin = useAuthStore(
    (s) => s.user?.roles?.includes("admin") ?? false,
  );
  const [searchParams, setSearchParams] = useSearchParams();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState(() => searchParams.get("search") ?? "");
  const [searchInput, setSearchInput] = useState(
    () => searchParams.get("search") ?? "",
  );
  const [clientFilter, setClientFilter] = useState(() => {
    return validResourceId(searchParams.get("client_id"));
  });
  const [serverFilter, setServerFilter] = useState(() => {
    return validResourceId(searchParams.get("server_id"));
  });
  const [statusFilter, setStatusFilter] = useState(() =>
    validProjectFilter(
      searchParams.get("status"),
      SAVED_VIEW_STATUS_OPTIONS,
      "exclude:archived",
    ),
  );
  const [coverageFilter, setCoverageFilter] = useState(() =>
    validProjectFilter(
      searchParams.get("coverage"),
      SAVED_VIEW_COVERAGE_OPTIONS,
      "all-coverage",
    ),
  );
  const [savedViews, setSavedViews] = useState(loadSavedProjectViews);
  const [selectedSavedViewId, setSelectedSavedViewId] = useState("");
  const [saveViewOpen, setSaveViewOpen] = useState(false);
  const [savedViewName, setSavedViewName] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [bedrockOpen, setBedrockOpen] = useState(false);
  const [bedrockJobsOpen, setBedrockJobsOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Project | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<Project | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<Project | null>(null);

  // ── Selection State ──────────────────────────────────────────────────────
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: [
      "projects",
      page,
      search,
      clientFilter,
      serverFilter,
      statusFilter,
      coverageFilter,
    ],
    queryFn: () => {
      const qs = new URLSearchParams({ page: String(page), limit: "10" });
      if (search) qs.set("search", search);
      if (clientFilter) qs.set("client_id", clientFilter);
      if (serverFilter) qs.set("server_id", serverFilter);
      if (statusFilter && statusFilter !== "all")
        qs.set("status", statusFilter);
      if (coverageFilter !== "all-coverage") qs.set("coverage", coverageFilter);
      return api.get<{ items: Project[]; total: number }>(`/projects?${qs}`);
    },
  });

  const { data: clients = [] } = useQuery({
    queryKey: ["clients-list"],
    queryFn: () =>
      api.get<{ items: Client[] }>("/clients?limit=100").then((r) => r.items),
  });

  const { data: servers = [] } = useServersList();

  const { data: hostingPkgs = [] } = useQuery({
    queryKey: ["packages-hosting"],
    queryFn: () => api.get<Package[]>("/packages/hosting"),
  });

  const { data: supportPkgs = [] } = useQuery({
    queryKey: ["packages-support"],
    queryFn: () => api.get<Package[]>("/packages/support"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) =>
      api.delete<{ message?: string }>(`/projects/${id}`),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      setDeleteTarget(null);
      toast({
        title: result?.message
          ? "Project decommissioning queued"
          : "Project deleted",
        description: result?.message,
      });
    },
    onError: () => toast({ title: "Delete failed", variant: "destructive" }),
  });

  const archiveMutation = useMutation({
    mutationFn: (options: {
      createBackup: boolean;
      deleteFromCyberpanel: boolean;
    }) => api.post(`/projects/${archiveTarget?.id}/archive`, options),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      setArchiveTarget(null);
      toast({ title: "Project archival queued successfully" });
    },
    onError: (err) =>
      toast({
        title: "Archival failed",
        description: err.message || "An error occurred",
        variant: "destructive",
      }),
  });

  const restoreMutation = useMutation({
    mutationFn: (selections: Record<string, number>) =>
      api.post(`/projects/${restoreTarget?.id}/restore-archive`, {
        environmentBackups: selections,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      setRestoreTarget(null);
      toast({ title: "Project restoration queued successfully" });
    },
    onError: (err) =>
      toast({
        title: "Restoration failed",
        description: err.message || "An error occurred",
        variant: "destructive",
      }),
  });

  const backupNowMutation = useMutation({
    mutationFn: (environmentId: number) =>
      api.post("/backups/create", {
        environment_id: environmentId,
        type: "full",
      }),
    onSuccess: () => toast({ title: "Backup queued" }),
    onError: () =>
      toast({ title: "Failed to queue backup", variant: "destructive" }),
  });

  const totalPages = data ? Math.ceil(data.total / 10) : 1;

  function invalidate() {
    qc.invalidateQueries({ queryKey: ["projects"] });
  }

  const projects = data?.items ?? [];

  useEffect(() => {
    try {
      window.localStorage.setItem(
        SAVED_PROJECT_VIEWS_KEY,
        JSON.stringify(savedViews),
      );
    } catch {
      // The current filters remain usable when browser storage is unavailable.
    }
  }, [savedViews]);

  function applySavedView(viewId: string) {
    const view = savedViews.find((candidate) => candidate.id === viewId);
    if (!view) {
      setSelectedSavedViewId("");
      return;
    }
    setSelectedSavedViewId(viewId);
    setSearch(view.search);
    setSearchInput(view.search);
    setClientFilter(view.clientId);
    setServerFilter(view.serverId);
    setStatusFilter(view.status);
    setCoverageFilter(view.coverage);
    setSearchParams((previous) => {
      if (view.search) previous.set("search", view.search);
      else previous.delete("search");
      if (view.clientId) previous.set("client_id", view.clientId);
      else previous.delete("client_id");
      if (view.serverId) previous.set("server_id", view.serverId);
      else previous.delete("server_id");
      if (view.status && view.status !== "exclude:archived") {
        previous.set("status", view.status);
      } else {
        previous.delete("status");
      }
      if (view.coverage && view.coverage !== "all-coverage") {
        previous.set("coverage", view.coverage);
      } else {
        previous.delete("coverage");
      }
      return previous;
    });
    setPage(1);
  }

  function saveCurrentView() {
    const name = savedViewName.trim();
    if (!name) return;
    const existing = savedViews.find(
      (view) => view.name.toLowerCase() === name.toLowerCase(),
    );
    const view: SavedProjectView = {
      id: existing?.id ?? crypto.randomUUID(),
      name,
      search,
      clientId: clientFilter,
      serverId: serverFilter,
      status: statusFilter,
      coverage: coverageFilter,
    };
    setSavedViews((current) =>
      [view, ...current.filter((candidate) => candidate.id !== view.id)].slice(
        0,
        20,
      ),
    );
    setSelectedSavedViewId(view.id);
    setSavedViewName("");
    setSaveViewOpen(false);
  }

  function deleteSavedView() {
    setSavedViews((current) =>
      current.filter((view) => view.id !== selectedSavedViewId),
    );
    setSelectedSavedViewId("");
  }

  useEffect(() => {
    const visibleIds = new Set(projects.map((project) => project.id));
    setSelectedIds((previous) => {
      const next = new Set(
        [...previous].filter((projectId) => visibleIds.has(projectId)),
      );
      return next.size === previous.size ? previous : next;
    });
  }, [projects]);

  // ── Selection Logic ──────────────────────────────────────────────────────
  const toggleSelect = (id: number) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  };

  const clearSelection = () => setSelectedIds(new Set());

  const isAllSelected =
    projects.length > 0 && projects.every((p) => selectedIds.has(p.id));

  const toggleAll = () => {
    if (isAllSelected) {
      const next = new Set(selectedIds);
      projects.forEach((p) => next.delete(p.id));
      setSelectedIds(next);
    } else {
      const next = new Set(selectedIds);
      projects.forEach((p) => next.add(p.id));
      setSelectedIds(next);
    }
  };

  const bulkDeleteMutation = useMutation({
    mutationFn: async (ids: number[]) => {
      for (const id of ids) {
        await api.delete(`/projects/${id}`);
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      clearSelection();
      toast({
        title: "Project removal requests completed",
        description:
          "Projects with remote resources remain archived until cleanup finishes.",
      });
    },
    onError: () =>
      toast({ title: "Bulk delete failed", variant: "destructive" }),
  });

  return (
    <div className="space-y-4">
      <PageHeader title="Projects">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm">
              <FolderPlus className="mr-1.5 h-4 w-4" />
              Add project / site
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => setCreateOpen(true)}>
              New project
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setImportOpen(true)}>
              <ServerIcon className="mr-2 h-4 w-4" />
              Import existing site
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setBedrockOpen(true)}>
              <Layers className="mr-2 h-4 w-4" />
              Provision Bedrock site
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setBedrockJobsOpen(true)}>
              <History className="mr-2 h-4 w-4" />
              View provisioning jobs
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </PageHeader>

      <SearchBar
        value={searchInput}
        onChange={setSearchInput}
        onSearch={() => {
          setSearch(searchInput);
          setSelectedSavedViewId("");
          setSearchParams((previous) => {
            if (searchInput) previous.set("search", searchInput);
            else previous.delete("search");
            return previous;
          });
          setPage(1);
        }}
        onClear={() => {
          setSearch("");
          setSearchInput("");
          setSelectedSavedViewId("");
          setSearchParams((previous) => {
            previous.delete("search");
            return previous;
          });
          setPage(1);
        }}
        placeholder="Search projects, URLs, clients, servers, and tags…"
        totalCount={data?.total ?? 0}
        totalLabel="total projects"
      >
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={selectedSavedViewId || "saved-view-none"}
            onValueChange={applySavedView}
          >
            <SelectTrigger className="w-[170px] h-9">
              <SelectValue placeholder="Saved views" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="saved-view-none">Saved views</SelectItem>
              {savedViews.map((view) => (
                <SelectItem key={view.id} value={view.id}>
                  {view.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={coverageFilter}
            onValueChange={(value) => {
              setCoverageFilter(value);
              setSelectedSavedViewId("");
              setSearchParams((previous) => {
                if (value === "all-coverage") previous.delete("coverage");
                else previous.set("coverage", value);
                return previous;
              });
              setPage(1);
            }}
          >
            <SelectTrigger className="w-[190px] h-9">
              <SelectValue placeholder="All coverage" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all-coverage">All coverage</SelectItem>
              <SelectItem value="no_backup">No completed backup</SelectItem>
              <SelectItem value="stale_backup">
                Backup older than 30 days
              </SelectItem>
              <SelectItem value="down">Site down</SelectItem>
              <SelectItem value="unmonitored">No active monitor</SelectItem>
              <SelectItem value="never_scanned">
                Never plugin scanned
              </SelectItem>
            </SelectContent>
          </Select>
          {selectedSavedViewId && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-9 w-9"
              aria-label="Delete saved view"
              title="Delete saved view"
              onClick={deleteSavedView}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9"
            onClick={() => setSaveViewOpen(true)}
          >
            <BookmarkPlus className="mr-1.5 h-4 w-4" />
            Save view
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={clientFilter || "all-clients"}
            onValueChange={(v) => {
              const nextFilter = v === "all-clients" ? "" : v;
              setClientFilter(nextFilter);
              setSelectedSavedViewId("");
              setSearchParams((prev) => {
                if (nextFilter) prev.set("client_id", nextFilter);
                else prev.delete("client_id");
                return prev;
              });
              setPage(1);
            }}
          >
            <SelectTrigger className="w-[160px] h-9">
              <SelectValue placeholder="All Clients" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all-clients">All Clients</SelectItem>
              {clients.map((c) => (
                <SelectItem key={c.id} value={c.id.toString()}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={serverFilter || "all-servers"}
            onValueChange={(v) => {
              const nextFilter = v === "all-servers" ? "" : v;
              setServerFilter(nextFilter);
              setSelectedSavedViewId("");
              setSearchParams((prev) => {
                if (nextFilter) prev.set("server_id", nextFilter);
                else prev.delete("server_id");
                return prev;
              });
              setPage(1);
            }}
          >
            <SelectTrigger className="w-[160px] h-9">
              <SelectValue placeholder="All Servers" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all-servers">All Servers</SelectItem>
              {servers.map((s) => (
                <SelectItem key={s.id} value={s.id.toString()}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={statusFilter}
            onValueChange={(v) => {
              setStatusFilter(v);
              setSelectedSavedViewId("");
              setSearchParams((prev) => {
                if (v && v !== "exclude:archived") prev.set("status", v);
                else prev.delete("status");
                return prev;
              });
              setPage(1);
            }}
          >
            <SelectTrigger className="w-[160px] h-9">
              <SelectValue placeholder="Active Projects" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="exclude:archived">Exclude archived</SelectItem>
              <SelectItem value="archived">Archived Only</SelectItem>
              <SelectItem value="all">All Statuses</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </SearchBar>

      <div className="flex items-center justify-between px-1">
        {isAdmin ? (
          <div className="flex items-center gap-2">
            <Checkbox
              id="select-all"
              checked={isAllSelected}
              onCheckedChange={toggleAll}
            />
            <Label
              htmlFor="select-all"
              className="text-sm font-normal cursor-pointer"
            >
              Select all on this page
            </Label>
          </div>
        ) : (
          <span />
        )}
        <p className="text-xs text-muted-foreground">
          Showing {projects.length} of {data?.total ?? 0} projects
        </p>
      </div>

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <ProjectCardSkeleton key={i} />
          ))}
        </div>
      ) : isError ? (
        <ErrorState
          title="Could not load projects"
          description="Your project list could not be retrieved. Try again."
          onRetry={() => void refetch()}
        />
      ) : projects.length === 0 ? (
        <EmptyState
          icon={FolderPlus}
          title="No projects found"
          description="You haven’t created any projects yet. Start by creating a new project or importing one from a server."
          action={{
            label: "Create Project",
            onClick: () => setCreateOpen(true),
            icon: FolderPlus,
          }}
          className="py-20"
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {projects.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              selected={selectedIds.has(project.id)}
              onSelect={() => toggleSelect(project.id)}
              onEdit={() => setEditTarget(project)}
              onDelete={() => setDeleteTarget(project)}
              onArchive={() => setArchiveTarget(project)}
              onRestore={() => setRestoreTarget(project)}
              onClick={() => navigate(`/projects/${project.id}`)}
              onBackupNow={(envId) => backupNowMutation.mutate(envId)}
              isAdmin={isAdmin}
            />
          ))}
        </div>
      )}

      {totalPages > 1 && (
        <Pagination
          page={page}
          totalPages={totalPages}
          onPageChange={setPage}
        />
      )}

      <Dialog open={saveViewOpen} onOpenChange={setSaveViewOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Save this project view</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="saved-project-view-name">View name</Label>
            <Input
              id="saved-project-view-name"
              value={savedViewName}
              onChange={(event) => setSavedViewName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && savedViewName.trim()) {
                  event.preventDefault();
                  saveCurrentView();
                }
              }}
              maxLength={60}
              placeholder="Production sites for Acme"
              autoFocus
            />
            <p className="text-xs text-muted-foreground">
              Saves the current search, client, server, and status filters in
              this browser.
            </p>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setSaveViewOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={saveCurrentView}
              disabled={!savedViewName.trim()}
            >
              Save view
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ProjectFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        clients={clients}
        hostingPackages={hostingPkgs}
        supportPackages={supportPkgs}
        onSuccess={invalidate}
      />
      {editTarget && (
        <ProjectFormDialog
          key={editTarget.id}
          open
          onOpenChange={(o) => !o && setEditTarget(null)}
          initial={editTarget}
          clients={clients}
          hostingPackages={hostingPkgs}
          supportPackages={supportPkgs}
          onSuccess={invalidate}
        />
      )}

      <ImportFromServerDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        clients={clients}
        onSuccess={invalidate}
      />
      <CreateBedrockDialog
        open={bedrockOpen}
        onOpenChange={setBedrockOpen}
        onSuccess={invalidate}
      />
      <BedrockJobsDialog
        open={bedrockJobsOpen}
        onOpenChange={setBedrockJobsOpen}
      />
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title="Delete Project"
        description={`This starts remote cleanup for "${deleteTarget?.name}". The project remains archived while its environments are decommissioned, then the project record is removed.`}
        confirmLabel="Delete"
        confirmVariant="destructive"
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
        isPending={deleteMutation.isPending}
        requireTextConfirm={deleteTarget?.name}
      />

      {isAdmin && (
        <BulkActionsBar
          selectedCount={selectedIds.size}
          onClear={clearSelection}
          actions={[
            {
              label: "Delete",
              icon: Trash2,
              variant: "destructive",
              onClick: () => {
                if (
                  confirm(
                    `Are you sure you want to delete ${selectedIds.size} projects?`,
                  )
                ) {
                  bulkDeleteMutation.mutate(Array.from(selectedIds));
                }
              },
            },
          ]}
        />
      )}
      <ArchiveDialog
        open={!!archiveTarget}
        onOpenChange={(open) => !open && setArchiveTarget(null)}
        projectName={archiveTarget?.name ?? ""}
        onConfirm={(options) => archiveMutation.mutate(options)}
        isPending={archiveMutation.isPending}
      />

      <RestoreDialog
        open={!!restoreTarget}
        onOpenChange={(open) => !open && setRestoreTarget(null)}
        environments={restoreTarget?.environments ?? []}
        onConfirm={(selections) => restoreMutation.mutate(selections)}
        isPending={restoreMutation.isPending}
      />
    </div>
  );
}
