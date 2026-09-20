import { Processor, WorkerHost, InjectQueue } from "@nestjs/bullmq";
import { Logger, OnApplicationBootstrap } from "@nestjs/common";
import { Job, Queue } from "bullmq";
import { SecurityAlertPollerService } from "./security-alert-poller.service";
import { SecurityAttackWatcherService } from "./security-attack-watcher.service";
import { SecurityScanRunnerService } from "./services/security-scan-runner.service";
import { SecuritySchedulerService } from "./services/security-scheduler.service";
import { SecurityHardeningService } from "./services/security-hardening.service";
import { SecurityDataRetentionService } from "./services/security-data-retention.service";
import { SecurityBaselineService } from "./services/security-baseline.service";
import { SecuritySecureGuardService } from "./services/security-secure-guard.service";
import { QUEUES, JOB_TYPES } from "@bedrock-forge/shared";

const TICK_JOB_ID = "security-schedule-tick";
const TICK_EVERY_MS = 15 * 60 * 1_000;
const ALERT_TICK_JOB_ID = "security-alert-poll-tick";
const ALERT_TICK_EVERY_MS = 60 * 1_000;
/** Nightly data-retention purge — every 24 h */
const RETENTION_TICK_JOB_ID = "security-data-retention-tick";
const RETENTION_TICK_EVERY_MS = 24 * 60 * 60 * 1_000;

@Processor(QUEUES.SECURITY, {
  concurrency: 4,
  lockDuration: 60_000,
  stalledInterval: 15_000,
  maxStalledCount: 1,
})
export class SecurityScanProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  private readonly logger = new Logger(SecurityScanProcessor.name);

  constructor(
    private readonly alertPoller: SecurityAlertPollerService,
    private readonly attackWatcher: SecurityAttackWatcherService,
    private readonly scanRunner: SecurityScanRunnerService,
    private readonly scheduler: SecuritySchedulerService,
    private readonly hardening: SecurityHardeningService,
    private readonly retention: SecurityDataRetentionService,
    private readonly baselineService: SecurityBaselineService,
    private readonly secureGuard: SecuritySecureGuardService,
    @InjectQueue(QUEUES.SECURITY) private readonly securityQueue: Queue,
  ) {
    super();
  }

  async onApplicationBootstrap() {
    await this.securityQueue.add(
      JOB_TYPES.SECURITY_SCHEDULED_SCAN,
      {},
      {
        repeat: { every: TICK_EVERY_MS },
        jobId: TICK_JOB_ID,
        removeOnComplete: 10,
        removeOnFail: 5,
      },
    );
    await this.securityQueue.add(
      JOB_TYPES.SECURITY_ATTACK_WATCH,
      {},
      {
        repeat: { every: 5 * 60 * 1_000 },
        jobId: "security-attack-watch",
        removeOnComplete: 10,
        removeOnFail: 5,
      },
    );
    await this.securityQueue.add(
      JOB_TYPES.SECURITY_ALERT_POLL,
      {},
      {
        repeat: { every: ALERT_TICK_EVERY_MS },
        jobId: ALERT_TICK_JOB_ID,
        removeOnComplete: 10,
        removeOnFail: 5,
      },
    );
    await this.securityQueue.add(
      JOB_TYPES.SECURITY_DATA_RETENTION,
      {},
      {
        repeat: { every: RETENTION_TICK_EVERY_MS },
        jobId: RETENTION_TICK_JOB_ID,
        removeOnComplete: 5,
        removeOnFail: 5,
      },
    );
    this.logger.log("Security attack watcher registered (every 5 min)");
    this.logger.log("Security alert poller registered (every 1 min)");
    this.logger.log("Security data retention purge registered (every 24 h)");
  }

  async process(job: Job) {
    switch (job.name) {
      case JOB_TYPES.SECURITY_SERVER_SCAN:
        return this.scanRunner.processServerScan(job);
      case JOB_TYPES.SECURITY_ENVIRONMENT_SCAN:
        return this.scanRunner.processEnvironmentScan(job);
      case JOB_TYPES.SECURITY_SCHEDULED_SCAN:
        return this.scheduler.processScheduleTick();
      case JOB_TYPES.SECURITY_SERVER_HARDEN:
        return this.hardening.processServerHardening(job);
      case JOB_TYPES.SECURITY_ENVIRONMENT_HARDEN:
        return this.hardening.processEnvironmentHardening(job);
      case JOB_TYPES.SECURITY_ATTACK_WATCH:
        return this.attackWatcher.processAttackWatcher();
      case JOB_TYPES.SECURITY_ALERT_POLL:
        return this.alertPoller.processAlertPoll(job);
      case JOB_TYPES.SECURITY_DATA_RETENTION:
        return this.retention.runRetentionPurge();
      case JOB_TYPES.SECURITY_BASELINE_CREATE: {
        const { targetType, targetId, userId, label } = job.data as {
          targetType: "server" | "environment";
          targetId: number;
          userId?: number;
          label?: string;
        };
        return this.baselineService.createBaseline(targetType, targetId, userId, label);
      }
      case JOB_TYPES.SECURITY_BASELINE_COMPARE: {
        const { targetType, targetId } = job.data as {
          targetType: "server" | "environment";
          targetId: number;
        };
        return this.baselineService.compareBaseline(targetType, targetId);
      }
      case JOB_TYPES.WP_SECURE_GUARD_INSTALL:
        return this.secureGuard.installSecureGuard(job);
      case JOB_TYPES.WP_SECURE_GUARD_WATCHDOG:
        return this.secureGuard.deployWatchdog(job);
      default:
        this.logger.warn(`Unknown security job type: ${job.name}`);
    }
  }
}

// Backwards-compatible alias
export { SecurityScanProcessor as SecurityServerScanProcessor };
