import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Pencil,
  Trash2,
  MoreHorizontal,
  Plug,
  ExternalLink,
  ChevronDown,
  ChevronUp,
  Server as ServerIcon,
  Activity,
} from "lucide-react";
import { api } from "@/lib/api-client";
import { toast } from "@/hooks/use-toast";
import { useAuthStore } from "@/store/auth.store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { AlertDialog } from "@/components/ui/alert-dialog";
import {
  PageHeader,
  SearchBar,
  DataTable,
  type Column,
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Checkbox } from "@/components/ui/checkbox";
import { BulkActionsBar } from "@/components/ui/bulk-actions-bar";

export interface Server {
  id: number;
  name: string;
  ip_address: string;
  ssh_port: number;
  ssh_user: string;
  provider: string | null;
  status: "online" | "offline" | "unknown";
  cyberpanel_version?: string | null;
}

const serverSchema = z.object({
  name: z.string().min(1, "Name is required").max(100),
  ip_address: z.string().min(1, "IP/hostname is required"),
  ssh_port: z.coerce.number().int().min(1).max(65535).default(22),
  ssh_user: z.string().min(1, "SSH user is required").default("root"),
  ssh_private_key: z.string().optional(),
  provider: z.string().optional().or(z.literal("")),
  // Panel credentials (CyberPanel / control panel)
  panel_url: z.string().optional().or(z.literal("")),
  panel_username: z.string().optional().or(z.literal("")),
  panel_password: z.string().optional(),
});
type ServerForm = z.infer<typeof serverSchema>;

interface PanelCredentials {
  url?: string;
  username: string;
  password?: string;
}

const STATUS_VARIANT: Record<string, "success" | "destructive" | "secondary"> =
  {
    online: "success",
    offline: "destructive",
    unknown: "secondary",
  };

