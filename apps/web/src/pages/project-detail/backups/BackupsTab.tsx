import { HardDrive } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { BackupScheduleSection } from "./components/BackupScheduleSection";
import { Environment } from "./types";

export function BackupsTab({
  projectId,
  environments,
}: {
  projectId: number;
  environments: Environment[];
}) {
  const [searchParams] = useSearchParams();
  const requestedEnvId = Number(searchParams.get("env"));
  const selectedEnv =
    environments.find((environment) => environment.id === requestedEnvId) ??
    environments.find((environment) => environment.type === "production") ??
    environments[0];

  if (!selectedEnv) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center">
        <HardDrive className="mx-auto mb-3 h-9 w-9 text-muted-foreground" />
        <h3 className="font-medium">Add an environment to manage backups</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Backup schedules are configured per environment.
        </p>
      </div>
    );
  }

  const backupCenterHref = `/backups?project_id=${projectId}&environment_id=${selectedEnv.id}`;

  return (
    <div className="space-y-5">
      <section className="flex flex-col gap-4 rounded-lg border bg-card p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <HardDrive className="mt-0.5 h-5 w-5 text-primary" />
          <div>
            <h3 className="font-semibold">Backup Center</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Create, restore, search, and review backup history in one place.
              The center is filtered to {selectedEnv.type} for this project.
            </p>
          </div>
        </div>
        <Button asChild>
          <Link to={backupCenterHref}>Open Backup Center</Link>
        </Button>
      </section>

      <BackupScheduleSection selectedEnvId={selectedEnv.id} />
    </div>
  );
}

export default BackupsTab;
