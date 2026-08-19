import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { QUEUES } from "@bedrock-forge/shared";
import { RcloneService } from "../../services/rclone.service";
import { ReportProcessor } from "./report.processor";
import { EncryptionModule } from "../../encryption/encryption.module";

@Module({
  imports: [
    BullModule.registerQueue({ name: QUEUES.REPORTS }),
    EncryptionModule,
  ],
  providers: [ReportProcessor, RcloneService],
})
export class ReportProcessorModule {}
