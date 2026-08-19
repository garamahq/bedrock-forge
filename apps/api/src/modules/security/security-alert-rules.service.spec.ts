import { SecurityAlertRulesService } from "./security-alert-rules.service";
import { SecurityRepository } from "./security.repository";
import { NotFoundException } from "@nestjs/common";

describe("SecurityAlertRulesService", () => {
  let service: SecurityAlertRulesService;
  let repoMock: any;

  beforeEach(() => {
    repoMock = {
      listAlertRules: jest.fn().mockResolvedValue([
        { id: BigInt(1), name: "Critical Finding Alert", enabled: true },
      ]),
      findAlertRuleById: jest.fn(),
      createAlertRule: jest.fn().mockResolvedValue({ id: BigInt(1), name: "New Rule" }),
      updateAlertRule: jest.fn().mockResolvedValue({ id: BigInt(1), name: "Updated Rule" }),
      deleteAlertRule: jest.fn().mockResolvedValue({ id: BigInt(1) }),
    };

    service = new SecurityAlertRulesService(repoMock as SecurityRepository);
  });

  it("lists all alert rules", async () => {
    const result = await service.listAlertRules();
    expect(result.length).toBe(1);
    expect(repoMock.listAlertRules).toHaveBeenCalled();
  });

  it("creates a new alert rule with mapped bigint server IDs", async () => {
    await service.createAlertRule({
      name: "High Severity Alert",
      min_severity: "high",
      server_ids: [10, 20],
      cooldown_minutes: 60,
    });
    expect(repoMock.createAlertRule).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "High Severity Alert",
        server_ids: [BigInt(10), BigInt(20)],
        cooldown_minutes: 60,
      }),
    );
  });

  it("throws NotFoundException when deleting non-existent alert rule", async () => {
    repoMock.findAlertRuleById.mockResolvedValue(null);
    await expect(service.deleteAlertRule(999)).rejects.toThrow(NotFoundException);
  });
});
