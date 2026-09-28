import { Throttle } from "@nestjs/throttler";
import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  ParseIntPipe,
  UseGuards,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import {
  CurrentUser,
  type AuthenticatedUser,
} from "../../common/decorators/current-user.decorator";
import { ROLES } from "@bedrock-forge/shared";
import { SecurityService } from "./security.service";
import { SettingsService } from "../settings/settings.service";
import {
  TriggerServerScanDto,
  TriggerEnvironmentScanDto,
} from "./dto/trigger-scan.dto";
import { ScanQueryDto, SecurityLogsQueryDto } from "./dto/scan-query.dto";
import { UpsertSecurityScheduleDto } from "./dto/security-schedule.dto";
import { UpdateSecuritySettingsDto } from "./dto/update-security-settings.dto";
import { FindingsQueryDto } from "./dto/findings-query.dto";
import { FindingTransitionDto } from "./dto/finding-transition.dto";
import { AckFindingDto, RemoveAckDto } from "./dto/ack-finding.dto";
import { GenerateSecurityReportDto } from "./dto/generate-security-report.dto";
import { HardenServerDto, HardenEnvironmentDto } from "./dto/harden-target.dto";
import { UpsertServerAlertSettingDto } from "./dto/server-alert-setting.dto";
import { CreateBaselineDto } from "./dto/create-baseline.dto";
import {
  SecurityIncidentsQueryDto,
  UpdateIncidentStatusDto,
} from "./dto/incident-status.dto";
import { CreateAlertRuleDto, UpdateAlertRuleDto } from "./dto/alert-rule.dto";
import { PreviewRemediationDto, ApplyRemediationDto } from "./dto/safe-remediation.dto";
import { WatcherHeartbeatDto } from "./dto/watcher-heartbeat.dto";
import { PaginationQueryDto } from "../../common/dto/pagination-query.dto";

@Controller("security")
@UseGuards(AuthGuard("jwt"), RolesGuard)
@Roles(ROLES.MANAGER)
export class SecurityController {
  constructor(
    private readonly svc: SecurityService,
    private readonly settings: SettingsService,
  ) {}

  /** GET /security/overview — aggregate across all servers + environments */
  @Get("overview")
  getOverview() {
    return this.svc.getOverview();
  }

  /** GET /security/servers — all servers with latest scan summary */
  @Get("servers")
  getServersList() {
    return this.svc.getServersList();
  }

  /** GET /security/servers/:id/scans — paginated scan history for a server */
  @Get("servers/:id/scans")
  getServerScanHistory(
    @Param("id", ParseIntPipe) id: number,
    @Query() query: ScanQueryDto,
  ) {
    return this.svc.getServerScanHistory(
      id,
      query.page ?? 1,
      query.limit ?? 25,
    );
  }

  /** POST /security/servers/:id/scan — trigger one or more scan types on a server */
  @Post("servers/:id/scan")
  @Throttle({ default: { ttl: 60_000, limit: 3 } })
  triggerServerScan(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: TriggerServerScanDto,
  ) {
    return this.svc.triggerServerScan(id, dto.types);
  }

  /** GET /security/environments/:id/scans */
  @Get("environments/:id/scans")
  getEnvironmentScanHistory(
    @Param("id", ParseIntPipe) id: number,
    @Query() query: ScanQueryDto,
  ) {
    return this.svc.getEnvironmentScanHistory(
      id,
      query.page ?? 1,
      query.limit ?? 25,
    );
  }

  /** POST /security/environments/:id/scan */
  @Post("environments/:id/scan")
  @Throttle({ default: { ttl: 60_000, limit: 3 } })
  triggerEnvironmentScan(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: TriggerEnvironmentScanDto,
  ) {
    return this.svc.triggerEnvironmentScan(id, dto.types);
  }

  /** GET /security/scans/:id — full scan result including findings JSON */
  @Get("scans/:id")
  getScan(@Param("id", ParseIntPipe) id: number) {
    return this.svc.getScanById(id);
  }

  /**
   * GET /security/logs — SSH auth event log extracted from SSH_AUDIT findings.
   * Filterable by server_id, date range.
   */
  @Get("logs")
  getSecurityLogs(@Query() query: SecurityLogsQueryDto) {
    return this.svc.getSecurityLogs(
      {
        server_id: query.server_id,
        date_from: query.date_from,
        date_to: query.date_to,
      },
      query.page ?? 1,
      query.limit ?? 50,
    );
  }

  // ─── Schedules ───────────────────────────────────────────────────────────────

