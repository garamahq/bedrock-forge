import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { DEFAULT_JOB_OPTIONS, JOB_TYPES, QUEUES } from "@bedrock-forge/shared";
import { LighthouseRepository } from "./lighthouse.repository";
import { TriggerLighthouseAuditDto } from "./dto/lighthouse-audit.dto";

@Injectable()
export class LighthouseService {
  constructor(
    private readonly repo: LighthouseRepository,
    @InjectQueue(QUEUES.MONITORS) private readonly queue: Queue,
  ) {}

  listLatest() {
    return this.repo.findLatest();
  }

  history(
    environmentId?: number,
    projectId?: number,
    page?: number,
    limit?: number,
  ) {
    return this.repo.findHistory(
      environmentId,
      projectId,
      page ?? 1,
      limit ?? 10,
    );
  }

  async findOne(id: number) {
    const audit = await this.repo.findById(BigInt(id));
    if (!audit) throw new NotFoundException(`Lighthouse audit ${id} not found`);
    return audit;
  }

  async trigger(dto: TriggerLighthouseAuditDto) {
    const env = await this.repo.findEnvironment(BigInt(dto.environment_id));
    if (!env) {
      throw new NotFoundException(
        `Environment ${dto.environment_id} not found`,
      );
    }
    const url = dto.url ?? env.url;
    const strategy = dto.strategy ?? "mobile";
    const running = await this.repo.findRunning(env.id, strategy);
    if (running) {
      return {
        auditId: running.id,
        jobExecutionId: running.job_execution_id,
        reused: true,
      };
    }

    const execution = await this.repo.createJobExecution({
      queue_name: QUEUES.MONITORS,
      job_type: JOB_TYPES.LIGHTHOUSE_AUDIT,
      environment_id: env.id,
      status: "queued",
      payload: { environmentId: dto.environment_id, url, strategy },
    });

    const audit = await this.repo.createAudit({
      environment_id: env.id,
      monitor_id: env.monitors[0]?.id ?? null,
      job_execution_id: execution.id,
      url,
      strategy,
    });

    const bullJob = await this.queue.add(
      JOB_TYPES.LIGHTHOUSE_AUDIT,
      {
        auditId: Number(audit.id),
        environmentId: dto.environment_id,
        url,
        strategy,
        jobExecutionId: Number(execution.id),
      },
      {
        ...DEFAULT_JOB_OPTIONS,
        jobId: `lighthouse-${audit.id}`,
      },
    );
    await this.repo.updateJobExecutionBullId(execution.id, String(bullJob.id));
    return {
      auditId: Number(audit.id),
      jobExecutionId: Number(execution.id),
    };
  }
}
