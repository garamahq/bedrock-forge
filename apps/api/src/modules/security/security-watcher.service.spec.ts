import { SecurityWatcherService } from "./security-watcher.service";
import { SecurityRepository } from "./security.repository";
import { NotFoundException } from "@nestjs/common";

describe("SecurityWatcherService", () => {
  let service: SecurityWatcherService;
  let repoMock: any;

  beforeEach(() => {
    repoMock = {
      listServers: jest.fn().mockResolvedValue([
        {
          id: BigInt(1),
          name: "Prod-Server-1",
          ip_address: "10.0.0.1",
          status: "online",
        },
      ]),
      findServerById: jest.fn().mockResolvedValue({ id: BigInt(1) }),
    };

    service = new SecurityWatcherService(repoMock as SecurityRepository);
  });

  it("returns watcher overview across active servers", async () => {
    const list = await service.getWatcherOverview();
    expect(list.length).toBe(1);
    expect(list[0].name).toBe("Prod-Server-1");
    expect(list[0].watcher_mode).toBe("agentless_polling");
  });

  it("records heartbeat telemetry for a server", async () => {
    const res = await service.recordHeartbeat({
      server_id: 1,
      failed_logins_10m: 4,
      active_connections: 12,
    });
    expect(res.received).toBe(true);
    expect(res.server_id).toBe(1);
  });

  it("generates lightweight shell installation script", () => {
    const script = service.getInstallScript(1, "https://api.forge.local");
    expect(script).toContain("SERVER_ID=\"1\"");
    expect(script).toContain("/usr/local/bin/bedrock-security-watcher");
    expect(script).toContain("systemctl enable --now bedrock-security-watcher.service");
  });
});
