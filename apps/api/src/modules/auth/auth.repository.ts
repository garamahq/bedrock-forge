import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";

@Injectable()
export class AuthRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findUserByEmail(email: string) {
    return this.prisma.user.findUnique({
      where: { email },
      include: {
        user_roles: { include: { role: true } },
      },
    });
  }

  async findUserById(id: number) {
    return this.prisma.user.findUnique({
      where: { id: BigInt(id) },
      include: {
        user_roles: { include: { role: true } },
      },
    });
  }

  async createUser(email: string, name: string, passwordHash: string) {
    // Find or create the 'client' role as default
    const defaultRole = await this.prisma.role.upsert({
      where: { name: "client" },
      update: {},
      create: { name: "client" },
    });

    return this.prisma.user.create({
      data: {
        email,
        name,
        password_hash: passwordHash,
        user_roles: {
          create: { role_id: defaultRole.id },
        },
      },
      include: {
        user_roles: { include: { role: true } },
      },
    });
  }

  async storeRefreshToken(
    userId: bigint,
    tokenHash: string,
    expiresAt: Date,
    userAgent?: string,
    ipAddress?: string,
  ) {
    return this.prisma.refreshToken.create({
      data: {
        user_id: userId,
        token_hash: tokenHash,
        expires_at: expiresAt,
        user_agent: userAgent ?? null,
        ip_address: ipAddress ?? null,
      },
    });
  }

  async findActiveSessionsByUserId(userId: bigint) {
    return this.prisma.refreshToken.findMany({
      where: {
        user_id: userId,
        revoked_at: null,
        expires_at: { gt: new Date() },
      },
      select: {
        id: true,
        created_at: true,
        expires_at: true,
        user_agent: true,
        ip_address: true,
      },
      orderBy: { created_at: "desc" },
    });
  }

  async revokeSessionById(id: bigint, userId: bigint) {
    const session = await this.prisma.refreshToken.findFirst({
      where: { id, user_id: userId, revoked_at: null },
    });
    if (!session) return null;
    return this.prisma.refreshToken.update({
      where: { id },
      data: { revoked_at: new Date() },
    });
  }

  async findValidRefreshToken(tokenHash: string) {
    return this.prisma.refreshToken.findFirst({
      where: {
        token_hash: tokenHash,
        revoked_at: null,
        expires_at: { gt: new Date() },
      },
    });
  }

  async revokeRefreshToken(id: bigint) {
    return this.prisma.refreshToken.update({
      where: { id },
      data: { revoked_at: new Date() },
    });
  }

  /**
   * Atomically claim an unrevoked, unexpired refresh token, load its owner,
   * and persist the replacement refresh token inside a single DB transaction.
   * Returns null if the token was invalid, expired, or already claimed concurrently.
   */
  async rotateRefreshToken(params: {
    oldTokenHash: string;
    newTokenHash: string;
    expiresAt: Date;
    userAgent?: string;
    ipAddress?: string;
  }) {
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const candidate = await tx.refreshToken.findFirst({
        where: {
          token_hash: params.oldTokenHash,
          revoked_at: null,
          expires_at: { gt: now },
        },
        select: { id: true, user_id: true },
      });
      if (!candidate) return null;

      const claimed = await tx.refreshToken.updateMany({
        where: {
          id: candidate.id,
          revoked_at: null,
          expires_at: { gt: now },
        },
        data: { revoked_at: now },
      });
      if (claimed.count !== 1) return null;

      const user = await tx.user.findUnique({
        where: { id: candidate.user_id },
        include: { user_roles: { include: { role: true } } },
      });
      if (!user) {
        throw new NotFoundException("User not found");
      }

      await tx.refreshToken.create({
        data: {
          user_id: candidate.user_id,
          token_hash: params.newTokenHash,
          expires_at: params.expiresAt,
          user_agent: params.userAgent ?? null,
          ip_address: params.ipAddress ?? null,
        },
      });

      return user;
    });
  }

  async revokeAllUserRefreshTokens(userId: bigint) {
    return this.prisma.refreshToken.updateMany({
      where: { user_id: userId, revoked_at: null },
      data: { revoked_at: new Date() },
    });
  }

  async updatePassword(userId: bigint, passwordHash: string) {
    return this.prisma.user.update({
      where: { id: userId },
      data: { password_hash: passwordHash },
    });
  }

  async updateMfa(userId: bigint, mfaEnabled: boolean, totpSecretEncrypted: string | null) {
    return this.prisma.user.update({
      where: { id: userId },
      data: {
        mfa_enabled: mfaEnabled,
        totp_secret_encrypted: totpSecretEncrypted,
        last_totp_step: null, // Reset step when MFA is modified
      },
    });
  }

  async updateLastTotpStep(userId: bigint, step: bigint) {
    return this.prisma.user.update({
      where: { id: userId },
      data: { last_totp_step: step },
    });
  }

  async recordLoginFailure(
    userId: bigint,
    failures: number,
    lockedUntil: Date | null,
  ) {
    return this.prisma.user.update({
      where: { id: userId },
      data: {
        login_failures: failures,
        ...(lockedUntil !== null ? { locked_until: lockedUntil } : {}),
      },
    });
  }

  async resetLoginFailures(userId: bigint) {
    return this.prisma.user.update({
      where: { id: userId },
      data: { login_failures: 0, locked_until: null },
    });
  }

  async ensureDefaultRolesExist() {
    const roles = ["admin", "manager", "maintainer", "client"];
    for (const name of roles) {
      await this.prisma.role.upsert({
        where: { name },
        update: {},
        create: { name },
      });
    }
  }
}
