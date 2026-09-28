import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
} from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import { UsersRepository } from "./users.repository";
import { CreateUserDto, UpdateUserDto } from "./dto/user.dto";
import { Role } from "@bedrock-forge/shared";

interface UserRow {
  id: bigint;
  email: string;
  name: string;
  created_at: Date;
  updated_at: Date;
  user_roles: { role: { name: string } }[];
}

function serialise(user: UserRow) {
  return {
    id: Number(user.id),
    email: user.email,
    name: user.name,
    roles: user.user_roles.map((ur) => ur.role.name),
    created_at: user.created_at,
    updated_at: user.updated_at,
  };
}

@Injectable()
export class UsersService {
  constructor(private readonly repo: UsersRepository) {}

  async findAll(page: number, limit: number, search?: string) {
    const { data, total } = await this.repo.findAll(page, limit, search);
    const totalPages = Math.ceil(total / limit);
    return {
      data: data.map(serialise),
      total,
      page,
      limit,
      totalPages,
    };
  }

  async findById(id: number) {
    const user = await this.repo.findById(id);
    if (!user) throw new NotFoundException(`User #${id} not found`);
    return serialise(user);
  }

  async findAllRoles() {
    const roles = await this.repo.findAllRoles();
    return roles.map((r) => ({ id: Number(r.id), name: r.name }));
  }

  async create(dto: CreateUserDto) {
    const existing = await this.repo.findByEmail(dto.email);
    if (existing) throw new ConflictException("Email already in use");

    const passwordHash = await bcrypt.hash(dto.password, 12);
    const user = await this.repo.create(
      dto.email,
      dto.name,
      passwordHash,
      dto.roles as Role[],
    );
    return serialise(user);
  }

  async update(id: number, dto: UpdateUserDto, requestingUserId: number) {
    const existing = await this.repo.findById(id);
    if (!existing) throw new NotFoundException(`User #${id} not found`);

    if (dto.email && dto.email !== existing.email) {
      const conflict = await this.repo.findByEmail(dto.email);
      if (conflict) throw new ConflictException("Email already in use");
    }

    const data: { email?: string; name?: string; password_hash?: string } = {};
    if (dto.email) data.email = dto.email;
    if (dto.name) data.name = dto.name;
    if (dto.password) data.password_hash = await bcrypt.hash(dto.password, 12);

    let user = await this.repo.updateAndRevokeRefreshTokens(id, data);

    if (dto.roles && dto.roles.length > 0) {
      // Prevent removing admin role if this is the last admin and it's being dropped
      const currentRoles = existing.user_roles.map(
        (ur: { role: { name: string } }) => ur.role.name,
      );
      const wasAdmin = currentRoles.includes("admin");
      const willBeAdmin = dto.roles.includes("admin");

      if (wasAdmin && !willBeAdmin) {
        const adminCount = await this.repo.countAdmins();
        if (adminCount <= 1) {
          throw new BadRequestException(
            "Cannot remove admin role from the last administrator",
          );
        }
      }

      user = (await this.repo.assignRoles(id, dto.roles as Role[]))!;
    }

    return serialise(user as UserRow);
  }

  async remove(id: number, requestingUserId: number) {
    if (id === requestingUserId) {
      throw new ForbiddenException("Cannot delete your own account");
    }

    const user = await this.repo.findById(id);
    if (!user) throw new NotFoundException(`User #${id} not found`);

    const isAdmin = user.user_roles.some(
      (ur: { role: { name: string } }) => ur.role.name === "admin",
    );
    if (isAdmin) {
      const adminCount = await this.repo.countAdmins();
      if (adminCount <= 1) {
        throw new BadRequestException(
          "Cannot delete the last administrator account",
        );
      }
    }

    await this.repo.remove(id);
  }
}
