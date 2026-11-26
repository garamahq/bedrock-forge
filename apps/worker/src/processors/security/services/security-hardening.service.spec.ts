import { SecurityHardeningService } from "./security-hardening.service";
import * as hardeningActions from "../hardening-actions";

jest.mock("../hardening-actions");
jest.mock("@bedrock-forge/remote-executor", () => ({
  createRemoteExecutor: jest.fn().mockReturnValue({}),
}));

describe("SecurityHardeningService", () => {
  let service: SecurityHardeningService;
  let prismaMock: any;
  let sshKeyMock: any;
  let securityQueueMock: any;

  beforeEach(() => {
    prismaMock = {
      server: {
        findUnique: jest.fn(),
      },
      environment: {
        findUnique: jest.fn(),
      },
      appSetting: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      jobExecution: {
        create: jest.fn().mockResolvedValue({ id: 200n }),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      securityScan: {
        create: jest.fn().mockResolvedValue({ id: 300n }),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
      securityFindingAck: {
        findMany: jest.fn().mockResolvedValue([]),
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
    securityQueueMock = {
      add: jest.fn().mockResolvedValue({ id: "bull-job-verify" }),
    };
    service = new SecurityHardeningService(prismaMock, sshKeyMock, securityQueueMock);
    jest.clearAllMocks();
  });

  describe("processServerHardening", () => {
    it("successfully runs server hardening actions and updates execution status", async () => {
      const job = {
        data: {
          serverId: 1,
          jobExecutionId: 100,
          actions: ["SSH_PORT_CHANGE"],
        },
      } as any;

      const server = {
        id: 1,
        ip_address: "1.2.3.4",
        ssh_port: 22,
        ssh_user: "root",
      };

      prismaMock.server.findUnique.mockResolvedValue(server);
      sshKeyMock.resolvePrivateKey.mockResolvedValue("fake-key");

      (
        hardeningActions.applyServerHardeningActions as jest.Mock
      ).mockResolvedValue([
        {
          action: "SSH_PORT_CHANGE",
          status: "success",
          detail: "Port changed to 2222",
        },
      ]);

      await service.processServerHardening(job);

      expect(prismaMock.jobExecution.update).toHaveBeenCalledWith({
        where: { id: BigInt(100) },
        data: { status: "active", started_at: expect.any(Date) },
      });
      expect(hardeningActions.applyServerHardeningActions).toHaveBeenCalled();
      expect(prismaMock.jobExecution.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: BigInt(100), status: { in: ["queued", "active"] } },
          data: expect.objectContaining({
            status: "completed",
            completed_at: expect.any(Date),
            execution_log: [
              expect.objectContaining({
                ts: expect.any(String),
                step: "SSH_PORT_CHANGE",
                level: "info",
                detail: "Port changed to 2222",
                hardenStatus: "success",
              }),
            ],
          }),
        }),
      );
    });

    it("marks job execution failed if server is not found", async () => {
      const job = {
        data: {
          serverId: 1,
          jobExecutionId: 100,
          actions: ["SSH_PORT_CHANGE"],
        },
      } as any;

      prismaMock.server.findUnique.mockResolvedValue(null);

      await expect(service.processServerHardening(job)).rejects.toThrow(
        "Server 1 not found",
      );

      expect(prismaMock.jobExecution.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: BigInt(100), status: { in: ["queued", "active"] } },
          data: expect.objectContaining({
            status: "failed",
            last_error: "Server 1 not found",
            completed_at: expect.any(Date),
          }),
        }),
      );
    });
  });

  describe("processEnvironmentHardening", () => {
    it("successfully runs environment hardening actions and updates execution status", async () => {
      const job = {
        data: {
          environmentId: 2,
          jobExecutionId: 101,
          actions: ["DISABLE_FILE_EDIT"],
        },
      } as any;

      const env = {
        id: 2,
        server_id: 1,
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

      (
        hardeningActions.applyEnvironmentHardeningActions as jest.Mock
      ).mockResolvedValue([
        {
          action: "DISABLE_FILE_EDIT",
          status: "skipped",
          detail: "Already disabled",
        },
      ]);

      await service.processEnvironmentHardening(job);

      expect(prismaMock.jobExecution.update).toHaveBeenCalledWith({
        where: { id: BigInt(101) },
        data: { status: "active", started_at: expect.any(Date) },
      });
      expect(
        hardeningActions.applyEnvironmentHardeningActions,
      ).toHaveBeenCalled();
      expect(prismaMock.jobExecution.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: BigInt(101), status: { in: ["queued", "active"] } },
          data: expect.objectContaining({
            status: "completed",
            completed_at: expect.any(Date),
            execution_log: [
              expect.objectContaining({
                ts: expect.any(String),
                step: "DISABLE_FILE_EDIT",
                level: "warn",
                detail: "Already disabled",
                hardenStatus: "skipped",
              }),
            ],
          }),
        }),
      );
    });
  });
});
