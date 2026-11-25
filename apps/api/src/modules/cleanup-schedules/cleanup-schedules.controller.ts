import {
  Controller,
  Get,
  Put,
  Delete,
  Param,
  Body,
  ParseIntPipe,
  UseGuards,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { ROLES } from "@bedrock-forge/shared";
import { CleanupSchedulesService } from "./cleanup-schedules.service";
import { UpsertCleanupScheduleDto } from "./dto/upsert-cleanup-schedule.dto";

@Controller("environments/:envId/cleanup-schedule")
@UseGuards(AuthGuard("jwt"), RolesGuard)
@Roles(ROLES.MANAGER)
export class CleanupSchedulesController {
  constructor(private readonly svc: CleanupSchedulesService) {}

  @Get()
  findOne(@Param("envId", ParseIntPipe) envId: number) {
    return this.svc.findByEnvironment(envId);
  }

  @Put()
  upsert(
    @Param("envId", ParseIntPipe) envId: number,
    @Body() dto: UpsertCleanupScheduleDto,
  ) {
    return this.svc.upsert(envId, dto);
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param("envId", ParseIntPipe) envId: number) {
    return this.svc.delete(envId);
  }
}
