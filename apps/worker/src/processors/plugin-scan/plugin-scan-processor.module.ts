import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { QUEUES } from "@bedrock-forge/shared";
import { PluginScanProcessor } from "./plugin-scan.processor";

@Module({
  imports: [
    BullModule.registerQueue(
      { name: QUEUES.PLUGIN_SCANS },
      { name: QUEUES.BACKUPS },
    ),
  ],
  providers: [PluginScanProcessor],
})
export class PluginScanProcessorModule {}
