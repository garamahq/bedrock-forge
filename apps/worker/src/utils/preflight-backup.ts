import { Logger } from "@nestjs/common";
import { Queue } from "bullmq";
import { randomUUID } from "crypto";
import { JOB_TYPES, QUEUES } from "@bedrock-forge/shared";
import { PrismaService } from "../prisma/prisma.service";
import { StepTracker } from "../services/step-tracker";

export interface PreflightSafetyBackupOptions {
  prisma: PrismaService;
  backupQueue: Pick<Queue, "add" | "getJob">;
  environmentId: number;
  tracker: StepTracker;
  logger?: Logger;
  queueWaitTimeoutMs?: number;
  executionTimeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_QUEUE_WAIT_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_EXECUTION_TIMEOUT_MS = 20 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 10_000;

async function markSafetyBackupFailed(
  prisma: PrismaService,
  execId: bigint,
  backupId: bigint,
  errorMessage: string,
): Promise<void> {
  const completedAt = new Date();
  await Promise.allSettled([
    prisma.jobExecution.update({
      where: { id: execId },
      data: {
        status: "failed",
        last_error: errorMessage,
        completed_at: completedAt,
      },
    }),
    prisma.backup.update({
      where: { id: backupId },
      data: {
        status: "failed",
        error_message: errorMessage,
        completed_at: completedAt,
      },
    }),
  ]);
}

/**
 * Enqueue a pre-flight DB safety backup and wait for it while separating queue wait
 * duration from active execution duration (`#38`):
 * - Rejects conflicting active backup/restore operations on the same environment.
 * - Uses priority 1 so interactive safety backups are not starved behind scheduled runs.
 * - Starts the execution timeout only once JobExecution enters `active` state.
 * - If queue wait expires before the backup starts, removes the queued BullMQ job and
 *   marks the safety records failed so it does not run orphaned later.
 */
export async function runPreflightSafetyBackup(
  opts: PreflightSafetyBackupOptions,
): Promise<{ jobExecutionId: bigint; backupId: bigint }> {
  const {
    prisma,
    backupQueue,
    environmentId,
    tracker,
    queueWaitTimeoutMs = DEFAULT_QUEUE_WAIT_TIMEOUT_MS,
    executionTimeoutMs = DEFAULT_EXECUTION_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    now = () => Date.now(),
    sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
  } = opts;

  const existingActive = await prisma.jobExecution.findFirst?.({
    where: {
      environment_id: BigInt(environmentId),
      queue_name: QUEUES.BACKUPS,
      status: { in: ["queued", "active"] },
    },
    select: { id: true, job_type: true, status: true },
  });

  if (existingActive) {
    throw new Error(
      `Cannot start pre-flight safety backup: environment ${environmentId} already has an active ${existingActive.job_type ?? "backup/restore"} job (#${existingActive.id})`,
    );
  }

  const backupExec = await prisma.jobExecution.create({
    data: {
      environment_id: BigInt(environmentId),
      queue_name: QUEUES.BACKUPS,
      job_type: JOB_TYPES.BACKUP_CREATE,
      bull_job_id: "",
      status: "queued",
    },
  });

  const backup = await prisma.backup.create({
    data: {
      environment_id: BigInt(environmentId),
      type: "db_only",
      status: "running",
      size_bytes: 0,
      file_path: "temp",
      job_execution_id: backupExec.id,
    },
  });

  const backupBullJobId = randomUUID();
  try {
    await backupQueue.add(
      JOB_TYPES.BACKUP_CREATE,
      {
        environmentId,
        type: "db_only",
        jobExecutionId: Number(backupExec.id),
        backupId: Number(backup.id),
      },
      { jobId: backupBullJobId, priority: 1 },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await markSafetyBackupFailed(prisma, backupExec.id, backup.id, msg);
    throw err;
  }

  await prisma.jobExecution.update({
    where: { id: backupExec.id },
    data: { bull_job_id: backupBullJobId },
  });

  const queuedAt = now();
  let activeStartedAt: number | null = null;
  let loggedQueueWait = false;

  while (true) {
    const exec = await prisma.jobExecution.findUnique({
      where: { id: backupExec.id },
    });

    if (exec?.status === "completed") {
      return { jobExecutionId: backupExec.id, backupId: backup.id };
    }

    if (
      exec?.status === "failed" ||
      exec?.status === "dead_letter" ||
      exec?.status === "discarded"
    ) {
      throw new Error(
        "Pre-flight backup failed: " + (exec.last_error || exec.status),
      );
    }

    const currentTime = now();
    if (exec?.status === "active") {
      if (activeStartedAt === null) {
        activeStartedAt = currentTime;
        await tracker.track({
          step: "Pre-flight safety backup started executing",
          level: "info",
          detail:
            loggedQueueWait
              ? `Waited ${Math.round((activeStartedAt - queuedAt) / 1000)}s in queue`
              : undefined,
        });
      }
      if (currentTime - activeStartedAt >= executionTimeoutMs) {
        const msg = `Pre-flight backup execution timed out after ${Math.round(executionTimeoutMs / 60_000)} minutes`;
        await tracker.track({ step: "Pre-flight backup failed", level: "error", detail: msg });
        throw new Error(msg);
      }
    } else {
      // Still queued waiting on another environment/backup worker slot
      if (!loggedQueueWait && currentTime > queuedAt) {
        loggedQueueWait = true;
        await tracker.track({
          step: "Waiting in backup queue for worker slot",
          level: "info",
          detail: "Delayed behind another queued backup job",
        });
      }
      if (currentTime - queuedAt >= queueWaitTimeoutMs) {
        const msg = `Pre-flight backup timed out waiting in backup queue (queue wait exceeded ${Math.round(queueWaitTimeoutMs / 60_000)} minutes)`;
        try {
          const queuedJob = await backupQueue.getJob?.(backupBullJobId);
          if (queuedJob && typeof queuedJob.remove === "function") {
            await queuedJob.remove().catch(() => undefined);
          }
        } catch {
          // Non-fatal if job already dequeued
        }
        await markSafetyBackupFailed(prisma, backupExec.id, backup.id, msg);
        throw new Error(msg);
      }
    }

    await sleep(pollIntervalMs);
  }
}
