import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { QUEUES } from "@bedrock-forge/shared";
import { SystemBackupsController } from "./system-backups.controller";
import { SystemBackupsService } from "./system-backups.service";
import { SystemBackupsRepository } from "./system-backups.repository";
import { SystemBackupScheduleService } from "./system-backup-schedule.service";
import { SettingsModule } from "../settings/settings.module";

@Module({
  imports: [
    BullModule.registerQueue({ name: QUEUES.SYSTEM_BACKUPS }),
    SettingsModule,
  ],
  controllers: [SystemBackupsController],
  providers: [
    SystemBackupsService,
    SystemBackupsRepository,
    SystemBackupScheduleService,
  ],
  exports: [SystemBackupsService],
})
export class SystemBackupsModule {}
