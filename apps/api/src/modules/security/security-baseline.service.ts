import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { QUEUES, JOB_TYPES } from "@bedrock-forge/shared";
import { SecurityRepository } from "./security.repository";
import { JobOrchestratorService } from "../job-executions/job-orchestrator.service";

@Injectable()
export class SecurityBaselineService {
  private readonly logger = new Logger(SecurityBaselineService.name);

  constructor(
    private readonly repo: SecurityRepository,
    private readonly jobOrchestrator: JobOrchestratorService,
    @InjectQueue(QUEUES.SECURITY) private readonly securityQueue: Queue,
  ) {}

  async triggerServerBaselineCapture(
    serverId: number,
    userId?: number,
    label?: string,
  ) {
    const server = await this.repo.findServerById(BigInt(serverId));
    if (!server) throw new NotFoundException(`Server ${serverId} not found`);

    const result = await this.jobOrchestrator.enqueue({
      queue: this.securityQueue,
      queueName: QUEUES.SECURITY,
      jobType: JOB_TYPES.SECURITY_BASELINE_CREATE,
      payload: {
        targetType: "server",
        targetId: serverId,
        userId,
        label,
      },
      serverId,
      jobId: `security-baseline-create-server-${serverId}-${Date.now()}`,
    });

    return { jobExecutionId: result.jobExecutionId };
  }

  async triggerEnvironmentBaselineCapture(
    environmentId: number,
    userId?: number,
    label?: string,
  ) {
    const env = await this.repo.findEnvironmentById(BigInt(environmentId));
    if (!env) throw new NotFoundException(`Environment ${environmentId} not found`);

    const result = await this.jobOrchestrator.enqueue({
      queue: this.securityQueue,
      queueName: QUEUES.SECURITY,
      jobType: JOB_TYPES.SECURITY_BASELINE_CREATE,
      payload: {
        targetType: "environment",
        targetId: environmentId,
        userId,
        label,
      },
      environmentId,
      jobId: `security-baseline-create-env-${environmentId}-${Date.now()}`,
    });

    return { jobExecutionId: result.jobExecutionId };
  }

  async triggerServerBaselineCompare(serverId: number) {
    const server = await this.repo.findServerById(BigInt(serverId));
    if (!server) throw new NotFoundException(`Server ${serverId} not found`);

    const result = await this.jobOrchestrator.enqueue({
      queue: this.securityQueue,
      queueName: QUEUES.SECURITY,
      jobType: JOB_TYPES.SECURITY_BASELINE_COMPARE,
      payload: {
        targetType: "server",
        targetId: serverId,
      },
      serverId,
      jobId: `security-baseline-compare-server-${serverId}-${Date.now()}`,
    });

    return { jobExecutionId: result.jobExecutionId };
  }

  async triggerEnvironmentBaselineCompare(environmentId: number) {
    const env = await this.repo.findEnvironmentById(BigInt(environmentId));
    if (!env) throw new NotFoundException(`Environment ${environmentId} not found`);

    const result = await this.jobOrchestrator.enqueue({
      queue: this.securityQueue,
      queueName: QUEUES.SECURITY,
      jobType: JOB_TYPES.SECURITY_BASELINE_COMPARE,
      payload: {
        targetType: "environment",
        targetId: environmentId,
      },
      environmentId,
      jobId: `security-baseline-compare-env-${environmentId}-${Date.now()}`,
    });

    return { jobExecutionId: result.jobExecutionId };
  }

  async getServerBaseline(serverId: number) {
    return this.repo.getActiveBaseline({ serverId: BigInt(serverId) });
  }

  async getEnvironmentBaseline(environmentId: number) {
    return this.repo.getActiveBaseline({ environmentId: BigInt(environmentId) });
  }

  async listServerDriftEvents(serverId: number, page?: number, limit?: number) {
    return this.repo.listDriftEvents({
      serverId: BigInt(serverId),
      page,
      limit,
    });
  }

  async listEnvironmentDriftEvents(environmentId: number, page?: number, limit?: number) {
    return this.repo.listDriftEvents({
      environmentId: BigInt(environmentId),
      page,
      limit,
    });
  }
}
