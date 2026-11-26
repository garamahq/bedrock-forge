import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { QUEUES } from "@bedrock-forge/shared";
import { PluginUpdateProcessor } from "./plugin-update.processor";

@Module({
  imports: [
    BullModule.registerQueue(
      { name: QUEUES.PLUGIN_UPDATES },
      { name: QUEUES.PLUGIN_SCANS },
      { name: QUEUES.NOTIFICATIONS },
      { name: QUEUES.BACKUPS },
    ),
  ],
  providers: [PluginUpdateProcessor],
})
export class PluginUpdateProcessorModule {}
