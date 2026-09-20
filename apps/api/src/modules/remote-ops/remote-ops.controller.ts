import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import {
  CurrentUser,
  AuthenticatedUser,
} from "../../common/decorators/current-user.decorator";
import { ROLES } from "@bedrock-forge/shared";
import { RemoteOpsService } from "./remote-ops.service";
import {
  CompareEnvQueryDto,
  CreateEnvTemplateDto,
  CreateResourceNoteDto,
  ReadRemoteFileQueryDto,
  RemotePathQueryDto,
  TailRemoteFileQueryDto,
  TouchRemotePathDto,
  UpdateResourceNoteDto,
  WriteEnvFileDto,
  WriteRemoteFileDto,
} from "./dto/remote-ops.dto";

@Controller()
@UseGuards(AuthGuard("jwt"), RolesGuard)
@Roles(ROLES.MANAGER)
export class RemoteOpsController {
  constructor(private readonly svc: RemoteOpsService) {}

  @Get("environments/:id/env-file")
  getEnvFile(
    @Param("id", ParseIntPipe) id: number,
    @Query("reveal_key") revealKey?: string,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    return this.svc.readEnvFile(id, revealKey, user?.id);
  }

  @Put("environments/:id/env-file")
  updateEnvFile(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: WriteEnvFileDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.svc.writeEnvFile(id, dto, user?.id);
  }

  @Get("projects/:id/env-file/compare")
  compareEnvFiles(
    @Param("id", ParseIntPipe) id: number,
    @Query() query: CompareEnvQueryDto,
  ) {
    return this.svc.compareEnvFiles(id, query.left, query.right);
  }

  @Get("environments/:id/files")
  listFiles(
    @Param("id", ParseIntPipe) id: number,
    @Query() query: RemotePathQueryDto,
  ) {
    return this.svc.listFiles(id, query.path);
  }

  @Get("environments/:id/files/read")
  readFile(
    @Param("id", ParseIntPipe) id: number,
    @Query() query: ReadRemoteFileQueryDto,
  ) {
    return this.svc.readFile(id, query.path ?? ".", query.max_bytes);
  }

  @Get("environments/:id/files/download")
  downloadFile(
    @Param("id", ParseIntPipe) id: number,
    @Query() query: ReadRemoteFileQueryDto,
  ) {
    return this.svc.downloadFile(id, query.path ?? "");
  }

  @Get("environments/:id/files/tail")
  tailFile(
    @Param("id", ParseIntPipe) id: number,
    @Query() query: TailRemoteFileQueryDto,
  ) {
    return this.svc.tailFile(id, query.path ?? "", query.lines ?? 100);
  }

  @Post("environments/:id/uploads/archive")
  archiveUploads(@Param("id", ParseIntPipe) id: number) {
    return this.svc.archiveUploads(id);
  }

  @Put("environments/:id/files")
  writeFile(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: WriteRemoteFileDto,
  ) {
    return this.svc.writeFile(id, dto);
  }

  @Post("environments/:id/files/touch")
  touchPath(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: TouchRemotePathDto,
  ) {
    return this.svc.touchPath(id, dto);
  }

  @Get("resource-notes/:resourceType/:resourceId")
  getNotes(
    @Param("resourceType") resourceType: string,
    @Param("resourceId") resourceId: string,
  ) {
    return this.svc.getNotes(resourceType, resourceId);
  }

  @Post("resource-notes")
  createNote(
    @Body() dto: CreateResourceNoteDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.svc.createNote(dto, user?.id);
  }

  @Put("resource-notes/:id")
  updateNote(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateResourceNoteDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.svc.updateNote(id, dto, user?.id, user?.roles);
  }

  @Delete("resource-notes/:id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteNote(
    @Param("id", ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.svc.deleteNote(id, user?.id, user?.roles);
  }

  @Get("env-variable-templates")
  listEnvTemplates() {
    return this.svc.listEnvTemplates();
  }

  @Post("env-variable-templates")
  createEnvTemplate(@Body() dto: CreateEnvTemplateDto) {
    return this.svc.createEnvTemplate(dto);
  }

  @Delete("env-variable-templates/:id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteEnvTemplate(@Param("id", ParseIntPipe) id: number) {
    await this.svc.deleteEnvTemplate(id);
  }
}
