import { Injectable, NotFoundException } from "@nestjs/common";
import { SecurityRepository } from "./security.repository";

@Injectable()
export class SecurityIncidentsService {
  constructor(private readonly repo: SecurityRepository) {}

  async listIncidents(params: {
    status?: string;
    serverId?: number;
    page?: number;
    limit?: number;
  }) {
    return this.repo.listIncidents({
      status: params.status,
      serverId: params.serverId ? BigInt(params.serverId) : undefined,
      page: params.page,
      limit: params.limit,
    });
  }

  async getIncidentById(id: number) {
    const incident = await this.repo.findIncidentById(BigInt(id));
    if (!incident) throw new NotFoundException(`Incident ${id} not found`);
    return incident;
  }

  async updateIncidentStatus(id: number, status: string) {
    const incident = await this.repo.findIncidentById(BigInt(id));
    if (!incident) throw new NotFoundException(`Incident ${id} not found`);
    return this.repo.updateIncidentStatus(BigInt(id), status);
  }
}
