import { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Environment } from "./types";
import { WpCliConsoleCard } from "./components/WpCliConsoleCard";
import { DbSearchReplaceCard } from "./components/DbSearchReplaceCard";
import { DbSnapshotCard } from "./components/DbSnapshotCard";
import { QuickFixActionsCard } from "./components/QuickFixActionsCard";
import { WpDebugCard } from "./components/WpDebugCard";
import { MaintenanceModeCard } from "./components/MaintenanceModeCard";
import { ErrorLogsCard } from "./components/ErrorLogsCard";
import { WpCronJobsCard } from "./components/WpCronJobsCard";
import { DbCleanupCard } from "./components/DbCleanupCard";
import { CleanupScheduleCard } from "./components/CleanupScheduleCard";

export function ToolsTab({ environments }: { environments: Environment[] }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const envParam = searchParams.get("env");
  const initialEnvId = envParam ? Number(envParam) : null;
  const validInitialEnv = environments.find((e) => e.id === initialEnvId)
    ? initialEnvId
    : (environments.find((e) => e.type === "production")?.id ??
      environments[0]?.id ??
      null);

  const [selectedEnvId, setSelectedEnvId] = useState<number | null>(
    validInitialEnv,
  );

  useEffect(() => {
    const envId = Number(searchParams.get("env"));
    if (envId && environments.some((e) => e.id === envId)) {
      setSelectedEnvId(envId);
    }
  }, [searchParams, environments]);

  useEffect(() => {
    if (selectedEnvId) {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (next.get("env") !== String(selectedEnvId)) {
            next.set("env", String(selectedEnvId));
          }
          return next;
        },
        { replace: true },
      );
    }
  }, [selectedEnvId, setSearchParams]);

  const selectedEnv = environments.find((e) => e.id === selectedEnvId);

  if (!environments.length) {
    return (
      <p className="text-muted-foreground text-sm">
        No environments configured.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      {/* Interactive WP-CLI Developer Console */}
      <WpCliConsoleCard selectedEnvId={selectedEnvId} />

      {/* Database Search & Replace Tool */}
      <DbSearchReplaceCard selectedEnvId={selectedEnvId} />

      {/* Quick Fix Actions */}
      <QuickFixActionsCard selectedEnvId={selectedEnvId} />

      {/* Instant DB Snapshot */}
      <DbSnapshotCard selectedEnvId={selectedEnvId} />

      {/* Debug Mode */}
      <WpDebugCard selectedEnvId={selectedEnvId} selectedEnv={selectedEnv} />

      {/* Maintenance Mode */}
      <MaintenanceModeCard selectedEnvId={selectedEnvId} />

      {/* Error Logs */}
      <ErrorLogsCard selectedEnvId={selectedEnvId} />

      {/* WP Cron */}
      <WpCronJobsCard selectedEnvId={selectedEnvId} />

      {/* DB Cleanup */}
      <DbCleanupCard selectedEnvId={selectedEnvId} />

      {/* Cleanup Schedule */}
      <CleanupScheduleCard selectedEnvId={selectedEnvId} />
    </div>
  );
}

export default ToolsTab;

