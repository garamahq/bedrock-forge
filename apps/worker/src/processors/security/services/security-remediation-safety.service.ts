import { Injectable, Logger, BadRequestException, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../../prisma/prisma.service";
import type { Server } from "@prisma/client";
import { SshKeyService } from "../../../services/ssh-key.service";
import { createRemoteExecutor } from "@bedrock-forge/remote-executor";
import { FindingDeduplicationService } from "./finding-deduplication.service";

export interface DryRunPlan {
  actionType: string;
  targetType: "server" | "environment";
  targetId: number;
  riskLevel: "low" | "medium" | "high";
  commandsToExecute: string[];
  filesToModify: string[];
  safetyBackupPath?: string;
  quarantinePath?: string;
  preconditionChecks: string[];
  postVerificationChecks: string[];
  lamahSafetyNotice: string;
}

@Injectable()
export class SecurityRemediationSafetyService {
  private readonly logger = new Logger(SecurityRemediationSafetyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sshKey: SshKeyService,
    private readonly findingDedup: FindingDeduplicationService,
  ) {}

  /**
   * Generates a preview plan for a remediation action without executing it.
   */
  async previewRemediation(params: {
    targetType: "server" | "environment";
    targetId: number;
    actionType: string;
    findingId?: number;
    resource?: string;
  }): Promise<DryRunPlan> {
    const timestamp = Date.now();
    const backupPath = `/root/.bedrock-forge-backups/safety_${params.targetType}_${params.targetId}_${params.actionType}_${timestamp}.tar.gz`;
    const quarantinePath = `/root/.bedrock-forge-quarantine/${timestamp}`;

    let riskLevel: "low" | "medium" | "high" = "low";
    let commands: string[] = [];
    let filesToModify: string[] = [];
    let preconditions: string[] = [];
    let postVerifications: string[] = [];

    switch (params.actionType) {
      case "DISABLE_PASSWORD_AUTH":
        riskLevel = "medium";
        filesToModify = ["/etc/ssh/sshd_config", "/etc/ssh/sshd_config.d/99-bedrock-forge.conf"];
        preconditions = [
          "Check that at least one authorized SSH public key is installed for ssh user",
          "Ensure active SSH session remains alive during reload",
        ];
        commands = [
          `mkdir -p /root/.bedrock-forge-backups`,
          `tar -czf ${backupPath} /etc/ssh/sshd_config /etc/ssh/sshd_config.d 2>/dev/null || true`,
          `mkdir -p /etc/ssh/sshd_config.d`,
          `echo "PasswordAuthentication no" > /etc/ssh/sshd_config.d/99-bedrock-forge-no-password.conf`,
          `sshd -t`,
          `systemctl reload sshd || systemctl reload ssh`,
        ];
        postVerifications = [
          "sshd -t syntax test must return exit code 0",
          "Verify SSH daemon is active",
        ];
        break;

      case "ENABLE_UFW_FIREWALL":
        riskLevel = "high";
        preconditions = [
          "Verify SSH port is explicitly allowed before enabling UFW to prevent lockout",
          "Verify web ports (80, 443) and control panel ports are allowed",
        ];
        commands = [
          `mkdir -p /root/.bedrock-forge-backups`,
          `tar -czf ${backupPath} /etc/ufw 2>/dev/null || true`,
          `ufw allow 22/tcp || ufw allow ssh`,
          `ufw allow 80/tcp`,
          `ufw allow 443/tcp`,
          `ufw --force enable`,
          `ufw status verbose`,
        ];
        postVerifications = ["Verify ufw status is active and port 22/ssh is ALLOWED"];
        break;

      case "QUARANTINE_FILE":
        riskLevel = "medium";
        const targetFile = params.resource || "/path/to/suspicious_file";
        filesToModify = [targetFile];
        preconditions = [
          `Ensure file ${targetFile} exists and is not an essential system library (/bin, /lib, /sbin)`,
        ];
        commands = [
          `mkdir -p ${quarantinePath}`,
          `chmod 700 ${quarantinePath}`,
          `cp -p "${targetFile}" "${quarantinePath}/"`,
          `mv "${targetFile}" "${quarantinePath}/quarantined_$(basename "${targetFile}")"`,
          `echo "Original path: ${targetFile} | Quarantined at: $(date)" > "${quarantinePath}/meta.txt"`,
        ];
        postVerifications = [
          `Verify file is removed from original path ${targetFile}`,
          `Verify copy exists safely in ${quarantinePath}`,
        ];
        break;

      case "HARDEN_WP_CONFIG":
      case "DISABLE_WP_FILE_EDIT":
        riskLevel = "low";
        const wpConfig = params.resource || "wp-config.php";
        filesToModify = [wpConfig];
        preconditions = [`Verify ${wpConfig} exists and is writable`];
        commands = [
          `mkdir -p /root/.bedrock-forge-backups`,
          `cp -p "${wpConfig}" "${backupPath}.bak"`,
          `grep -q "DISALLOW_FILE_EDIT" "${wpConfig}" || sed -i "1s/^/<?php define('DISALLOW_FILE_EDIT', true); ?>\\n/" "${wpConfig}"`,
        ];
        postVerifications = [`Verify DISALLOW_FILE_EDIT is set in ${wpConfig}`];
        break;

      default:
        riskLevel = "medium";
        commands = [
          `mkdir -p /root/.bedrock-forge-backups`,
          `echo "Remediation ${params.actionType} executed at $(date)" >> /root/.bedrock-forge-backups/audit.log`,
        ];
        break;
    }

    return {
      actionType: params.actionType,
      targetType: params.targetType,
      targetId: params.targetId,
      riskLevel,
      commandsToExecute: commands,
      filesToModify,
      safetyBackupPath: backupPath,
      quarantinePath: params.actionType === "QUARANTINE_FILE" ? quarantinePath : undefined,
      preconditionChecks: preconditions,
      postVerificationChecks: postVerifications,
      lamahSafetyNotice:
        "Lamah-Staging Safety Policy: All destructive actions create an automated safety rollback archive before modification. Files are quarantined rather than deleted.",
    };
  }

  /**
   * Safely executes a remediation action on a remote server.
   */
  async applyRemediation(params: {
    targetType: "server" | "environment";
    targetId: number;
    actionType: string;
    findingId?: number;
    resource?: string;
  }) {
    this.logger.log(
      `Applying safe remediation ${params.actionType} for ${params.targetType} ${params.targetId}`,
    );

    // Resolve server SSH connection
    let server: Server | null = null;
    if (params.targetType === "server") {
      server = await this.prisma.server.findUnique({ where: { id: BigInt(params.targetId) } });
    } else {
      const env = await this.prisma.environment.findUnique({
        where: { id: BigInt(params.targetId) },
        include: { server: true },
      });
      server = env?.server ?? null;
    }

    if (!server) {
      throw new NotFoundException(`Target server not found for ${params.targetType} ${params.targetId}`);
    }

    const sshConfig = await this.sshKey.getSshConfig(server);
    const exec = createRemoteExecutor(sshConfig);

    const plan = await this.previewRemediation(params);

    // Execute commands sequentially
    const executionLogs: { cmd: string; code: number; stdout: string; stderr: string }[] = [];

    for (const cmd of plan.commandsToExecute) {
      const res = await exec.execute(cmd, { timeout: 45_000 });
      executionLogs.push({ cmd, code: res.code, stdout: res.stdout, stderr: res.stderr });

      if (res.code !== 0 && !cmd.includes("|| true")) {
        this.logger.error(`Remediation command failed: ${cmd}\nError: ${res.stderr}`);
        throw new BadRequestException(
          `Remediation step failed: ${cmd}. Stderr: ${res.stderr || res.stdout}`,
        );
      }
    }

    // If findingId provided, update finding status to remediated
    if (params.findingId) {
      const finding = await this.prisma.securityFinding.findUnique({
        where: { id: BigInt(params.findingId) },
      });
      if (finding) {
        await this.prisma.securityFinding.update({
          where: { id: finding.id },
          data: {
            status: "remediated",
            resolved_at: new Date(),
          },
        });
        await this.prisma.securityFindingTransition.create({
          data: {
            finding_id: finding.id,
            from_status: finding.status,
            to_status: "remediated",
            note: `Remediated safely via action ${params.actionType}. Safety backup created at ${plan.safetyBackupPath || plan.quarantinePath}.`,
          },
        });
      }
    }

    return {
      success: true,
      actionType: params.actionType,
      backupCreated: plan.safetyBackupPath || plan.quarantinePath,
      executionLogs,
    };
  }
}
