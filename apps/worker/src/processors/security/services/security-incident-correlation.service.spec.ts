import { SecurityIncidentCorrelationService } from "./security-incident-correlation.service";
import { PrismaService } from "../../../prisma/prisma.service";

describe("SecurityIncidentCorrelationService", () => {
  let service: SecurityIncidentCorrelationService;
  let prisma: Partial<PrismaService>;
  let notifQueue: any;

  beforeEach(() => {
    prisma = {
      securityFinding: {
        findMany: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      } as any,
      securityIncident: {
        findFirst: jest.fn(),
        create: jest.fn().mockResolvedValue({
          id: BigInt(500),
          title: "Webshell Backdoor & Remote Command Execution Threat",
          severity: "critical",
          status: "open",
        }),
      } as any,
    };
    notifQueue = {
      add: jest.fn().mockResolvedValue({}),
    };
    service = new SecurityIncidentCorrelationService(
      prisma as PrismaService,
      notifQueue,
    );
  });

  it("creates a critical incident when webshell and anomalous process findings co-occur", async () => {
    (prisma.securityFinding!.findMany as jest.Mock).mockResolvedValue([
      {
        id: BigInt(1),
        server_id: BigInt(10),
        category: "MALWARE",
        title: "Webshell detected in /home/user/public_html/c99.php",
        status: "new",
        incident_id: null,
      },
      {
        id: BigInt(2),
        server_id: BigInt(10),
        category: "PROCESS_ANOMALY",
        title: "Web server spawned interactive shell",
        status: "new",
        incident_id: null,
      },
    ]);

    (prisma.securityIncident!.findFirst as jest.Mock).mockResolvedValue(null);

    const result = await service.correlateServerIncidents(10);
    expect(result.incidentsCreated).toBe(1);
    expect(prisma.securityIncident!.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          server_id: BigInt(10),
          severity: "critical",
        }),
      }),
    );
    expect(notifQueue.add).toHaveBeenCalled();
  });
});
