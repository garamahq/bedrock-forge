import { SecurityRemediationsService } from "./security-remediations.service";
import { SecurityRepository } from "./security.repository";
import { NotFoundException } from "@nestjs/common";

describe("SecurityRemediationsService", () => {
  let service: SecurityRemediationsService;
  let repoMock: any;
  let securityQueueMock: any;

  beforeEach(() => {
    repoMock = {
      findServerById: jest.fn().mockResolvedValue({ id: BigInt(1) }),
      findEnvironmentById: jest.fn().mockResolvedValue({ id: BigInt(2) }),
    };
    securityQueueMock = {
      add: jest.fn().mockResolvedValue({ id: "job-123" }),
    };

    service = new SecurityRemediationsService(
      repoMock as SecurityRepository,
      securityQueueMock as any,
    );
  });

  it("returns preview dry-run plan with commands and safety backup path", async () => {
    const plan = await service.previewRemediation({
      targetType: "server",
      targetId: 1,
      actionType: "ENABLE_UFW_FIREWALL",
    });

    expect(plan.actionType).toBe("ENABLE_UFW_FIREWALL");
    expect(plan.riskLevel).toBe("high");
    expect(plan.safetyBackupPath).toContain("/root/.bedrock-forge-backups/");
    expect(plan.commandsToExecute).toEqual(
      expect.arrayContaining([
        expect.stringContaining("ufw allow 22/tcp"),
        expect.stringContaining("ufw --force enable"),
      ]),
    );
  });

  it("enqueues remediation job safely and returns job ID", async () => {
    const result = await service.applyRemediation(
      {
        targetType: "server",
        targetId: 1,
        actionType: "DISABLE_PASSWORD_AUTH",
        findingId: 99,
      },
      42,
    );

    expect(result.queued).toBe(true);
    expect(result.jobId).toBe("job-123");
    expect(securityQueueMock.add).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        serverId: 1,
        actionTypes: ["DISABLE_PASSWORD_AUTH"],
        findingId: 99,
        userId: 42,
      }),
    );
  });
});
