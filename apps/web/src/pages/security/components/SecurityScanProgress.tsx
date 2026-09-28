import React, { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useWebSocketEvent } from "@/lib/websocket";
import { Progress } from "@/components/ui/progress";
import { Card, CardContent } from "@/components/ui/card";
import { Shield, Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import {
  WS_EVENTS,
  type JobCompletedEvent,
  type JobFailedEvent,
  type JobProgressEvent,
} from "@bedrock-forge/shared";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isJobProgressEvent(value: unknown): value is JobProgressEvent {
  return (
    isRecord(value) &&
    typeof value.jobId === "string" &&
    typeof value.queueName === "string" &&
    typeof value.progress === "number" &&
    Number.isFinite(value.progress) &&
    (value.step === undefined || typeof value.step === "string")
  );
}

function isJobCompletedEvent(value: unknown): value is JobCompletedEvent {
  return (
    isRecord(value) &&
    typeof value.jobId === "string" &&
    typeof value.queueName === "string"
  );
}

function isJobFailedEvent(value: unknown): value is JobFailedEvent {
  return (
    isRecord(value) &&
    typeof value.jobId === "string" &&
    typeof value.queueName === "string" &&
    typeof value.error === "string" &&
    typeof value.attempt === "number"
  );
}

export function SecurityScanProgress() {
  const queryClient = useQueryClient();
  const [activeJobs, setActiveJobs] = useState<
    Record<string, { progress: number; step?: string }>
  >({});

  useWebSocketEvent(WS_EVENTS.JOB_PROGRESS, (payload) => {
    if (isJobProgressEvent(payload) && payload.queueName === "security") {
      setActiveJobs((prev) => ({
        ...prev,
        [payload.jobId]: { progress: payload.progress, step: payload.step },
      }));
    }
  });

  useWebSocketEvent(WS_EVENTS.JOB_COMPLETED, (payload) => {
    if (isJobCompletedEvent(payload) && payload.queueName === "security") {
      setActiveJobs((prev) => {
        const next = { ...prev };
        delete next[payload.jobId];
        return next;
      });
      void queryClient.invalidateQueries({ queryKey: ["security"] });
    }
  });

  useWebSocketEvent(WS_EVENTS.JOB_FAILED, (payload) => {
    if (isJobFailedEvent(payload) && payload.queueName === "security") {
      setActiveJobs((prev) => {
        const next = { ...prev };
        delete next[payload.jobId];
        return next;
      });
      void queryClient.invalidateQueries({ queryKey: ["security"] });
    }
  });

  const jobIds = Object.keys(activeJobs);
  if (jobIds.length === 0) return null;

  return (
    <div className="space-y-3 mb-6 animate-in fade-in slide-in-from-top-4 duration-500">
      {jobIds.map((id) => {
        const job = activeJobs[id];
        return (
          <Card
            key={id}
            className="border-primary/20 bg-primary/5 overflow-hidden"
          >
            <CardContent className="p-4">
              <div className="flex items-center gap-4">
                <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center text-primary shrink-0">
                  <Loader2 className="h-5 w-5 animate-spin" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex justify-between items-center mb-1">
                    <p className="text-sm font-semibold truncate">
                      Security Scan in Progress
                    </p>
                    <span className="text-xs font-mono font-medium text-primary">
                      {Math.round(job.progress)}%
                    </span>
                  </div>
                  <Progress value={job.progress} className="h-1.5" />
                  {job.step && (
                    <p className="text-[10px] text-muted-foreground mt-1.5 uppercase tracking-wider font-medium">
                      Current step:{" "}
                      <span className="text-foreground">{job.step}</span>
                    </p>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
