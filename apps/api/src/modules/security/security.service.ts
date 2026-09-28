import { Injectable } from "@nestjs/common";
import { SecurityScanService } from "./security-scan.service";
import { SecurityFindingsService } from "./security-findings.service";
import { SecuritySchedulesService } from "./security-schedules.service";
import { SecurityAlertsService } from "./security-alerts.service";
import { SecurityBaselineService } from "./security-baseline.service";
import { SecurityIncidentsService } from "./security-incidents.service";
import { SecurityAlertRulesService } from "./security-alert-rules.service";
import { SecurityRemediationsService } from "./security-remediations.service";
import { SecurityWatcherService } from "./security-watcher.service";
import type {
  SecurityScanType,
  ServerHardeningActionType,
  EnvironmentHardeningActionType,
} from "@bedrock-forge/shared";
import type { SecurityFindingStatus, SecurityIncidentStatus } from "@prisma/client";
import type { UpsertSecurityScheduleDto } from "./dto/security-schedule.dto";
import type { AckFindingDto, RemoveAckDto } from "./dto/ack-finding.dto";
import type { GenerateSecurityReportDto } from "./dto/generate-security-report.dto";
import type { UpsertServerAlertSettingDto } from "./dto/server-alert-setting.dto";
import type { CreateAlertRuleDto, UpdateAlertRuleDto } from "./dto/alert-rule.dto";
import type { PreviewRemediationDto, ApplyRemediationDto } from "./dto/safe-remediation.dto";
import type { WatcherHeartbeatDto } from "./dto/watcher-heartbeat.dto";

@Injectable()
export class SecurityService {
  constructor(
    private readonly scanSvc: SecurityScanService,
    private readonly findingsSvc: SecurityFindingsService,
    private readonly schedulesSvc: SecuritySchedulesService,
    private readonly alertsSvc: SecurityAlertsService,
    private readonly baselineSvc: SecurityBaselineService,
    private readonly incidentsSvc: SecurityIncidentsService,
    private readonly alertRulesSvc: SecurityAlertRulesService,
    private readonly remediationsSvc: SecurityRemediationsService,
    private readonly watcherSvc: SecurityWatcherService,
  ) {}

  // ─── Trigger scans ──────────────────────────────────────────────────────────

  async triggerServerScan(
    serverId: number,
    types: SecurityScanType[],
  ) {
    return this.scanSvc.triggerServerScan(serverId, types);
  }

  async triggerEnvironmentScan(
    environmentId: number,
    types: SecurityScanType[],
  ) {
    return this.scanSvc.triggerEnvironmentScan(environmentId, types);
  }

  // ─── Hardening ───────────────────────────────────────────────────────────────

  async applyServerHardening(
    serverId: number,
    actions: ServerHardeningActionType[],
  ) {
    return this.scanSvc.applyServerHardening(serverId, actions);
  }

  async applyEnvironmentHardening(
    environmentId: number,
    actions: EnvironmentHardeningActionType[],
  ) {
    return this.scanSvc.applyEnvironmentHardening(environmentId, actions);
  }

  // ─── Finding Lifecycle ───────────────────────────────────────────────────────

  async getFindingById(id: number) {
    return this.findingsSvc.getFindingById(id);
  }

  async listFindings(
    filter: {
      server_id?: number;
      environment_id?: number;
      severity?: string;
      status?: string;
      category?: string;
      search?: string;
    },
    page: number = 1,
    limit: number = 50,
  ) {
    return this.findingsSvc.listFindings(filter, page, limit);
  }

  async transitionFindingStatus(
    id: number,
    status: SecurityFindingStatus,
    note?: string,
    actorId?: number,
  ) {
    return this.findingsSvc.transitionFindingStatus(id, status, note, actorId);
  }

  // ─── Read ────────────────────────────────────────────────────────────────────

  async getScanById(id: number) {
    return this.findingsSvc.getScanById(id);
  }

  async getServerScanHistory(serverId: number, page: number, limit: number) {
    return this.findingsSvc.getServerScanHistory(serverId, page, limit);
  }

  async getEnvironmentScanHistory(
    environmentId: number,
    page: number,
    limit: number,
  ) {
    return this.findingsSvc.getEnvironmentScanHistory(
      environmentId,
      page,
      limit,
    );
  }

  async getOverview() {
    return this.findingsSvc.getOverview();
  }

  async getServersList() {
    return this.findingsSvc.getServersList();
  }

  async getSecurityLogs(
    filter: { server_id?: number; date_from?: string; date_to?: string },
    page: number,
    limit: number,
  ) {
    return this.findingsSvc.getSecurityLogs(filter, page, limit);
  }

  // ─── Schedules ───────────────────────────────────────────────────────────────

  async getServerSchedule(serverId: number) {
    return this.schedulesSvc.getServerSchedule(serverId);
  }

  async upsertServerSchedule(serverId: number, dto: UpsertSecurityScheduleDto) {
    return this.schedulesSvc.upsertServerSchedule(serverId, dto);
  }

  async deleteServerSchedule(serverId: number) {
    return this.schedulesSvc.deleteServerSchedule(serverId);
  }

  async getEnvironmentSchedule(environmentId: number) {
    return this.schedulesSvc.getEnvironmentSchedule(environmentId);
  }

  async upsertEnvironmentSchedule(
    environmentId: number,
    dto: UpsertSecurityScheduleDto,
  ) {
    return this.schedulesSvc.upsertEnvironmentSchedule(environmentId, dto);
  }

  async deleteEnvironmentSchedule(environmentId: number) {
    return this.schedulesSvc.deleteEnvironmentSchedule(environmentId);
  }

  // ─── Server Security Alerts ────────────────────────────────────────────────

