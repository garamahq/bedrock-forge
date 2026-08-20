import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { BullModule } from "@nestjs/bullmq";
import { QUEUES } from "@bedrock-forge/shared";
import { PrismaModule } from "./prisma/prisma.module";
import { EncryptionModule } from "./encryption/encryption.module";
import { BackupProcessorModule } from "./processors/backup/backup-processor.module";
import { PluginScanProcessorModule } from "./processors/plugin-scan/plugin-scan-processor.module";
import { SyncProcessorModule } from "./processors/sync/sync-processor.module";
import { MonitorProcessorModule } from "./processors/monitor/monitor-processor.module";
import { DomainWhoisProcessorModule } from "./processors/domain-whois/domain-whois-processor.module";
import { CreateBedrockProcessorModule } from "./processors/create-bedrock/create-bedrock-processor.module";
import { NotificationProcessorModule } from "./processors/notification/notification-processor.module";
import { ReportProcessorModule } from "./processors/report/report-processor.module";
import { PluginUpdateProcessorModule } from "./processors/plugin-update/plugin-update-processor.module";
import { WpActionsProcessorModule } from "./processors/wp-actions/wp-actions-processor.module";
import { CustomPluginProcessorModule } from "./processors/custom-plugin/custom-plugin-processor.module";
import { SystemBackupProcessorModule } from "./processors/system-backup/system-backup-processor.module";
import { ThemeScanProcessorModule } from "./processors/theme-scan/theme-scan-processor.module";
import { SecurityProcessorModule } from "./processors/security/security-processor.module";
import { SshKeyModule } from "./services/ssh-key.module";
import { QueueRecoveryService } from "./services/queue-recovery.service";
import workerConfig from "./config/worker.config";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [workerConfig],
      envFilePath: [".env"],
    }),

    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: { url: config.get<string>("redis.url") },
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: "exponential", delay: 5_000 },
          removeOnComplete: { count: 1000, age: 7 * 24 * 3600 },
          removeOnFail: { count: 500, age: 30 * 24 * 3600 },
        },
      }),
    }),

    BullModule.registerQueue(
      { name: QUEUES.BACKUPS },
      { name: QUEUES.PLUGIN_SCANS },
      { name: QUEUES.SYNC },
      { name: QUEUES.MONITORS },
      { name: QUEUES.DOMAINS },
      { name: QUEUES.PROJECTS },
      { name: QUEUES.NOTIFICATIONS },
      { name: QUEUES.REPORTS },
      { name: QUEUES.PLUGIN_UPDATES },
      { name: QUEUES.WP_ACTIONS },
      { name: QUEUES.CUSTOM_PLUGINS },
      { name: QUEUES.SYSTEM_BACKUPS },
      { name: QUEUES.THEME_SCANS },
      { name: QUEUES.SECURITY },
    ),

    PrismaModule,
    EncryptionModule,
    SshKeyModule,

    BackupProcessorModule,
    PluginScanProcessorModule,
    SyncProcessorModule,
    MonitorProcessorModule,
    DomainWhoisProcessorModule,
    CreateBedrockProcessorModule,
    NotificationProcessorModule,
    ReportProcessorModule,
    PluginUpdateProcessorModule,
    WpActionsProcessorModule,
    CustomPluginProcessorModule,
    SystemBackupProcessorModule,
    ThemeScanProcessorModule,
    SecurityProcessorModule,
  ],
  providers: [QueueRecoveryService],
})
export class WorkerModule {}
