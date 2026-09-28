import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Globe,
  Pencil,
  Trash2,
  RefreshCw,
  MoreHorizontal,
  AlertTriangle,
  Clock,
  ShieldCheck,
} from "lucide-react";
import { api } from "@/lib/api-client";
import { toast } from "@/hooks/use-toast";
import { useAuthStore } from "@/store/auth.store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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
import { BulkActionsBar } from "@/components/ui/bulk-actions-bar";

interface Domain {
  id: number;
  name: string;
  expires_at: string | null;
  last_checked_at: string | null;
  whois_json: Record<string, unknown> | null;
  ssl_expires_at: string | null;
  ssl_issuer: string | null;
  ssl_checked_at: string | null;
}

interface PaginatedDomains {
  items: Domain[];
  total: number;
  page: number;
  limit: number;
}

const domainSchema = z.object({
  name: z
    .string()
    .min(1, "Domain name is required")
    .max(253)
    .regex(/^[a-zA-Z0-9.-]+$/, "Invalid domain name format"),
});
type DomainForm = z.infer<typeof domainSchema>;

function daysUntilExpiry(expiresAt: string | null): number | null {
  if (!expiresAt) return null;
  const diff = new Date(expiresAt).getTime() - Date.now();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

function ExpiryBadge({ expiresAt }: { expiresAt: string | null }) {
  const days = daysUntilExpiry(expiresAt);

  if (days === null) {
    return <span className="text-muted-foreground text-sm">—</span>;
  }

  if (days < 0) {
    return (
      <Badge variant="destructive" className="gap-1">
        <AlertTriangle className="h-3 w-3" />
        Expired
      </Badge>
    );
  }

  if (days <= 30) {
    return (
      <Badge variant="destructive" className="gap-1">
        <Clock className="h-3 w-3" />
        {days}d left
      </Badge>
    );
  }

  if (days <= 90) {
    return (
      <Badge variant="warning" className="gap-1">
        <Clock className="h-3 w-3" />
        {days}d left
      </Badge>
    );
  }

  return (
    <span className="text-sm text-muted-foreground">
      {new Date(expiresAt!).toLocaleDateString()}
    </span>
  );
}

function SslBadge({ sslExpiresAt }: { sslExpiresAt: string | null }) {
  const days = daysUntilExpiry(sslExpiresAt);

  if (days === null) {
    return <span className="text-muted-foreground text-sm">—</span>;
  }

  if (days < 0) {
    return (
      <Badge variant="destructive" className="gap-1">
        <AlertTriangle className="h-3 w-3" />
        Expired
      </Badge>
    );
  }

  if (days <= 14) {
    return (
      <Badge variant="destructive" className="gap-1">
        <Clock className="h-3 w-3" />
        {days}d left
      </Badge>
    );
  }

  if (days <= 30) {
    return (
      <Badge variant="warning" className="gap-1">
        <Clock className="h-3 w-3" />
        {days}d left
      </Badge>
    );
  }

  return (
    <span className="text-sm text-muted-foreground flex items-center gap-1">
      <ShieldCheck className="h-3.5 w-3.5 text-green-500" />
      {new Date(sslExpiresAt!).toLocaleDateString()}
    </span>
  );
}

export function DomainsPage() {
  const qc = useQueryClient();
  const isAdmin = useAuthStore(
    (s) => s.user?.roles?.includes("admin") ?? false,
  );

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Domain | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Domain | null>(null);
  const [refreshingId, setRefreshingId] = useState<number | null>(null);
  const [refreshingSslId, setRefreshingSslId] = useState<number | null>(null);
  const [whoisTarget, setWhoisTarget] = useState<Domain | null>(null);
  const [selectedIds, setSelectedIds] = useState<(string | number)[]>([]);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);

  const limit = 10;

  const { data, isLoading, isError, refetch } = useQuery<PaginatedDomains>({
    queryKey: ["domains", page, search],
    queryFn: () => {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(limit),
        ...(search && { search }),
      });
      return api.get(`/domains?${params}`);
    },
  });

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<DomainForm>({ resolver: zodResolver(domainSchema) });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["domains"] });

  const createMutation = useMutation({
    mutationFn: (body: DomainForm) => api.post("/domains", body),
    onSuccess: () => {
      invalidate();
      setDialogOpen(false);
      reset();
      toast({ title: "Domain added — WHOIS + SSL lookup started" });
    },
    onError: (e: { message?: string }) =>
      toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Partial<DomainForm> }) =>
      api.put(`/domains/${id}`, body),
    onSuccess: () => {
      invalidate();
      setEditTarget(null);
      setDialogOpen(false);
      reset();
      toast({ title: "Domain updated" });
    },
    onError: (e: { message?: string }) =>
      toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.delete(`/domains/${id}`),
    onSuccess: () => {
      invalidate();
      setDeleteTarget(null);
      toast({ title: "Domain deleted" });
    },
    onError: (e: { message?: string }) =>
      toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: (ids: (string | number)[]) =>
      Promise.all(ids.map((id) => api.delete(`/domains/${id}`))),
    onSuccess: () => {
      invalidate();
      setSelectedIds([]);
      setIsBulkDeleting(false);
      toast({ title: "Domains deleted successfully" });
    },
    onError: () => {
      setIsBulkDeleting(false);
      toast({ title: "Bulk delete failed", variant: "destructive" });
    },
  });

  const bulkWhoisRefresh = useMutation({
    mutationFn: async (ids: (string | number)[]) => {
      const results = [];
      for (const id of ids) {
        try {
          await api.post(`/domains/${id}/whois-refresh`, {});
          results.push({ id, success: true });
        } catch {
          results.push({ id, success: false });
        }
      }
      return results;
    },
    onSuccess: (results) => {
      invalidate();
      setSelectedIds([]);
      const failed = results.filter((r) => !r.success).length;
      toast({
        title: `WHOIS Refresh queued for ${results.length} domains`,
        description:
          failed > 0
            ? `Failed for ${failed} domains.`
            : "All successfully queued.",
        variant: failed === results.length ? "destructive" : "default",
      });
    },
  });

  const bulkSslRefresh = useMutation({
    mutationFn: async (ids: (string | number)[]) => {
      const results = [];
      for (const id of ids) {
        try {
          await api.post(`/domains/${id}/ssl-refresh`, {});
          results.push({ id, success: true });
        } catch {
          results.push({ id, success: false });
        }
      }
      return results;
    },
    onSuccess: (results) => {
      invalidate();
      setSelectedIds([]);
      const failed = results.filter((r) => !r.success).length;
      toast({
        title: `SSL Refresh queued for ${results.length} domains`,
        description:
          failed > 0
            ? `Failed for ${failed} domains.`
            : "All successfully queued.",
        variant: failed === results.length ? "destructive" : "default",
      });
    },
  });

  async function handleWhoisRefresh(domain: Domain) {
    setRefreshingId(domain.id);
    try {
      await api.post(`/domains/${domain.id}/whois-refresh`, {});
      toast({ title: `WHOIS refresh queued for ${domain.name}` });
    } catch (e: unknown) {
      const msg =
        e && typeof e === "object" && "message" in e
          ? String((e as { message: unknown }).message)
          : "Failed";
      toast({ title: "Error", description: msg, variant: "destructive" });
    } finally {
      setRefreshingId(null);
    }
  }

  async function handleSslRefresh(domain: Domain) {
    setRefreshingSslId(domain.id);
    try {
      await api.post(`/domains/${domain.id}/ssl-refresh`, {});
      toast({ title: `SSL refresh queued for ${domain.name}` });
    } catch (e: unknown) {
      const msg =
        e && typeof e === "object" && "message" in e
          ? String((e as { message: unknown }).message)
          : "Failed";
      toast({ title: "Error", description: msg, variant: "destructive" });
    } finally {
      setRefreshingSslId(null);
    }
  }

  function openCreate() {
    setEditTarget(null);
    reset({ name: "" });
    setDialogOpen(true);
  }

  function openEdit(d: Domain) {
    setEditTarget(d);
    reset({ name: d.name });
    setDialogOpen(true);
  }

  function onSubmit(values: DomainForm) {
    if (editTarget) {
      updateMutation.mutate({ id: editTarget.id, body: values });
    } else {
      createMutation.mutate(values);
    }
  }

  const isPending = createMutation.isPending || updateMutation.isPending;
  const totalPages = data ? Math.ceil(data.total / limit) : 1;

  const columns: Column<Domain>[] = [
    {
      header: "Domain",
      render: (d) => (
        <a
          href={`https://${d.name}`}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-sm text-primary hover:underline flex items-center gap-1.5"
        >
          <Globe className="h-3.5 w-3.5 shrink-0" />
          {d.name}
        </a>
      ),
    },
    {
      header: "Expires",
      render: (d) => <ExpiryBadge expiresAt={d.expires_at} />,
    },
    {
      header: "SSL Expires",
      render: (d) => <SslBadge sslExpiresAt={d.ssl_expires_at} />,
    },
    {
      header: "SSL Issuer",
      render: (d) => (
        <span className="text-xs text-muted-foreground">
          {d.ssl_issuer ?? "—"}
        </span>
      ),
    },
    {
      header: "Last Checked",
      render: (d) => (
        <span className="text-xs text-muted-foreground">
          {d.last_checked_at
            ? new Date(d.last_checked_at).toLocaleDateString()
            : "—"}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-4 pb-20">
      <PageHeader
        title="Domains"
        onCreate={openCreate}
        createLabel="Add Domain"
      />

      <SearchBar
        value={searchInput}
        onChange={setSearchInput}
        onSearch={() => {
          setSearch(searchInput);
          setPage(1);
          setSelectedIds([]);
        }}
        onClear={() => {
          setSearchInput("");
          setSearch("");
          setPage(1);
          setSelectedIds([]);
        }}
        placeholder="Search domains…"
        totalCount={data?.total ?? 0}
        totalLabel="total domains"
      />

      <DataTable
        tableId="domains-table"
        data={data?.items ?? []}
        columns={columns}
        isLoading={isLoading}
        isError={isError}
        onRetry={refetch}
        rowKey={(d) => d.id}
        selectedIds={selectedIds}
        onSelectionChange={setSelectedIds}
        emptyMessage={search ? "No domains found" : "No domains yet."}
        emptyDescription={
          search
            ? "Try adjusting your search query."
            : "Get started by adding your first domain."
        }
        emptyAction={
          !search ? (
            <Button className="mt-2" onClick={openCreate}>
              Add Domain
            </Button>
          ) : undefined
        }
        renderActions={(d) => (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() => handleWhoisRefresh(d)}
                disabled={refreshingId === d.id}
              >
                <RefreshCw
                  className={`h-4 w-4 mr-2 ${refreshingId === d.id ? "animate-spin" : ""}`}
                />
                Refresh WHOIS
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => handleSslRefresh(d)}
                disabled={refreshingSslId === d.id}
              >
                <RefreshCw
                  className={`h-4 w-4 mr-2 ${refreshingSslId === d.id ? "animate-spin" : ""}`}
                />
                Refresh SSL
              </DropdownMenuItem>
              {d.whois_json && (
                <DropdownMenuItem onClick={() => setWhoisTarget(d)}>
                  <Globe className="h-4 w-4 mr-2" />
                  View WHOIS
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => openEdit(d)}>
                <Pencil className="h-4 w-4 mr-2" />
                Edit
              </DropdownMenuItem>
              {isAdmin && (
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onClick={() => setDeleteTarget(d)}
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      />

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />

      <BulkActionsBar
        selectedCount={selectedIds.length}
        actions={[
          {
            label: "Refresh WHOIS",
            icon: Globe,
            onClick: () => {
              bulkWhoisRefresh.mutate(selectedIds);
            },
          },
          {
            label: "Refresh SSL",
            icon: ShieldCheck,
            onClick: () => {
              bulkSslRefresh.mutate(selectedIds);
            },
          },
          {
            label: "Delete Selected",
            icon: Trash2,
            variant: "destructive",
            onClick: () => setIsBulkDeleting(true),
          },
        ]}
        onClear={() => setSelectedIds([])}
      />

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            setDialogOpen(false);
            setEditTarget(null);
            reset();
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editTarget ? "Edit Domain" : "Add Domain"}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="d-name">
                Domain Name <span className="text-destructive">*</span>
              </Label>
              <Input
                id="d-name"
                {...register("name")}
                placeholder="example.com"
                autoFocus
              />
              {errors.name && (
                <p className="text-xs text-destructive">
                  {errors.name.message}
                </p>
              )}
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setDialogOpen(false);
                  setEditTarget(null);
                  reset();
                }}
                disabled={isPending}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isPending}>
                {editTarget ? "Save Changes" : "Add Domain"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* WHOIS viewer */}
      <Dialog
        open={!!whoisTarget}
        onOpenChange={(open) => {
          if (!open) setWhoisTarget(null);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>WHOIS — {whoisTarget?.name}</DialogTitle>
          </DialogHeader>
          <pre className="text-[11px] bg-muted rounded p-3 overflow-auto max-h-96 whitespace-pre-wrap font-mono">
            {whoisTarget?.whois_json
              ? JSON.stringify(whoisTarget.whois_json, null, 2)
              : "No WHOIS data yet. Refresh to fetch."}
          </pre>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title={`Delete ${deleteTarget?.name ?? "domain"}?`}
        description="This will permanently remove the domain and its WHOIS data."
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
        confirmLabel="Delete"
        confirmVariant="destructive"
        isPending={deleteMutation.isPending}
        requireTextConfirm={deleteTarget?.name}
      />

      <AlertDialog
        open={isBulkDeleting}
        onOpenChange={(o) => !o && setIsBulkDeleting(false)}
        title="Delete Domains"
        description={`Are you sure you want to delete ${selectedIds.length} selected domains? This action cannot be undone.`}
        confirmLabel="Delete All"
        confirmVariant="destructive"
        onConfirm={() => bulkDeleteMutation.mutate(selectedIds)}
        isPending={bulkDeleteMutation.isPending}
      />
    </div>
  );
}