  /** GET /security/schedules/servers/:id */
  @Get("schedules/servers/:id")
  getServerSchedule(@Param("id", ParseIntPipe) id: number) {
    return this.svc.getServerSchedule(id);
  }

  /** PUT /security/schedules/servers/:id */
  @Put("schedules/servers/:id")
  upsertServerSchedule(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpsertSecurityScheduleDto,
  ) {
    return this.svc.upsertServerSchedule(id, dto);
  }

  /** DELETE /security/schedules/servers/:id */
  @Delete("schedules/servers/:id")
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteServerSchedule(@Param("id", ParseIntPipe) id: number) {
    return this.svc.deleteServerSchedule(id);
  }

  /** GET /security/schedules/environments/:id */
  @Get("schedules/environments/:id")
  getEnvironmentSchedule(@Param("id", ParseIntPipe) id: number) {
    return this.svc.getEnvironmentSchedule(id);
  }

  /** PUT /security/schedules/environments/:id */
  @Put("schedules/environments/:id")
  upsertEnvironmentSchedule(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpsertSecurityScheduleDto,
  ) {
    return this.svc.upsertEnvironmentSchedule(id, dto);
  }

  /** DELETE /security/schedules/environments/:id */
  @Delete("schedules/environments/:id")
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteEnvironmentSchedule(@Param("id", ParseIntPipe) id: number) {
    return this.svc.deleteEnvironmentSchedule(id);
  }

  // ─── Server Security Alerts ────────────────────────────────────────────────

  /** GET /security/server-alerts/:serverId */
  @Get("server-alerts/:serverId")
  getServerAlertSetting(@Param("serverId", ParseIntPipe) serverId: number) {
    return this.svc.getServerAlertSetting(serverId);
  }

  /** PUT /security/server-alerts/:serverId */
  @Put("server-alerts/:serverId")
  upsertServerAlertSetting(
    @Param("serverId", ParseIntPipe) serverId: number,
    @Body() dto: UpsertServerAlertSettingDto,
  ) {
    return this.svc.upsertServerAlertSetting(serverId, dto);
  }

