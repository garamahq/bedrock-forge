import { Test, TestingModule } from "@nestjs/testing";
import { FindingDeduplicationService } from "./finding-deduplication.service";
import { PrismaService } from "../../../prisma/prisma.service";
import type { SecurityFinding } from "@bedrock-forge/shared";

describe("FindingDeduplicationService", () => {
  let service: FindingDeduplicationService;
  let prisma: {
    securityFinding: {
      findFirst: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    securityFindingTransition: {
      create: jest.Mock;
    };
  };

  beforeEach(async () => {
    prisma = {
      securityFinding: {
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      securityFindingTransition: {
        create: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FindingDeduplicationService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<FindingDeduplicationService>(FindingDeduplicationService);
  });

  it("should generate deterministic dedup keys", () => {
    const k1 = service.computeDedupKey({ serverId: 1 }, "SSH_CONFIG", "Root login enabled", "/etc/ssh/sshd_config");
    const k2 = service.computeDedupKey({ serverId: 1 }, "ssh_config", "Root Login Enabled", "/etc/ssh/sshd_config");
    const k3 = service.computeDedupKey({ serverId: 2 }, "SSH_CONFIG", "Root login enabled", "/etc/ssh/sshd_config");

    expect(k1).toEqual(k2);
    expect(k1).not.toEqual(k3);
  });

  it("should create new finding and initial transition when finding does not exist", async () => {
    prisma.securityFinding.findFirst.mockResolvedValue(null);
    prisma.securityFinding.create.mockResolvedValue({ id: BigInt(101) });
    prisma.securityFindingTransition.create.mockResolvedValue({ id: BigInt(1) });

    const findings: SecurityFinding[] = [
      {
        id: "test-uuid-1",
        severity: "critical",
        category: "MALWARE",
        title: "Webshell detected",
        description: "PHP executable found in uploads",
        resource: "/home/user/public_html/wp-content/uploads/shell.php",
      },
    ];

    await service.upsertFindings({
      serverId: 1,
      scanId: 50,
      findings,
    });

    expect(prisma.securityFinding.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.securityFinding.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          server_id: BigInt(1),
          scan_id: BigInt(50),
          category: "MALWARE",
          severity: "critical",
          status: "new",
          title: "Webshell detected",
        }),
      }),
    );
    expect(prisma.securityFindingTransition.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          finding_id: BigInt(101),
          to_status: "new",
        }),
      }),
    );
  });

  it("should reopen resolved finding when detected again", async () => {
    prisma.securityFinding.findFirst.mockResolvedValue({
      id: BigInt(202),
      status: "resolved",
      scan_id: BigInt(40),
      resolved_at: new Date(),
    });
    prisma.securityFinding.update.mockResolvedValue({ id: BigInt(202), status: "new" });
    prisma.securityFindingTransition.create.mockResolvedValue({ id: BigInt(2) });

    const findings: SecurityFinding[] = [
      {
        id: "test-uuid-2",
        severity: "high",
        category: "INACTIVE_PLUGINS",
        title: "Inactive plugin detected",
        description: "Plugin hello-dolly is inactive",
      },
    ];

    await service.upsertFindings({
      environmentId: 2,
      scanId: 60,
      findings,
    });

    expect(prisma.securityFinding.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: BigInt(202) },
        data: expect.objectContaining({
          status: "new",
          resolved_at: null,
        }),
      }),
    );
    expect(prisma.securityFindingTransition.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          finding_id: BigInt(202),
          from_status: "resolved",
          to_status: "new",
        }),
      }),
    );
  });
});
