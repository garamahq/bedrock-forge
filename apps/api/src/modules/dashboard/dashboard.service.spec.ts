import { DashboardService } from "./dashboard.service";
import { DashboardRepository } from "./dashboard.repository";

describe("DashboardService", () => {
  it("counts redirects as working and excludes unchecked monitors from uptime", async () => {
    const repository = {
      getSummaryData: jest.fn().mockResolvedValue({
        projectTotal: 1,
        serverTotal: 1,
        clientTotal: 1,
        monitors: [
          { last_status: 301, uptime_pct: "99.0" },
          { last_status: 503, uptime_pct: "80.0" },
          { last_status: null, uptime_pct: "100.0" },
        ],
        recentJobs: [],
        domainsExpiringSoon: 0,
        runningJobs: [],
        failedJobs24h: [],
      }),
    };
    const service = new DashboardService(
      repository as unknown as DashboardRepository,
    );

    const summary = await service.getSummary();

    expect(summary.monitors).toEqual({
      total: 3,
      up: 1,
      down: 1,
      avgUptime: 89.5,
    });
  });
});