  async getServerAlertSetting(serverId: number) {
    return this.alertsSvc.getServerAlertSetting(serverId);
  }

  async upsertServerAlertSetting(
    serverId: number,
    dto: UpsertServerAlertSettingDto,
  ) {
    return this.alertsSvc.upsertServerAlertSetting(serverId, dto);
  }

  async testServerAlertSetting(serverId: number) {
    return this.alertsSvc.testServerAlertSetting(serverId);
  }

  // ─── Security settings (IP allowlist via AppSettings) ────────────────────────

  async getSecuritySettings(settingsSvc: {
    get: (key: string) => Promise<{ key: string; value?: string } | null>;
  }) {
    const [allowlist, threshold] = await Promise.all([
      settingsSvc.get("security_ip_allowlist"),
      settingsSvc.get("security_notify_threshold"),
    ]);
    return {
      ip_allowlist: allowlist?.value
        ? (JSON.parse(allowlist.value) as string[])
        : [],
      notify_threshold: threshold?.value ?? "critical",
    };
  }

  async setSecuritySettings(
    settingsSvc: {
      set: (key: string, value: string) => Promise<unknown>;
    },
    ip_allowlist: string[],
    notify_threshold: string,
  ) {
    await Promise.all([
      settingsSvc.set("security_ip_allowlist", JSON.stringify(ip_allowlist)),
      settingsSvc.set("security_notify_threshold", notify_threshold),
    ]);
    return { success: true };
  }

  // ─── Aggregated Findings + Acknowledgements ───────────────────────────────────

  async getAggregatedFindings(
    filters: {
      severity?: string;
      server_id?: number;
      environment_id?: number;
      scan_type?: string;
      acknowledged?: boolean;
    },
    page: number,
    limit: number,
  ) {
    return this.findingsSvc.getAggregatedFindings(filters, page, limit);
  }

  async acknowledgeFinding(userId: number, dto: AckFindingDto) {
    return this.findingsSvc.acknowledgeFinding(userId, dto);
  }

  async removeAcknowledgement(dto: RemoveAckDto) {
    return this.findingsSvc.removeAcknowledgement(dto);
  }

  // ─── Security Reports ────────────────────────────────────────────────────

  async generateSecurityReport(dto: GenerateSecurityReportDto) {
    return this.findingsSvc.generateSecurityReport(dto);
  }

  async getSecurityReportHistory() {
    return this.findingsSvc.getSecurityReportHistory();
  }

  // ─── Baseline & Drift ──────────────────────────────────────────────────────

  async triggerServerBaselineCapture(serverId: number, userId?: number, label?: string) {
    return this.baselineSvc.triggerServerBaselineCapture(serverId, userId, label);
  }

  async triggerEnvironmentBaselineCapture(environmentId: number, userId?: number, label?: string) {
    return this.baselineSvc.triggerEnvironmentBaselineCapture(environmentId, userId, label);
  }

  async triggerServerBaselineCompare(serverId: number) {
    return this.baselineSvc.triggerServerBaselineCompare(serverId);
  }

  async triggerEnvironmentBaselineCompare(environmentId: number) {
    return this.baselineSvc.triggerEnvironmentBaselineCompare(environmentId);
  }

  async getServerBaseline(serverId: number) {
    return this.baselineSvc.getServerBaseline(serverId);
  }

  async getEnvironmentBaseline(environmentId: number) {
    return this.baselineSvc.getEnvironmentBaseline(environmentId);
  }

  async listServerDriftEvents(serverId: number, page?: number, limit?: number) {
    return this.baselineSvc.listServerDriftEvents(serverId, page, limit);
  }

  async listEnvironmentDriftEvents(environmentId: number, page?: number, limit?: number) {
    return this.baselineSvc.listEnvironmentDriftEvents(environmentId, page, limit);
  }

  // ─── Incidents ─────────────────────────────────────────────────────────────

  async listIncidents(params: {
    status?: SecurityIncidentStatus;
    serverId?: number;
    page?: number;
    limit?: number;
  }) {
    return this.incidentsSvc.listIncidents(params);
  }

  async getIncidentById(id: number) {
    return this.incidentsSvc.getIncidentById(id);
  }

  async updateIncidentStatus(id: number, status: SecurityIncidentStatus) {
    return this.incidentsSvc.updateIncidentStatus(id, status);
  }

  // ─── Alert Rules ───────────────────────────────────────────────────────────

  async listAlertRules() {
    return this.alertRulesSvc.listAlertRules();
  }

  async getAlertRuleById(id: number) {
    return this.alertRulesSvc.getAlertRuleById(id);
  }

  async createAlertRule(dto: CreateAlertRuleDto) {
    return this.alertRulesSvc.createAlertRule(dto);
  }

  async updateAlertRule(id: number, dto: UpdateAlertRuleDto) {
    return this.alertRulesSvc.updateAlertRule(id, dto);
  }

  async deleteAlertRule(id: number) {
    return this.alertRulesSvc.deleteAlertRule(id);
  }

  // ─── Safe Remediations ─────────────────────────────────────────────────────

  async previewRemediation(dto: PreviewRemediationDto) {
    return this.remediationsSvc.previewRemediation(dto);
  }

  async applyRemediation(dto: ApplyRemediationDto, userId?: number) {
    return this.remediationsSvc.applyRemediation(dto, userId);
  }

  // ─── Continuous Security Watcher ───────────────────────────────────────────

  async getWatcherOverview() {
    return this.watcherSvc.getWatcherOverview();
  }

  async recordWatcherHeartbeat(dto: WatcherHeartbeatDto) {
    return this.watcherSvc.recordHeartbeat(dto);
  }

  getWatcherInstallScript(serverId: number, hostUrl?: string) {
    return this.watcherSvc.getInstallScript(serverId, hostUrl);
  }
}
