import {
  Controller,
  Get,
  Post,
  Param,
  ParseIntPipe,
  Query,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { ROLES } from "@bedrock-forge/shared";
import { JobExecutionsService } from "./job-executions.service";
import { QueryJobExecutionDto } from "./dto/query-job-execution.dto";
import { RecoverQueueDto } from "./dto/recover-queue.dto";

@Controller("job-executions")
@UseGuards(AuthGuard("jwt"), RolesGuard)
@Roles(ROLES.MAINTAINER)
export class JobExecutionsController {
  constructor(private readonly svc: JobExecutionsService) {}

  /** GET /job-executions?page=1&limit=25&queue_name=backups&status=failed&environment_id=3 */
  @Get()
  list(@Query() query: QueryJobExecutionDto) {
    const envIds = query.environment_ids
      ? query.environment_ids.split(",").map(Number).filter(Boolean)
      : undefined;
    return this.svc.list(
      {
        queue_name: query.queue_name,
        job_id: query.job_id,
        search: query.search,
        job_type: query.job_type,
        status: query.status,
        environment_id: query.environment_id,
        environment_ids: envIds,
        date_from: query.date_from ? new Date(query.date_from) : undefined,
        date_to: query.date_to ? new Date(query.date_to) : undefined,
      },
      query.page,
      query.limit,
    );
  }

  @Get("recovery-preview")
  @Roles(ROLES.ADMIN)
  recoveryPreview(@Query() query: RecoverQueueDto) {
    return this.svc.recoveryPreview(query.queue_name);
  }

  /** GET /job-executions/:id — full record with environment/project/client */
  @Get(":id")
  findOne(@Param("id", ParseIntPipe) id: number) {
    return this.svc.findOne(id);
  }

  /** GET /job-executions/:id/log — id, status, execution_log only (used for polling) */
  @Get(":id/log")
  findLog(@Param("id", ParseIntPipe) id: number) {
    return this.svc.findLog(id);
  }

  /** POST /job-executions/:id/retry — Retry failed or dead letter job */
  @Post(":id/retry")
  retry(@Param("id", ParseIntPipe) id: number) {
    return this.svc.retry(id);
  }

  /** Reconcile stale records only when BullMQ confirms that work has stopped. */
  @Post("recover-stalled")
  @Roles(ROLES.ADMIN)
  recoverStalled(@Query() query: RecoverQueueDto) {
    return this.svc.recoverStalled(query.queue_name);
  }

  /** POST /job-executions/:id/discard — Mark job as discarded */
  @Post(":id/discard")
  discard(@Param("id", ParseIntPipe) id: number) {
    return this.svc.discard(id);
  }
}
