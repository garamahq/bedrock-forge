import { RefreshCw } from "lucide-react";
import { Environment } from "./types";
import { useSyncHistoryQuery, useCancelSyncMutation } from "./hooks";
import { PushPanel } from "./components/PushPanel";
import { SyncHistoryRow } from "./components/SyncHistoryRow";
import { Pagination, ErrorState } from "@/components/crud";
import { useState } from "react";

export function SyncTab({
  projectId,
  environments,
}: {
  projectId: number;
  environments: Environment[];
}) {
  const [page, setPage] = useState(1);
  const envIds = environments.map((e) => e.id).join(",");

  const {
    data: historyData,
    isLoading: historyLoading,
    isError: historyError,
    refetch: refetchHistory,
  } = useSyncHistoryQuery(projectId, envIds, environments.length > 0, page);

  const cancelHistoryMutation = useCancelSyncMutation(projectId);

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h3 className="font-semibold mb-1">Sync Environments</h3>
        <p className="text-sm text-muted-foreground">
          Choose the source, target, and whether to sync the database, files, or
          both. A safety backup is created before the sync unless you explicitly
          skip it.
        </p>
      </div>

      {environments.length < 2 ? (
        <div className="text-center py-12 text-muted-foreground border rounded-lg">
          <RefreshCw className="h-10 w-10 mx-auto mb-3 opacity-40" />
          <p className="font-medium">Need at least 2 environments to sync</p>
          <p className="text-sm mt-1">
            Add environments in the Environments tab
          </p>
        </div>
      ) : (
        <PushPanel projectId={projectId} environments={environments} />
      )}

      <div className="space-y-3">
        <h4 className="text-sm font-semibold">Sync History</h4>

        {historyError ? (
          <ErrorState
            title="Sync history could not be loaded"
            description="The request failed. Retry to check recent sync jobs."
            onRetry={() => void refetchHistory()}
          />
        ) : historyLoading ? (
          <div className="border rounded-lg text-center py-8 text-muted-foreground text-sm">
            Loading sync history…
          </div>
        ) : !historyData || historyData.data.length === 0 ? (
          <div className="border rounded-lg text-center py-8 text-muted-foreground text-sm">
            No sync jobs yet for this project.
          </div>
        ) : (
          <div className="border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40">
                <tr>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">
                    Status
                  </th>
                  <th className="text-left px-2 py-2.5 text-xs font-medium text-muted-foreground">
                    Type
                  </th>
                  <th className="text-left px-2 py-2.5 text-xs font-medium text-muted-foreground">
                    Started
                  </th>
                  <th className="text-left px-2 py-2.5 text-xs font-medium text-muted-foreground">
                    Duration
                  </th>
                  <th className="text-left px-2 py-2.5 text-xs font-medium text-muted-foreground">
                    Details
                  </th>
                  <th className="py-2.5 pr-4 pl-2 w-16" />
                </tr>
              </thead>
              <tbody>
                {historyData.data.map((row) => (
                  <SyncHistoryRow
                    key={row.id}
                    row={row}
                    onCancel={cancelHistoryMutation.mutate}
                    isCancelling={cancelHistoryMutation.isPending}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {historyData && historyData.total > 10 && (
          <Pagination
            page={page}
            totalPages={Math.ceil(historyData.total / 10)}
            onPageChange={setPage}
          />
        )}
      </div>
    </div>
  );
}
export default SyncTab;
