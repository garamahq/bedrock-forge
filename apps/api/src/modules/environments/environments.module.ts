import { Module, forwardRef } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { QUEUES } from "@bedrock-forge/shared";
import { EnvironmentsController } from "./environments.controller";
import { EnvironmentsListController } from "./environments-list.controller";
import { DeployWebhookController } from "./deploy-webhook.controller";
import { EnvironmentsService } from "./environments.service";
import { EnvironmentsRepository } from "./environments.repository";
import { ServersModule } from "../servers/servers.module";
import { MonitorsModule } from "../monitors/monitors.module";
import { DomainsModule } from "../domains/domains.module";
import { PrismaModule } from "../../prisma/prisma.module";
import { BackupsModule } from "../backups/backups.module";
import { PluginUpdateSchedulesModule } from "../plugin-update-schedules/plugin-update-schedules.module";

@Module({
  imports: [
    BullModule.registerQueue(
      { name: QUEUES.PROJECTS },
      { name: QUEUES.SECURITY },
    ),
    ServersModule,
    MonitorsModule,
    DomainsModule,
    PrismaModule,
    forwardRef(() => BackupsModule),
    PluginUpdateSchedulesModule,
  ],
  controllers: [
    EnvironmentsController,
    EnvironmentsListController,
    DeployWebhookController,
  ],
  providers: [EnvironmentsService, EnvironmentsRepository],
  exports: [EnvironmentsService],
})
export class EnvironmentsModule {}
