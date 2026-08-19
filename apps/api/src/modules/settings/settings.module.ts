import { Module } from "@nestjs/common";
import { SettingsController } from "./settings.controller";
import { SettingsService } from "./settings.service";
import { SettingsRepository } from "./settings.repository";
import { BillingSettingsService } from "./services/billing-settings.service";
import { CloudflareSettingsService } from "./services/cloudflare-settings.service";
import { GdriveSettingsService } from "./services/gdrive-settings.service";
import { PagespeedSettingsService } from "./services/pagespeed-settings.service";
import { EncryptionModule } from "../../common/encryption/encryption.module";

@Module({
  imports: [EncryptionModule],
  controllers: [SettingsController],
  providers: [
    SettingsService,
    SettingsRepository,
    BillingSettingsService,
    CloudflareSettingsService,
    GdriveSettingsService,
    PagespeedSettingsService,
  ],
  exports: [
    SettingsService,
    SettingsRepository,
    BillingSettingsService,
    CloudflareSettingsService,
    GdriveSettingsService,
    PagespeedSettingsService,
  ],
})
export class SettingsModule {}

