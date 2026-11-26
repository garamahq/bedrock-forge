import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Job, Queue } from "bullmq";
import { join } from "path";
import { PrismaService } from "../../prisma/prisma.service";
import { SshKeyService } from "../../services/ssh-key.service";
import { StepTracker } from "../../services/step-tracker";
import { createRemoteExecutor } from "@bedrock-forge/remote-executor";
import {
  QUEUES,
  JOB_TYPES,
  PluginScheduledUpdatePayload,
} from "@bedrock-forge/shared";
import { ConfigService } from "@nestjs/config";
import { shellQuote, pushRemoteScript } from "../../utils/processor-utils";
import { runPreFlightDbBackup } from "../../utils/preflight-backup";

@Processor(QUEUES.PLUGIN_UPDATES, { concurrency: 1 })
export class PluginUpdateProcessor extends WorkerHost {
  private readonly logger = new Logger(PluginUpdateProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly sshKey: SshKeyService,
    @InjectQueue(QUEUES.PLUGIN_UPDATES)
    private readonly pluginUpdatesQueue: Queue,
    @InjectQueue(QUEUES.PLUGIN_SCANS)
    private readonly pluginScansQueue: Queue,
    @InjectQueue(QUEUES.NOTIFICATIONS)
    private readonly notificationsQueue: Queue,
  ) {
    super();
  }

