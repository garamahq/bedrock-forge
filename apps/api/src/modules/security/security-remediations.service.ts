import { Injectable, NotFoundException } from "@nestjs/common";
import { SecurityRepository } from "./security.repository";
import { PreviewRemediationDto, ApplyRemediationDto } from "./dto/safe-remediation.dto";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { QUEUES, JOB_TYPES } from "@bedrock-forge/shared";

@Injectable()
export class SecurityRemediationsService {
  constructor(
    private readonly repo: SecurityRepository,
    @InjectQueue(QUEUES.SECURITY) private readonly securityQueue: Queue,
  ) {}

  async previewRemediation(dto: PreviewRemediationDto) {
    const timestamp = Date.now();
    const backupPath = `/root/.bedrock-forge-backups/safety_${dto.targetType}_${dto.targetId}_${dto.actionType}_${timestamp}.tar.gz`;
    const quarantinePath = `/root/.bedrock-forge-quarantine/${timestamp}`;

    let riskLevel: "low" | "medium" | "high" = "low";
    let commands: string[] = [];
    let filesToModify: string[] = [];
    let preconditions: string[] = [];
    let postVerifications: string[] = [];

    switch (dto.actionType) {
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
        const targetFile = dto.resource || "/path/to/suspicious_file";
        filesToModify = [targetFile];
        preconditions = [
          `Ensure file ${targetFile} exists and is not an essential system binary`,
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
        const wpConfig = dto.resource || "wp-config.php";
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
          `echo "Remediation ${dto.actionType} previewed"`,
        ];
        break;
    }

    return {
      actionType: dto.actionType,
      targetType: dto.targetType,
      targetId: dto.targetId,
      findingId: dto.findingId,
      riskLevel,
      commandsToExecute: commands,
      filesToModify,
      safetyBackupPath: backupPath,
      quarantinePath: dto.actionType === "QUARANTINE_FILE" ? quarantinePath : undefined,
      preconditionChecks: preconditions,
      postVerificationChecks: postVerifications,
      lamahSafetyNotice:
        "Lamah-Staging Safety Policy: All destructive actions create an automated safety rollback archive before modification. Files are quarantined rather than deleted.",
    };
  }

  async applyRemediation(dto: ApplyRemediationDto, userId?: number) {
    if (dto.targetType === "server") {
      const server = await this.repo.findServerById(BigInt(dto.targetId));
      if (!server) throw new NotFoundException(`Server ${dto.targetId} not found`);
    } else {
      const env = await this.repo.findEnvironmentById(BigInt(dto.targetId));
      if (!env) throw new NotFoundException(`Environment ${dto.targetId} not found`);
    }

    // Queue hardening / safe remediation job
    const job = await this.securityQueue.add(
      dto.targetType === "server"
        ? JOB_TYPES.SECURITY_SERVER_HARDEN
        : JOB_TYPES.SECURITY_ENVIRONMENT_HARDEN,
      {
        serverId: dto.targetType === "server" ? dto.targetId : undefined,
        environmentId: dto.targetType === "environment" ? dto.targetId : undefined,
        actionTypes: [dto.actionType],
        findingId: dto.findingId,
        resource: dto.resource,
        userId,
      },
    );

    return {
      queued: true,
      jobId: job.id,
      actionType: dto.actionType,
      targetType: dto.targetType,
      targetId: dto.targetId,
    };
  }
}
