import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { ROLES } from "@bedrock-forge/shared";
import { LighthouseService } from "./lighthouse.service";
import { TriggerLighthouseAuditDto } from "./dto/lighthouse-audit.dto";

@Controller("lighthouse")
@UseGuards(AuthGuard("jwt"), RolesGuard)
@Roles(ROLES.MANAGER)
export class LighthouseController {
  constructor(private readonly svc: LighthouseService) {}

  @Get()
  listLatest() {
    return this.svc.listLatest();
  }

  @Get("history")
  history(
    @Query("environment_id") environmentId?: string,
    @Query("project_id") projectId?: string,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
  ) {
    return this.svc.history(
      environmentId ? Number(environmentId) : undefined,
      projectId ? Number(projectId) : undefined,
      page ? Number(page) : undefined,
      limit ? Number(limit) : undefined,
    );
  }

  @Get(":id")
  findOne(@Param("id", ParseIntPipe) id: number) {
    return this.svc.findOne(id);
  }

  @Post("audits")
  trigger(@Body() dto: TriggerLighthouseAuditDto) {
    return this.svc.trigger(dto);
  }
}
