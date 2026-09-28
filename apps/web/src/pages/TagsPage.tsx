import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Tag, Pencil, Trash2, Plus } from "lucide-react";
import { api } from "@/lib/api-client";
import { useAuthStore } from "@/store/auth.store";
import { toast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { AlertDialog } from "@/components/ui/alert-dialog";
import { PageHeader, DataTable, type Column } from "@/components/crud";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";

interface TagItem {
  id: number;
  name: string;
  color: string;
  _count?: { client_tags: number };
}

const tagSchema = z.object({
  name: z.string().min(1, "Required").max(50),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Must be a valid hex color"),
});
type TagForm = z.infer<typeof tagSchema>;

const PRESET_COLORS = [
  "#6366f1",
  "#8b5cf6",
  "#a855f7",
  "#ec4899",
  "#f43f5e",
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#10b981",
  "#14b8a6",
  "#06b6d4",
  "#3b82f6",
  "#64748b",
  "#78716c",
];

function TagFormDialog({
  open,
  onOpenChange,
  initial,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  initial?: TagItem;
  onSuccess: () => void;
}) {
  const {
    register,
    handleSubmit,
    watch,
    setValue,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<TagForm>({
    resolver: zodResolver(tagSchema),
    defaultValues: {
      name: initial?.name ?? "",
      color: initial?.color ?? "#6366f1",
    },
  });

  const currentColor = watch("color");

  async function onSubmit(data: TagForm) {
    try {
      if (initial) {
        await api.put(`/tags/${initial.id}`, data);
        toast({ title: "Tag updated" });
      } else {
        await api.post("/tags", data);
        toast({ title: "Tag created" });
      }
      reset();
      onSuccess();
      onOpenChange(false);
    } catch (err) {
      setError("root", {
        message: err instanceof Error ? err.message : "Save failed",
      });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{initial ? "Edit Tag" : "New Tag"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="tag-name">Name *</Label>
            <Input
              id="tag-name"
              {...register("name")}
              placeholder="e.g. VIP, Prospect, Agency"
            />
            {errors.name && (
              <p className="text-xs text-destructive">{errors.name.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label>Color</Label>
            <div className="flex items-center gap-3">
              <input
                type="color"
                value={currentColor}
                onChange={(e) => setValue("color", e.target.value)}
                className="h-9 w-14 rounded border cursor-pointer"
              />
              <Input
                {...register("color")}
                placeholder="#6366f1"
                className="font-mono flex-1"
              />
            </div>
            {errors.color && (
              <p className="text-xs text-destructive">{errors.color.message}</p>
            )}
            {/* Presets */}
            <div className="flex flex-wrap gap-1.5 pt-1">
              {PRESET_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setValue("color", c)}
                  className={`w-6 h-6 rounded-full border-2 transition-all ${
                    currentColor === c
                      ? "border-foreground scale-110"
                      : "border-transparent hover:border-muted-foreground"
                  }`}
                  style={{ backgroundColor: c }}
                  title={c}
                />
              ))}
            </div>
          </div>

          {/* Preview */}
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Preview:</span>
            <Badge
              style={{ backgroundColor: currentColor, color: "#fff" }}
              className="text-xs"
            >
              {watch("name") || "Tag name"}
            </Badge>
          </div>

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

export function TagsPage() {
  const qc = useQueryClient();
  const isAdmin = useAuthStore(
    (s) => s.user?.roles?.includes("admin") ?? false,
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<TagItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TagItem | null>(null);

  const {
    data = [],
    isLoading,
    isError,
    refetch,
  } = useQuery<TagItem[]>({
    queryKey: ["tags"],
    queryFn: () => api.get("/tags"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.delete(`/tags/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tags"] });
      setDeleteTarget(null);
      toast({ title: "Tag deleted" });
    },
    onError: () => toast({ title: "Delete failed", variant: "destructive" }),
  });

  function invalidate() {
    qc.invalidateQueries({ queryKey: ["tags"] });
  }

  const columns: Column<TagItem>[] = [
    {
      header: "Tag",
      render: (t) => (
        <div className="flex items-center gap-2.5">
          <span
            className="w-3 h-3 rounded-full shrink-0"
            style={{ backgroundColor: t.color }}
          />
          <span className="font-medium">{t.name}</span>
        </div>
      ),
    },
    {
      header: "Color",
      render: (t) => (
        <span className="font-mono text-xs text-muted-foreground">
          {t.color}
        </span>
      ),
    },
    {
      header: "Preview",
      render: (t) => (
        <Badge
          style={{ backgroundColor: t.color, color: "#fff" }}
          className="text-xs"
        >
          {t.name}
        </Badge>
      ),
    },
    {
      header: "Clients",
      render: (t) => (
        <span className="text-muted-foreground text-sm">
          {t._count?.client_tags ?? "—"}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-4 max-w-3xl">
      <PageHeader
        title="Tags"
        onCreate={isAdmin ? () => setCreateOpen(true) : undefined}
        createLabel="New Tag"
      >
        <div className="text-sm text-muted-foreground">
          Organize clients with colored labels.
        </div>
      </PageHeader>

      <DataTable
        columns={columns}
        data={data}
        isLoading={isLoading}
        isError={isError}
        onRetry={refetch}
        rowKey={(t) => t.id}
        emptyMessage="No tags yet"
        emptyDescription="Create tags to organize and filter your clients."
        emptyAction={
          isAdmin ? (
            <Button className="mt-2" onClick={() => setCreateOpen(true)}>
              <Tag className="h-4 w-4 mr-2" />
              Create Tag
            </Button>
          ) : undefined
        }
        renderActions={
          isAdmin
            ? (t) => (
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => setEditTarget(t)}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-destructive hover:text-destructive"
                    onClick={() => setDeleteTarget(t)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              )
            : undefined
        }
      />

      <TagFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSuccess={invalidate}
      />
      {editTarget && (
        <TagFormDialog
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
        title="Delete Tag"
        description={`"${deleteTarget?.name}" will be removed from all clients.`}
        confirmLabel="Delete"
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
        isPending={deleteMutation.isPending}
      />
    </div>
  );
}
