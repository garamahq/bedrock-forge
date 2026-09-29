import { SecurityDataRetentionService } from "./security-data-retention.service";

describe("SecurityDataRetentionService", () => {
  let service: SecurityDataRetentionService;
  let prismaMock: any;

  beforeEach(() => {
    prismaMock = {
      jobExecution: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      securityScan: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      pluginScan: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      themeScan: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      lighthouseAudit: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      monitorResult: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      monitorLog: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      systemBackup: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      auditLog: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      notificationLog: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      userNotification: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    service = new SecurityDataRetentionService(prismaMock);
  });

  it("calls deleteMany on all 11 tables", async () => {
    await service.runRetentionPurge();

    expect(prismaMock.jobExecution.deleteMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.securityScan.deleteMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.pluginScan.deleteMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.themeScan.deleteMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.lighthouseAudit.deleteMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.monitorResult.deleteMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.monitorLog.deleteMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.systemBackup.deleteMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.auditLog.deleteMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.notificationLog.deleteMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.userNotification.deleteMany).toHaveBeenCalledTimes(1);
  });

  it("only deletes terminal-status job_executions", async () => {
    await service.runRetentionPurge();

    const call = prismaMock.jobExecution.deleteMany.mock.calls[0][0];
    expect(call.where.status).toEqual({
      in: ["completed", "failed", "dead_letter", "discarded"],
    });
    expect(call.where.completed_at).toHaveProperty("lt");
  });

  it("only deletes completed/failed security_scans", async () => {
    await service.runRetentionPurge();

    const call = prismaMock.securityScan.deleteMany.mock.calls[0][0];
    expect(call.where.status).toEqual({ in: ["completed", "failed"] });
    expect(call.where.completed_at).toHaveProperty("lt");
  });

  it("cutoff is approximately 6 months ago", async () => {
    await service.runRetentionPurge();

    const call = prismaMock.jobExecution.deleteMany.mock.calls[0][0];
    const cutoff: Date = call.where.completed_at.lt;

    const now = new Date();
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(now.getMonth() - 6);

    // Allow up to 5 seconds of clock drift in the test
    expect(Math.abs(cutoff.getTime() - sixMonthsAgo.getTime())).toBeLessThan(
      5_000,
    );
  });

  it("survives a partial failure — other tables still purged", async () => {
    prismaMock.securityScan.deleteMany.mockRejectedValue(
      new Error("DB timeout"),
    );

    // Should not throw
    await expect(service.runRetentionPurge()).resolves.toBeUndefined();

    // Other tables must still have been attempted
    expect(prismaMock.jobExecution.deleteMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.pluginScan.deleteMany).toHaveBeenCalledTimes(1);
  });
});
