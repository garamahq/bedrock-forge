import { Throttle } from "@nestjs/throttler";
import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  ParseIntPipe,
  Req,
  Res,
  NotFoundException,
  BadRequestException,
  Logger,
} from "@nestjs/common";
import { Request, Response } from "express";
import { ConfigService } from "@nestjs/config";
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
import { SystemBackupsService } from "./system-backups.service";
import { SystemBackupScheduleService } from "./system-backup-schedule.service";
import { UpsertSystemBackupScheduleDto } from "./system-backup-schedule.dto";
import { GdriveSettingsService } from "../settings/services/gdrive-settings.service";
import { streamRcloneDownloadToResponse } from "../../common/utils/rclone-download.util";

@Controller("system-backups")
@UseGuards(DownloadOrJwtAuthGuard, RolesGuard)
@Roles(ROLES.ADMIN)
export class SystemBackupsController {
  private readonly logger = new Logger(SystemBackupsController.name);

  constructor(
    private readonly svc: SystemBackupsService,
    private readonly scheduleSvc: SystemBackupScheduleService,
    private readonly config: ConfigService,
    private readonly gdrive: GdriveSettingsService,
    private readonly tickets?: DownloadTicketService,
  ) {}

  /** List all Forge system backups, newest first. */
  @Get()
  list(@Query() q: PaginationQueryDto) {
    return this.svc.list(q.page ?? 1, q.limit ?? 20);
  }

  // ── Schedule routes (must precede :id to avoid parameter capture) ────────

  /** Get the current system backup schedule (or null). */
  @Get("schedule")
  getSchedule() {
    return this.scheduleSvc.findSchedule();
  }

  /** Create or update the system backup schedule. */
  @Put("schedule")
  upsertSchedule(@Body() dto: UpsertSystemBackupScheduleDto) {
    return this.scheduleSvc.upsert(dto);
  }

  /** Delete the system backup schedule and remove the repeatable job. */
  @Delete("schedule")
  @HttpCode(HttpStatus.NO_CONTENT)
  removeSchedule() {
    return this.scheduleSvc.remove();
  }

  /** Get a single system backup by ID. */
  @Get(":id")
  findOne(@Param("id", ParseIntPipe) id: number) {
    return this.svc.findOne(id);
  }

  /** Issue an opaque single-use download ticket for system backup archive streaming. */
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
      throw new NotFoundException(
        "System backup file is not available for download.",
      );
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
      kind: "system-backup",
      resourceId: Number(backup.id),
      userId: user.id,
      roles: user.roles,
    });
    return { ticket };
  }

  /** Stream a completed system backup file from Google Drive via rclone cat. */
  @Get(":id/download")
  @AllowDownloadTicket("system-backup")
  async download(
    @Param("id", ParseIntPipe) id: number,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const backup = await this.svc.findOne(id);

    if (backup.status !== "completed" || !backup.file_path) {
      throw new NotFoundException(
        "System backup file is not available for download.",
      );
    }

    if (!backup.file_path.startsWith("gdrive:")) {
      throw new NotFoundException(
        "Only Google Drive backups are supported for download.",
      );
    }

    try {
      parseGdriveFilePath(backup.file_path);
    } catch {
      throw new NotFoundException("Invalid system backup file_path format.");
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

  /** Trigger a manual Forge DB backup to Google Drive. */
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { ttl: 300_000, limit: 3 } })
  create() {
    return this.svc.enqueueCreate();
  }
}
