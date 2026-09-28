import { useEffect, useState } from "react";
import { Calendar, Clock, Loader2, Trash2 } from "lucide-react";
import {
  usePluginUpdateSchedule,
  useSavePluginUpdateSchedule,
  useDeletePluginUpdateSchedule,
} from "../hooks";
import { toast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/crud";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function PluginUpdateScheduleCard({ envId }: { envId: number }) {
  const [frequency, setFrequency] = useState<"daily" | "weekly" | "monthly">(
    "daily",
  );
  const [enabled, setEnabled] = useState(true);
  const [hour, setHour] = useState(3);
  const [minute, setMinute] = useState(0);
  const [dayOfWeek, setDayOfWeek] = useState(1);
  const [dayOfMonth, setDayOfMonth] = useState(1);
  const [initialized, setInitialized] = useState(false);

  const {
    data: schedule,
    isLoading,
    isError,
    refetch,
  } = usePluginUpdateSchedule(envId);

  useEffect(() => {
    if (!schedule || initialized) return;
    setEnabled(schedule.enabled);
    setFrequency(schedule.frequency);
    setHour(schedule.hour);
    setMinute(schedule.minute);
    if (schedule.day_of_week != null) setDayOfWeek(schedule.day_of_week);
    if (schedule.day_of_month != null) setDayOfMonth(schedule.day_of_month);
    setInitialized(true);
  }, [initialized, schedule]);

  const saveMutation = useSavePluginUpdateSchedule(envId, {
    onSuccess: () => {
      toast({ title: "Auto-update schedule saved" });
    },
  });

  const deleteMutation = useDeletePluginUpdateSchedule(envId, {
    onSuccess: () => {
      setInitialized(false);
      toast({ title: "Schedule removed" });
    },
  });

  const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <Calendar className="h-4 w-4" />
          Auto-Update Schedule
        </CardTitle>
        <CardDescription className="text-xs">
          Automatically run <code className="font-mono">composer update</code>{" "}
          on a schedule.
          {schedule?.last_run_at && (
            <span className="ml-1">
              Last run:{" "}
              <span className="font-medium text-foreground">
                {new Date(schedule.last_run_at).toLocaleString()}
              </span>
            </span>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isError ? (
          <ErrorState
            title="Could not load the auto-update schedule"
            onRetry={() => void refetch()}
            className="py-8"
          />
        ) : isLoading ? (
          <div className="space-y-2">
            <div className="h-8 bg-muted animate-pulse rounded" />
            <div className="h-8 bg-muted animate-pulse rounded w-3/4" />
          </div>
        ) : (
          <div className="space-y-4">
            {/* Enabled toggle */}
            <div className="flex items-center gap-3">
              <button
                type="button"
                role="switch"
                aria-checked={enabled}
                onClick={() => setEnabled((v) => !v)}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${enabled ? "bg-primary" : "bg-muted-foreground/30"}`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${enabled ? "translate-x-4" : "translate-x-0.5"}`}
                />
              </button>
              <label className="text-sm font-medium">
                {enabled ? "Enabled" : "Disabled"}
              </label>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {/* Frequency */}
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">
                  Frequency
                </label>
                <Select
                  value={frequency}
                  onValueChange={(v) => setFrequency(v as typeof frequency)}
                >
                  <SelectTrigger className="h-8 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="daily">Daily</SelectItem>
                    <SelectItem value="weekly">Weekly</SelectItem>
                    <SelectItem value="monthly">Monthly</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Time */}
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground flex items-center gap-1">
                  <Clock className="h-3 w-3" /> Time (UTC)
                </label>
                <div className="flex items-center gap-1">
                  <Input
                    type="number"
                    min={0}
                    max={23}
                    value={hour}
                    onChange={(e) => setHour(Number(e.target.value))}
                    className="h-8 w-14 text-sm font-mono text-center p-1"
                  />
                  <span className="text-muted-foreground text-sm">:</span>
                  <Input
                    type="number"
                    min={0}
                    max={59}
                    value={minute}
                    onChange={(e) => setMinute(Number(e.target.value))}
                    className="h-8 w-14 text-sm font-mono text-center p-1"
                  />
                </div>
              </div>

              {/* Day of week (weekly only) */}
              {frequency === "weekly" && (
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">Day</label>
                  <Select
                    value={String(dayOfWeek)}
                    onValueChange={(v) => setDayOfWeek(Number(v))}
                  >
                    <SelectTrigger className="h-8 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DAY_NAMES.map((d, i) => (
                        <SelectItem key={i} value={String(i)}>
                          {d}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {/* Day of month (monthly only) */}
              {frequency === "monthly" && (
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">
                    Day of month
                  </label>
                  <Input
                    type="number"
                    min={1}
                    max={28}
                    value={dayOfMonth}
                    onChange={(e) => setDayOfMonth(Number(e.target.value))}
                    className="h-8 w-14 text-sm font-mono text-center p-1"
                  />
                </div>
              )}
            </div>

            <div className="flex gap-2 pt-1">
              <Button
                size="sm"
                onClick={() =>
                  saveMutation.mutate({
                    enabled,
                    frequency,
                    hour,
                    minute,
                    day_of_week: frequency === "weekly" ? dayOfWeek : undefined,
                    day_of_month:
                      frequency === "monthly" ? dayOfMonth : undefined,
                  })
                }
                disabled={saveMutation.isPending}
                className="flex-1"
              >
                {saveMutation.isPending ? (
                  <>
                    <Loader2 className="h-3 w-3 mr-1.5 animate-spin" /> Saving…
                  </>
                ) : (
                  "Save schedule"
                )}
              </Button>
              {schedule && (
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => deleteMutation.mutate()}
                  disabled={deleteMutation.isPending}
                >
                  {deleteMutation.isPending ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Trash2 className="h-3 w-3" />
                  )}
                </Button>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
