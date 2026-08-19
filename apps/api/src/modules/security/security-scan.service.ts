import { Injectable, NotFoundException, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { SecurityRepository } from "./security.repository";
import { QUEUES, JOB_TYPES } from "@bedrock-forge/shared";
import type {
  SecurityScanType,
  ServerHardeningActionType,
  EnvironmentHardeningActionType,
} from "@bedrock-forge/shared";
import { JobOrchestratorService } from "../job-executions/job-orchestrator.service";

@Injectable()
export class SecurityScanService {
  private readonly logger = new Logger(SecurityScanService.name);

  constructor(
    private readonly repo: SecurityRepository,
    private readonly jobOrchestrator: JobOrchestratorService,
    @InjectQueue(QUEUES.SECURITY) private readonly securityQueue: Queue,
  ) {}

  async triggerServerScan(
    serverId: number,
    types: SecurityScanType[],
  ) {
    const server = await this.repo.findServerById(BigInt(serverId));
    if (!server) throw new NotFoundException(`Server ${serverId} not found`);

    let scanIds: number[] = [];

    const result = await this.jobOrchestrator.enqueue({
      queue: this.securityQueue,
      queueName: QUEUES.SECURITY,
      jobType: JOB_TYPES.SECURITY_SERVER_SCAN,
      payload: { serverId, types },
      serverId,
      jobId: `security-server-${serverId}-${Date.now()}`,
      beforeQueueAdd: async (jobExecutionId) => {
        const createdScans = await this.repo.createServerScansTransaction(
          BigInt(serverId),
          BigInt(jobExecutionId),
          types,
        );
        scanIds = createdScans.map((s) => Number(s.id));
        return {
          serverId,
          scanTypes: types,
          jobExecutionId,
          scanIds,
        };
      },
      onFailure: async () => {
        if (scanIds.length > 0) {
          await this.repo.failSecurityScans(scanIds.map((id) => BigInt(id)));
        }
      },
    });

    return { jobExecutionId: result.jobExecutionId, scanIds };
  }

  async triggerEnvironmentScan(
    environmentId: number,
    types: SecurityScanType[],
  ) {
    const env = await this.repo.findEnvironmentById(BigInt(environmentId));
    if (!env)
      throw new NotFoundException(`Environment ${environmentId} not found`);

    let scanIds: number[] = [];

    const result = await this.jobOrchestrator.enqueue({
      queue: this.securityQueue,
      queueName: QUEUES.SECURITY,
      jobType: JOB_TYPES.SECURITY_ENVIRONMENT_SCAN,
      payload: { environmentId, types },
      environmentId,
      serverId: env.server_id,
      jobId: `security-env-${environmentId}-${Date.now()}`,
      beforeQueueAdd: async (jobExecutionId) => {
        const createdScans = await this.repo.createEnvironmentScansTransaction(
          BigInt(environmentId),
          BigInt(jobExecutionId),
          types,
        );
        scanIds = createdScans.map((s) => Number(s.id));
        return {
          environmentId,
          scanTypes: types,
          jobExecutionId,
          scanIds,
        };
      },
      onFailure: async () => {
        if (scanIds.length > 0) {
          await this.repo.failSecurityScans(scanIds.map((id) => BigInt(id)));
        }
      },
    });

    return { jobExecutionId: result.jobExecutionId, scanIds };
  }

  async applyServerHardening(
    serverId: number,
    actions: ServerHardeningActionType[],
  ) {
    const server = await this.repo.findServerById(BigInt(serverId));
    if (!server) throw new NotFoundException(`Server ${serverId} not found`);

    const result = await this.jobOrchestrator.enqueue({
      queue: this.securityQueue,
      queueName: QUEUES.SECURITY,
      jobType: JOB_TYPES.SECURITY_SERVER_HARDEN,
      payload: { serverId, actions },
      serverId,
      jobId: `security-harden-server-${serverId}-${Date.now()}`,
    });

    return { jobExecutionId: result.jobExecutionId };
  }

  async applyEnvironmentHardening(
    environmentId: number,
    actions: EnvironmentHardeningActionType[],
  ) {
    const env = await this.repo.findEnvironmentById(BigInt(environmentId));
    if (!env)
      throw new NotFoundException(`Environment ${environmentId} not found`);

    const result = await this.jobOrchestrator.enqueue({
      queue: this.securityQueue,
      queueName: QUEUES.SECURITY,
      jobType: JOB_TYPES.SECURITY_ENVIRONMENT_HARDEN,
      payload: { environmentId, actions },
      environmentId,
      serverId: env.server_id,
      jobId: `security-harden-env-${environmentId}-${Date.now()}`,
    });

    return { jobExecutionId: result.jobExecutionId };
  }
}
