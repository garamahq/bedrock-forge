import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  Query,
  ParseIntPipe,
  UseGuards,
  HttpCode,
  HttpStatus,
  NotFoundException,
  BadRequestException,
  Req,
  Res,
  Logger,
} from "@nestjs/common";
import { Request, Response } from "express";
import { Throttle } from "@nestjs/throttler";
import { RolesGuard } from "../../common/guards/roles.guard";
import {
  AllowDownloadTicket,
  DownloadOrJwtAuthGuard,
} from "../../common/guards/download-auth.guard";
import { DownloadTicketService } from "../../common/auth/download-ticket.service";
import {
  CurrentUser,
  AuthenticatedUser,
} from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { ROLES, parseGdriveFilePath } from "@bedrock-forge/shared";
import { PaginationQueryDto } from "../../common/dto/pagination-query.dto";
import { BackupsService } from "./backups.service";
import { EnqueueBackupDto, RestoreBackupDto } from "./dto/backup.dto";
import { ConfigService } from "@nestjs/config";
import { GdriveSettingsService } from "../settings/services/gdrive-settings.service";
import { streamRcloneDownloadToResponse } from "../../common/utils/rclone-download.util";

@Controller("backups")
@UseGuards(DownloadOrJwtAuthGuard, RolesGuard)
@Roles(ROLES.MANAGER)
export class BackupsController {
  private readonly logger = new Logger(BackupsController.name);

  constructor(
    private readonly svc: BackupsService,
    private readonly config: ConfigService,
    private readonly gdrive: GdriveSettingsService,
    private readonly tickets?: DownloadTicketService,
  ) {}

  @Get("environment/:envId")
  findByEnv(
    @Param("envId", ParseIntPipe) envId: number,
    @Query() q: PaginationQueryDto,
  ) {
    return this.svc.findByEnvironment(envId, q);
  }

  /** Fetch a single JobExecution by ID for status/progress/error inspection. */
  @Get("execution/:id")
  findJobExecution(@Param("id", ParseIntPipe) id: number) {
    return this.svc.findJobExecution(id);
  }

  /** Fetch only the execution_log JSONB for a JobExecution — used by the UI expand panel. */
  @Get("execution/:id/log")
  findJobExecutionLog(@Param("id", ParseIntPipe) id: number) {
    return this.svc.findJobExecutionLog(id);
  }

  /** Cancel an actively running job execution. */
  @Post("execution/:id/cancel")
  @HttpCode(HttpStatus.OK)
  cancelJobExecution(@Param("id", ParseIntPipe) id: number) {
    return this.svc.cancelJobExecution(id);
  }

  /** Issue an opaque single-use download ticket so large browser downloads avoid JWTs in URLs. */
  @Post(":id/download-ticket")
  @HttpCode(HttpStatus.OK)
  async createDownloadTicket(
    @Param("id", ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (!this.tickets) {
      throw new BadRequestException("Download tickets are not configured.");
    }
    const backup = await this.svc.findOne(id);
    if (backup.status !== "completed" || !backup.file_path) {
      throw new NotFoundException("Backup file is not available for download.");
    }
    try {
      parseGdriveFilePath(backup.file_path);
    } catch {
      throw new NotFoundException(
        "Only Google Drive backups are supported for download.",
      );
    }
    await this.gdrive.ensureRcloneConfig();
    const ticket = await this.tickets.issueTicket({
      kind: "backup",
      resourceId: Number(backup.id),
      userId: user.id,
      roles: user.roles,
    });
    return { ticket };
  }

  /**
   * Stream a completed backup file to the client.
   * Accepts either an `Authorization: Bearer` JWT or a single-use opaque `?ticket=`.
   * Provisions `rclone.conf` from PostgreSQL on demand before spawning `rclone cat`.
   */
  @Get(":id/download")
  @AllowDownloadTicket("backup")
  async download(
    @Param("id", ParseIntPipe) id: number,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const backup = await this.svc.findOne(id);

    if (backup.status !== "completed" || !backup.file_path) {
      throw new NotFoundException("Backup file is not available for download.");
    }

    if (!backup.file_path.startsWith("gdrive:")) {
      throw new NotFoundException(
        "Only Google Drive backups are supported for download.",
      );
    }

    try {
      parseGdriveFilePath(backup.file_path);
    } catch {
      throw new NotFoundException("Invalid backup file_path format.");
    }

    await streamRcloneDownloadToResponse({
      req,
      res,
      filePath: backup.file_path,
      sizeBytes: backup.size_bytes,
      ensureConfig: () => this.gdrive.ensureRcloneConfig(),
      syncRefreshedConfig: (snapshot) =>
        this.gdrive.syncRefreshedRcloneConfig(snapshot),
      logger: this.logger,
    });
  }

  @Post("create")
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  enqueueCreate(@Body() dto: EnqueueBackupDto) {
    return this.svc.enqueueCreate(dto);
  }

  @Post("restore")
  @Throttle({ default: { ttl: 60_000, limit: 3 } })
  enqueueRestore(@Body() dto: RestoreBackupDto) {
    return this.svc.enqueueRestore(dto);
  }

  @Delete(":id")
  @Roles(ROLES.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param("id", ParseIntPipe) id: number) {
    return this.svc.remove(id);
  }
}
