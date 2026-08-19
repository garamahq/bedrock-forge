import { NotFoundException } from "@nestjs/common";
import { JOB_TYPES } from "@bedrock-forge/shared";
import { SecurityService } from "./security.service";
import { SecurityScanService } from "./security-scan.service";
import { SecurityFindingsService } from "./security-findings.service";
import { SecuritySchedulesService } from "./security-schedules.service";
import { SecurityAlertsService } from "./security-alerts.service";

describe("SecurityService server alert settings", () => {
  function makeSubject() {
    const repo = {
      findServerById: jest.fn(),
      findServerAlertSetting: jest.fn(),
      upsertServerAlertSetting: jest.fn(),
    };
    const securityQueue = { add: jest.fn() };
    const reportsQueue = {};

    const scanSvc = new SecurityScanService(
      repo as any,
      {} as any,
      securityQueue as any,
    );
    const findingsSvc = new SecurityFindingsService(
      repo as any,
      reportsQueue as any,
    );
    const schedulesSvc = new SecuritySchedulesService(repo as any);
    const alertsSvc = new SecurityAlertsService(
      repo as any,
      securityQueue as any,
    );
    const baselineSvc = {} as any;
    const incidentsSvc = {} as any;
    const alertRulesSvc = {} as any;
    const remediationsSvc = {} as any;
    const watcherSvc = {} as any;

    const service = new SecurityService(
      scanSvc,
      findingsSvc,
      schedulesSvc,
      alertsSvc,
      baselineSvc,
      incidentsSvc,
      alertRulesSvc,
      remediationsSvc,
      watcherSvc,
    );
    return { service, repo, securityQueue };
  }

  it("returns default alert settings when no row exists", async () => {
    const { service, repo } = makeSubject();
    repo.findServerById.mockResolvedValue({ id: BigInt(7) });
    repo.findServerAlertSetting.mockResolvedValue(null);

    const result = await service.getServerAlertSetting(7);

    expect(result).toEqual(
      expect.objectContaining({
        server_id: BigInt(7),
        enabled: false,
        ssh_login_alerts_enabled: true,
        file_change_alerts_enabled: true,
        interval_minutes: 5,
      }),
    );
    expect((result as any).file_watch_paths).toContain("/etc/ssh");
  });

  it("upserts alert settings with defaults for omitted fields", async () => {
    const { service, repo } = makeSubject();
    repo.findServerById.mockResolvedValue({ id: BigInt(7) });
    repo.findServerAlertSetting.mockResolvedValue(null);
    repo.upsertServerAlertSetting.mockResolvedValue({ id: BigInt(1) });

    await service.upsertServerAlertSetting(7, {
      enabled: true,
      interval_minutes: 10,
    });

    expect(repo.upsertServerAlertSetting).toHaveBeenCalledWith(BigInt(7), {
      enabled: true,
      ssh_login_alerts_enabled: true,
      file_change_alerts_enabled: true,
      interval_minutes: 10,
      file_watch_paths: expect.arrayContaining(["/etc/ssh"]),
    });
  });

  it("queues a forced alert poll for the test endpoint", async () => {
    const { service, repo, securityQueue } = makeSubject();
    repo.findServerById.mockResolvedValue({ id: BigInt(7) });
    securityQueue.add.mockResolvedValue({ id: "job-1" });

    await expect(service.testServerAlertSetting(7)).resolves.toEqual({
      jobId: "job-1",
    });
    expect(securityQueue.add).toHaveBeenCalledWith(
      JOB_TYPES.SECURITY_ALERT_POLL,
      { serverId: 7, force: true },
      expect.objectContaining({
        jobId: expect.stringContaining("security-alert-test-7-"),
      }),
    );
  });

  it("throws when the server does not exist", async () => {
    const { service, repo } = makeSubject();
    repo.findServerById.mockResolvedValue(null);

    await expect(service.getServerAlertSetting(404)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
