import { Logger } from "@nestjs/common";
import { Queue } from "bullmq";
import { randomUUID } from "crypto";
import {
  BACKUP_JOB_OPTIONS,
  JOB_TYPES,
  QUEUES,
} from "@bedrock-forge/shared";
import { PrismaService } from "../prisma/prisma.service";
import { StepTracker } from "../services/step-tracker";

/**
 * Enqueue a pre-flight DB-only backup and wait for its completion before
 * proceeding with destructive plugin operations (#43).
 */
export async function runPreFlightDbBackup(params: {
  prisma: PrismaService;
  redisUrl: string;
  environmentId: number;
  tracker: StepTracker;
  logger: Logger;
  pollIntervalMs?: number;
  maxAttempts?: number;
}): Promise<void> {
  const {
    prisma,
    redisUrl,
    environmentId,
    tracker,
    logger,
    pollIntervalMs = 10_000,
    maxAttempts = 120,
  } = params;

  await tracker.track({
    step: "Queueing pre-flight backup",
    level: "info",
  });

  const backupBullJobId = randomUUID();
  const createRecords = async (tx: Pick<PrismaService, "jobExecution" | "backup">) => {
    const backupExec = await tx.jobExecution.create({
      data: {
        environment_id: BigInt(environmentId),
        queue_name: QUEUES.BACKUPS,
        job_type: JOB_TYPES.BACKUP_CREATE,
        bull_job_id: backupBullJobId,
        status: "queued",
        payload: { environmentId, type: "db_only" },
      },
    });
    const backup = await tx.backup.create({
      data: {
        environment_id: BigInt(environmentId),
        type: "db_only",
        status: "pending",
        job_execution_id: backupExec.id,
      },
    });
    return { backupExec, backup };
  };

  const { backupExec, backup } =
    typeof prisma.$transaction === "function"
      ? await prisma.$transaction((tx) => createRecords(tx as never))
      : await createRecords(prisma);

  const backupQueue = new Queue(QUEUES.BACKUPS, {
    connection: { url: redisUrl },
  });

  try {
    let addedJob;
    try {
      addedJob = await backupQueue.add(
        JOB_TYPES.BACKUP_CREATE,
        {
          environmentId,
          type: "db_only",
          jobExecutionId: Number(backupExec.id),
          backupId: Number(backup.id),
        },
        { ...BACKUP_JOB_OPTIONS, jobId: backupBullJobId },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const now = new Date();
      await Promise.allSettled([
        prisma.jobExecution.update({
          where: { id: backupExec.id },
          data: { status: "failed", last_error: msg, completed_at: now },
        }),
        prisma.backup.update({
          where: { id: backup.id },
          data: { status: "failed", error_message: msg, completed_at: now },
        }),
      ]);
      throw err;
    }

    const resolvedJobId = addedJob?.id ? String(addedJob.id) : backupBullJobId;
    if (resolvedJobId !== backupBullJobId) {
      await prisma.jobExecution
        .update({
          where: { id: backupExec.id },
          data: { bull_job_id: resolvedJobId },
        })
        .catch((linkErr) => {
          logger.warn(
            `Failed to reconcile backup bull_job_id ${resolvedJobId}: ${
              linkErr instanceof Error ? linkErr.message : String(linkErr)
            }`,
          );
        });
    }
  } finally {
    await backupQueue.close().catch(() => undefined);
  }

  let attempts = 0;
  while (attempts < maxAttempts) {
    const exec = await prisma.jobExecution.findUnique({
      where: { id: backupExec.id },
    });
    if (exec?.status === "completed") {
      await tracker.track({
        step: "Pre-flight backup completed successfully",
        level: "info",
      });
      return;
    }
    if (
      exec?.status === "failed" ||
      exec?.status === "dead_letter" ||
      exec?.status === "discarded"
    ) {
      throw new Error(
        `Pre-flight backup failed: ${exec.last_error ?? exec.status}`,
      );
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    attempts++;
  }

  throw new Error("Pre-flight backup timed out after 20 minutes");
}
