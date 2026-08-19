import {
  Controller,
  Get,
  Put,
  Delete,
  Post,
  Param,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { ROLES, BillingSettingsResponse, CloudflareConfigResponse, GdriveConfigResponse } from "@bedrock-forge/shared";
import { SettingsService } from "./settings.service";
import { BillingSettingsService } from "./services/billing-settings.service";
import { CloudflareSettingsService } from "./services/cloudflare-settings.service";
import { GdriveSettingsService } from "./services/gdrive-settings.service";
import {
  PagespeedSettingsService,
  PagespeedConfigResponse,
} from "./services/pagespeed-settings.service";
import { SetGdriveDto } from "./dto/gdrive-settings.dto";
import { SetPagespeedSettingsDto } from "./dto/pagespeed-settings.dto";
import { SetSettingDto } from "./dto/setting.dto";
import { SetSshKeyDto } from "./dto/ssh-key.dto";
import { SetBillingSettingsDto } from "./dto/billing-settings.dto";
import {
  SetCloudflareSettingsDto,
  UpdateCloudflareDnsRecordDto,
} from "./dto/cloudflare-settings.dto";
import { TestWebhookDto } from "./dto/test-webhook.dto";

@Controller("settings")
@UseGuards(AuthGuard("jwt"), RolesGuard)
@Roles(ROLES.ADMIN)
export class SettingsController {
  constructor(
    private readonly svc: SettingsService,
    private readonly billing: BillingSettingsService,
    private readonly cloudflare: CloudflareSettingsService,
    private readonly gdrive: GdriveSettingsService,
    private readonly pagespeed: PagespeedSettingsService,
  ) {}

  /** Returns all non-sensitive settings as a key:value map. */
  @Get() getAll() {
    return this.svc.getAllPublic();
  }

  @Get("public/billing")
  @Roles(ROLES.MANAGER)
  getBillingSettings(): Promise<BillingSettingsResponse> {
    return this.billing.getBillingSettings();
  }

  @Put("billing")
  @HttpCode(HttpStatus.NO_CONTENT)
  async setBillingSettings(@Body() dto: SetBillingSettingsDto) {
    await this.billing.setBillingSettings(dto);
  }

  // ── Global SSH Key ──────────────────────────────────────────────────────

  /** Returns { has_key: boolean } — never exposes the actual value. */
  @Get("ssh-key") async getSshKey() {
    const has_key = await this.svc.hasEncrypted("global_ssh_private_key");
    return { has_key };
  }

  /** Store or replace the global SSH private key (encrypted at rest). */
  @Put("ssh-key") @HttpCode(HttpStatus.NO_CONTENT) async setSshKey(
    @Body() dto: SetSshKeyDto,
  ) {
    await this.svc.setEncrypted("global_ssh_private_key", dto.key);
  }

  /** Remove the global SSH private key. */
  @Delete("ssh-key") @HttpCode(HttpStatus.NO_CONTENT) async deleteSshKey() {
    await this.svc.delete("global_ssh_private_key");
  }

  // ── Google Drive (rclone) ───────────────────────────────────────────────

  /** Returns { configured: boolean }. */
  @Get("gdrive") async getGdrive(): Promise<GdriveConfigResponse> {
    return this.gdrive.getGdriveConfig();
  }

  /** Store Google Drive OAuth token. */
  @Put("gdrive") @HttpCode(HttpStatus.NO_CONTENT) async setGdrive(
    @Body() dto: SetGdriveDto,
  ) {
    await this.gdrive.setGdrive(dto.token);
  }

  /** Remove Google Drive configuration. */
  @Delete("gdrive") @HttpCode(HttpStatus.NO_CONTENT) async deleteGdrive() {
    await this.gdrive.deleteGdrive();
  }

  /** Test Google Drive connection. */
  @Post("gdrive/test") async testGdrive() {
    return this.gdrive.testGdrive();
  }

  // ── Cloudflare ──────────────────────────────────────────────────────────

  @Get("cloudflare") async getCloudflare(): Promise<CloudflareConfigResponse> {
    return this.cloudflare.getCloudflareConfig();
  }

  @Put("cloudflare") @HttpCode(HttpStatus.NO_CONTENT) async setCloudflare(
    @Body() dto: SetCloudflareSettingsDto,
  ) {
    await this.cloudflare.setCloudflareConfig(dto);
  }

  @Delete("cloudflare")
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteCloudflare() {
    await this.cloudflare.deleteCloudflareConfig();
  }

  @Post("cloudflare/test") async testCloudflare() {
    return this.cloudflare.testCloudflare();
  }

  @Get("cloudflare/dns-records") async listCloudflareDnsRecords() {
    return this.cloudflare.listCloudflareDnsRecords();
  }

  @Put("cloudflare/dns-records/:recordId") async updateCloudflareDnsRecord(
    @Param("recordId") recordId: string,
    @Body() dto: UpdateCloudflareDnsRecordDto,
  ) {
    return this.cloudflare.updateCloudflareDnsRecord(recordId, dto);
  }

  @Post("cloudflare/cache/purge") async purgeCloudflareCache() {
    return this.cloudflare.purgeCloudflareCache();
  }

  @Put("cloudflare/development-mode") async setCloudflareDevelopmentMode(
    @Body("enabled") enabled: boolean,
  ) {
    return this.cloudflare.setCloudflareDevelopmentMode(enabled);
  }

  // ── PageSpeed / Lighthouse ─────────────────────────────────────────────

  @Get("pagespeed") async getPagespeed(): Promise<PagespeedConfigResponse> {
    return this.pagespeed.getPagespeedConfig();
  }

  @Put("pagespeed")
  @HttpCode(HttpStatus.NO_CONTENT)
  async setPagespeed(@Body() dto: SetPagespeedSettingsDto) {
    await this.pagespeed.setPagespeedConfig(dto);
  }

  @Delete("pagespeed")
  @HttpCode(HttpStatus.NO_CONTENT)
  async deletePagespeed() {
    await this.pagespeed.deletePagespeedConfig();
  }

  @Post("pagespeed/test") async testPagespeed(@Body("url") url?: string) {
    return this.pagespeed.testPagespeed(url);
  }

  // ── System Backup Folder ID ─────────────────────────────────────────────

  /** Returns { folder_id: string | null } — the Google Drive folder used for Forge self-backups. */
  @Get("system-backup-folder") async getSystemBackupFolder() {
    const result = await this.svc.get("forge_system_backup_folder_id");
    return { folder_id: result?.value ?? null };
  }

  /** Save the Google Drive folder ID used for Forge system backups. */
  @Put("system-backup-folder")
  @HttpCode(HttpStatus.NO_CONTENT)
  async setSystemBackupFolder(@Body() dto: SetSettingDto) {
    await this.svc.set("forge_system_backup_folder_id", dto.value);
  }

  // ── Generic key/value settings ──────────────────────────────────────────

  @Get(":key") get(@Param("key") key: string) {
    return this.svc.get(key);
  }

  @Put(":key") set(@Param("key") key: string, @Body() dto: SetSettingDto) {
    return this.svc.set(key, dto.value);
  }

  @Delete(":key") delete(@Param("key") key: string) {
    return this.svc.delete(key);
  }

  @Post("test-webhook") async testWebhook(@Body() dto: TestWebhookDto) {
    return this.svc.testWebhook(dto.type, dto.url);
  }
}
