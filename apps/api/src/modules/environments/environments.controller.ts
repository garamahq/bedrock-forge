import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Param,
  Body,
  ParseIntPipe,
  UseGuards,
  HttpCode,
  HttpStatus,
  NotFoundException,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { ROLES } from "@bedrock-forge/shared";
import { EnvironmentsService } from "./environments.service";
import {
  CreateEnvironmentDto,
  UpdateEnvironmentDto,
  UpsertDbCredentialsDto,
  CreateEnvironmentFullDto,
} from "./dto/environment.dto";
import {
  DeployEnvironmentDto,
  UpdateEnvironmentGitDto,
} from "./dto/git-deploy.dto";
import { InstallSecureGuardDto } from "./dto/secure-guard.dto";
import { ScanServerForEnvDto } from "./dto/scan-server-for-env.dto";
import { WpQuickLoginDto } from "./dto/wp-quick-login.dto";

@Controller("projects/:projectId/environments")
@UseGuards(AuthGuard("jwt"), RolesGuard)
@Roles(ROLES.MANAGER)
export class EnvironmentsController {
  constructor(private readonly svc: EnvironmentsService) {}

  @Get()
  findAll(@Param("projectId", ParseIntPipe) projectId: number) {
    return this.svc.findByProject(projectId);
  }

  /**
   * POST /projects/:projectId/environments/scan-server
   * SSH into the given server, discover WordPress sites, and return
   * which are already environments in this project vs. available to add.
   */
  @Post("scan-server")
  @Roles(ROLES.MANAGER)
  scanServer(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body() dto: ScanServerForEnvDto,
  ) {
    return this.svc.scanServerForNewEnv(projectId, dto.server_id);
  }

  @Get(":id")
  async findOne(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("id", ParseIntPipe) id: number,
  ) {
    await this.svc.assertBelongsToProject(id, projectId);
    return this.svc.findOne(id);
  }

  @Post()
  @Roles(ROLES.MANAGER)
  create(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body() dto: CreateEnvironmentDto,
  ) {
    return this.svc.create(projectId, dto);
  }

  @Post("clone")
  @Roles(ROLES.MANAGER)
  clone(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body() dto: CreateEnvironmentFullDto,
  ) {
    return this.svc.createFull(projectId, dto);
  }

  @Put(":id")
  @Roles(ROLES.MANAGER)
  async update(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateEnvironmentDto,
  ) {
    await this.svc.assertBelongsToProject(id, projectId);
    return this.svc.update(id, dto);
  }

  @Delete(":id")
  @Roles(ROLES.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("id", ParseIntPipe) id: number,
  ) {
    await this.svc.assertBelongsToProject(id, projectId);
    return this.svc.remove(id);
  }

  @Get(":id/db-credentials")
  async getDbCredentials(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("id", ParseIntPipe) id: number,
  ) {
    await this.svc.assertBelongsToProject(id, projectId);
    const creds = await this.svc.getDbCredentials(id);
    if (!creds)
      throw new NotFoundException(
        `No DB credentials stored for environment ${id}`,
      );
    return creds;
  }

  @Put(":id/db-credentials")
  @Roles(ROLES.MANAGER)
  async upsertDbCredentials(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpsertDbCredentialsDto,
  ) {
    await this.svc.assertBelongsToProject(id, projectId);
    return this.svc.upsertDbCredentials(id, dto);
  }

  @Get(":id/db-tables")
  async listDbTables(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("id", ParseIntPipe) id: number,
  ) {
    await this.svc.assertBelongsToProject(id, projectId);
    return this.svc.listDbTables(id);
  }

  @Get(":id/wp-users")
  async getWpUsers(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("id", ParseIntPipe) id: number,
  ) {
    await this.svc.assertBelongsToProject(id, projectId);
    return this.svc.getWpUsers(id);
  }

  @Post(":id/wp-quick-login")
  @Roles(ROLES.MANAGER)
  async createWpQuickLogin(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: WpQuickLoginDto,
  ) {
    await this.svc.assertBelongsToProject(id, projectId);
    return this.svc.createWpQuickLogin(id, dto);
  }

  @Post(":id/deploy")
  @Roles(ROLES.MANAGER)
  async deploy(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: DeployEnvironmentDto,
  ) {
    await this.svc.assertBelongsToProject(id, projectId);
    return this.svc.deployGit(id, dto);
  }

  @Patch(":id/git")
  @Roles(ROLES.MANAGER)
  async updateGitSettings(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateEnvironmentGitDto,
  ) {
    await this.svc.assertBelongsToProject(id, projectId);
    return this.svc.updateGitSettings(id, dto);
  }

  @Post(":id/git/webhook-token")
  @Roles(ROLES.MANAGER)
  async generateDeployWebhookToken(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("id", ParseIntPipe) id: number,
  ) {
    await this.svc.assertBelongsToProject(id, projectId);
    return this.svc.generateDeployWebhookToken(id);
  }

  @Get(":id/git/deploy-key")
  @Roles(ROLES.MANAGER)
  async getDeployKey(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("id", ParseIntPipe) id: number,
  ) {
    await this.svc.assertBelongsToProject(id, projectId);
    return this.svc.getServerDeployKey(id);
  }

  @Post(":id/secure-guard/install")
  @Roles(ROLES.MANAGER)
  async installSecureGuard(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: InstallSecureGuardDto,
  ) {
    await this.svc.assertBelongsToProject(id, projectId);
    return this.svc.installSecureGuard(id, dto);
  }

  @Post(":id/secure-guard/watchdog")
  @Roles(ROLES.MANAGER)
  async deploySecureGuardWatchdog(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("id", ParseIntPipe) id: number,
  ) {
    await this.svc.assertBelongsToProject(id, projectId);
    return this.svc.deploySecureGuardWatchdog(id);
  }
}
