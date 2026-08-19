import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  Query,
  ParseIntPipe,
  UseGuards,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { ROLES } from "@bedrock-forge/shared";
import { ServersService } from "./servers.service";
import { CreateServerDto, UpdateServerDto } from "./dto/server.dto";
import { DetectBedrockDto } from "./dto/detect-bedrock.dto";
import { ScanProjectsMultiDto } from "./dto/scan-projects.dto";
import { normalizePage, normalizePageSize } from "../../common/pagination";

@Controller("servers")
@UseGuards(AuthGuard("jwt"), RolesGuard)
@Roles(ROLES.MANAGER)
export class ServersController {
  constructor(private readonly svc: ServersService) {}

  @Get() findAll(
    @Query("page") page?: string,
    @Query("limit") limit?: string,
    @Query("search") search?: string,
  ) {
    return this.svc.findAll({
      page: normalizePage(page),
      limit: normalizePageSize(limit, 50),
      search,
    });
  }
  @Get(":id") findOne(@Param("id", ParseIntPipe) id: number) {
    return this.svc.findOne(id);
  }
  @Post() @Roles(ROLES.ADMIN) create(@Body() dto: CreateServerDto) {
    return this.svc.create(dto);
  }
  @Put(":id") @Roles(ROLES.ADMIN) update(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateServerDto,
  ) {
    return this.svc.update(id, dto);
  }
  @Delete(":id") @Roles(ROLES.ADMIN) @HttpCode(HttpStatus.NO_CONTENT) remove(
    @Param("id", ParseIntPipe) id: number,
  ) {
    return this.svc.remove(id);
  }
  @Post(":id/test-connection") testConnection(
    @Param("id", ParseIntPipe) id: number,
  ) {
    return this.svc.testConnection(id);
  }
  @Post(":id/detect-bedrock") detectBedrock(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: DetectBedrockDto,
  ) {
    return this.svc.detectBedrock(id, dto.path);
  }
  @Post(":id/scan-projects") scanProjects(
    @Param("id", ParseIntPipe) id: number,
  ) {
    return this.svc.scanProjects(id);
  }
  @Post("scan-projects-multi") scanProjectsMulti(
    @Body() dto: ScanProjectsMultiDto,
  ) {
    return this.svc.scanProjectsMulti(dto);
  }
  @Get(":id/ssh-health") getSshHealth(@Param("id", ParseIntPipe) id: number) {
    return this.svc.getSshPoolHealth(id);
  }

  @Get(":id/stats") getStats(@Param("id", ParseIntPipe) id: number) {
    return this.svc.getServerStats(id);
  }

  @Get(":id/metrics") getMetrics(
    @Param("id", ParseIntPipe) id: number,
    @Query("range") range?: "1h" | "24h" | "7d",
  ) {
    return this.svc.getServerMetricsHistory(id, range);
  }

  @Post(":id/test-ping") testPing(@Param("id", ParseIntPipe) id: number) {
    return this.svc.testPing(id);
  }
}
