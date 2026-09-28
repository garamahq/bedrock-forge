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
import { PaginationQueryDto } from "../../common/dto/pagination-query.dto";
import { ProjectsService } from "./projects.service";
import type { PaginatedProjects } from "./projects.repository";
import {
  CreateProjectDto,
  UpdateProjectDto,
  QueryProjectsDto,
  ArchiveProjectDto,
  RestoreProjectArchiveDto,
} from "./dto/project.dto";
import { ImportProjectDto } from "./dto/import-project.dto";
import { BulkImportProjectsDto } from "./dto/bulk-import-projects.dto";
import { CreateProjectFullDto } from "./dto/create-project-full.dto";

@Controller("projects")
@UseGuards(AuthGuard("jwt"), RolesGuard)
@Roles(ROLES.MANAGER)
export class ProjectsController {
  constructor(private readonly svc: ProjectsService) {}

  @Get() findAll(@Query() q: QueryProjectsDto): Promise<PaginatedProjects> {
    return this.svc.findAll(q);
  }
  @Get(":id/history") getHistory(
    @Param("id", ParseIntPipe) id: number,
    @Query() query: PaginationQueryDto,
  ) {
    return this.svc.getHistory(id, query.page, query.limit, query.search);
  }
  @Get(":id") findOne(@Param("id", ParseIntPipe) id: number) {
    return this.svc.findOne(id);
  }
  @Post() create(@Body() dto: CreateProjectDto) {
    return this.svc.create(dto);
  }
  @Put(":id") update(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateProjectDto,
  ) {
    return this.svc.update(id, dto);
  }
  @Delete(":id") @Roles(ROLES.ADMIN) @HttpCode(HttpStatus.NO_CONTENT) remove(
    @Param("id", ParseIntPipe) id: number,
  ) {
    return this.svc.remove(id);
  }
  @Post("import") @HttpCode(HttpStatus.CREATED) importFromServer(
    @Body() dto: ImportProjectDto,
  ) {
    return this.svc.importFromServer(dto);
  }
  @Post("import-bulk") @HttpCode(HttpStatus.CREATED) importBulk(
    @Body() dto: BulkImportProjectsDto,
  ) {
    return this.svc.importBulk(dto);
  }

  /** Provision a full Bedrock project via CyberPanel + SSH */
  @Post("create-full")
  @HttpCode(HttpStatus.ACCEPTED)
  createFull(@Body() dto: CreateProjectFullDto) {
    return this.svc.createFull(dto);
  }

  @Post(":id/archive")
  @HttpCode(HttpStatus.ACCEPTED)
  archive(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: ArchiveProjectDto,
  ) {
    return this.svc.archive(id, dto);
  }

  @Post(":id/restore-archive")
  @HttpCode(HttpStatus.ACCEPTED)
  restoreArchive(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: RestoreProjectArchiveDto,
  ) {
    return this.svc.restoreArchive(id, dto);
  }
}
