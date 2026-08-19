import { SecurityScanRunnerService } from "./security-scan-runner.service";
import * as serverChecks from "../server-checks";
import * as envChecks from "../environment-checks";
import * as scoring from "../scoring";

jest.mock("../server-checks");
jest.mock("../environment-checks");
jest.mock("../scoring");
jest.mock("@bedrock-forge/remote-executor", () => ({
  createRemoteExecutor: jest.fn().mockReturnValue({}),
}));

describe("SecurityScanRunnerService", () => {
  let service: SecurityScanRunnerService;
  let prismaMock: any;
  let sshKeyMock: any;
  let notificationsQueueMock: any;

  beforeEach(() => {
    prismaMock = {
      server: {
        findUnique: jest.fn(),
      },
      environment: {
        findUnique: jest.fn(),
      },
      jobExecution: {
        update: jest.fn().mockResolvedValue({}),
      },
      securityScan: {
        update: jest.fn(),
        create: jest.fn(),
        findMany: jest.fn(),
      },
      securityScanSchedule: {
        findUnique: jest.fn(),
      },
    };
    sshKeyMock = {
      resolvePrivateKey: jest.fn(),
      getSshConfig: jest.fn().mockImplementation(async (server: any) => ({
        host: server.ip_address,
        port: server.ssh_port,
        username: server.ssh_user,
        privateKey: "fake-key",
      })),
    };
    notificationsQueueMock = {
      add: jest.fn(),
    };
    const findingDedupMock = {
      upsertFindings: jest.fn().mockResolvedValue(undefined),
    };
    const incidentCorrelationMock = {
      correlateServerIncidents: jest.fn().mockResolvedValue({ incidentsCreated: 0 }),
    };
    const alertRuleEngineMock = {
      evaluateFindings: jest.fn().mockResolvedValue({ rulesTriggered: 0 }),
    };
    service = new SecurityScanRunnerService(
      prismaMock,
      sshKeyMock,
      findingDedupMock as any,
      incidentCorrelationMock as any,
      alertRuleEngineMock as any,
      notificationsQueueMock,
    );
    jest.clearAllMocks();
  });

  describe("processServerScan", () => {
    it("processes server scans successfully and updates statuses", async () => {
      const job = {
        data: {
          serverId: 1,
          scanTypes: ["SSH_AUDIT"],
          jobExecutionId: 100,
          scanIds: [200],
        },
        updateProgress: jest.fn(),
      } as any;

      const server = {
        id: 1,
        ip_address: "1.2.3.4",
        ssh_port: 22,
        ssh_user: "root",
      };

      prismaMock.server.findUnique.mockResolvedValue(server);
      sshKeyMock.resolvePrivateKey.mockResolvedValue("fake-key");

      const findings = [{ id: "finding-1", severity: "low", message: "test" }];
      (serverChecks.runSshAudit as jest.Mock).mockResolvedValue(findings);
      (scoring.calculateScore as jest.Mock).mockReturnValue(95);
      (scoring.buildSummary as jest.Mock).mockReturnValue({
        info: 0,
        low: 1,
        medium: 0,
        high: 0,
        critical: 0,
      });

      await service.processServerScan(job);

      expect(prismaMock.jobExecution.update).toHaveBeenCalledWith({
        where: { id: BigInt(100) },
        data: { status: "active", started_at: expect.any(Date) },
      });

      expect(prismaMock.securityScan.update).toHaveBeenCalledWith({
        where: { id: BigInt(200) },
        data: { status: "running", started_at: expect.any(Date) },
      });

      expect(serverChecks.runSshAudit).toHaveBeenCalled();

      expect(prismaMock.securityScan.update).toHaveBeenLastCalledWith({
        where: { id: BigInt(200) },
        data: {
          status: "completed",
          score: 95,
          summary: { info: 0, low: 1, medium: 0, high: 0, critical: 0 },
          findings: findings as any,
          completed_at: expect.any(Date),
        },
      });

      expect(job.updateProgress).toHaveBeenCalledWith(100);
      expect(prismaMock.jobExecution.update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: { id: BigInt(100) },
          data: expect.objectContaining({
            status: "completed",
            completed_at: expect.any(Date),
            progress: 100,
          }),
        }),
      );
    });

    it("processes multi-subcheck server scans like SYSTEM_AUDIT and NETWORK_AUDIT", async () => {
      const job = {
        data: {
          serverId: 1,
          scanTypes: ["SYSTEM_AUDIT", "NETWORK_AUDIT"],
          jobExecutionId: 100,
          scanIds: [200, 201],
        },
        updateProgress: jest.fn(),
      } as any;

      const server = {
        id: 1,
        ip_address: "1.2.3.4",
        ssh_port: 22,
        ssh_user: "root",
      };

      prismaMock.server.findUnique.mockResolvedValue(server);
      sshKeyMock.resolvePrivateKey.mockResolvedValue("fake-key");

      (serverChecks.runSystemAudit as jest.Mock).mockResolvedValue([{ id: "sys-1", severity: "info" }]);
      (serverChecks.runCronAudit as jest.Mock).mockResolvedValue([]);
      (serverChecks.runUserAudit as jest.Mock).mockResolvedValue([]);
      (serverChecks.runNetworkAudit as jest.Mock).mockResolvedValue([{ id: "net-1", severity: "high" }]);
      (serverChecks.runFirewallAudit as jest.Mock).mockResolvedValue([]);
      (serverChecks.runFail2BanAudit as jest.Mock).mockResolvedValue([]);
      (scoring.calculateScore as jest.Mock).mockReturnValue(90);
      (scoring.buildSummary as jest.Mock).mockReturnValue({
        info: 1,
        low: 0,
        medium: 0,
        high: 1,
        critical: 0,
      });

      await service.processServerScan(job);

      expect(serverChecks.runSystemAudit).toHaveBeenCalled();
      expect(serverChecks.runCronAudit).toHaveBeenCalled();
      expect(serverChecks.runUserAudit).toHaveBeenCalled();
      expect(serverChecks.runNetworkAudit).toHaveBeenCalled();
      expect(serverChecks.runFirewallAudit).toHaveBeenCalled();
      expect(serverChecks.runFail2BanAudit).toHaveBeenCalled();
      expect(job.updateProgress).toHaveBeenCalledWith(50);
      expect(job.updateProgress).toHaveBeenCalledWith(100);
    });

    it("marks job execution failed if server is not found", async () => {
      const job = {
        data: {
          serverId: 1,
          scanTypes: ["SSH_AUDIT"],
          jobExecutionId: 100,
          scanIds: [200],
        },
      } as any;

      prismaMock.server.findUnique.mockResolvedValue(null);

      await expect(service.processServerScan(job)).rejects.toThrow(
        "Server 1 not found",
      );

      expect(prismaMock.jobExecution.update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: { id: BigInt(100) },
          data: expect.objectContaining({
            status: "failed",
            last_error: "Server 1 not found",
            completed_at: expect.any(Date),
          }),
        }),
      );
    });
  });

  describe("processEnvironmentScan", () => {
    it("processes environment scans successfully and updates statuses", async () => {
      const job = {
        data: {
          environmentId: 2,
          scanTypes: ["WP_AUDIT", "BACKDOOR_SEARCH", "PLUGIN_AUDIT"],
          jobExecutionId: 101,
          scanIds: [201, 202, 203],
        },
        updateProgress: jest.fn(),
      } as any;

      const env = {
        id: 2,
        root_path: "/var/www",
        server: {
          id: 1,
          ip_address: "1.2.3.4",
          ssh_port: 22,
          ssh_user: "root",
        },
      };

      prismaMock.environment.findUnique.mockResolvedValue(env);
      sshKeyMock.resolvePrivateKey.mockResolvedValue("fake-key");

      const findings = [
        { id: "finding-2", severity: "medium", message: "test wp" },
      ];
      (envChecks.runWpAudit as jest.Mock).mockResolvedValue(findings);
      (envChecks.runBackdoorSearch as jest.Mock).mockResolvedValue([]);
      (envChecks.runPluginAudit as jest.Mock).mockResolvedValue([]);
      (scoring.calculateScore as jest.Mock).mockReturnValue(80);
      (scoring.buildSummary as jest.Mock).mockReturnValue({
        info: 0,
        low: 0,
        medium: 1,
        high: 0,
        critical: 0,
      });

      await service.processEnvironmentScan(job);

      expect(prismaMock.jobExecution.update).toHaveBeenCalledWith({
        where: { id: BigInt(101) },
        data: { status: "active", started_at: expect.any(Date) },
      });

      expect(envChecks.runWpAudit).toHaveBeenCalled();
      expect(envChecks.runBackdoorSearch).toHaveBeenCalled();
      expect(envChecks.runPluginAudit).toHaveBeenCalled();

      expect(prismaMock.securityScan.update).toHaveBeenCalledWith({
        where: { id: BigInt(201) },
        data: expect.objectContaining({ status: "completed" }),
      });
      expect(prismaMock.securityScan.update).toHaveBeenCalledWith({
        where: { id: BigInt(202) },
        data: expect.objectContaining({ status: "completed" }),
      });
      expect(prismaMock.securityScan.update).toHaveBeenCalledWith({
        where: { id: BigInt(203) },
        data: expect.objectContaining({ status: "completed" }),
      });
    });
  });
});
