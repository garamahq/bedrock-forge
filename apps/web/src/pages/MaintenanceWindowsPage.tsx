import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Calendar,
  Trash2,
  Plus,
  Server,
  Layout,
  AlertCircle,
  Clock,
} from "lucide-react";
import { api } from "@/lib/api-client";
import { toast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { AlertDialog } from "@/components/ui/alert-dialog";
import {
  PageHeader,
  DataTable,
  Pagination,
  type Column,
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

interface MaintenanceWindow {
  id: number;
  resource_type: "server" | "environment";
  resource_id: number;
  starts_at: string;
  ends_at: string;
  reason: string | null;
  created_by: number;
  created_at: string;
  server?: { id: number; name: string };
  environment?: { id: number; type: string; url: string };
}

interface ServerOption {
  id: number;
  name: string;
}

interface EnvironmentOption {
  id: number;
  type: string;
  url: string;
}

const windowSchema = z
  .object({
    resource_type: z.enum(["server", "environment"]),
    resource_id: z.string().min(1, "Please select a resource"),
    starts_at: z.string().min(1, "Start date and time is required"),
    ends_at: z.string().min(1, "End date and time is required"),
    reason: z.string().optional().or(z.literal("")),
  })
  .refine(
    (data) => {
      const start = new Date(data.starts_at).getTime();
      const end = new Date(data.ends_at).getTime();
      return end > start;
    },
    {
      message: "End time must be after start time",
      path: ["ends_at"],
    },
  );

type WindowForm = z.infer<typeof windowSchema>;

function MaintenanceWindowFormDialog({
  open,
  onOpenChange,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSuccess: () => void;
}) {
  const { data: servers = [] } = useQuery<ServerOption[]>({
    queryKey: ["servers-options"],
    queryFn: async () => {
      const res = await api.get<{ items: ServerOption[] }>(
        "/servers?limit=100",
      );
      return res.items || [];
    },
  });

  const { data: environments = [] } = useQuery<EnvironmentOption[]>({
    queryKey: ["environments-options"],
    queryFn: async () => {
      return await api.get<EnvironmentOption[]>("/environments");
    },
  });

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<WindowForm>({
    resolver: zodResolver(windowSchema),
    defaultValues: {
      resource_type: "server",
      resource_id: "",
      starts_at: "",
      ends_at: "",
      reason: "",
    },
  });

  const resourceType = watch("resource_type");
  const selectedResourceId = watch("resource_id");

  async function onSubmit(data: WindowForm) {
    try {
      await api.post("/maintenance-windows", {
        resource_type: data.resource_type,
        resource_id: parseInt(data.resource_id, 10),
        starts_at: new Date(data.starts_at).toISOString(),
        ends_at: new Date(data.ends_at).toISOString(),
        reason: data.reason || null,
      });
      toast({ title: "Maintenance window scheduled successfully" });
      reset();
      onSuccess();
      onOpenChange(false);
    } catch (err) {
      setError("root", {
        message: err instanceof Error ? err.message : "Schedule failed",
      });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Schedule Maintenance Window</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-1.5">
            <Label>Resource Type</Label>
            <Select
              value={resourceType}
              onValueChange={(val: "server" | "environment") => {
                setValue("resource_type", val);
                setValue("resource_id", "");
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select resource type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="server">Server</SelectItem>
                <SelectItem value="environment">Environment</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>Target Resource *</Label>
            <Select
              value={selectedResourceId}
              onValueChange={(val) => setValue("resource_id", val)}
            >
              <SelectTrigger>
                <SelectValue
                  placeholder={
                    resourceType === "server"
                      ? "Select Server"
                      : "Select Environment"
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {resourceType === "server"
                  ? servers.map((s) => (
                      <SelectItem key={s.id} value={s.id.toString()}>
                        {s.name}
                      </SelectItem>
                    ))
                  : environments.map((e) => (
                      <SelectItem key={e.id} value={e.id.toString()}>
                        {e.type} ({e.url})
                      </SelectItem>
                    ))}
              </SelectContent>
            </Select>
            {errors.resource_id && (
              <p className="text-xs text-destructive">
                {errors.resource_id.message}
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="starts_at">Starts At *</Label>
              <Input
                id="starts_at"
                type="datetime-local"
                {...register("starts_at")}
              />
              {errors.starts_at && (
                <p className="text-xs text-destructive">
                  {errors.starts_at.message}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ends_at">Ends At *</Label>
              <Input
                id="ends_at"
                type="datetime-local"
                {...register("ends_at")}
              />
              {errors.ends_at && (
                <p className="text-xs text-destructive">
                  {errors.ends_at.message}
                </p>
              )}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="reason">Reason</Label>
            <Textarea
              id="reason"
              {...register("reason")}
              placeholder="Migrating server to new host, upgrading PHP, etc..."
              rows={3}
            />
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
              {isSubmitting ? "Scheduling…" : "Schedule"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function MaintenanceWindowsPage() {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const limit = 10;
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<MaintenanceWindow | null>(
    null,
  );

  const {
    data: response,
    isLoading,
    isError,
    refetch,
  } = useQuery<{ data: MaintenanceWindow[]; total: number }>({
    queryKey: ["maintenance-windows", page, limit],
    queryFn: () => api.get(`/maintenance-windows?page=${page}&limit=${limit}`),
  });

  const data = response?.data ?? [];
  const totalPages = Math.max(1, Math.ceil((response?.total ?? 0) / limit));

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.delete(`/maintenance-windows/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["maintenance-windows"] });
      setDeleteTarget(null);
      toast({ title: "Maintenance window deleted" });
    },
    onError: () =>
      toast({
        title: "Failed to delete maintenance window",
        variant: "destructive",
      }),
  });

  function getStatus(w: MaintenanceWindow) {
    const now = new Date().getTime();
    const start = new Date(w.starts_at).getTime();
    const end = new Date(w.ends_at).getTime();

    if (now < start) {
      return { label: "Scheduled", variant: "secondary" as const };
    } else if (now > end) {
      return { label: "Completed", variant: "outline" as const };
    } else {
      return { label: "Active", variant: "success" as const };
    }
  }

  const columns: Column<MaintenanceWindow>[] = [
    {
      header: "Resource",
      render: (w) => (
        <div className="flex items-center gap-2">
          {w.resource_type === "server" ? (
            <Server className="h-4 w-4 text-muted-foreground" />
          ) : (
            <Layout className="h-4 w-4 text-muted-foreground" />
          )}
          <div>
            <span className="font-medium text-foreground">
              {w.resource_type === "server"
                ? w.server?.name || `Server #${w.resource_id}`
                : w.environment
                  ? `${w.environment.type} (${w.environment.url})`
                  : `Environment #${w.resource_id}`}
            </span>
            <span className="ml-1.5 text-xs text-muted-foreground capitalize">
              ({w.resource_type})
            </span>
          </div>
        </div>
      ),
    },
    {
      header: "Reason",
      render: (w) => (
        <span className="text-sm text-muted-foreground">
          {w.reason || (
            <em className="text-muted-foreground/50">No reason provided</em>
          )}
        </span>
      ),
    },
    {
      header: "Timing",
      render: (w) => {
        const startStr = new Date(w.starts_at).toLocaleString();
        const endStr = new Date(w.ends_at).toLocaleString();
        return (
          <div className="flex flex-col text-xs font-mono">
            <span>From: {startStr}</span>
            <span className="text-muted-foreground">To: {endStr}</span>
          </div>
        );
      },
    },
    {
      header: "Status",
      render: (w) => {
        const status = getStatus(w);
        return <Badge variant={status.variant}>{status.label}</Badge>;
      },
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Maintenance Windows"
        onCreate={() => setCreateOpen(true)}
        createLabel="Schedule Maintenance"
      >
        <div className="text-sm text-muted-foreground flex items-center gap-1.5 mt-1">
          <Clock className="h-4 w-4 text-indigo-500" />
          <span>
            Monitor checks continue and record results; notifications are
            suppressed during active windows.
          </span>
        </div>
      </PageHeader>

      <div className="rounded-xl border bg-card/50 backdrop-blur-sm p-1">
        <DataTable
          columns={columns}
          data={data}
          isLoading={isLoading}
          isError={isError}
          onRetry={refetch}
          rowKey={(w) => w.id}
          emptyMessage="No maintenance windows"
          emptyDescription="Schedule a maintenance window to temporarily suppress notifications during planned upgrades or migrations."
          emptyAction={
            <Button className="mt-2" onClick={() => setCreateOpen(true)}>
              <Calendar className="h-4 w-4 mr-2" />
              Schedule Maintenance
            </Button>
          }
          renderActions={(w) => {
            return (
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-destructive hover:text-destructive hover:bg-destructive/10"
                  onClick={() => setDeleteTarget(w)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            );
          }}
        />
      </div>

      {totalPages > 1 && (
        <Pagination
          page={page}
          totalPages={totalPages}
          onPageChange={setPage}
        />
      )}

      <MaintenanceWindowFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSuccess={() =>
          qc.invalidateQueries({ queryKey: ["maintenance-windows"] })
        }
      />

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title="Delete Maintenance Window"
        description="Are you sure you want to delete this maintenance window? Notifications and checks will resume immediately."
        confirmLabel="Delete"
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
        isPending={deleteMutation.isPending}
      />
    </div>
  );
}