  async process(job: Job) {
    const payload = job.data as PluginScheduledUpdatePayload;
    const { scheduleId, environmentId } = payload;

    // Guard: if schedule no longer exists or is disabled, self-clean and skip
    const scheduleRecord = await this.prisma.pluginUpdateSchedule.findUnique({
      where: { id: BigInt(scheduleId) },
    });
    if (!scheduleRecord || !scheduleRecord.enabled) {
      this.logger.warn(
        `[${job.id}] Plugin update schedule ${scheduleId} is disabled or no longer exists in DB — removing orphaned repeatable job and skipping`,
      );
      try {
        const repeatableJobs = await this.pluginUpdatesQueue.getRepeatableJobs();
        const orphanKey = `plugin-update-schedule-${scheduleId}`;
        for (const rj of repeatableJobs) {
          if (rj.id === orphanKey) {
            await this.pluginUpdatesQueue.removeRepeatableByKey(rj.key);
            this.logger.log(
              `[${job.id}] Removed orphaned repeatable job: ${rj.key}`,
            );
          }
        }
      } catch (cleanupErr) {
        this.logger.warn(
          `[${job.id}] Could not remove orphaned repeatable job: ${cleanupErr}`,
        );
      }
      return;
    }

    const execution = await this.prisma.jobExecution.create({
      data: {
        queue_name: QUEUES.PLUGIN_UPDATES,
        bull_job_id: String(job.id),
        job_type: JOB_TYPES.PLUGIN_SCHEDULED_UPDATE,
        environment_id: BigInt(environmentId),
        status: "active",
        started_at: new Date(),
        payload: { scheduleId, environmentId },
      },
    });

    const tracker = new StepTracker(
      this.prisma,
      execution.id,
      this.logger,
      job.id ?? "",
    );

    try {
      await tracker.track({
        step: "Plugin auto-update started",
        level: "info",
        detail: `scheduleId=${scheduleId} env=${environmentId}`,
      });

      const env = await this.prisma.environment.findUniqueOrThrow({
        where: { id: BigInt(environmentId) },
        include: { server: true },
      });

      // Verify this is a Bedrock environment by checking the latest plugin scan
      const latestScan = await this.prisma.pluginScan.findFirst({
        where: { environment_id: BigInt(environmentId) },
        orderBy: { scanned_at: "desc" },
      });

      const isBedrock =
        latestScan &&
        typeof latestScan.plugins === "object" &&
        latestScan.plugins !== null &&
        !Array.isArray(latestScan.plugins) &&
        (latestScan.plugins as Record<string, unknown>).is_bedrock === true;

      if (!isBedrock) {
        await tracker.track({
          step: "Skipping — not a Bedrock environment",
          level: "warn",
          detail: "Plugin auto-updates require Bedrock / Composer",
        });
        await this.prisma.jobExecution.update({
          where: { id: execution.id },
          data: {
            status: "failed",
            last_error: "Not a Bedrock environment",
            completed_at: new Date(),
          },
        });
        return;
      }

      // PRE-FLIGHT BACKUP LOGIC
      if (!env.google_drive_folder_id) {
        await tracker.track({
          step: "Skipping pre-flight backup",
          level: "warn",
          detail:
            "Google Drive not configured for this environment. Proceeding without backup.",
        });
      } else {
        await runPreFlightDbBackup({
          prisma: this.prisma,
          redisUrl: this.config.get<string>("redis.url")!,
          environmentId,
          tracker,
          logger: this.logger,
        });
        await job.updateProgress(5);
      }

      const server = env.server;
      await tracker.track({
        step: "Connecting to server",
        level: "info",
        detail: server.ip_address,
      });

      const executor = createRemoteExecutor(
        await this.sshKey.getSshConfig(server),
      );

      await job.updateProgress(10);

      const scriptsPath = this.config.get<string>("scriptsPath")!;
      const remoteScript = `/tmp/bf_composer_update_${job.id}.php`;

      await tracker.track({
        step: "Uploading composer-manager script",
        level: "info",
        detail: `${join(scriptsPath, "composer-manager.php")} → ${remoteScript}`,
      });

      await pushRemoteScript(
        executor,
        join(scriptsPath, "composer-manager.php"),
        remoteScript,
      );

      await job.updateProgress(20);

      await tracker.track({
        step: "Running composer update",
        level: "info",
        detail: `docroot=${env.root_path}`,
      });

      const composerCmd =
        `php ${shellQuote(remoteScript)} --action=update-all` +
        ` --docroot=${shellQuote(env.root_path)}`;
      const composerStart = Date.now();
      const result = await executor.execute(
        composerCmd,
        { timeout: 10 * 60 * 1000 }, // 10-minute timeout for composer
      );

      await tracker.trackCommand(
        "composer-manager.php --action=update-all",
        composerCmd,
        result,
        Date.now() - composerStart,
      );
      await executor.execute(`rm -f ${shellQuote(remoteScript)}`).catch(() => {});

      await job.updateProgress(80);

      if (result.code !== 0) {
        throw new Error(
          `composer update-all failed: ${result.stderr?.trim() || result.stdout.trim() || "unknown error"}`,
        );
      }

      // Update last_run_at on the schedule
      await this.prisma.pluginUpdateSchedule.update({
        where: { id: BigInt(scheduleId) },
        data: { last_run_at: new Date() },
      });

      // Trigger a fresh plugin scan so the UI reflects updated versions
      await tracker.track({
        step: "Queueing post-update plugin scan",
        level: "info",
        detail: "",
      });

      const scanExecution = await this.prisma.jobExecution.create({
        data: {
          queue_name: QUEUES.PLUGIN_SCANS,
          bull_job_id: "",
          job_type: JOB_TYPES.PLUGIN_SCAN_RUN,
          environment_id: BigInt(environmentId),
          status: "queued",
          started_at: new Date(),
          payload: { environmentId },
        },
      });

      const scanJob = await this.pluginScansQueue.add(
        JOB_TYPES.PLUGIN_SCAN_RUN,
        { environmentId, jobExecutionId: Number(scanExecution.id) },
        { attempts: 2, removeOnComplete: 10, removeOnFail: 5 },
      );

      await this.prisma.jobExecution.update({
        where: { id: scanExecution.id },
        data: { bull_job_id: String(scanJob.id) },
      });

      await job.updateProgress(100);

      await this.prisma.jobExecution.update({
        where: { id: execution.id },
        data: { status: "completed", progress: 100, completed_at: new Date() },
      });

      await this.notificationsQueue.add(
        JOB_TYPES.NOTIFICATION_SEND,
        {
          eventType: "plugin-update.completed",
          payload: { scheduleId, environmentId },
        },
        { attempts: 3, removeOnComplete: 100, removeOnFail: 1000 },
      );

      await tracker.track({
        step: "Plugin auto-update completed successfully",
        level: "info",
        detail: "",
      });
    } catch (err) {
      this.logger.error(
        `Plugin auto-update failed for env ${environmentId}: ${err}`,
      );
      await this.prisma.jobExecution.update({
        where: { id: execution.id },
        data: {
          status: "failed",
          last_error: String(err),
          completed_at: new Date(),
        },
      });
      await this.notificationsQueue
        .add(
          JOB_TYPES.NOTIFICATION_SEND,
          {
            eventType: "plugin-update.failed",
            payload: { scheduleId, environmentId, error: String(err) },
          },
          { attempts: 3, removeOnComplete: 100, removeOnFail: 1000 },
        )
        .catch(() => {});
      throw err;
    }
  }
}
