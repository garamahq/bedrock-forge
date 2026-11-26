import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { QUEUES } from "@bedrock-forge/shared";
import { DownloadTicketService } from "./download-ticket.service";
import { DownloadOrJwtAuthGuard } from "../guards/download-auth.guard";

@Module({
  imports: [BullModule.registerQueue({ name: QUEUES.BACKUPS })],
  providers: [DownloadTicketService, DownloadOrJwtAuthGuard],
  exports: [DownloadTicketService, DownloadOrJwtAuthGuard],
})
export class DownloadTicketModule {}
