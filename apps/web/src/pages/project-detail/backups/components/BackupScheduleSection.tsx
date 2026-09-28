import { useState } from "react";
import { Clock, Calendar, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/crud";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { BackupSchedule, BackupScheduleForm } from "../types";
import {
  useBackupScheduleQuery,
  useUpsertScheduleMutation,
  useDeleteScheduleMutation,
} from "../hooks";

export function BackupScheduleSection({
  selectedEnvId,
}: {
  selectedEnvId: number | null;
}) {
  const [scheduleFormOpen, setScheduleFormOpen] = useState(false);
  const [scheduleForm, setScheduleForm] = useState<BackupScheduleForm>({
    type: "full",
    frequency: "daily",
    hour: 3,
    minute: 0,
    day_of_week: 0,
    day_of_month: 1,
    enabled: true,
    retention_count: null,
    retention_days: null,
  });

  const {
    data: scheduleData,
    isLoading: scheduleLoading,
    isError: scheduleError,
    refetch: refetchSchedule,
  } = useBackupScheduleQuery(selectedEnvId);
  const upsertScheduleMutation = useUpsertScheduleMutation(selectedEnvId);
  const deleteScheduleMutation = useDeleteScheduleMutation(selectedEnvId);

  function openScheduleForm(existing?: BackupSchedule | null) {
    setScheduleForm(
      existing
        ? {
            type: existing.type,
            frequency: existing.frequency as BackupScheduleForm["frequency"],
            hour: existing.hour,
            minute: existing.minute,
            day_of_week: existing.day_of_week ?? 0,
            day_of_month: existing.day_of_month ?? 1,
            enabled: existing.enabled,
            retention_count: existing.retention_count ?? null,
            retention_days: existing.retention_days ?? null,
          }
        : {
            type: "full",
            frequency: "daily",
            hour: 3,
            minute: 0,
            day_of_week: 0,
            day_of_month: 1,
            enabled: true,
            retention_count: null,
            retention_days: null,
          },
    );
    setScheduleFormOpen(true);
  }

  if (!selectedEnvId) return null;

  return (
    <div className="border rounded-lg">
      <div className="flex items-center justify-between px-4 py-3 border-b">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Clock className="h-4 w-4 text-muted-foreground" />
          Backup Schedule
        </div>
        {!scheduleFormOpen && !scheduleError && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1.5"
            disabled={scheduleLoading}
            onClick={() => openScheduleForm(scheduleData)}
          >
            {scheduleData ? (
              <>
                <Pencil className="h-3 w-3" /> Edit
              </>
            ) : (
              <>
                <Plus className="h-3 w-3" /> Set up schedule
              </>
            )}
          </Button>
        )}
      </div>

      <div className="p-4">
        {/* Current schedule summary */}
        {!scheduleFormOpen &&
          !scheduleLoading &&
          !scheduleError &&
          scheduleData && (
            <div className="flex flex-wrap items-center gap-4 text-sm">
              <div className="flex items-center gap-1.5">
                <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="capitalize font-medium">
                  {scheduleData.frequency}
                </span>
                {scheduleData.frequency === "weekly" &&
                  scheduleData.day_of_week != null && (
                    <span className="text-muted-foreground">
                      —{" "}
                      {
                        ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][
                          scheduleData.day_of_week
                        ]
                      }
                    </span>
                  )}
                {scheduleData.frequency === "monthly" &&
                  scheduleData.day_of_month && (
                    <span className="text-muted-foreground">
                      — day {scheduleData.day_of_month}
                    </span>
                  )}
                <span className="text-muted-foreground">
                  at {String(scheduleData.hour).padStart(2, "0")}:
                  {String(scheduleData.minute).padStart(2, "0")} UTC
                </span>
              </div>
              <Badge variant="outline" className="text-xs capitalize">
                {scheduleData.type.replace("_", " ")}
              </Badge>
              <Badge
                variant={scheduleData.enabled ? "success" : "secondary"}
                className="text-xs"
              >
                {scheduleData.enabled ? "Enabled" : "Disabled"}
              </Badge>
              {scheduleData.last_run_at && (
                <span className="text-xs text-muted-foreground">
                  Last ran {new Date(scheduleData.last_run_at).toLocaleString()}
                </span>
              )}
              {(scheduleData.retention_count ||
                scheduleData.retention_days) && (
                <span className="text-xs text-muted-foreground">
                  Retention:
                  {scheduleData.retention_count
                    ? ` keep last ${scheduleData.retention_count}`
                    : ""}
                  {scheduleData.retention_count && scheduleData.retention_days
                    ? " ·"
                    : ""}
                  {scheduleData.retention_days
                    ? ` delete after ${scheduleData.retention_days}d`
                    : ""}
                </span>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="h-6 text-xs text-destructive hover:text-destructive ml-auto"
                onClick={() => deleteScheduleMutation.mutate()}
                disabled={deleteScheduleMutation.isPending}
              >
                <Trash2 className="h-3 w-3 mr-1" />
                Remove
              </Button>
            </div>
          )}

        {scheduleError && (
          <ErrorState
            title="Could not load the backup schedule"
            onRetry={() => void refetchSchedule()}
            className="py-8"
          />
        )}

        {!scheduleFormOpen &&
          !scheduleLoading &&
          !scheduleError &&
          !scheduleData && (
            <p className="text-sm text-muted-foreground">
              No schedule configured — backups are created manually only.
            </p>
          )}

        {scheduleLoading && <Skeleton className="h-6 w-64" />}

        {/* Schedule edit form */}
        {scheduleFormOpen && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {/* Backup type */}
              <div className="space-y-1.5">
                <Label className="text-xs">Backup type</Label>
                <Select
                  value={scheduleForm.type}
                  onValueChange={(v) =>
                    setScheduleForm((f) => ({
                      ...f,
                      type: v as typeof f.type,
                    }))
                  }
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="full">Full</SelectItem>
                    <SelectItem value="db_only">Database only</SelectItem>
                    <SelectItem value="files_only">Files only</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Frequency */}
              <div className="space-y-1.5">
                <Label className="text-xs">Frequency</Label>
                <Select
                  value={scheduleForm.frequency}
                  onValueChange={(v) =>
                    setScheduleForm((f) => ({
                      ...f,
                      frequency: v as typeof f.frequency,
                    }))
                  }
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="daily">Daily</SelectItem>
                    <SelectItem value="weekly">Weekly</SelectItem>
                    <SelectItem value="monthly">Monthly</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Hour */}
              <div className="space-y-1.5">
                <Label className="text-xs">Hour (UTC 0–23)</Label>
                <Input
                  type="number"
                  min={0}
                  max={23}
                  className="h-8 text-xs"
                  value={scheduleForm.hour}
                  onChange={(e) =>
                    setScheduleForm((f) => ({
                      ...f,
                      hour: Math.min(23, Math.max(0, Number(e.target.value))),
                    }))
                  }
                />
              </div>

              {/* Minute */}
              <div className="space-y-1.5">
                <Label className="text-xs">Minute (0–59)</Label>
                <Input
                  type="number"
                  min={0}
                  max={59}
                  className="h-8 text-xs"
                  value={scheduleForm.minute}
                  onChange={(e) =>
                    setScheduleForm((f) => ({
                      ...f,
                      minute: Math.min(59, Math.max(0, Number(e.target.value))),
                    }))
                  }
                />
              </div>

              {/* Day of week (weekly) */}
              {scheduleForm.frequency === "weekly" && (
                <div className="space-y-1.5">
                  <Label className="text-xs">Day of week</Label>
                  <Select
                    value={String(scheduleForm.day_of_week)}
                    onValueChange={(v) =>
                      setScheduleForm((f) => ({
                        ...f,
                        day_of_week: Number(v),
                      }))
                    }
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[
                        "Sunday",
                        "Monday",
                        "Tuesday",
                        "Wednesday",
                        "Thursday",
                        "Friday",
                        "Saturday",
                      ].map((d, i) => (
                        <SelectItem key={i} value={String(i)}>
                          {d}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {/* Day of month (monthly) */}
              {scheduleForm.frequency === "monthly" && (
                <div className="space-y-1.5">
                  <Label className="text-xs">Day of month (1–28)</Label>
                  <Input
                    type="number"
                    min={1}
                    max={28}
                    className="h-8 text-xs"
                    value={scheduleForm.day_of_month}
                    onChange={(e) =>
                      setScheduleForm((f) => ({
                        ...f,
                        day_of_month: Math.min(
                          28,
                          Math.max(1, Number(e.target.value)),
                        ),
                      }))
                    }
                  />
                </div>
              )}
            </div>

            {/* Enabled toggle */}
            <div className="flex items-center gap-2">
              <Switch
                id="schedule-enabled"
                checked={scheduleForm.enabled}
                onCheckedChange={(v) =>
                  setScheduleForm((f) => ({ ...f, enabled: v }))
                }
              />
              <Label
                htmlFor="schedule-enabled"
                className="text-sm cursor-pointer"
              >
                {scheduleForm.enabled ? "Enabled" : "Disabled"}
              </Label>
            </div>

            {/* Retention policy */}
            <div className="border-t pt-4 space-y-3">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Retention Policy
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Keep last N backups</Label>
                  <Input
                    type="number"
                    min={1}
                    max={1000}
                    placeholder="Unlimited"
                    className="h-8 text-xs"
                    value={
                      scheduleForm.retention_count === null
                        ? ""
                        : String(scheduleForm.retention_count)
                    }
                    onChange={(e) =>
                      setScheduleForm((f) => ({
                        ...f,
                        retention_count: e.target.value
                          ? Math.max(1, Math.min(1000, Number(e.target.value)))
                          : null,
                      }))
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    Leave empty for unlimited
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Delete after N days</Label>
                  <Input
                    type="number"
                    min={1}
                    max={365}
                    placeholder="Never"
                    className="h-8 text-xs"
                    value={
                      scheduleForm.retention_days === null
                        ? ""
                        : String(scheduleForm.retention_days)
                    }
                    onChange={(e) =>
                      setScheduleForm((f) => ({
                        ...f,
                        retention_days: e.target.value
                          ? Math.max(1, Math.min(365, Number(e.target.value)))
                          : null,
                      }))
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    Leave empty to keep forever
                  </p>
                </div>
              </div>
            </div>

            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => {
                  upsertScheduleMutation.mutate(scheduleForm);
                  setScheduleFormOpen(false);
                }}
                disabled={upsertScheduleMutation.isPending}
              >
                Save schedule
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setScheduleFormOpen(false)}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
