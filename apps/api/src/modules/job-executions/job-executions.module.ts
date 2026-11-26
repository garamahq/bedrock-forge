import { Module } from "@nestjs/common";
import { JobExecutionsController } from "./job-executions.controller";
import { JobExecutionsService } from "./job-executions.service";
import { JobExecutionsRepository } from "./job-executions.repository";
import { JobOrchestratorService } from "./job-orchestrator.service";
import { BackupsModule } from "../backups/backups.module";
import { SystemBackupsModule } from "../system-backups/system-backups.module";

@Module({
  imports: [BackupsModule, SystemBackupsModule],
  controllers: [JobExecutionsController],
  providers: [
    JobExecutionsService,
    JobExecutionsRepository,
    JobOrchestratorService,
  ],
  exports: [JobExecutionsService, JobOrchestratorService],
})
export class JobExecutionsModule {}
