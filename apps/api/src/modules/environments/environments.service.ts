import {
  BadRequestException,
  UnauthorizedException,
  Inject,
  InternalServerErrorException,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from "@nestjs/common";
import { EnvironmentsRepository } from "./environments.repository";
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
import { WpQuickLoginDto } from "./dto/wp-quick-login.dto";
import { ServersService } from "../servers/servers.service";
import {
  createRemoteExecutor,
  credentialParser,
  type RemoteExecutorService,
} from "@bedrock-forge/remote-executor";
import { MonitorsService } from "../monitors/monitors.service";
import { DomainsService } from "../domains/domains.service";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { QUEUES, JOB_TYPES, DEFAULT_JOB_OPTIONS } from "@bedrock-forge/shared";
import { BackupSchedulesService } from "../backups/backup-schedules.service";
import { PluginUpdateSchedulesService } from "../plugin-update-schedules/plugin-update-schedules.service";
import { randomBytes, createHmac, timingSafeEqual } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";

export interface DeployWebhookOptions {
  token?: string;
  signature?: string;
  event?: string;
  body?: Record<string, unknown>;
}

export interface WpUser {
  id: number;
  user_login: string;
  user_email: string;
  display_name: string;
  user_registered: string;
  roles: string[];
}

@Injectable()
export class EnvironmentsService {
  private readonly logger = new Logger(EnvironmentsService.name);

  constructor(
    private readonly repo: EnvironmentsRepository,
    private readonly serversService: ServersService,
    private readonly monitorsService: MonitorsService,
    private readonly domainsService: DomainsService,
    @Inject(forwardRef(() => BackupSchedulesService))
    private readonly backupSchedulesService: BackupSchedulesService,
    @Inject(forwardRef(() => PluginUpdateSchedulesService))
    private readonly pluginUpdateSchedulesService: PluginUpdateSchedulesService,
    @InjectQueue(QUEUES.PROJECTS) private readonly projectsQueue: Queue,
    @InjectQueue(QUEUES.SECURITY) private readonly securityQueue: Queue,
  ) {}

  existsById(id: bigint): Promise<boolean> {
    return this.repo.existsById(id);
  }

  existsByIdForUser(
    id: bigint,
    userId: bigint,
    roles: string[],
  ): Promise<boolean> {
    return this.repo.existsByIdForUser(id, userId, roles);
  }

  findAll() {
    return this.repo.findAll();
  }

  findByProject(projectId: number) {
    return this.repo.findByProject(BigInt(projectId));
  }

  async findOne(id: number) {
    const env = await this.repo.findById(BigInt(id));
    if (!env) throw new NotFoundException(`Environment ${id} not found`);
    return env;
  }

  async assertBelongsToProject(
    envId: number,
    projectId: number,
  ): Promise<void> {
    const env = await this.repo.findById(BigInt(envId));
    if (!env || env.project_id !== BigInt(projectId))
      throw new NotFoundException(`Environment ${envId} not found`);
  }

  async create(projectId: number, dto: CreateEnvironmentDto) {
    const project = await this.repo.findProjectWithHostingPackage(BigInt(projectId));
    if (project && project.hosting_package) {
      const maxSites = project.hosting_package.max_sites;
      const currentEnvsCount = await this.repo.countEnvironmentsForProject(BigInt(projectId));
      if (currentEnvsCount >= maxSites) {
        throw new BadRequestException(
          `Environment quota reached. Your hosting package allows a maximum of ${maxSites} sites/environments for this project.`,
        );
      }
    }

    const env = await this.repo.create(BigInt(projectId), dto);
    // Store DB credentials extracted during server scan (if provided)
    if (dto.db_credentials) {
      try {
        await this.repo.upsertDbCredentials(env.id, dto.db_credentials);
      } catch (err) {
        this.logger.warn(
          `Failed to store DB credentials for env ${env.id}: ${err}`,
        );
      }
    }
    // Auto-create a monitor for the new environment
    try {
      await this.monitorsService.create({
        environment_id: Number(env.id),
        interval_seconds: 600,
        enabled: true,
      });
    } catch (err) {
      this.logger.warn(
        `Failed to auto-create monitor for env ${env.id}: ${err}`,
      );
    }
    // Auto-create a domain record from the registrable root domain
    try {
      const hostname = new URL(dto.url).hostname;
      const domain = this.extractRegistrableDomain(hostname);
      await this.domainsService.findOrCreate(domain);
    } catch (err) {
      this.logger.warn(
        `Failed to auto-create domain for env ${env.id}: ${err}`,
      );
    }
    return env;
  }

  async createFull(projectId: number, dto: CreateEnvironmentFullDto) {
    const project = await this.repo.findProjectWithHostingPackage(BigInt(projectId));
    if (project && project.hosting_package) {
      const maxSites = project.hosting_package.max_sites;
      const currentEnvsCount = await this.repo.countEnvironmentsForProject(BigInt(projectId));
      if (currentEnvsCount >= maxSites) {
        throw new BadRequestException(
          `Environment quota reached. Your hosting package allows a maximum of ${maxSites} sites/environments for this project.`,
        );
      }
    }

    const { server_id, domain, admin_email } = dto;
    const phpVersion = dto.php_version ?? "8.3";
    const envType = dto.env_type ?? "production";
    const rootPath = `/home/${domain}/public_html`;
    const siteUrl = `https://${domain}`;

    // Use user-provided DB credentials, or auto-generate random ones
    const dbSuffix = randomBytes(4).toString("hex");
    const dbName = dto.db_name?.trim() || `wp_${dbSuffix}`;
    const dbUser = dto.db_user?.trim() || `u_${dbSuffix}`;
    const dbPassword =
      dto.db_password?.trim() || randomBytes(16).toString("base64url");
    const dbHost = dto.db_host?.trim() || "localhost";

    // 1. Create the Environment in the database (Prisma)
    const env = await this.repo.createEnvironment({
      project_id: BigInt(projectId),
      server_id: BigInt(server_id),
      type: envType,
      url: siteUrl,
      root_path: rootPath,
    });

    // 2. Create the Job Execution record
    const jobExecution = await this.repo.createJobExecution({
      queue_name: QUEUES.PROJECTS,
      bull_job_id: "0",
      job_type: JOB_TYPES.PROJECT_CREATE_BEDROCK,
      environment_id: env.id,
      server_id: BigInt(server_id),
      status: "queued",
      payload: {
        environmentId: Number(env.id),
        cyberpanel: {
          domain,
          dbName,
          dbUser,
          dbPassword,
          dbHost,
          phpVersion,
          adminEmail: admin_email,
        },
        sourceEnvironmentId: dto.source_environment_id,
      },
    });

    // 3. Enqueue the provisioning job
    const job = await this.projectsQueue.add(
      JOB_TYPES.PROJECT_CREATE_BEDROCK,
      {
        environmentId: Number(env.id),
        jobExecutionId: Number(jobExecution.id),
        cyberpanel: {
          domain,
          dbName,
          dbUser,
          dbPassword,
          dbHost,
          phpVersion,
          adminEmail: admin_email,
        },
        sourceEnvironmentId: dto.source_environment_id,
      },
      { ...DEFAULT_JOB_OPTIONS, attempts: 1 },
    );

    // 4. Back-fill the bull_job_id
    await this.repo.updateJobExecution(jobExecution.id, {
      bull_job_id: String(job.id),
    });

    return {
      environment: { id: Number(env.id), url: siteUrl },
      jobExecutionId: Number(jobExecution.id),
      jobId: String(job.id),
    };
  }

  async update(id: number, dto: UpdateEnvironmentDto) {
    await this.findOne(id);
    return this.repo.update(BigInt(id), dto);
  }

  async remove(id: number) {
    const env = await this.findOne(id);

    // 1. Fetch schedules to delete/disable them cleanly
    const { backupSchedules, pluginUpdateSchedules, monitors } =
      await this.repo.getSchedulesForEnvironment(BigInt(id));

    // 2. Disable/clear monitor and cron schedules
    await this.repo.disableEnvironmentSchedules(BigInt(id));

    // 3. Unregister repeatable jobs from BullMQ
    for (const monitor of monitors) {
      await this.monitorsService.unregisterRepeatable(monitor);
    }
    for (const bs of backupSchedules) {
      await this.backupSchedulesService.removeRepeatableJob(Number(bs.id));
    }
    for (const pus of pluginUpdateSchedules) {
      await this.pluginUpdateSchedulesService.removeRepeatableJob(Number(pus.id));
    }

    // 4. Create job execution for decommissioning tracking
    const jobExecution = await this.repo.createJobExecution({
      queue_name: QUEUES.PROJECTS,
      bull_job_id: "0",
      job_type: JOB_TYPES.ENVIRONMENT_DECOMMISSION,
      environment_id: BigInt(id),
      server_id: env.server_id,
      status: "queued",
      payload: {
        environmentId: id,
        deleteFromCyberpanel: true,
      },
    });

    // 5. Enqueue the BullMQ decommissioning job
    const job = await this.projectsQueue.add(
      JOB_TYPES.ENVIRONMENT_DECOMMISSION,
      {
        environmentId: id,
        jobExecutionId: Number(jobExecution.id),
        deleteFromCyberpanel: true,
      },
      DEFAULT_JOB_OPTIONS,
    );

    // Update job execution with bull job id
    await this.repo.updateJobExecution(jobExecution.id, {
      bull_job_id: String(job.id),
    });

    return {
      environmentId: id,
      jobExecutionId: Number(jobExecution.id),
      jobId: String(job.id),
      message: "Environment decommissioning job queued. The environment will be fully deleted once remote server resources are cleaned up.",
    };
  }

  async getDbCredentials(id: number) {
    await this.findOne(id);
    return this.repo.getDbCredentials(BigInt(id));
  }

  async upsertDbCredentials(id: number, dto: UpsertDbCredentialsDto) {
    await this.findOne(id);
    return this.repo.upsertDbCredentials(BigInt(id), dto);
  }

  /**
   * Scan a server for WordPress installations and return discovered sites,
   * marking which ones are already environments in this specific project.
   * Used by the Add Environment wizard.
   */
  async scanServerForNewEnv(projectId: number, serverId: number) {
    // Run the full server scan (SSH-based WP discovery)
    const scanned = await this.serversService.scanProjects(serverId);

    // Build a set of root_paths already used in THIS project
    const projectEnvs = await this.repo.findByProject(BigInt(projectId));
    const projectPaths = new Set(projectEnvs.map((e) => e.root_path));

    // Annotate each result with a project-specific flag and filter to this server
    return scanned
      .filter((site) => site.serverId === serverId)
      .map((site) => ({
        ...site,
        alreadyInThisProject: projectPaths.has(site.path),
      }));
  }

  /**
   * SSH into the environment's server and return a sorted list of all MySQL
   * table names in the WP database.  Uses stored DB credentials if available,
   * otherwise falls back to parsing .env / config/application.php on the server.
   */
  async listDbTables(envId: number): Promise<string[]> {
    const env = await this.findOne(envId);

    // Resolve SSH config for the server
    const sshConfig = await this.serversService.getServerSshConfig(
      Number(env.server_id),
    );
    const executor = createRemoteExecutor(sshConfig);

    // 1. Try stored encrypted credentials
    let creds = await this.repo.getDbCredentials(BigInt(envId));

    // 2. Fallback: parse .env from root_path
    if (!creds) {
      const rootPath = env.root_path.replace(/\/$/, "");
      const envRes = await executor
        .execute(`cat "${rootPath}/.env" 2>/dev/null || true`)
        .catch(() => null);
      if (envRes?.code === 0 && envRes.stdout.trim()) {
        const parsed = credentialParser.parseEnvFile(envRes.stdout);
        if (parsed) creds = parsed;
      }
    }

    // 3. Fallback: parse config/application.php
    if (!creds) {
      const rootPath = env.root_path.replace(/\/$/, "");
      const appRes = await executor
        .execute(`cat "${rootPath}/config/application.php" 2>/dev/null || true`)
        .catch(() => null);
      if (appRes?.code === 0 && appRes.stdout.trim()) {
        const parsed = credentialParser.parse(appRes.stdout);
        if (parsed) creds = parsed;
      }
    }

    if (!creds) {
      throw new BadRequestException(
        `No DB credentials found for environment ${envId}. ` +
          "Add credentials on the environment settings first.",
      );
    }

    // Write creds to a temp .my.cnf via base64 (safe: no shell-special chars)
    const cnfContent = `[client]\nhost=${creds.dbHost}\nuser=${creds.dbUser}\npassword=${creds.dbPassword}\n`;
    const cnfB64 = Buffer.from(cnfContent).toString("base64");
    const tmpDir = `/tmp/bf-dbt-${Date.now()}`;
    const cnfPath = `${tmpDir}/.my.cnf`;

    try {
      await executor.execute(`mkdir -p "${tmpDir}" && chmod 700 "${tmpDir}"`);
      await executor.execute(
        `echo '${cnfB64}' | base64 -d > "${cnfPath}" && chmod 600 "${cnfPath}"`,
      );

      const result = await executor.execute(
        `mysql --defaults-extra-file="${cnfPath}" "${creds.dbName}" -e "SHOW TABLES" 2>&1`,
      );

      if (result.code !== 0) {
        throw new InternalServerErrorException(
          `Failed to list tables: ${result.stdout.trim() || result.stderr?.trim() || "unknown error"}`,
        );
      }

      // First line is the header "Tables_in_<db>" — skip it
      const tables = result.stdout
        .split("\n")
        .slice(1)
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .sort();

      return tables;
    } finally {
      await executor.execute(`rm -rf "${tmpDir}"`).catch(() => {});
    }
  }

  /**
   * SSH into the environment's server, deploy a PHP user-scanner script,
   * and return all WordPress users with their roles.
   *
   * Credential resolution mirrors listDbTables — TypeScript credentialParser
   * handles all real-world .env formats before falling back to PHP-side search.
   */
  async getWpUsers(envId: number): Promise<WpUser[]> {
    const env = await this.findOne(envId);
    const sshConfig = await this.serversService.getServerSshConfig(
      Number(env.server_id),
    );
    const executor = createRemoteExecutor(sshConfig);

    const scriptsPath = join(__dirname, "../../../../worker/scripts");
    const ts = Date.now();
    const remoteScript = `/tmp/bf-wp-users-${ts}.php`;
    let remoteCredsFile = "";

    try {
      // ── Step 1: resolve DB credentials in TypeScript ─────────────────
      let creds = await this.repo.getDbCredentials(BigInt(envId));

      if (!creds && env.root_path) {
        const rootPath = env.root_path.replace(/\/$/, "");
        const envRes = await executor
          .execute(`cat "${rootPath}/.env" 2>/dev/null || true`)
          .catch(() => null);
        if (envRes?.code === 0 && envRes.stdout.trim()) {
          creds = credentialParser.parseEnvFile(envRes.stdout);
        }
      }

      if (!creds && env.root_path) {
        const rootPath = env.root_path.replace(/\/$/, "");
        const appRes = await executor
          .execute(
            `cat "${rootPath}/config/application.php" 2>/dev/null || true`,
          )
          .catch(() => null);
        if (appRes?.code === 0 && appRes.stdout.trim()) {
          creds = credentialParser.parse(appRes.stdout);
        }
      }

      // ── Step 2: push PHP script ───────────────────────────────────────
      const scriptContent = readFileSync(join(scriptsPath, "wp-users.php"));
      await executor.pushFile({
        remotePath: remoteScript,
        content: scriptContent,
      });

      // ── Step 3: build command ─────────────────────────────────────────
      const phpBinary = await detectRemotePhpBinary(
        executor,
        env.root_path ?? "",
      );
      const phpCmdPrefix = phpBinary === "php" ? "php" : shellEscape(phpBinary);
      let phpCmd: string;
      if (creds) {
        // Write creds to a temp file (600) so the password is never
        // exposed in the process list via CLI args.
        remoteCredsFile = `/tmp/bf-wp-creds-${ts}.json`;
        const credsJson = JSON.stringify({
          dbHost: creds.dbHost,
          dbUser: creds.dbUser,
          dbPassword: creds.dbPassword,
          dbName: creds.dbName,
        });
        const credsB64 = Buffer.from(credsJson).toString("base64");
        await executor.execute(
          `echo ${shellEscape(credsB64)} | base64 -d > ${shellEscape(remoteCredsFile)} && chmod 600 ${shellEscape(remoteCredsFile)}`,
        );
        phpCmd = `${phpCmdPrefix} ${shellEscape(remoteScript)} --creds-file=${shellEscape(remoteCredsFile)}${env.root_path ? ` --docroot=${shellEscape(env.root_path)}` : ""}`;
      } else {
        // Credentials not pre-resolved — let the PHP script search for
        // .env / wp-config.php on the remote filesystem as a last resort.
        phpCmd = `${phpCmdPrefix} ${shellEscape(remoteScript)} --docroot=${shellEscape(env.root_path ?? "")}`;
      }

      const result = await executor.execute(phpCmd, { timeout: 30_000 });

      if (result.code !== 0) {
        throw new InternalServerErrorException(
          `wp-users scan failed: ${result.stderr?.trim() || result.stdout.trim() || "unknown error"}`,
        );
      }

      let parsed: { users?: WpUser[]; error?: string };
      try {
        parsed = JSON.parse(result.stdout.trim()) as {
          users?: WpUser[];
          error?: string;
        };
      } catch (err) {
        throw new InternalServerErrorException(
          `wp-users returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (parsed.error) {
        this.logger.warn(
          `[getWpUsers] Environment ${envId} scan error: ${parsed.error}`,
        );
        if (!parsed.users || parsed.users.length === 0) {
          throw new BadRequestException(`WordPress scan error: ${parsed.error}`);
        }
        return parsed.users;
      }
      return parsed.users ?? [];
    } catch (err) {
      if (
        err instanceof BadRequestException ||
        err instanceof InternalServerErrorException
      ) {
        throw err;
      }
      throw new InternalServerErrorException(
        `wp-users SSH check failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      await executor
        .execute(`rm -f ${shellEscape(remoteScript)}`)
        .catch(() => {});
      if (remoteCredsFile) {
        await executor
          .execute(`rm -f ${shellEscape(remoteCredsFile)}`)
          .catch(() => {});
      }
    }
  }

  /**
   * Deploy a self-deleting PHP quick-login file to the environment's web root.
   * Returns the one-time login URL and its expiry timestamp (10 min from now).
   */
  async createWpQuickLogin(
    envId: number,
    dto: WpQuickLoginDto,
  ): Promise<{ loginUrl: string; expiresAt: string }> {
    const env = await this.findOne(envId);
    const sshConfig = await this.serversService.getServerSshConfig(
      Number(env.server_id),
    );
    const executor = createRemoteExecutor(sshConfig);

    // Generate a cryptographically random token
    const fileToken = randomBytes(12).toString("hex"); // used in filename
    const queryToken = randomBytes(24).toString("hex"); // used in ?t= param
    const expiryTs = Math.floor(Date.now() / 1000) + 10 * 60; // 10 minutes
    const filename = `bf-login-${fileToken}.php`;

    /* Determine web root:
     *   Bedrock: root_path/web  (CyberPanel vhost root is public_html/web)
     *   Standard WP: root_path
     * Indicator: web/wp-config.php exists in Bedrock (same check as detectBedrock).
     * NOTE: wp-load.php lives at web/wp/wp-load.php in Bedrock, NOT web/wp-load.php.
     */
    const rootPath = env.root_path.replace(/\/$/, "");
    const bedrockCheckResult = await executor
      .execute(
        `test -f "${rootPath}/web/wp-config.php" && echo "bedrock" || echo "standard"`,
      )
      .catch(() => null);
    const isBedrock = bedrockCheckResult?.stdout?.trim() === "bedrock";
    const webRoot = isBedrock ? `${rootPath}/web` : rootPath;
    const remotePath = `${webRoot}/${filename}`;

    // Build the PHP file from the template
    const scriptsPath = join(__dirname, "../../../../worker/scripts");
    const template = readFileSync(
      join(scriptsPath, "wp-quick-login.php"),
      "utf-8",
    );
    const phpContent = template
      .replaceAll("{TOKEN}", queryToken)
      .replaceAll("{EXPIRY_TS}", String(expiryTs))
      .replaceAll("{USER_ID}", String(dto.userId));

    await executor.pushFile({ remotePath, content: Buffer.from(phpContent) });

    // 644: owner write, web server (www-data/nobody) needs read to serve the file.
    // Security comes from the unguessable filename + query token, not file perms.
    await executor.execute(`chmod 644 "${remotePath}"`).catch(() => {});

    const loginUrl = `${env.url.replace(/\/$/, "")}/${filename}?t=${queryToken}`;
    const expiresAt = new Date(expiryTs * 1000).toISOString();
    return { loginUrl, expiresAt };
  }

  /**
   * Extract the registrable root domain from a hostname.
   * e.g. blog.example.com → example.com
   */
  private extractRegistrableDomain(hostname: string): string {
    const MULTI_TLD = new Set([
      "co.uk",
      "com.au",
      "co.nz",
      "org.uk",
      "net.au",
      "co.za",
    ]);
    const parts = hostname.split(".");
    if (parts.length <= 2) return hostname;
    const twoLabel = parts.slice(-2).join(".");
    if (MULTI_TLD.has(twoLabel)) return parts.slice(-3).join(".");
    return twoLabel;
  }

  // ── PHP Info ──────────────────────────────────────────────────────────────

  async getPhpInfo(envId: number): Promise<Record<string, string>> {
    const env = await this.findOne(envId);
    const sshConfig = await this.serversService.getServerSshConfig(
      Number(env.server_id),
    );
    const executor = createRemoteExecutor(sshConfig);
    const cmd =
      `php -r "echo json_encode([` +
      `'memory_limit'=>ini_get('memory_limit'),` +
      `'max_execution_time'=>ini_get('max_execution_time'),` +
      `'upload_max_filesize'=>ini_get('upload_max_filesize'),` +
      `'post_max_size'=>ini_get('post_max_size'),` +
      `'display_errors'=>ini_get('display_errors'),` +
      `'php_version'=>PHP_VERSION]);" 2>/dev/null`;
    const result = await executor.execute(cmd, { timeout: 15_000 });
    if (result.code !== 0) {
      throw new InternalServerErrorException("PHP info fetch failed");
    }
    return JSON.parse(result.stdout.trim()) as Record<string, string>;
  }

  // ── Tags ──────────────────────────────────────────────────────────────────

  async addTag(envId: number, tagId: number) {
    await this.findOne(envId);
    return this.repo.addTag(BigInt(envId), BigInt(tagId));
  }

  async removeTag(envId: number, tagId: number) {
    await this.findOne(envId);
    return this.repo.removeTag(BigInt(envId), BigInt(tagId));
  }

  async listTags(envId: number) {
    await this.findOne(envId);
    return this.repo.listTags(BigInt(envId));
  }

  // ── Git & Deployment ──────────────────────────────────────────────────────

  async deployGit(id: number, dto: DeployEnvironmentDto) {
    const env = await this.repo.findById(BigInt(id));
    if (!env) throw new NotFoundException(`Environment ${id} not found`);

    const jobExecution = await this.repo.createJobExecution({
      queue_name: QUEUES.PROJECTS,
      bull_job_id: "0",
      job_type: JOB_TYPES.PROJECT_GIT_DEPLOY,
      environment_id: BigInt(id),
      server_id: env.server.id,
      status: "queued",
      payload: {
        environmentId: id,
        branch: dto.branch || env.git_branch || "main",
        commitSha: dto.commitSha,
        runComposer: dto.runComposer ?? true,
        updateDb: dto.updateDb ?? true,
        flushCache: dto.flushCache ?? true,
      },
    });

    const job = await this.projectsQueue.add(
      JOB_TYPES.PROJECT_GIT_DEPLOY,
      {
        environmentId: id,
        jobExecutionId: Number(jobExecution.id),
        branch: dto.branch || env.git_branch || "main",
        commitSha: dto.commitSha,
        runComposer: dto.runComposer ?? true,
        updateDb: dto.updateDb ?? true,
        flushCache: dto.flushCache ?? true,
      },
      DEFAULT_JOB_OPTIONS,
    );

    await this.repo.updateJobExecution(jobExecution.id, {
      bull_job_id: String(job.id),
    });

    return {
      environmentId: id,
      jobExecutionId: Number(jobExecution.id),
      jobId: String(job.id),
    };
  }

  async updateGitSettings(id: number, dto: UpdateEnvironmentGitDto) {
    await this.findOne(id);
    return this.repo.updateGitDeployment(BigInt(id), dto);
  }

  async generateDeployWebhookToken(id: number) {
    await this.findOne(id);
    const token = randomBytes(24).toString("hex");
    await this.repo.updateGitDeployment(BigInt(id), {
      deploy_webhook_token: token,
    });
    return { token };
  }

  async triggerDeployWebhook(
    id: number,
    opts: string | DeployWebhookOptions,
  ) {
    const env = await this.repo.findById(BigInt(id));
    if (!env) throw new NotFoundException(`Environment ${id} not found`);

    const options: DeployWebhookOptions =
      typeof opts === "string" ? { token: opts } : opts;

    if (!env.deploy_webhook_token) {
      throw new BadRequestException("Deploy webhook token is not configured on this environment");
    }

    // 1. Authenticate via token or HMAC SHA256 signature
    let authenticated = false;
    if (options.token && options.token === env.deploy_webhook_token) {
      authenticated = true;
    } else if (options.signature && options.body) {
      try {
        const expectedSig =
          "sha256=" +
          createHmac("sha256", env.deploy_webhook_token)
            .update(JSON.stringify(options.body))
            .digest("hex");
        if (
          expectedSig.length === options.signature.length &&
          timingSafeEqual(
            Buffer.from(expectedSig),
            Buffer.from(options.signature),
          )
        ) {
          authenticated = true;
        }
      } catch {
        authenticated = false;
      }
    }

    if (!authenticated) {
      throw new UnauthorizedException("Invalid deploy webhook token or signature");
    }

    // 2. Handle GitHub ping event
    if (options.event === "ping") {
      return {
        message: "pong",
        environmentId: id,
        branch: env.git_branch || "main",
        status: "ok",
      };
    }

    // 3. Branch filtering: verify pushed ref matches configured branch
    const configuredBranch = env.git_branch || "main";
    const ref =
      typeof options.body?.ref === "string" ? options.body.ref : undefined;
    if (ref && ref.startsWith("refs/heads/")) {
      const pushedBranch = ref.replace("refs/heads/", "");
      if (pushedBranch !== configuredBranch) {
        return {
          status: "skipped",
          reason: `Pushed branch "${pushedBranch}" does not match configured environment branch "${configuredBranch}"`,
          pushedBranch,
          configuredBranch,
        };
      }
    }

    // 4. Extract commit SHA if present
    const commitSha =
      typeof options.body?.after === "string" &&
      options.body.after !== "0000000000000000000000000000000000000000"
        ? options.body.after
        : undefined;

    return this.deployGit(id, {
      branch: configuredBranch,
      commitSha,
    });
  }

  async getServerDeployKey(
    id: number,
  ): Promise<{ publicKey: string; keyType: string; isGenerated: boolean }> {
    const env = await this.repo.findById(BigInt(id));
    if (!env) throw new NotFoundException(`Environment ${id} not found`);

    const executor = createRemoteExecutor(
      await this.serversService.getServerSshConfig(Number(env.server.id)),
    );

    // Check for existing public key (ed25519 first, then rsa)
    const checkRes = await executor.execute(
      "test -f ~/.ssh/id_ed25519.pub && cat ~/.ssh/id_ed25519.pub || (test -f ~/.ssh/id_rsa.pub && cat ~/.ssh/id_rsa.pub || echo 'none')",
    );
    const existing = checkRes.stdout.trim();

    if (existing && existing !== "none" && existing.startsWith("ssh-")) {
      const keyType = existing.split(" ")[0] || "ssh-ed25519";
      return { publicKey: existing, keyType, isGenerated: false };
    }

    // Generate new ed25519 key if none exists
    const genRes = await executor.execute(
      'mkdir -p ~/.ssh && chmod 700 ~/.ssh && ssh-keygen -t ed25519 -C "bedrock-forge-deploy" -N "" -f ~/.ssh/id_ed25519 && cat ~/.ssh/id_ed25519.pub',
    );
    const newKey = genRes.stdout.trim().split("\n").pop() || "";
    if (newKey && newKey.startsWith("ssh-")) {
      const keyType = newKey.split(" ")[0] || "ssh-ed25519";
      return { publicKey: newKey, keyType, isGenerated: true };
    }

    throw new BadRequestException("Failed to read or generate server SSH deploy key");
  }

  // ── Secure Guard ──────────────────────────────────────────────────────────

  async installSecureGuard(id: number, dto: InstallSecureGuardDto) {
    const env = await this.repo.findById(BigInt(id));
    if (!env) throw new NotFoundException(`Environment ${id} not found`);

    const jobExecution = await this.repo.createJobExecution({
      queue_name: QUEUES.SECURITY,
      bull_job_id: "0",
      job_type: JOB_TYPES.WP_SECURE_GUARD_INSTALL,
      environment_id: BigInt(id),
      server_id: env.server.id,
      status: "queued",
      payload: {
        environmentId: id,
        preset: dto.preset ?? "balanced",
        deployWatchdog: dto.deployWatchdog ?? true,
      },
    });

    const job = await this.securityQueue.add(
      JOB_TYPES.WP_SECURE_GUARD_INSTALL,
      {
        environmentId: id,
        jobExecutionId: Number(jobExecution.id),
        preset: dto.preset ?? "balanced",
        deployWatchdog: dto.deployWatchdog ?? true,
      },
      DEFAULT_JOB_OPTIONS,
    );

    await this.repo.updateJobExecution(jobExecution.id, {
      bull_job_id: String(job.id),
    });

    return {
      environmentId: id,
      jobExecutionId: Number(jobExecution.id),
      jobId: String(job.id),
    };
  }

  async deploySecureGuardWatchdog(id: number) {
    const env = await this.repo.findById(BigInt(id));
    if (!env) throw new NotFoundException(`Environment ${id} not found`);

    const jobExecution = await this.repo.createJobExecution({
      queue_name: QUEUES.SECURITY,
      bull_job_id: "0",
      job_type: JOB_TYPES.WP_SECURE_GUARD_WATCHDOG,
      environment_id: BigInt(id),
      server_id: env.server.id,
      status: "queued",
      payload: {
        environmentId: id,
        action: "deploy",
      },
    });

    const job = await this.securityQueue.add(
      JOB_TYPES.WP_SECURE_GUARD_WATCHDOG,
      {
        environmentId: id,
        jobExecutionId: Number(jobExecution.id),
        action: "deploy",
      },
      DEFAULT_JOB_OPTIONS,
    );

    await this.repo.updateJobExecution(jobExecution.id, {
      bull_job_id: String(job.id),
    });

    return {
      environmentId: id,
      jobExecutionId: Number(jobExecution.id),
      jobId: String(job.id),
    };
  }
}

function shellEscape(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

async function detectRemotePhpBinary(
  executor: Pick<RemoteExecutorService, "execute">,
  rootPath: string,
): Promise<string> {
  const root = rootPath.replace(/\/+$/, "");
  const domain = root.match(/\/home\/([^/]+)\/public_html(?:\/|$)/)?.[1];

  if (domain) {
    try {
      const vhostPath = `/usr/local/lsws/conf/vhosts/${domain}/vhost.conf`;
      const result = await executor.execute(
        `grep -oE '/usr/local/lsws/lsphp[0-9]+/bin/(ls)?php' ${shellEscape(vhostPath)} 2>/dev/null | head -1`,
      );
      const vhostPhp = result.stdout.trim();
      if (
        vhostPhp &&
        /^\/usr\/local\/lsws\/lsphp\d+\/bin\/(ls)?php$/.test(vhostPhp)
      ) {
        const cliPhp = vhostPhp.replace(/\/bin\/lsphp$/, "/bin/php");
        const check = await executor.execute(
          `[ -x ${shellEscape(cliPhp)} ] && echo yes || echo no`,
        );
        if (check.stdout.trim() === "yes") return cliPhp;
        const originalCheck = await executor.execute(
          `[ -x ${shellEscape(vhostPhp)} ] && echo yes || echo no`,
        );
        if (originalCheck.stdout.trim() === "yes") return vhostPhp;
      }
    } catch {
      // Fall back to probing installed OpenLiteSpeed PHP binaries.
    }
  }

  try {
    const result = await executor.execute(
      `ls /usr/local/lsws/lsphp*/bin/php 2>/dev/null | sort -V | tail -1`,
    );
    const bin = result.stdout.trim();
    if (bin && /^\/usr\/local\/lsws\/lsphp\d+\/bin\/php$/.test(bin)) {
      return bin;
    }
  } catch {
    // Fall back to PATH php below.
  }

  return "php";
}
