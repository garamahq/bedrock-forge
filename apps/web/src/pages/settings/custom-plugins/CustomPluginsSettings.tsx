import { useState } from "react";
import { Github, Plus, RefreshCw, Loader2, Package } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AlertDialog } from "@/components/ui/alert-dialog";
import { EmptyState, ErrorState } from "@/components/crud/StateViews";
import {
  useCustomPlugins,
  useScanAllPlugins,
  useCreatePlugin,
  useUpdatePlugin,
  useDeletePlugin,
} from "./hooks";
import { CustomPlugin, EMPTY_FORM, PluginFormData } from "./types";
import { PluginFormDialog } from "./components/PluginFormDialog";
import { InventoryDialog } from "./components/InventoryDialog";
import { PluginsTable } from "./components/PluginsTable";

export function CustomPluginsSettings() {
  const [dialogForm, setDialogForm] = useState<PluginFormData | null>(null);
  const [editTarget, setEditTarget] = useState<CustomPlugin | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CustomPlugin | null>(null);
  const [inventoryTarget, setInventoryTarget] = useState<CustomPlugin | null>(
    null,
  );

  const {
    data: plugins = [],
    isLoading,
    isError,
    refetch,
  } = useCustomPlugins();
  const scanAllMutation = useScanAllPlugins();
  const createMutation = useCreatePlugin();
  const updateMutation = useUpdatePlugin();
  const deleteMutation = useDeletePlugin();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h2 className="text-xl font-bold flex items-center gap-2">
            <Github className="h-5 w-5 text-indigo-500" />
            Plugin Catalog
          </h2>
          <p className="text-sm text-muted-foreground">
            Manage GitHub-hosted plugins available for installation across your
            environments.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => scanAllMutation.mutate()}
            disabled={scanAllMutation.isPending}
          >
            {scanAllMutation.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4 mr-2" />
            )}
            Scan All
          </Button>
          <Button
            size="sm"
            onClick={() => setDialogForm(EMPTY_FORM)}
            className="shadow-md"
          >
            <Plus className="h-4 w-4 mr-2" />
            Register Plugin
          </Button>
        </div>
      </div>

      {isError ? (
        <ErrorState
          title="Could not load the custom plugin catalog"
          onRetry={() => void refetch()}
        />
      ) : isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-16 bg-muted/40 animate-pulse rounded-xl"
            />
          ))}
        </div>
      ) : plugins.length === 0 ? (
        <EmptyState
          icon={Package}
          title="Empty Catalog"
          description="You haven't registered any custom plugins yet. Register your GitHub repos to start deploying them."
          action={
            <Button variant="outline" onClick={() => setDialogForm(EMPTY_FORM)}>
              Add First Plugin
            </Button>
          }
        />
      ) : (
        <PluginsTable
          plugins={plugins}
          onViewInventory={setInventoryTarget}
          onEdit={setEditTarget}
          onDelete={setDeleteTarget}
        />
      )}

      {/* Create dialog */}
      {dialogForm && (
        <PluginFormDialog
          initial={dialogForm}
          onClose={() => setDialogForm(null)}
          onSave={async (data) => {
            await createMutation.mutateAsync(data);
            setDialogForm(null);
          }}
          isPending={createMutation.isPending}
        />
      )}

      {/* Edit dialog */}
      {editTarget && (
        <PluginFormDialog
          initial={{
            name: editTarget.name,
            slug: editTarget.slug,
            description: editTarget.description ?? "",
            repo_url: editTarget.repo_url,
            repo_path: editTarget.repo_path,
            type: editTarget.type,
          }}
          onClose={() => setEditTarget(null)}
          onSave={async (data) => {
            await updateMutation.mutateAsync({ id: editTarget.id, data });
            setEditTarget(null);
          }}
          isPending={updateMutation.isPending}
        />
      )}

      {/* Delete confirmation */}
      {deleteTarget && (
        <AlertDialog
          open
          onOpenChange={(v) => !v && setDeleteTarget(null)}
          title={`Remove ${deleteTarget.name}?`}
          description="This removes the plugin from the catalog. It will not uninstall it from environments where it is already deployed."
          confirmLabel="Remove Permanently"
          confirmVariant="destructive"
          onConfirm={async () => {
            await deleteMutation.mutateAsync(deleteTarget.id);
            setDeleteTarget(null);
          }}
          isPending={deleteMutation.isPending}
        />
      )}

      {inventoryTarget && (
        <InventoryDialog
          plugin={inventoryTarget}
          onClose={() => setInventoryTarget(null)}
        />
      )}
    </div>
  );
}
