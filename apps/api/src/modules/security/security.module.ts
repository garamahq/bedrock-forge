import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { QUEUES } from "@bedrock-forge/shared";
import { SecurityController } from "./security.controller";
import { SecurityService } from "./security.service";
import { SecurityScanService } from "./security-scan.service";
import { SecurityFindingsService } from "./security-findings.service";
import { SecuritySchedulesService } from "./security-schedules.service";
import { SecurityAlertsService } from "./security-alerts.service";
import { SecurityBaselineService } from "./security-baseline.service";
import { SecurityIncidentsService } from "./security-incidents.service";
import { SecurityAlertRulesService } from "./security-alert-rules.service";
import { SecurityRemediationsService } from "./security-remediations.service";
import { SecurityWatcherService } from "./security-watcher.service";
import { SecurityRepository } from "./security.repository";
import { SettingsModule } from "../settings/settings.module";
import { VulnerabilityDbService } from "./vulnerability-db.service";
import { JobExecutionsModule } from "../job-executions/job-executions.module";

@Module({
  imports: [
    BullModule.registerQueue({ name: QUEUES.SECURITY }),
    BullModule.registerQueue({ name: QUEUES.REPORTS }),
    BullModule.registerQueue({ name: QUEUES.NOTIFICATIONS }),
    SettingsModule,
    JobExecutionsModule,
  ],
  controllers: [SecurityController],
  providers: [
    SecurityService,
    SecurityScanService,
    SecurityFindingsService,
    SecuritySchedulesService,
    SecurityAlertsService,
    SecurityBaselineService,
    SecurityIncidentsService,
    SecurityAlertRulesService,
    SecurityRemediationsService,
    SecurityWatcherService,
    SecurityRepository,
    VulnerabilityDbService,
  ],
  exports: [
    SecurityService,
    SecurityScanService,
    SecurityFindingsService,
    SecuritySchedulesService,
    SecurityAlertsService,
    SecurityBaselineService,
    SecurityIncidentsService,
    SecurityAlertRulesService,
    SecurityRemediationsService,
    SecurityWatcherService,
    VulnerabilityDbService,
  ],
})
export class SecurityModule {}
