import { Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Job, Queue } from "bullmq";
import { PrismaService } from "../../../prisma/prisma.service";
import { SshKeyService } from "../../../services/ssh-key.service";
import { createRemoteExecutor } from "@bedrock-forge/remote-executor";
import {
  QUEUES,
  JOB_TYPES,
  type SecurityServerHardeningPayload,
  type SecurityEnvironmentHardeningPayload,
  type SecurityScanType,
} from "@bedrock-forge/shared";
import {
  applyServerHardeningActions,
  applyEnvironmentHardeningActions,
} from "../hardening-actions";
import { StepTracker } from "../../../services/step-tracker";

interface StoredScanFinding {
  category: string;
  title: string;
  severity: string;
  metadata?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStoredScanFinding(value: unknown): value is StoredScanFinding {
  return (
    isRecord(value) &&
    typeof value.category === "string" &&
    typeof value.title === "string" &&
    typeof value.severity === "string" &&
    (value.metadata === undefined || isRecord(value.metadata))
  );
}

function parseStoredScanFindings(value: unknown): StoredScanFinding[] {
  return Array.isArray(value) ? value.filter(isStoredScanFinding) : [];
}

@Injectable()
export class SecurityHardeningService {
  private readonly logger = new Logger(SecurityHardeningService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sshKey: SshKeyService,
    @InjectQueue(QUEUES.SECURITY) private readonly securityQueue: Queue,
  ) {}

