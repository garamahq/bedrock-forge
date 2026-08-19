import { SecurityRemediationSafetyService } from "./security-remediation-safety.service";
import { PrismaService } from "../../../prisma/prisma.service";
import { SshKeyService } from "../../../services/ssh-key.service";

describe("SecurityRemediationSafetyService", () => {
  let service: SecurityRemediationSafetyService;
  let prismaMock: any;
  let sshKeyMock: any;
  let findingDedupMock: any;

  beforeEach(() => {
    prismaMock = {
      server: { findUnique: jest.fn() },
      environment: { findUnique: jest.fn() },
    };
    sshKeyMock = {
      getSshConfig: jest.fn().mockResolvedValue({ host: "1.2.3.4", port: 22 }),
    };
    findingDedupMock = {
      transitionStatus: jest.fn().mockResolvedValue({}),
    };

    service = new SecurityRemediationSafetyService(
      prismaMock as PrismaService,
      sshKeyMock as SshKeyService,
      findingDedupMock,
    );
  });

  it("generates a dry run preview for DISABLE_PASSWORD_AUTH with safety backup path", async () => {
    const plan = await service.previewRemediation({
      targetType: "server",
      targetId: 1,
      actionType: "DISABLE_PASSWORD_AUTH",
    });

    expect(plan.actionType).toBe("DISABLE_PASSWORD_AUTH");
    expect(plan.safetyBackupPath).toContain("/root/.bedrock-forge-backups/");
    expect(plan.commandsToExecute).toEqual(
      expect.arrayContaining([
        expect.stringContaining("tar -czf"),
        expect.stringContaining("PasswordAuthentication no"),
        "sshd -t",
      ]),
    );
    expect(plan.lamahSafetyNotice).toContain("Lamah-Staging Safety Policy");
  });

  it("generates a quarantine plan for QUARANTINE_FILE without rm -rf", async () => {
    const plan = await service.previewRemediation({
      targetType: "server",
      targetId: 1,
      actionType: "QUARANTINE_FILE",
      resource: "/home/user/public_html/shell.php",
    });

    expect(plan.quarantinePath).toContain("/root/.bedrock-forge-quarantine/");
    expect(plan.commandsToExecute.some((cmd) => cmd.includes("rm -rf"))).toBe(false);
    expect(plan.commandsToExecute.some((cmd) => cmd.includes("mv "))).toBe(true);
  });
});
