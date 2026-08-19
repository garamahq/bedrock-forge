import { SecurityAlertRuleEngineService } from "./security-alert-rule-engine.service";
import { PrismaService } from "../../../prisma/prisma.service";
import { SecurityFinding } from "@bedrock-forge/shared";

describe("SecurityAlertRuleEngineService", () => {
  let service: SecurityAlertRuleEngineService;
  let prisma: Partial<PrismaService>;
  let notifQueue: any;

  beforeEach(() => {
    prisma = {
      securityAlertRule: {
        findMany: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      } as any,
      securityIncident: {
        create: jest.fn().mockResolvedValue({ id: BigInt(1) }),
      } as any,
    };
    notifQueue = {
      add: jest.fn().mockResolvedValue({}),
    };
    service = new SecurityAlertRuleEngineService(
      prisma as PrismaService,
      notifQueue,
    );
  });

  it("triggers alert rule and dispatches notification when finding matches minimum severity", async () => {
    (prisma.securityAlertRule!.findMany as jest.Mock).mockResolvedValue([
      {
        id: BigInt(1),
        name: "Critical Threats Alert",
        enabled: true,
        min_severity: "high",
        categories: [],
        server_ids: [],
        cooldown_minutes: 30,
        last_fired_at: null,
        create_incident: true,
      },
    ]);

    const findings: SecurityFinding[] = [
      {
        id: "1",
        severity: "critical",
        category: "MALWARE",
        title: "Malware detected",
        description: "Backdoor file found",
      },
    ];

    const result = await service.evaluateFindings(1, undefined, findings);
    expect(result.rulesTriggered).toBe(1);
    expect(prisma.securityAlertRule!.update).toHaveBeenCalled();
    expect(notifQueue.add).toHaveBeenCalledWith(
      "security-alert-rule-fired",
      expect.objectContaining({
        ruleName: "Critical Threats Alert",
        serverId: 1,
      }),
    );
  });
});