export function ServerFormDialog({
  open,
  onOpenChange,
  initial,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  initial?: Server;
  onSuccess: () => void;
}) {
  const [panelExpanded, setPanelExpanded] = useState(false);

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ServerForm>({
    resolver: zodResolver(serverSchema),
    defaultValues: {
      name: initial?.name ?? "",
      ip_address: initial?.ip_address ?? "",
      ssh_port: initial?.ssh_port ?? 22,
      ssh_user: initial?.ssh_user ?? "root",
      provider: initial?.provider ?? "",
      ssh_private_key: "",
      panel_url: "",
      panel_username: "",
      panel_password: "",
    },
  });

  // Pre-load existing panel credentials when editing
  useQuery({
    queryKey: ["server-cyberpanel", initial?.id],
    enabled: !!initial?.id,
    queryFn: async () => {
      try {
        const data = await api.get<PanelCredentials>(
          `/servers/${initial!.id}/cyberpanel/credentials`,
        );
        if (data) {
          // Patch the form fields without resetting others
          reset((prev) => ({
            ...prev,
            panel_url: data.url ?? "",
            panel_username: data.username ?? "",
            panel_password: "",
          }));
          if (data.url || data.username) setPanelExpanded(true);
        }
      } catch {
        // No credentials stored yet — that's fine
      }
      return null;
    },
  });

  async function onSubmit(data: ServerForm) {
    try {
      const payload: Record<string, unknown> = {
        name: data.name,
        ip_address: data.ip_address,
        ssh_port: data.ssh_port,
        ssh_user: data.ssh_user,
        provider: data.provider || undefined,
      };
      if (data.ssh_private_key) {
        payload.ssh_private_key = data.ssh_private_key;
      }
      let serverId: number;
      if (initial) {
        await api.put(`/servers/${initial.id}`, payload);
        serverId = initial.id;
        toast({ title: "Server updated" });
      } else {
        const created = await api.post<{ id: number }>("/servers", payload);
        serverId = created.id;
        toast({ title: "Server created" });
      }
      // Save panel credentials if any credential fields are filled
      const hasPanelCreds =
        (data.panel_url && data.panel_url.trim()) ||
        (data.panel_username && data.panel_username.trim()) ||
        (data.panel_password && data.panel_password.trim());
      if (hasPanelCreds) {
        const panelPayload: Record<string, string> = {};
        if (data.panel_url) panelPayload.url = data.panel_url.trim();
        if (data.panel_username)
          panelPayload.username = data.panel_username.trim();
        if (data.panel_password)
          panelPayload.password = data.panel_password.trim();
        try {
          await api.put(
            `/servers/${serverId}/cyberpanel/credentials`,
            panelPayload,
          );
        } catch {
          toast({
            title: "Panel credentials could not be saved",
            variant: "destructive",
          });
        }
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
          <DialogTitle>{initial ? "Edit Server" : "New Server"}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="s-name">Name *</Label>
            <Input
              id="s-name"
              {...register("name")}
              placeholder="Production Web 01"
            />
            {errors.name && (
              <p className="text-xs text-destructive">{errors.name.message}</p>
            )}
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2 space-y-1">
              <Label htmlFor="s-ip">IP / Hostname *</Label>
              <Input
                id="s-ip"
                {...register("ip_address")}
                placeholder="192.168.1.100"
                className="font-mono"
              />
              {errors.ip_address && (
                <p className="text-xs text-destructive">
                  {errors.ip_address.message}
                </p>
              )}
            </div>
            <div className="space-y-1">
              <Label htmlFor="s-port">SSH Port</Label>
              <Input
                id="s-port"
                type="number"
                {...register("ssh_port")}
                placeholder="22"
                className="font-mono"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="s-user">SSH User *</Label>
              <Input
                id="s-user"
                {...register("ssh_user")}
                placeholder="root"
                className="font-mono"
              />
              {errors.ssh_user && (
                <p className="text-xs text-destructive">
                  {errors.ssh_user.message}
                </p>
              )}
            </div>
            <div className="space-y-1">
              <Label htmlFor="s-provider">Provider</Label>
              <Input
                id="s-provider"
                {...register("provider")}
                placeholder="DigitalOcean, AWS…"
              />
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="s-key">
              SSH Private Key
              {initial && (
                <span className="ml-1 text-muted-foreground font-normal">
                  (leave blank to keep current)
                </span>
              )}
            </Label>
            <Textarea
              id="s-key"
              {...register("ssh_private_key")}
              rows={6}
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
              className="font-mono resize-y"
            />
            <p className="text-xs text-muted-foreground">
              Leave blank to use the global SSH key configured in Settings.
            </p>
          </div>
          {/* Panel Credentials (collapsible) */}
          <div className="border rounded-lg">
            <button
              type="button"
              className="flex items-center justify-between w-full px-3 py-2.5 text-sm font-medium text-left hover:bg-muted/40 transition-colors rounded-lg"
              onClick={() => setPanelExpanded((v) => !v)}
            >
              <span>
                Panel Credentials{" "}
                <span className="font-normal text-muted-foreground">
                  (CyberPanel, etc.)
                </span>
              </span>
              {panelExpanded ? (
                <ChevronUp className="h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              )}
            </button>
            {panelExpanded && (
              <div className="px-3 pb-3 space-y-3 border-t pt-3">
                <div className="space-y-1">
                  <Label htmlFor="s-panel-url">Panel URL</Label>
                  <Input
                    id="s-panel-url"
                    {...register("panel_url")}
                    placeholder="https://cp.example.com:8090"
                    className="font-mono"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label htmlFor="s-panel-user">Username</Label>
                    <Input
                      id="s-panel-user"
                      {...register("panel_username")}
                      placeholder="admin"
                      autoComplete="off"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="s-panel-pass">
                      Password
                      {initial && (
                        <span className="ml-1 text-xs text-muted-foreground font-normal">
                          (leave blank to keep)
                        </span>
                      )}
                    </Label>
                    <Input
                      id="s-panel-pass"
                      type="password"
                      {...register("panel_password")}
                      placeholder="••••••••"
                      autoComplete="new-password"
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
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

interface SshHealth {
  active: number;
  idle: number;
  total: number;
  maxConnections: number;
  status: "healthy" | "busy" | "empty";
}

function SshHealthCell({ serverId }: { serverId: number }) {
  const { data } = useQuery<SshHealth>({
    queryKey: ["ssh-health", serverId],
    queryFn: () => api.get(`/servers/${serverId}/ssh-health`),
    staleTime: 30_000,
    retry: false,
  });

  if (!data) return <span className="text-muted-foreground">—</span>;

  const statusClass =
    data.status === "healthy"
      ? "text-green-600 dark:text-green-400"
      : data.status === "busy"
        ? "text-yellow-600 dark:text-yellow-400"
        : "text-muted-foreground";

  return (
    <span className={`text-xs font-mono ${statusClass}`}>
      {data.active}/{data.total}
    </span>
  );
}

export function ServersPage() {
  const qc = useQueryClient();
  const isAdmin = useAuthStore(
    (s) => s.user?.roles?.includes("admin") ?? false,
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Server | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Server | null>(null);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");

  // ── Selection State ──────────────────────────────────────────────────────
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["servers", page, search],
    queryFn: () =>
      api.get<{ items: Server[]; total: number }>(
        `/servers?page=${page}&limit=10${search ? `&search=${encodeURIComponent(search)}` : ""}`,
      ),
  });

  const servers = data?.items ?? [];

  useEffect(() => {
    const visibleIds = new Set(servers.map((server) => server.id));
    setSelectedIds((previous) => {
      const next = new Set(
        [...previous].filter((serverId) => visibleIds.has(serverId)),
      );
      return next.size === previous.size ? previous : next;
    });
  }, [servers]);
  const totalPages = data ? Math.ceil(data.total / 10) : 1;

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.delete(`/servers/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["servers"] });
      setDeleteTarget(null);
      toast({ title: "Server deleted" });
    },
    onError: () => toast({ title: "Delete failed", variant: "destructive" }),
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: async (ids: number[]) => {
      for (const id of ids) {
        await api.delete(`/servers/${id}`);
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["servers"] });
      clearSelection();
      toast({ title: "Servers deleted" });
    },
  });

  const testConnection = useMutation({
    mutationFn: (id: number) =>
      api.post<{
        success: boolean;
        message: string;
        cyberpanelVersion?: string;
      }>(`/servers/${id}/test-connection`, {}),
    onSuccess: (result, id) => {
      qc.invalidateQueries({ queryKey: ["servers"] });
      const versionLine = result.cyberpanelVersion
        ? ` · CyberPanel ${result.cyberpanelVersion}`
        : "";
      toast({ title: `Server #${id} is reachable${versionLine}` });
    },
    onError: () =>
      toast({ title: "Connection test failed", variant: "destructive" }),
  });

  const bulkTestConnection = useMutation({
    mutationFn: async (ids: number[]) => {
      const results = [];
      for (const id of ids) {
        try {
          const res = await api.post<{
            success: boolean;
            message: string;
            cyberpanelVersion?: string;
          }>(`/servers/${id}/test-connection`, {});
          results.push({ id, success: true, version: res.cyberpanelVersion });
        } catch {
          results.push({ id, success: false });
        }
      }
      return results;
    },
    onSuccess: (results) => {
      qc.invalidateQueries({ queryKey: ["servers"] });
      clearSelection();
      const failedCount = results.filter((r) => !r.success).length;
      if (failedCount === 0) {
        toast({ title: `Tested ${results.length} servers: All reachable` });
      } else {
        toast({
          title: `Tested ${results.length} servers`,
          description: `${results.length - failedCount} reachable, ${failedCount} unreachable`,
          variant: failedCount === results.length ? "destructive" : "default",
        });
      }
    },
  });

  function invalidate() {
    qc.invalidateQueries({ queryKey: ["servers"] });
  }

  async function handleOpenPanel(id: number) {
    try {
      const creds = await api.get<PanelCredentials>(
        `/servers/${id}/cyberpanel/credentials`,
      );
      if (creds?.url) window.open(creds.url, "_blank", "noopener,noreferrer");
      if (creds?.password) {
        try {
          await navigator.clipboard.writeText(creds.password);
        } catch {
          /* clipboard not available */
        }
      }
      toast({
        title: creds?.url
          ? `Opening panel for server #${id}`
          : `No panel URL configured`,
        description: creds?.password
          ? "Password copied to clipboard"
          : undefined,
      });
    } catch {
      toast({
        title: "No panel credentials configured",
        description: "Add them via Edit server → Panel Credentials",
        variant: "destructive",
      });
    }
  }

  // ── Selection Logic ──────────────────────────────────────────────────────
  const toggleSelect = (id: number) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  };

  const clearSelection = () => setSelectedIds(new Set());

  const isAllSelected =
    servers.length > 0 && servers.every((s) => selectedIds.has(s.id));

  const toggleAll = () => {
    if (isAllSelected) {
      const next = new Set(selectedIds);
      servers.forEach((s) => next.delete(s.id));
      setSelectedIds(next);
    } else {
      const next = new Set(selectedIds);
      servers.forEach((s) => next.add(s.id));
      setSelectedIds(next);
    }
  };

  const columns: Column<Server>[] = [
    {
      header: "",
      headerClassName: "w-10 px-4 py-3",
      render: (s) => (
        <Checkbox
          checked={selectedIds.has(s.id)}
          onCheckedChange={() => toggleSelect(s.id)}
        />
      ),
    },
    {
      header: "Name",
      render: (s) => (
        <Link
          to={`/servers/${s.id}`}
          className="font-medium hover:text-primary transition-colors"
        >
          {s.name}
        </Link>
      ),
    },
    {
      header: "IP Address",
      render: (s) => (
        <span className="font-mono text-muted-foreground">
          {s.ip_address}:{s.ssh_port}
        </span>
      ),
    },
    {
      header: "SSH User",
      render: (s) => (
        <span className="font-mono text-muted-foreground">{s.ssh_user}</span>
      ),
    },
    {
      header: "Provider",
      render: (s) => (
        <span className="text-muted-foreground">{s.provider ?? "—"}</span>
      ),
    },
    {
      header: "Panel",
      render: (s) => {
        if (!s.cyberpanel_version) {
          return <span className="text-muted-foreground">—</span>;
        }
        let trimmed = s.cyberpanel_version.trim();
        if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === "string") {
              trimmed = parsed.trim();
            }
          } catch {
            // fallback
          }
        }
        let displayVersion = trimmed;
        if (trimmed.startsWith("{")) {
          try {
            const parsed = JSON.parse(trimmed);
            if (parsed && typeof parsed === "object" && parsed.version) {
              displayVersion = parsed.version;
            }
          } catch {
            // fallback
          }
        }
        return <Badge variant="info">CP {displayVersion}</Badge>;
      },
    },
    {
      header: "Status",
      render: (s) => (
        <Badge variant={STATUS_VARIANT[s.status] ?? "secondary"}>
          {s.status}
        </Badge>
      ),
    },
    {
      header: "SSH Pool",
      render: (s) => <SshHealthCell serverId={s.id} />,
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Servers"
        onCreate={isAdmin ? () => setCreateOpen(true) : undefined}
        createLabel="New Server"
      />

      <SearchBar
        value={searchInput}
        onChange={setSearchInput}
        onSearch={() => {
          setSearch(searchInput);
          setPage(1);
        }}
        onClear={() => {
          setSearch("");
          setSearchInput("");
          setPage(1);
        }}
        placeholder="Search servers…"
        totalCount={data?.total ?? 0}
        totalLabel="total servers"
      />

      <DataTable
        columns={columns}
        data={servers}
        isLoading={isLoading}
        isError={isError}
        onRetry={refetch}
        rowKey={(s) => s.id}
        emptyMessage={search ? "No servers found" : "No servers found"}
        emptyDescription={
          search
            ? "Try adjusting your search query."
            : "You haven’t added any servers yet. Add your first server to start managing your projects."
        }
        emptyAction={
          !search && isAdmin ? (
            <Button className="mt-2" onClick={() => setCreateOpen(true)}>
              <ServerIcon className="h-4 w-4 mr-2" />
              Add Server
            </Button>
          ) : undefined
        }
        actionsHeader={
          <Checkbox checked={isAllSelected} onCheckedChange={toggleAll} />
        }
        renderActions={(s) => (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem asChild>
                <Link to={`/servers/${s.id}`} className="flex items-center">
                  <ServerIcon className="h-4 w-4 mr-2" />
                  View Details
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => testConnection.mutate(s.id)}
                disabled={testConnection.isPending}
              >
                <Plug className="h-4 w-4 mr-2" />
                Test Connection
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleOpenPanel(s.id)}>
                <ExternalLink className="h-4 w-4 mr-2" />
                Open Panel
              </DropdownMenuItem>
              {isAdmin && (
                <DropdownMenuItem onClick={() => setEditTarget(s)}>
                  <Pencil className="h-4 w-4 mr-2" />
                  Edit
                </DropdownMenuItem>
              )}
              {isAdmin && (
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onClick={() => setDeleteTarget(s)}
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      />

      {totalPages > 1 && (
        <Pagination
          page={page}
          totalPages={totalPages}
          onPageChange={setPage}
        />
      )}

      <ServerFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSuccess={invalidate}
      />

      {editTarget && (
        <ServerFormDialog
          key={editTarget.id}
          open
          onOpenChange={(o) => !o && setEditTarget(null)}
          initial={editTarget}
          onSuccess={invalidate}
        />
      )}

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title="Delete Server"
        description={`Servers with linked environments cannot be deleted. Decommission or remove their projects and environments first, then retry.`}
        confirmLabel="Delete"
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
        isPending={deleteMutation.isPending}
      />

      <BulkActionsBar
        selectedCount={selectedIds.size}
        onClear={clearSelection}
        actions={[
          {
            label: "Test Connection",
            icon: Activity,
            onClick: () => {
              bulkTestConnection.mutate(Array.from(selectedIds));
            },
          },
          {
            label: "Delete",
            icon: Trash2,
            variant: "destructive",
            onClick: () => {
              if (
                confirm(
                  `Are you sure you want to delete ${selectedIds.size} servers?`,
                )
              ) {
                bulkDeleteMutation.mutate(Array.from(selectedIds));
              }
            },
          },
        ]}
      />
    </div>
  );
}
