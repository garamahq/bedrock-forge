import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";

@Injectable()
export class RemoteOpsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createAuditLog(data: {
    user_id?: bigint;
    action: string;
    resource_type: string;
    resource_id: bigint;
    metadata: Prisma.InputJsonObject;
  }) {
    return this.prisma.auditLog.create({ data }).catch(() => undefined);
  }

  async findTemplatesByEnvType(envType: string) {
    return this.prisma.envVariableTemplate.findMany({
      where: {
        OR: [{ environment_type: null }, { environment_type: envType }],
      },
      orderBy: [{ environment_type: "asc" }, { name: "asc" }],
    });
  }

  async findProjectById(projectId: number) {
    return this.prisma.project.findUnique({
      where: { id: BigInt(projectId) },
      select: { id: true },
    });
  }

  async findEnvironmentById(envId: number) {
    return this.prisma.environment.findUnique({
      where: { id: BigInt(envId) },
      select: { project_id: true, type: true },
    });
  }

  async findNotes(resourceType: string, resourceId: string) {
    return this.prisma.resourceNote.findMany({
      where: { resource_type: resourceType, resource_id: BigInt(resourceId) },
      orderBy: [{ pinned: "desc" }, { updated_at: "desc" }],
    });
  }

  async createNote(data: {
    resource_type: string;
    resource_id: bigint;
    body: string;
    pinned: boolean;
    created_by_id?: bigint;
  }) {
    return this.prisma.resourceNote.create({ data });
  }

  async findNoteById(noteId: number) {
    return this.prisma.resourceNote.findUnique({
      where: { id: BigInt(noteId) },
      select: { id: true, created_by_id: true },
    });
  }

  async updateNote(
    noteId: number,
    data: {
      body?: string;
      pinned?: boolean;
    },
  ) {
    return this.prisma.resourceNote.update({
      where: { id: BigInt(noteId) },
      data,
    });
  }

  async deleteNote(noteId: number) {
    return this.prisma.resourceNote.delete({ where: { id: BigInt(noteId) } });
  }

  async findAllTemplates() {
    return this.prisma.envVariableTemplate.findMany({
      orderBy: [{ environment_type: "asc" }, { name: "asc" }],
    });
  }

  async createTemplate(data: {
    name: string;
    environment_type: string | null;
    required_keys: string[];
    secret_keys: string[];
    defaults?: Prisma.InputJsonValue;
  }) {
    return this.prisma.envVariableTemplate.create({ data });
  }

  async deleteTemplate(id: number) {
    return this.prisma.envVariableTemplate.delete({ where: { id: BigInt(id) } });
  }

  async findTemplatesForValidation(environmentType: string) {
    return this.prisma.envVariableTemplate.findMany({
      where: {
        OR: [{ environment_type: null }, { environment_type: environmentType }],
      },
    });
  }

  async findEnvironmentWithServerAndProject(envId: number) {
    return this.prisma.environment.findUnique({
      where: { id: BigInt(envId) },
      include: { server: true, project: { select: { name: true } } },
    });
  }

  async resourceExists(resourceType: string, resourceId: string): Promise<boolean> {
    const id = BigInt(resourceId);
    let exists;
    if (resourceType === "project") {
      exists = await this.prisma.project.findUnique({ where: { id } });
    } else if (resourceType === "environment") {
      exists = await this.prisma.environment.findUnique({ where: { id } });
    } else {
      exists = await this.prisma.server.findUnique({ where: { id } });
    }
    return !!exists;
  }
}