  async processServerHardening(job: Job) {
    const payload = job.data as SecurityServerHardeningPayload;
    const { serverId, jobExecutionId, actions } = payload;

    const tracker = await StepTracker.start(
      this.prisma,
      jobExecutionId,
      this.logger,
      job,
    );

    try {
      const server = await this.prisma.server.findUnique({
        where: { id: BigInt(serverId) },
      });
      if (!server) throw new Error(`Server ${serverId} not found`);

      const executor = createRemoteExecutor(
        await this.sshKey.getSshConfig(server),
      );

      const allowlistSetting = await this.prisma.appSetting.findUnique({
        where: { key: "security_ip_allowlist" },
      });
      let trustedCidrs: string[] = [];
      try {
        const parsed = JSON.parse(allowlistSetting?.value ?? "[]");
        if (Array.isArray(parsed)) trustedCidrs = parsed.filter((value): value is string => typeof value === "string");
      } catch {
        trustedCidrs = [];
      }

      let malwareFiles: string[] = [];
      if (actions.includes("QUARANTINE_MALWARE")) {
        malwareFiles = await this.getMalwareFilesForServer(serverId);
      }

      const results = await applyServerHardeningActions(executor, actions, trustedCidrs, malwareFiles);

      const logEntries = results.map((r) => ({
        ts: new Date().toISOString(),
        step: r.action,
        level:
          r.status === "failed"
            ? "error"
            : r.status === "skipped"
              ? "warn"
              : "info",
        detail: r.detail,
        hardenStatus: r.status,
      }));

      await tracker.complete({ executionLog: logEntries });

      this.logger.log(
        `Server hardening ${jobExecutionId} completed — ${results.length} action(s)`,
      );

      try {
        await this.triggerVerificationScan("server", serverId, serverId, actions);
      } catch (scanErr) {
        this.logger.error(
          `Failed to trigger automated verification scan for server ${serverId}: ${scanErr instanceof Error ? scanErr.message : String(scanErr)}`,
        );
      }

      return results;
    } catch (err) {
      this.logger.error(
        `Server hardening ${jobExecutionId} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      await tracker.fail(err, "Server hardening");
      throw err;
    }
  }

  async processEnvironmentHardening(job: Job) {
    const payload = job.data as SecurityEnvironmentHardeningPayload;
    const { environmentId, jobExecutionId, actions } = payload;

    const tracker = await StepTracker.start(
      this.prisma,
      jobExecutionId,
      this.logger,
      job,
    );

    try {
      const env = await this.prisma.environment.findUnique({
        where: { id: BigInt(environmentId) },
        include: { server: true },
      });
      if (!env) throw new Error(`Environment ${environmentId} not found`);

      const executor = createRemoteExecutor(
        await this.sshKey.getSshConfig(env.server),
      );

      const rootPath = env.root_path;

      let malwareFiles: string[] = [];
      if (actions.includes("QUARANTINE_MALWARE")) {
        malwareFiles = await this.getMalwareFilesForEnvironment(environmentId);
      }

      const results = await applyEnvironmentHardeningActions(
        executor,
        rootPath,
        actions,
        malwareFiles,
      );

      const logEntries = results.map((r) => ({
        ts: new Date().toISOString(),
        step: r.action,
        level:
          r.status === "failed"
            ? "error"
            : r.status === "skipped"
              ? "warn"
              : "info",
        detail: r.detail,
        hardenStatus: r.status,
      }));

      await tracker.complete({ executionLog: logEntries });

      this.logger.log(
        `Environment hardening ${jobExecutionId} completed — ${results.length} action(s)`,
      );

      try {
        await this.triggerVerificationScan("environment", environmentId, Number(env.server_id), actions);
      } catch (scanErr) {
        this.logger.error(
          `Failed to trigger automated verification scan for environment ${environmentId}: ${scanErr instanceof Error ? scanErr.message : String(scanErr)}`,
        );
      }

      return results;
    } catch (err) {
      this.logger.error(
        `Environment hardening ${jobExecutionId} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      await tracker.fail(err, "Environment hardening");
      throw err;
    }
  }

  /**
   * Determines which scan types should run to verify the effect of the applied
   * hardening actions, then enqueues a verification scan job.
   *
   * Only the scan types relevant to the actions are scheduled — e.g. applying
   * SSH actions triggers SSH_AUDIT + SERVER_HARDENING; malware quarantine also
   * triggers MALWARE_SCAN.  This avoids re-running unrelated slow scans.
   */
  private async triggerVerificationScan(
    targetType: "server" | "environment",
    targetId: number,
    serverId: number,
    appliedActions: string[],
  ) {
    const scanTypes = this.deriveVerificationScanTypes(
      targetType,
      appliedActions,
    );

    if (scanTypes.length === 0) {
      this.logger.log(
        `[Verification] No scan types derived for ${targetType} ${targetId} — skipping`,
      );
      return;
    }

    const jobType =
      targetType === "server"
        ? JOB_TYPES.SECURITY_SERVER_SCAN
        : JOB_TYPES.SECURITY_ENVIRONMENT_SCAN;

    const execution = await this.prisma.jobExecution.create({
      data: {
        queue_name: QUEUES.SECURITY,
        bull_job_id: "pending",
        job_type: jobType,
        server_id: BigInt(serverId),
        environment_id:
          targetType === "environment" ? BigInt(targetId) : undefined,
        status: "queued",
        payload:
          targetType === "server"
            ? { serverId: Number(targetId), types: scanTypes }
            : { environmentId: Number(targetId), types: scanTypes },
      },
    });

    const scanIds: number[] = [];
    for (const scanType of scanTypes) {
      const scan = await this.prisma.securityScan.create({
        data: {
          scan_type: scanType,
          server_id: BigInt(serverId),
          environment_id:
            targetType === "environment" ? BigInt(targetId) : undefined,
          job_execution_id: execution.id,
        },
      });
      scanIds.push(Number(scan.id));
    }

    const bullJob = await this.securityQueue.add(
      jobType,
      targetType === "server"
        ? {
            serverId: Number(targetId),
            scanTypes,
            jobExecutionId: Number(execution.id),
            scanIds,
          }
        : {
            environmentId: Number(targetId),
            scanTypes,
            jobExecutionId: Number(execution.id),
            scanIds,
          },
      {
        attempts: 3,
        backoff: { type: "exponential", delay: 30_000 },
        removeOnComplete: 10,
        removeOnFail: 5,
        jobId: `security-${targetType}-${targetId}-verify-${Date.now()}`,
      },
    );

    await this.prisma.jobExecution.update({
      where: { id: execution.id },
      data: { bull_job_id: String(bullJob.id) },
    });

    this.logger.log(
      `[Verification] Enqueued post-hardening scan for ${targetType} ${targetId} — types: ${scanTypes.join(", ")}`,
    );
  }

  /**
   * Maps hardening actions to the scan types that best verify their effect.
   * Multiple actions may map to the same scan type — duplicates are deduplicated.
   */
  private deriveVerificationScanTypes(
    targetType: "server" | "environment",
    appliedActions: string[],
  ): SecurityScanType[] {
    const actionSet = new Set(appliedActions);
    const scanTypes = new Set<SecurityScanType>();

    if (targetType === "server") {
      // SSH / auth hardening → audit SSH config
      const sshActions = new Set([
        "DISABLE_X11_FORWARDING",
        "SET_MAX_AUTH_TRIES",
        "FIX_SSH_DIR_PERMS",
        "DISABLE_PASSWORD_AUTH",
      ]);
      if ([...sshActions].some((a) => actionSet.has(a))) {
        scanTypes.add("SSH_AUDIT");
      }

      // General server hardening actions → server hardening scan
      const serverActions = new Set([
        "FIX_WORLD_WRITABLE",
        "INSTALL_FAIL2BAN",
        "INSTALL_AUDITD",
        "BLOCK_BRUTE_FORCE_IPS",
        "CLEAN_HTACCESS_REDIRECTS",
        "RESTRICT_INTERNAL_PORTS",
        "CLEAN_SUSPICIOUS_CRONS",
      ]);
      if ([...serverActions].some((a) => actionSet.has(a))) {
        scanTypes.add("SERVER_HARDENING");
      }

      // Port restriction also needs a fresh NETWORK_AUDIT to clear stale
      // Redis / MySQL / Memcached "listening on 0.0.0.0" findings.
      if (actionSet.has("RESTRICT_INTERNAL_PORTS")) {
        scanTypes.add("NETWORK_AUDIT");
      }

      // Exposed backups moved → re-run filesystem audit to clear the finding
      if (actionSet.has("REMOVE_EXPOSED_BACKUPS")) {
        scanTypes.add("FILESYSTEM_AUDIT");
      }

      // Malware / file cleanup → malware scan
      if (
        actionSet.has("QUARANTINE_MALWARE") ||
        actionSet.has("DELETE_PHP_UPLOAD_FILES")
      ) {
        scanTypes.add("MALWARE_SCAN");
      }
    } else {
      // WordPress content/plugin actions → wp audit
      const wpActions = new Set([
        "BLOCK_PHP_UPLOADS",
        "BLOCK_XMLRPC",
        "BLOCK_VERSION_DISCLOSURE",
        "ADD_SECURITY_HEADERS",
        "DISABLE_DIRECTORY_LISTING",
        "BLOCK_DEBUG_LOG",
        "BLOCK_SENSITIVE_FILES",
        "DISABLE_FILE_EDITOR",
        "BLOCK_USER_ENUMERATION",
        "CLEAN_HTACCESS_REDIRECTS",
      ]);
      if ([...wpActions].some((a) => actionSet.has(a))) {
        scanTypes.add("WP_AUDIT");
      }

      // Core / plugin updates → plugin audit
      if (
        actionSet.has("FORCE_REINSTALL_CORE") ||
        actionSet.has("UPDATE_ALL_PLUGINS")
      ) {
        scanTypes.add("PLUGIN_AUDIT");
        scanTypes.add("WP_AUDIT");
      }

      // Malware / backdoor cleanup → malware + backdoor scan
      if (
        actionSet.has("QUARANTINE_MALWARE") ||
        actionSet.has("DELETE_PHP_UPLOAD_FILES")
      ) {
        scanTypes.add("PROJECT_MALWARE");
        scanTypes.add("BACKDOOR_SEARCH");
      }
    }

    return Array.from(scanTypes);
  }

  private async getMalwareFilesForServer(serverId: number): Promise<string[]> {
    const latestScan = await this.prisma.securityScan.findFirst({
      where: {
        server_id: BigInt(serverId),
        scan_type: "MALWARE_SCAN",
        status: "completed",
      },
      orderBy: { completed_at: "desc" },
    });
    if (!latestScan || !latestScan.findings) return [];
    const findings = parseStoredScanFindings(latestScan.findings);

    const acks = await this.prisma.securityFindingAck.findMany({
      where: { server_id: BigInt(serverId) },
    });
    const ackKeys = new Set(
      acks.map((ack) => `${ack.scope_key}::${ack.category}::${ack.title}`)
    );

    const files = new Set<string>();
    const scopeKey = `server:${serverId}`;
    for (const f of findings) {
      const ackKey = `${scopeKey}::${f.category}::${f.title}`;
      if (ackKeys.has(ackKey)) {
        continue;
      }
      const meta = f.metadata || {};
      if (meta.is_malware === false) {
        continue;
      }
      const titleLower = (f.title || "").toLowerCase();
      if (titleLower.includes("modified in the last") || titleLower.includes("recently modified")) {
        continue;
      }
      // Only quarantine files from critical/high malware findings, reverse shells, or known webshell categories
      const isMalwareCategory =
        f.category === "MALWARE" ||
        f.category === "REVERSE_SHELL" ||
        (f.category === "SUSPICIOUS_FILES" && (
          f.severity === "critical" ||
          titleLower.includes("uploads") ||
          titleLower.includes("tmp") ||
          titleLower.includes("hidden") ||
          titleLower.includes("backdoor") ||
          titleLower.includes("pattern")
        ));

      if (isMalwareCategory) {
        const matched = meta.matched_files || meta.infected_files || (f.severity === "critical" ? meta.files : []);
        if (Array.isArray(matched)) {
          for (const file of matched) {
            if (typeof file === "string") files.add(file);
          }
        }
      }
    }
    return Array.from(files);
  }

  private async getMalwareFilesForEnvironment(environmentId: number): Promise<string[]> {
    const latestScans = await this.prisma.securityScan.findMany({
      where: {
        environment_id: BigInt(environmentId),
        scan_type: { in: ["PROJECT_MALWARE", "BACKDOOR_SEARCH"] },
        status: "completed",
      },
      orderBy: { completed_at: "desc" },
    });
    if (!latestScans || latestScans.length === 0) return [];

    const scanMap = new Map<string, typeof latestScans[0]>();
    for (const s of latestScans) {
      if (!scanMap.has(s.scan_type)) {
        scanMap.set(s.scan_type, s);
      }
    }

    const acks = await this.prisma.securityFindingAck.findMany({
      where: { environment_id: BigInt(environmentId) },
    });
    const ackKeys = new Set(
      acks.map((ack) => `${ack.scope_key}::${ack.category}::${ack.title}`)
    );

    const files = new Set<string>();
    const scopeKey = `environment:${environmentId}`;
    for (const scan of scanMap.values()) {
      if (!scan.findings) continue;
      const findings = parseStoredScanFindings(scan.findings);
      for (const f of findings) {
        const ackKey = `${scopeKey}::${f.category}::${f.title}`;
        if (ackKeys.has(ackKey)) {
          continue;
        }
        const meta = f.metadata || {};
        if (meta.is_malware === false) {
          continue;
        }
        const titleLower = (f.title || "").toLowerCase();
        if (titleLower.includes("modified in the last") || titleLower.includes("recently modified")) {
          continue;
        }
        const isMalwareCategory =
          f.category === "MALWARE" ||
          f.category === "REVERSE_SHELL" ||
          (f.category === "SUSPICIOUS_FILES" && (
            f.severity === "critical" ||
            titleLower.includes("uploads") ||
            titleLower.includes("tmp") ||
            titleLower.includes("hidden") ||
            titleLower.includes("backdoor") ||
            titleLower.includes("pattern")
          ));

        if (isMalwareCategory) {
          const matched = meta.matched_files || meta.infected_files || (f.severity === "critical" ? meta.files : []);
          if (Array.isArray(matched)) {
            for (const file of matched) {
              if (typeof file === "string") files.add(file);
            }
          }
        }
      }
    }
    return Array.from(files);
  }
}
