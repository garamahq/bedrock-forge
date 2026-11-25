import { useState, useEffect } from "react";
import { CalendarClock, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { CleanupScheduleData } from "../types";
import { DEFAULT_SCHEDULE } from "../utils";
import {
  useCleanupScheduleQuery,
  useUpsertCleanupScheduleMutation,
  useDeleteCleanupScheduleMutation,
} from "../hooks";

export function CleanupScheduleCard({
  selectedEnvId,
}: {
  selectedEnvId: number | null;
}) {
  const [scheduleForm, setScheduleForm] =
    useState<CleanupScheduleData>(DEFAULT_SCHEDULE);

  const { data: cleanupSchedule, isLoading: scheduleLoading } =
    useCleanupScheduleQuery(selectedEnvId);

  useEffect(() => {
    if (cleanupSchedule) {
      setScheduleForm({
        enabled: cleanupSchedule.enabled ?? true,
        frequency: cleanupSchedule.frequency ?? "weekly",
        hour: cleanupSchedule.hour ?? 3,
        minute: cleanupSchedule.minute ?? 30,
        day_of_week: cleanupSchedule.day_of_week ?? 1,
        day_of_month: cleanupSchedule.day_of_month ?? 1,
        keep_revisions: cleanupSchedule.keep_revisions ?? 3,
      });
    } else {
      setScheduleForm(DEFAULT_SCHEDULE);
    }
  }, [cleanupSchedule, selectedEnvId]);

  const upsertScheduleMutation =
    useUpsertCleanupScheduleMutation(selectedEnvId);
  const deleteScheduleMutation = useDeleteCleanupScheduleMutation(
    selectedEnvId,
    () => {
      setScheduleForm(DEFAULT_SCHEDULE);
    },
  );

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <CalendarClock className="h-4 w-4" />
          Cleanup Schedule
        </CardTitle>
        <CardDescription>
          Automatically run database cleanup on a recurring schedule
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {scheduleLoading ? (
          <p className="text-xs text-muted-foreground">Loading schedule…</p>
        ) : (
          <>
            {/* Enabled toggle */}
            <div className="flex items-center gap-3">
              <Switch
                id="sched-enabled"
                checked={scheduleForm.enabled}
                onCheckedChange={(v) =>
                  setScheduleForm((f) => ({ ...f, enabled: v }))
                }
              />
              <Label htmlFor="sched-enabled" className="text-sm">
                {scheduleForm.enabled ? "Enabled" : "Disabled"}
              </Label>
            </div>

            {/* Frequency + time */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Frequency</Label>
                <Select
                  value={scheduleForm.frequency}
                  onValueChange={(v) =>
                    setScheduleForm((f) => ({ ...f, frequency: v }))
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
              <div className="space-y-1">
                <Label className="text-xs">Time (UTC, hour : minute)</Label>
                <div className="flex items-center gap-1">
                  <Input
                    type="number"
                    min={0}
                    max={23}
                    value={scheduleForm.hour}
                    onChange={(e) =>
                      setScheduleForm((f) => ({
                        ...f,
                        hour: Math.min(
                          23,
                          Math.max(0, parseInt(e.target.value) || 0),
                        ),
                      }))
                    }
                    className="h-8 text-xs w-16 font-mono"
                  />
                  <span className="text-muted-foreground text-xs">:</span>
                  <Input
                    type="number"
                    min={0}
                    max={59}
                    value={scheduleForm.minute}
                    onChange={(e) =>
                      setScheduleForm((f) => ({
                        ...f,
                        minute: Math.min(
                          59,
                          Math.max(0, parseInt(e.target.value) || 0),
                        ),
                      }))
                    }
                    className="h-8 text-xs w-16 font-mono"
                  />
                </div>
              </div>
            </div>

            {/* Day-of-week (weekly only) */}
            {scheduleForm.frequency === "weekly" && (
              <div className="space-y-1">
                <Label className="text-xs">Day of week</Label>
                <Select
                  value={String(scheduleForm.day_of_week ?? 1)}
                  onValueChange={(v) =>
                    setScheduleForm((f) => ({ ...f, day_of_week: Number(v) }))
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

            {/* Day-of-month (monthly only) */}
            {scheduleForm.frequency === "monthly" && (
              <div className="space-y-1">
                <Label className="text-xs">Day of month (1–28)</Label>
                <Input
                  type="number"
                  min={1}
                  max={28}
                  value={scheduleForm.day_of_month ?? 1}
                  onChange={(e) =>
                    setScheduleForm((f) => ({
                      ...f,
                      day_of_month: Math.min(
                        28,
                        Math.max(1, parseInt(e.target.value) || 1),
                      ),
                    }))
                  }
                  className="h-8 text-xs w-20 font-mono"
                />
              </div>
            )}

            {/* Keep revisions */}
            <div className="space-y-1">
              <Label className="text-xs">
                Keep post revisions (0 = delete all)
              </Label>
              <Input
                type="number"
                min={0}
                max={100}
                value={scheduleForm.keep_revisions}
                onChange={(e) =>
                  setScheduleForm((f) => ({
                    ...f,
                    keep_revisions: Math.max(0, parseInt(e.target.value) || 0),
                  }))
                }
                className="h-8 text-xs w-20 font-mono"
              />
            </div>

            {cleanupSchedule?.unsupported_frequency_reason && (
              <p className="text-xs text-destructive">
                {cleanupSchedule.unsupported_frequency_reason}
              </p>
            )}

            {cleanupSchedule?.last_run_at && (
              <p className="text-xs text-muted-foreground">
                Last run:{" "}
                {new Date(cleanupSchedule.last_run_at)
                  .toISOString()
                  .replace("T", " ")
                  .slice(0, 16)}{" "}
                UTC
              </p>
            )}

            <div className="flex flex-wrap gap-2 pt-1">
              <Button
                size="sm"
                disabled={upsertScheduleMutation.isPending || !selectedEnvId}
                onClick={() => upsertScheduleMutation.mutate(scheduleForm)}
              >
                {upsertScheduleMutation.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
                ) : null}
                {cleanupSchedule ? "Update Schedule" : "Save Schedule"}
              </Button>
              {cleanupSchedule && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={deleteScheduleMutation.isPending}
                  onClick={() => deleteScheduleMutation.mutate()}
                >
                  Remove Schedule
                </Button>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
