import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Pencil,
  Trash2,
  MoreHorizontal,
  Tag,
  ExternalLink,
} from "lucide-react";
import { api } from "@/lib/api-client";
import { toast } from "@/hooks/use-toast";
import { useAuthStore } from "@/store/auth.store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

interface TagItem {
  id: number;
  name: string;
  color: string;
}

interface Client {
  id: number;
  name: string;
  email: string | null;
  phone: string | null;
  notes: string | null;
  client_tags: { tag: TagItem }[];
}

interface PaginatedClients {
  items: Client[];
  total: number;
}

const clientSchema = z.object({
  name: z.string().min(1, "Name is required").max(100),
  email: z.string().email("Invalid email").optional().or(z.literal("")),
  phone: z.string().max(30).optional().or(z.literal("")),
  notes: z.string().optional().or(z.literal("")),
});
type ClientForm = z.infer<typeof clientSchema>;

export function ClientFormDialog({
  open,
  onOpenChange,
  initial,
  allTags,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  initial?: Client;
  allTags: TagItem[];
  onSuccess: () => void;
}) {
  const [selectedTagIds, setSelectedTagIds] = useState<number[]>(
    () => initial?.client_tags.map((ct) => ct.tag.id) ?? [],
  );

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ClientForm>({
    resolver: zodResolver(clientSchema),
    defaultValues: {
      name: initial?.name ?? "",
      email: initial?.email ?? "",
      phone: initial?.phone ?? "",
      notes: initial?.notes ?? "",
    },
  });

  function toggleTag(id: number) {
    setSelectedTagIds((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id],
    );
  }

  async function onSubmit(data: ClientForm) {
    try {
      const payload = {
        name: data.name,
        email: data.email || undefined,
        phone: data.phone || undefined,
        notes: data.notes || undefined,
        tagIds: selectedTagIds,
      };
      if (initial) {
        await api.put(`/clients/${initial.id}`, payload);
        toast({ title: "Client updated" });
      } else {
        await api.post("/clients", payload);
        toast({ title: "Client created" });
      }
      reset();
      setSelectedTagIds([]);
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
          <DialogTitle>{initial ? "Edit Client" : "New Client"}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="c-name">Name *</Label>
            <Input id="c-name" {...register("name")} placeholder="Acme Corp" />
            {errors.name && (
              <p className="text-xs text-destructive">{errors.name.message}</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="c-email">Email</Label>
              <Input
                id="c-email"
                type="email"
                {...register("email")}
                placeholder="contact@acme.com"
              />
              {errors.email && (
                <p className="text-xs text-destructive">
                  {errors.email.message}
                </p>
              )}
            </div>
            <div className="space-y-1">
              <Label htmlFor="c-phone">Phone</Label>
              <Input
                id="c-phone"
                {...register("phone")}
                placeholder="+1 555 000 0000"
              />
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="c-notes">Notes</Label>
            <Input id="c-notes" {...register("notes")} placeholder="Optional" />
          </div>

          {allTags.length > 0 && (
            <div className="space-y-1">
              <Label>Tags</Label>
              <div className="flex flex-wrap gap-2 pt-1">
                {allTags.map((tag) => {
                  const selected = selectedTagIds.includes(tag.id);
                  return (
                    <button
                      key={tag.id}
                      type="button"
                      onClick={() => toggleTag(tag.id)}
                      className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border transition-colors ${
                        selected
                          ? "border-transparent text-white"
                          : "border-border bg-background text-muted-foreground hover:border-primary"
                      }`}
                      style={selected ? { backgroundColor: tag.color } : {}}
                    >
                      {tag.name}
                    </button>
                  );
                })}
              </div>
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

export function ClientsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const isAdmin = useAuthStore(
    (s) => s.user?.roles?.includes("admin") ?? false,
  );
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Client | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Client | null>(null);
  const [selectedIds, setSelectedIds] = useState<(string | number)[]>([]);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["clients", page, search],
    queryFn: () =>
      api.get<PaginatedClients>(
        `/clients?page=${page}&limit=10${search ? `&search=${encodeURIComponent(search)}` : ""}`,
      ),
  });

  const { data: tags = [] } = useQuery({
    queryKey: ["tags"],
    queryFn: () => api.get<TagItem[]>("/tags"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.delete(`/clients/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["clients"] });
      setDeleteTarget(null);
      toast({ title: "Client deleted" });
    },
    onError: () => toast({ title: "Delete failed", variant: "destructive" }),
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: (ids: (string | number)[]) =>
      Promise.all(ids.map((id) => api.delete(`/clients/${id}`))),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["clients"] });
      setSelectedIds([]);
      setIsBulkDeleting(false);
      toast({ title: "Clients deleted successfully" });
    },
    onError: () => {
      setIsBulkDeleting(false);
      toast({ title: "Bulk delete failed", variant: "destructive" });
    },
  });

  const totalPages = data ? Math.ceil(data.total / 10) : 1;

  function invalidate() {
    qc.invalidateQueries({ queryKey: ["clients"] });
  }

  const columns: Column<Client>[] = [
    {
      header: "Name",
      render: (c) => <span className="font-medium">{c.name}</span>,
    },
    {
      header: "Email",
      render: (c) => (
        <span className="text-muted-foreground text-xs">{c.email ?? "—"}</span>
      ),
    },
    {
      header: "Phone",
      render: (c) => (
        <span className="text-muted-foreground text-xs">{c.phone ?? "—"}</span>
      ),
    },
    {
      header: "Tags",
      render: (c) => (
        <div className="flex flex-wrap gap-1">
          {c.client_tags.map((ct) => (
            <span
              key={ct.tag.id}
              className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full text-white font-medium"
              style={{ backgroundColor: ct.tag.color }}
            >
              <Tag className="h-2 w-2" />
              {ct.tag.name}
            </span>
          ))}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4 pb-20">
      <PageHeader
        title="Clients"
        onCreate={isAdmin ? () => setCreateOpen(true) : undefined}
        createLabel="New Client"
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
          setSearch("");
          setSearchInput("");
          setPage(1);
          setSelectedIds([]);
        }}
        placeholder="Search clients…"
        totalCount={data?.total ?? 0}
        totalLabel="total clients"
      />

      <DataTable
        tableId="clients-table"
        columns={columns}
        data={data?.items ?? []}
        isLoading={isLoading}
        isError={isError}
        onRetry={refetch}
        rowKey={(c) => c.id}
        selectedIds={selectedIds}
        onSelectionChange={setSelectedIds}
        emptyMessage={search ? "No clients found" : "No clients yet."}
        emptyDescription={
          search
            ? "Try adjusting your search query."
            : "Get started by creating your first client."
        }
        emptyAction={
          !search && isAdmin ? (
            <Button className="mt-2" onClick={() => setCreateOpen(true)}>
              Create Client
            </Button>
          ) : undefined
        }
        renderActions={(client) => (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() => navigate(`/clients/${client.id}`)}
              >
                <ExternalLink className="h-4 w-4 mr-2" />
                View Details
              </DropdownMenuItem>
              {isAdmin && (
                <DropdownMenuItem onClick={() => setEditTarget(client)}>
                  <Pencil className="h-4 w-4 mr-2" />
                  Edit
                </DropdownMenuItem>
              )}
              {isAdmin && (
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onClick={() => setDeleteTarget(client)}
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
            label: "Delete Selected",
            icon: Trash2,
            variant: "destructive",
            onClick: () => setIsBulkDeleting(true),
          },
        ]}
        onClear={() => setSelectedIds([])}
      />

      <ClientFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        allTags={tags}
        onSuccess={invalidate}
      />

      {editTarget && (
        <ClientFormDialog
          key={editTarget.id}
          open
          onOpenChange={(o) => !o && setEditTarget(null)}
          initial={editTarget}
          allTags={tags}
          onSuccess={invalidate}
        />
      )}

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title="Delete Client"
        description={`"${deleteTarget?.name}" can only be deleted after its linked projects and invoices are removed or reassigned. This action cannot be undone.`}
        confirmLabel="Delete"
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
        isPending={deleteMutation.isPending}
        requireTextConfirm={deleteTarget?.name}
      />

      <AlertDialog
        open={isBulkDeleting}
        onOpenChange={(o) => !o && setIsBulkDeleting(false)}
        title="Delete Clients"
        description={`Are you sure you want to delete ${selectedIds.length} selected clients? This action cannot be undone.`}
        confirmLabel="Delete All"
        confirmVariant="destructive"
        onConfirm={() => bulkDeleteMutation.mutate(selectedIds)}
        isPending={bulkDeleteMutation.isPending}
      />
    </div>
  );
}
