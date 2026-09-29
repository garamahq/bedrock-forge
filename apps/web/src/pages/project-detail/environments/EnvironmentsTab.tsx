import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Plus, MonitorSmartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertDialog } from "@/components/ui/alert-dialog";
import {
  useEnvironmentsQuery,
  useServersQuery,
  useDeleteEnvironmentMutation,
} from "./hooks";
import { Environment } from "./types";
import { EnvironmentCard } from "./components/EnvironmentCard";
import { AddEnvironmentWizard } from "./components/AddEnvironmentWizard";
import { EnvironmentFormDialog } from "./components/EnvironmentFormDialog";

export function EnvironmentsTab({ projectId }: { projectId: number }) {
  const [searchParams] = useSearchParams();
  const focusedEnvId = Number(searchParams.get("env"));
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Environment | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Environment | null>(null);

  const {
    data: environments = [],
    isLoading,
    refetch,
  } = useEnvironmentsQuery(projectId);
  const { data: servers = [] } = useServersQuery();
  const deleteMutation = useDeleteEnvironmentMutation(projectId);

  function handleSuccess() {
    refetch();
  }

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {[1, 2].map((i) => (
          <Skeleton key={i} className="h-56 rounded-lg" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {environments.length} environment
          {environments.length !== 1 ? "s" : ""} configured
        </p>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4 mr-1.5" />
          Add Environment
        </Button>
      </div>

      {environments.length === 0 ? (
        <div className="border rounded-lg p-12 text-center">
          <MonitorSmartphone className="h-10 w-10 mx-auto text-muted-foreground/40 mb-3" />
          <p className="font-medium text-muted-foreground">
            No environments yet
          </p>
          <p className="text-sm text-muted-foreground mt-1">
            Add a production or staging environment to get started
          </p>
          <Button
            className="mt-4"
            size="sm"
            onClick={() => setCreateOpen(true)}
          >
            <Plus className="h-4 w-4 mr-1.5" />
            Add First Environment
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
          {environments.map((env) => (
            <div
              key={env.id}
              className={
                env.id === focusedEnvId
                  ? "rounded-lg ring-2 ring-primary ring-offset-2 ring-offset-background"
                  : undefined
              }
            >
              <EnvironmentCard
                env={env}
                projectId={projectId}
                onEdit={setEditTarget}
                onDelete={setDeleteTarget}
              />
            </div>
          ))}
        </div>
      )}

      <AddEnvironmentWizard
        open={createOpen}
        onOpenChange={setCreateOpen}
        projectId={projectId}
        servers={servers}
        onSuccess={handleSuccess}
      />

      {editTarget && (
        <EnvironmentFormDialog
          key={editTarget.id}
          open
          onOpenChange={(o) => !o && setEditTarget(null)}
          projectId={projectId}
          initial={editTarget}
          servers={servers}
          onSuccess={handleSuccess}
        />
      )}

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title="Decommission Environment"
        description={`Start remote cleanup for the "${deleteTarget?.type}" environment at ${deleteTarget?.url}. Its record and related data remain until cleanup finishes.`}
        confirmLabel="Start decommission"
        onConfirm={async () => {
          if (deleteTarget) {
            await deleteMutation.mutateAsync(deleteTarget.id);
            setDeleteTarget(null);
          }
        }}
        isPending={deleteMutation.isPending}
      />
    </div>
  );
}
