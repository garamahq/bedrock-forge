import { NotFoundException } from "@nestjs/common";
import { AuthRepository } from "./auth.repository";
import { PrismaService } from "../../prisma/prisma.service";

describe("AuthRepository.rotateRefreshToken (#101)", () => {
  it("atomically claims old token once and creates replacement inside the same transaction", async () => {
    let revoked = false;
    const createdTokens: unknown[] = [];

    const prisma = {
      $transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          refreshToken: {
            findFirst: jest.fn().mockImplementation(async () =>
              revoked ? null : { id: BigInt(11), user_id: BigInt(5) },
            ),
            updateMany: jest.fn().mockImplementation(async () => {
              if (revoked) return { count: 0 };
              revoked = true;
              return { count: 1 };
            }),
            create: jest.fn().mockImplementation(async ({ data }: { data: unknown }) => {
              createdTokens.push(data);
              return { id: BigInt(12) };
            }),
          },
          user: {
            findUnique: jest.fn().mockResolvedValue({
              id: BigInt(5),
              email: "u@example.test",
              name: "User",
              mfa_enabled: false,
              user_roles: [{ role: { name: "admin" } }],
            }),
          },
        };
        return cb(tx);
      }),
    } as unknown as PrismaService;

    const repo = new AuthRepository(prisma);
    const expiresAt = new Date(Date.now() + 60_000);

    const [first, second] = await Promise.all([
      repo.rotateRefreshToken({
        oldTokenHash: "hash-old",
        newTokenHash: "hash-new-1",
        expiresAt,
        userAgent: "tab-1",
      }),
      repo.rotateRefreshToken({
        oldTokenHash: "hash-old",
        newTokenHash: "hash-new-2",
        expiresAt,
        userAgent: "tab-2",
      }),
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(createdTokens).toHaveLength(1);
  });

  it("propagates partial failure when replacement token creation throws inside transaction", async () => {
    const prisma = {
      $transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          refreshToken: {
            findFirst: jest.fn().mockResolvedValue({ id: BigInt(11), user_id: BigInt(5) }),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            create: jest.fn().mockRejectedValue(new Error("DB write error")),
          },
          user: {
            findUnique: jest.fn().mockResolvedValue({
              id: BigInt(5),
              email: "u@example.test",
              name: "User",
              mfa_enabled: false,
              user_roles: [{ role: { name: "admin" } }],
            }),
          },
        };
        return cb(tx);
      }),
    } as unknown as PrismaService;

    const repo = new AuthRepository(prisma);
    await expect(
      repo.rotateRefreshToken({
        oldTokenHash: "hash-old",
        newTokenHash: "hash-new",
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toThrow("DB write error");
  });

  it("throws NotFoundException inside transaction if token owner no longer exists", async () => {
    const createMock = jest.fn();
    const prisma = {
      $transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          refreshToken: {
            findFirst: jest.fn().mockResolvedValue({ id: BigInt(11), user_id: BigInt(999) }),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            create: createMock,
          },
          user: {
            findUnique: jest.fn().mockResolvedValue(null),
          },
        };
        return cb(tx);
      }),
    } as unknown as PrismaService;

    const repo = new AuthRepository(prisma);
    await expect(
      repo.rotateRefreshToken({
        oldTokenHash: "hash-old",
        newTokenHash: "hash-new",
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toThrow(NotFoundException);
    expect(createMock).not.toHaveBeenCalled();
  });
});
