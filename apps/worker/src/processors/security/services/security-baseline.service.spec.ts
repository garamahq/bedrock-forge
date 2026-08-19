import { SecurityBaselineService } from "./security-baseline.service";
import { PrismaService } from "../../../prisma/prisma.service";
import { SshKeyService } from "../../../services/ssh-key.service";
import { FindingDeduplicationService } from "./finding-deduplication.service";

describe("SecurityBaselineService", () => {
  let service: SecurityBaselineService;
  let prisma: Partial<PrismaService>;
  let sshKey: Partial<SshKeyService>;
  let findingDedup: Partial<FindingDeduplicationService>;

  beforeEach(() => {
    prisma = {
      server: {
        findUnique: jest.fn().mockResolvedValue({
          id: BigInt(1),
          ip_address: "127.0.0.1",
          ssh_port: 22,
          ssh_user: "root",
          ssh_private_key_encrypted: "MOCK_ENC",
        }),
      } as any,
      securityBaseline: {
        create: jest.fn().mockResolvedValue({
          id: BigInt(10),
          label: "Initial Baseline",
          created_at: new Date(),
        }),
        findFirst: jest.fn(),
      } as any,
      securityBaselineItem: {
        createMany: jest.fn().mockResolvedValue({ count: 5 }),
      } as any,
      securityDriftEvent: {
        create: jest.fn().mockResolvedValue({
          id: BigInt(100),
        }),
      } as any,
      $transaction: jest.fn().mockImplementation((cb) => cb(prisma)),
    };

    sshKey = {
      resolvePrivateKey: jest.fn().mockResolvedValue("MOCK_KEY"),
    };

    findingDedup = {
      upsertFindings: jest.fn().mockResolvedValue([]),
    };

    service = new SecurityBaselineService(
      prisma as PrismaService,
      sshKey as SshKeyService,
      findingDedup as FindingDeduplicationService,
    );
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  it("compares current state with baseline and flags added SSH keys and ports as drift", async () => {
    const existingBaseline = {
      id: BigInt(1),
      items: [
        {
          category: "ssh_keys",
          key: "ssh-ed25519:abcdef123456",
          value: { type: "ssh-ed25519", fingerprint: "abcdef123456", comment: "admin@work" },
        },
        {
          category: "ports",
          key: "0.0.0.0:22",
          value: { address: "0.0.0.0:22" },
        },
      ],
    };

    (prisma.securityBaseline!.findFirst as jest.Mock).mockResolvedValue(existingBaseline);

    // Mock collecting live state with a new unauthorized SSH key and port
    jest.spyOn<any, any>(service, "collectCurrentState").mockResolvedValue([
      {
        category: "ssh_keys",
        key: "ssh-ed25519:abcdef123456",
        value: { type: "ssh-ed25519", fingerprint: "abcdef123456", comment: "admin@work" },
      },
      {
        category: "ssh_keys",
        key: "ssh-rsa:hackerkey123",
        value: { type: "ssh-rsa", fingerprint: "hackerkey123", comment: "attacker" },
      },
      {
        category: "ports",
        key: "0.0.0.0:22",
        value: { address: "0.0.0.0:22" },
      },
      {
        category: "ports",
        key: "0.0.0.0:4444",
        value: { address: "0.0.0.0:4444" },
      },
    ]);

    const result = await service.compareBaseline("server", 1);
    expect(result.driftCount).toBe(2);
    expect(result.diffs.some((d) => d.key === "ssh-rsa:hackerkey123" && d.change_type === "added")).toBe(true);
    expect(result.diffs.some((d) => d.key === "0.0.0.0:4444" && d.change_type === "added")).toBe(true);
    expect(findingDedup.upsertFindings).toHaveBeenCalled();
  });
});
