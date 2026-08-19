import { Injectable, NotFoundException } from "@nestjs/common";
import { SecurityRepository } from "./security.repository";
import { CreateAlertRuleDto, UpdateAlertRuleDto } from "./dto/alert-rule.dto";

@Injectable()
export class SecurityAlertRulesService {
  constructor(private readonly repo: SecurityRepository) {}

  async listAlertRules() {
    return this.repo.listAlertRules();
  }

  async getAlertRuleById(id: number) {
    const rule = await this.repo.findAlertRuleById(BigInt(id));
    if (!rule) throw new NotFoundException(`Alert rule ${id} not found`);
    return rule;
  }

  async createAlertRule(dto: CreateAlertRuleDto) {
    return this.repo.createAlertRule({
      name: dto.name,
      enabled: dto.enabled,
      min_severity: dto.min_severity,
      categories: dto.categories,
      server_ids: dto.server_ids?.map(BigInt),
      channel_ids: dto.channel_ids?.map(BigInt),
      create_incident: dto.create_incident,
      cooldown_minutes: dto.cooldown_minutes,
    });
  }

  async updateAlertRule(id: number, dto: UpdateAlertRuleDto) {
    const existing = await this.repo.findAlertRuleById(BigInt(id));
    if (!existing) throw new NotFoundException(`Alert rule ${id} not found`);

    return this.repo.updateAlertRule(BigInt(id), {
      name: dto.name,
      enabled: dto.enabled,
      min_severity: dto.min_severity,
      categories: dto.categories,
      server_ids: dto.server_ids?.map(BigInt),
      channel_ids: dto.channel_ids?.map(BigInt),
      create_incident: dto.create_incident,
      cooldown_minutes: dto.cooldown_minutes,
    });
  }

  async deleteAlertRule(id: number) {
    const existing = await this.repo.findAlertRuleById(BigInt(id));
    if (!existing) throw new NotFoundException(`Alert rule ${id} not found`);
    return this.repo.deleteAlertRule(BigInt(id));
  }
}
