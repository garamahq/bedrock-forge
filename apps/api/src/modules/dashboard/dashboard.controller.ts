import { Controller, Get, UseGuards } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { ROLES } from "@bedrock-forge/shared";
import { DashboardService } from "./dashboard.service";

@Controller("dashboard")
@UseGuards(AuthGuard("jwt"), RolesGuard)
@Roles(ROLES.MAINTAINER)
export class DashboardController {
  constructor(private readonly svc: DashboardService) {}

  @Get("summary")
  getSummary() {
    return this.svc.getSummary();
  }

  @Get("health-scores")
  getHealthScores() {
    return this.svc.getHealthScores();
  }

  @Get("attention")
  getAttention() {
    return this.svc.getAttentionItems();
  }

  @Get("summary-24h")
  get24hSummary() {
    return this.svc.get24hSummary();
  }
}