  /** POST /security/server-alerts/:serverId/test */
  @Post("server-alerts/:serverId/test")
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { ttl: 60_000, limit: 3 } })
  testServerAlertSetting(@Param("serverId", ParseIntPipe) serverId: number) {
    return this.svc.testServerAlertSetting(serverId);
  }

  // ─── Security Settings ───────────────────────────────────────────────────────

  /** GET /security/settings — return IP allowlist + global notify threshold */
  @Get("settings")
  getSecuritySettings() {
    return this.svc.getSecuritySettings(this.settings);
  }

  /** PUT /security/settings — update IP allowlist + global notify threshold */
  @Put("settings")
  setSecuritySettings(@Body() dto: UpdateSecuritySettingsDto) {
    return this.svc.setSecuritySettings(
      this.settings,
      dto.ip_allowlist,
      dto.notify_threshold,
    );
  }

  // ─── Findings + Acknowledgements ────────────────────────────────────────────

  /**
   * GET /security/findings — structured, paginated list of security findings.
   * Supports filtering by severity, status, category, server_id, environment_id, search.
   */
  @Get("findings")
  async getFindings(@Query() query: FindingsQueryDto) {
    const res = await this.svc.listFindings(
      {
        severity: query.severity,
        status: query.status,
        category: query.category,
        search: query.search,
        server_id: query.server_id,
        environment_id: query.environment_id,
      },
      query.page ?? 1,
      query.limit ?? 50,
    );

    // If database table has records, return them. If empty, fall back to legacy scanner JSON.
    if (res.total > 0 || query.status || query.category || query.search) {
      return res;
    }

    return this.svc.getAggregatedFindings(
      {
        severity: query.severity,
        server_id: query.server_id,
        environment_id: query.environment_id,
        scan_type: query.scan_type,
        acknowledged: query.acknowledged,
      },
      query.page ?? 1,
      query.limit ?? 50,
    );
  }

  /** GET /security/findings/:id — single finding detail with full transition history */
  @Get("findings/:id")
  getFindingDetail(@Param("id", ParseIntPipe) id: number) {
    return this.svc.getFindingById(id);
  }

  /** POST /security/findings/:id/transition — transition finding status */
  @Post("findings/:id/transition")
  transitionFindingStatus(
    @Param("id", ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: FindingTransitionDto,
  ) {
    return this.svc.transitionFindingStatus(
      id,
      dto.status,
      dto.note,
      Number(user.id),
    );
  }

  /** GET /security/servers/:id/findings — findings specific to a server */
  @Get("servers/:id/findings")
  getServerFindings(
    @Param("id", ParseIntPipe) id: number,
    @Query() query: FindingsQueryDto,
  ) {
    return this.svc.listFindings(
      {
        server_id: id,
        severity: query.severity,
        status: query.status,
        category: query.category,
        search: query.search,
      },
      query.page ?? 1,
      query.limit ?? 50,
    );
  }

  /** GET /security/environments/:id/findings — findings specific to an environment */
  @Get("environments/:id/findings")
  getEnvironmentFindings(
    @Param("id", ParseIntPipe) id: number,
    @Query() query: FindingsQueryDto,
  ) {
    return this.svc.listFindings(
      {
        environment_id: id,
        severity: query.severity,
        status: query.status,
        category: query.category,
        search: query.search,
      },
      query.page ?? 1,
      query.limit ?? 50,
    );
  }

  /** POST /security/findings/ack — mark a finding as reviewed/accepted (legacy) */
  @Post("findings/ack")
  @HttpCode(HttpStatus.NO_CONTENT)
  acknowledgeFinding(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: AckFindingDto,
  ) {
    return this.svc.acknowledgeFinding(user.id, dto);
  }

  /** DELETE /security/findings/ack — remove an acknowledgement */
  @Delete("findings/ack")
  @HttpCode(HttpStatus.NO_CONTENT)
  removeAcknowledgement(@Body() dto: RemoveAckDto) {
    return this.svc.removeAcknowledgement(dto);
  }

  /** POST /security/report — queue a security PDF report */
  @Post("report")
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { ttl: 300_000, limit: 2 } })
  generateReport(@Body() dto: GenerateSecurityReportDto) {
    return this.svc.generateSecurityReport(dto);
  }

  /** GET /security/report/history — last 20 security report jobs */
  @Get("report/history")
  getReportHistory() {
    return this.svc.getSecurityReportHistory();
  }

  // ─── Hardening ───────────────────────────────────────────────────────────────

  /** POST /security/servers/:id/harden — apply server hardening actions */
  @Post("servers/:id/harden")
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { ttl: 60_000, limit: 2 } })
  hardenServer(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: HardenServerDto,
  ) {
    return this.svc.applyServerHardening(id, dto.actions);
  }

  /** POST /security/environments/:id/harden — apply environment hardening actions */
  @Post("environments/:id/harden")
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { ttl: 60_000, limit: 2 } })
  hardenEnvironment(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: HardenEnvironmentDto,
  ) {
    return this.svc.applyEnvironmentHardening(id, dto.actions);
  }

  // ─── Baseline & Drift ──────────────────────────────────────────────────────

  /** POST /security/servers/:id/baseline — capture security baseline */
  @Post("servers/:id/baseline")
  @HttpCode(HttpStatus.ACCEPTED)
  @Roles(ROLES.ADMIN, ROLES.MANAGER)
  captureServerBaseline(
    @Param("id", ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateBaselineDto,
  ) {
    return this.svc.triggerServerBaselineCapture(id, user.id, dto.label);
  }

  /** GET /security/servers/:id/baseline — get active security baseline */
  @Get("servers/:id/baseline")
  getServerBaseline(@Param("id", ParseIntPipe) id: number) {
    return this.svc.getServerBaseline(id);
  }

  /** POST /security/servers/:id/baseline/compare — compare live state against baseline */
  @Post("servers/:id/baseline/compare")
  @HttpCode(HttpStatus.ACCEPTED)
  @Roles(ROLES.ADMIN, ROLES.MANAGER)
  compareServerBaseline(@Param("id", ParseIntPipe) id: number) {
    return this.svc.triggerServerBaselineCompare(id);
  }

  /** GET /security/servers/:id/drift — list drift events for server */
  @Get("servers/:id/drift")
  listServerDrift(
    @Param("id", ParseIntPipe) id: number,
    @Query() query: PaginationQueryDto,
  ) {
    return this.svc.listServerDriftEvents(id, query.page, query.limit);
  }

  /** POST /security/environments/:id/baseline — capture environment baseline */
  @Post("environments/:id/baseline")
  @HttpCode(HttpStatus.ACCEPTED)
  @Roles(ROLES.ADMIN, ROLES.MANAGER)
  captureEnvironmentBaseline(
    @Param("id", ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateBaselineDto,
  ) {
    return this.svc.triggerEnvironmentBaselineCapture(id, user.id, dto.label);
  }

  /** GET /security/environments/:id/baseline — get active environment baseline */
  @Get("environments/:id/baseline")
  getEnvironmentBaseline(@Param("id", ParseIntPipe) id: number) {
    return this.svc.getEnvironmentBaseline(id);
  }

  /** POST /security/environments/:id/baseline/compare — compare live state against baseline */
  @Post("environments/:id/baseline/compare")
  @HttpCode(HttpStatus.ACCEPTED)
  @Roles(ROLES.ADMIN, ROLES.MANAGER)
  compareEnvironmentBaseline(@Param("id", ParseIntPipe) id: number) {
    return this.svc.triggerEnvironmentBaselineCompare(id);
  }

  /** GET /security/environments/:id/drift — list drift events for environment */
  @Get("environments/:id/drift")
  listEnvironmentDrift(
    @Param("id", ParseIntPipe) id: number,
    @Query() query: PaginationQueryDto,
  ) {
    return this.svc.listEnvironmentDriftEvents(id, query.page, query.limit);
  }

  // ─── Incidents ─────────────────────────────────────────────────────────────

  /** GET /security/incidents — list correlated security incidents */
  @Get("incidents")
  listIncidents(@Query() query: SecurityIncidentsQueryDto) {
    return this.svc.listIncidents({
      status: query.status,
      serverId: query.serverId,
      page: query.page,
      limit: query.limit,
    });
  }

  /** GET /security/incidents/:id — get incident details with findings */
  @Get("incidents/:id")
  getIncidentById(@Param("id", ParseIntPipe) id: number) {
    return this.svc.getIncidentById(id);
  }

  /** PATCH /security/incidents/:id/status — update incident status */
  @Patch("incidents/:id/status")
  @Roles(ROLES.ADMIN, ROLES.MANAGER)
  updateIncidentStatus(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateIncidentStatusDto,
  ) {
    return this.svc.updateIncidentStatus(id, dto.status);
  }

  // ─── Alert Rules ───────────────────────────────────────────────────────────

  /** GET /security/alert-rules — list security alert rules */
  @Get("alert-rules")
  listAlertRules() {
    return this.svc.listAlertRules();
  }

  /** GET /security/alert-rules/:id — get alert rule by ID */
  @Get("alert-rules/:id")
  getAlertRuleById(@Param("id", ParseIntPipe) id: number) {
    return this.svc.getAlertRuleById(id);
  }

  /** POST /security/alert-rules — create alert rule */
  @Post("alert-rules")
  @Roles(ROLES.ADMIN)
  createAlertRule(@Body() dto: CreateAlertRuleDto) {
    return this.svc.createAlertRule(dto);
  }

  /** PUT /security/alert-rules/:id — update alert rule */
  @Put("alert-rules/:id")
  @Roles(ROLES.ADMIN)
  updateAlertRule(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateAlertRuleDto,
  ) {
    return this.svc.updateAlertRule(id, dto);
  }

  /** DELETE /security/alert-rules/:id — delete alert rule */
  @Delete("alert-rules/:id")
  @Roles(ROLES.ADMIN)
  deleteAlertRule(@Param("id", ParseIntPipe) id: number) {
    return this.svc.deleteAlertRule(id);
  }

  // ─── Safe Remediations (Lamah-Staging Safety Layer) ────────────────────────

  /** POST /security/remediations/preview — dry run preview with safety rollback paths */
  @Post("remediations/preview")
  @HttpCode(HttpStatus.OK)
  @Roles(ROLES.ADMIN, ROLES.MANAGER)
  previewRemediation(@Body() dto: PreviewRemediationDto) {
    return this.svc.previewRemediation(dto);
  }

  /** POST /security/remediations/apply — safely execute remediation */
  @Post("remediations/apply")
  @HttpCode(HttpStatus.ACCEPTED)
  @Roles(ROLES.ADMIN, ROLES.MANAGER)
  applyRemediation(
    @Body() dto: ApplyRemediationDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.svc.applyRemediation(dto, user.id);
  }

  // ─── Continuous Security Watcher ───────────────────────────────────────────

  /** GET /security/watcher/status — get watcher health status across servers */
  @Get("watcher/status")
  getWatcherStatus() {
    return this.svc.getWatcherOverview();
  }

  /** POST /security/watcher/heartbeat — ingest agent telemetry */
  @Post("watcher/heartbeat")
  @HttpCode(HttpStatus.OK)
  recordHeartbeat(@Body() dto: WatcherHeartbeatDto) {
    return this.svc.recordWatcherHeartbeat(dto);
  }

  /** GET /security/watcher/install-script — generate installer script */
  @Get("watcher/install-script")
  @Roles(ROLES.ADMIN, ROLES.MANAGER)
  getInstallScript(@Query("serverId", ParseIntPipe) serverId: number) {
    return { script: this.svc.getWatcherInstallScript(serverId) };
  }
}
