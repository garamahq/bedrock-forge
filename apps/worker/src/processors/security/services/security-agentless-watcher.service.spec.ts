import { SecurityAgentlessWatcherService } from "./security-agentless-watcher.service";
import { PrismaService } from "../../../prisma/prisma.service";
import { SshKeyService } from "../../../services/ssh-key.service";

jest.mock("@bedrock-forge/remote-executor", () => ({
  createRemoteExecutor: jest.fn().mockReturnValue({
    execute: jest.fn().mockImplementation(async (cmd: string) => {
      if (cmd.includes("Failed password")) {
        return { stdout: "35\n", stderr: "", code: 0 };
      }
      if (cmd.includes("/proc/[0-9]*/exe")) {
        return { stdout: "/tmp/kdevtmpfsi\n", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    }),
  }),
}));

describe("SecurityAgentlessWatcherService", () => {
  let service: SecurityAgentlessWatcherService;
  let prismaMock: any;
  let sshKeyMock: any;
  let findingDedupMock: any;
  let alertRuleEngineMock: any;
  let incidentCorrelationMock: any;
  let notifQueueMock: any;

  beforeEach(() => {
    prismaMock = {
      server: {
        findMany: jest.fn().mockResolvedValue([
          { id: BigInt(1), name: "Prod-1", ip_address: "1.1.1.1", status: "online" },
        ]),
      },
    };
    sshKeyMock = {
      getSshConfig: jest.fn().mockResolvedValue({ host: "1.1.1.1", port: 22 }),
    };
    findingDedupMock = {
      upsertFindings: jest.fn().mockResolvedValue({}),
    };
    alertRuleEngineMock = {
      evaluateFindings: jest.fn().mockResolvedValue({ rulesTriggered: 1 }),
    };
    incidentCorrelationMock = {
      correlateServerIncidents: jest.fn().mockResolvedValue({ incidentsCreated: 1 }),
    };
    notifQueueMock = {
      add: jest.fn().mockResolvedValue({}),
    };

    service = new SecurityAgentlessWatcherService(
      prismaMock as PrismaService,
      sshKeyMock as SshKeyService,
      findingDedupMock,
      alertRuleEngineMock,
      incidentCorrelationMock,
      notifQueueMock,
    );
  });

  it("detects rapid failed login bursts and tmp executables via agentless SSH polling", async () => {
    await service.checkServersWatcherHealth();

    expect(findingDedupMock.upsertFindings).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: 1,
        findings: expect.arrayContaining([
          expect.objectContaining({ category: "FAILED_LOGINS" }),
          expect.objectContaining({ category: "PROCESS_ANOMALY" }),
        ]),
      }),
    );
    expect(alertRuleEngineMock.evaluateFindings).toHaveBeenCalled();
    expect(incidentCorrelationMock.correlateServerIncidents).toHaveBeenCalledWith(1);
  });
});
