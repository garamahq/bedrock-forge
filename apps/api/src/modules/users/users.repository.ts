import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { Role } from "@bedrock-forge/shared";

const USER_WITH_ROLES = {
  include: {
    user_roles: { include: { role: true } },
  },
} as const;
type UserWithRoles = Prisma.UserGetPayload<typeof USER_WITH_ROLES>;

@Injectable()
export class UsersRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(page: number, limit: number, search?: string) {
    const where = search
      ? {
          OR: [
            { name: { contains: search, mode: "insensitive" as const } },
            { email: { contains: search, mode: "insensitive" as const } },
          ],
        }
      : {};

    const [data, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        ...USER_WITH_ROLES,
        orderBy: { created_at: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.user.count({ where }),
    ]);

    return { data, total };
  }

  async findById(id: number) {
    return this.prisma.user.findUnique({
      where: { id: BigInt(id) },
      ...USER_WITH_ROLES,
    });
  }

  async findByEmail(email: string) {
    return this.prisma.user.findUnique({
      where: { email },
      ...USER_WITH_ROLES,
    });
  }

  async findAllRoles() {
    return this.prisma.role.findMany({ orderBy: { name: "asc" } });
  }

  async create(
    email: string,
    name: string,
    passwordHash: string,
    roleNames: Role[],
  ) {
    const roles = await this.prisma.role.findMany({
      where: { name: { in: roleNames } },
    });

    return this.prisma.user.create({
      data: {
        email,
        name,
        password_hash: passwordHash,
        user_roles: {
          create: roles.map((r) => ({ role_id: r.id })),
        },
      },
      ...USER_WITH_ROLES,
    });
  }

  async updateAndRevokeRefreshTokens(
    id: number,
    data: { email?: string; name?: string; password_hash?: string },
  ): Promise<UserWithRoles> {
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.update({
        where: { id: BigInt(id) },
        data,
        ...USER_WITH_ROLES,
      });
      if (data.password_hash !== undefined) {
        await tx.refreshToken.updateMany({
          where: { user_id: BigInt(id), revoked_at: null },
          data: { revoked_at: new Date() },
        });
      }
      return user;
    });
  }

  async assignRoles(userId: number, roleNames: Role[]) {
    const roles = await this.prisma.role.findMany({
      where: { name: { in: roleNames } },
    });

    await this.prisma.userRole.deleteMany({
      where: { user_id: BigInt(userId) },
    });

    await this.prisma.userRole.createMany({
      data: roles.map((r) => ({
        user_id: BigInt(userId),
        role_id: r.id,
      })),
    });

    return this.findById(userId);
  }

  async remove(id: number) {
    return this.prisma.user.delete({ where: { id: BigInt(id) } });
  }

  async countAdmins(): Promise<number> {
    const adminRole = await this.prisma.role.findUnique({
      where: { name: "admin" },
    });
    if (!adminRole) return 0;
    return this.prisma.userRole.count({ where: { role_id: adminRole.id } });
  }
}
