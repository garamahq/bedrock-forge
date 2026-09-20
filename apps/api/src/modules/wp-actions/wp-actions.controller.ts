import {
  Controller,
  Get,
  Post,
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
import { WpActionsService } from "./wp-actions.service";
import {
  WpFixActionDto,
  WpDebugModeDto,
  WpLogsQueryDto,
  WpMaintenanceModeDto,
} from "./dto/wp-actions.dto";
import { WpCliRunDto, WpSearchReplaceDto } from "./dto/wp-cli.dto";

@Controller("environments/:id/wp-actions")
@UseGuards(AuthGuard("jwt"), RolesGuard)
@Roles(ROLES.MANAGER)
export class WpActionsController {
  constructor(private readonly svc: WpActionsService) {}

  /** Execute an interactive/preset WP-CLI command remotely */
  @Post("cli")
  cli(@Param("id", ParseIntPipe) id: number, @Body() dto: WpCliRunDto) {
    return this.svc.runCli(id, dto);
  }

  /** Run a guided wp search-replace with dry-run support */
  @Post("search-replace")
  searchReplace(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: WpSearchReplaceDto,
  ) {
    return this.svc.runSearchReplace(id, dto);
  }

  /** 1-click snapshot of the database via wp db export */
  @Post("db-export")
  dbExport(@Param("id", ParseIntPipe) id: number) {
    return this.svc.exportDb(id);
  }

  /** Enqueue a WordPress quick-fix action (flush rewrite, clear cache, etc.) */
  @Post("fix")
  @HttpCode(HttpStatus.ACCEPTED)
  fix(@Param("id", ParseIntPipe) id: number, @Body() dto: WpFixActionDto) {
    return this.svc.enqueueFix(id, dto);
  }

  /** Synchronously check current WP_DEBUG status via SSH */
  @Get("debug-status")
  debugStatus(@Param("id", ParseIntPipe) id: number) {
    return this.svc.getDebugStatus(id);
  }

  /** Enqueue WP_DEBUG enable/disable (with optional auto-revert) */
  @Post("debug-mode")
  @HttpCode(HttpStatus.ACCEPTED)
  debugMode(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: WpDebugModeDto,
  ) {
    return this.svc.enqueueDebugMode(id, dto);
  }

  /** Synchronously check WordPress maintenance mode status via SSH */
  @Get("maintenance-status")
  maintenanceStatus(@Param("id", ParseIntPipe) id: number) {
    return this.svc.getMaintenanceStatus(id);
  }

  /** Enqueue maintenance mode enable/disable */
  @Post("maintenance-mode")
  @HttpCode(HttpStatus.ACCEPTED)
  maintenanceMode(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: WpMaintenanceModeDto,
  ) {
    return this.svc.enqueueMaintenanceMode(id, dto);
  }

  /** Synchronously fetch log file lines via SSH */
  @Get("logs")
  logs(@Param("id", ParseIntPipe) id: number, @Query() query: WpLogsQueryDto) {
    return this.svc.getLogs(id, query);
  }

  /** Synchronously list WP cron jobs via SSH */
  @Get("cron")
  cron(@Param("id", ParseIntPipe) id: number) {
    return this.svc.getCron(id);
  }

  /** Enqueue DB cleanup (with optional dry-run) */
  @Post("cleanup")
  @HttpCode(HttpStatus.ACCEPTED)
  cleanup(
    @Param("id", ParseIntPipe) id: number,
    @Body("dry_run") dryRun?: boolean,
  ) {
    return this.svc.enqueueCleanup(id, dryRun ?? false);
  }

  /** Enqueue a WP core version check (wp core version + wp core check-update) */
  @Post("core/check")
  @HttpCode(HttpStatus.ACCEPTED)
  coreCheck(@Param("id", ParseIntPipe) id: number) {
    return this.svc.enqueueCoreCheck(id);
  }

  /** Enqueue a WP core update (wp core update + wp core update-db) */
  @Post("core/update")
  @HttpCode(HttpStatus.ACCEPTED)
  coreUpdate(@Param("id", ParseIntPipe) id: number) {
    return this.svc.enqueueCoreUpdate(id);
  }
}
