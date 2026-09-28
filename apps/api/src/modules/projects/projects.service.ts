import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { randomBytes } from "crypto";
import {
  QUEUES,
  JOB_TYPES,
  DEFAULT_JOB_OPTIONS,
  PaginationQuery,
} from "@bedrock-forge/shared";
import { ProjectsRepository } from "./projects.repository";
import { projectLinksJson } from "./dto/project.dto";
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
import { DomainsService } from "../domains/domains.service";
import { MonitorsService } from "../monitors/monitors.service";
import { BackupSchedulesService } from "../backups/backup-schedules.service";
import { PluginUpdateSchedulesService } from "../plugin-update-schedules/plugin-update-schedules.service";

const SECRET_ASSIGNMENT_RE =
  /\b[\w-]*(?:PASSWORD|PASSWD|PASSPHRASE|DB[_-]?PASS|SECRET|TOKEN|API[_-]?KEY|PRIVATE[_-]?KEY|CLIENT[_-]?SECRET|AUTHORIZATION)[\w-]*\b\s*["']?\s*[:=]\s*(?:"([^"]*)"|'([^']*)'|([^\s,;]+))/gi;
const PRIVATE_KEY_RE = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/i;
const CREDENTIAL_URL_RE =
  /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^@\s/]+@/i;
const BEARER_TOKEN_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i;
const JWT_TOKEN_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/;
const PLACEHOLDER_SECRET_RE =
  /^(?:your(?:[-_ ]|$)|placeholder\b|example\b|change[-_ ]?me\b|changeme\b|replace[-_ ]?me\b|redacted\b|x{4,}$|<[^>]+>|\$\{?[A-Z_][A-Z0-9_]*\}?$)/i;
const SENSITIVE_LINK_LABEL_RE =
  /(password|passwd|db[_ -]?(?:password|pass)|secret|token|api[_ -]?key|private[_ -]?key|credential|auth(?:orization)?)/i;

function containsSecretAssignment(value: string): boolean {
  SECRET_ASSIGNMENT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = SECRET_ASSIGNMENT_RE.exec(value)) !== null) {
    const assignedValue = match[1] ?? match[2] ?? match[3] ?? "";
    if (assignedValue && !PLACEHOLDER_SECRET_RE.test(assignedValue)) {
      return true;
    }
  }
  return false;
}

@Injectable()
export class ProjectsService {
  private readonly logger = new Logger(ProjectsService.name);

  constructor(
    private readonly repo: ProjectsRepository,
    @InjectQueue(QUEUES.PROJECTS) private readonly projectsQueue: Queue,
    private readonly domainsService: DomainsService,
    private readonly monitorsService: MonitorsService,
    private readonly backupSchedulesService: BackupSchedulesService,
    private readonly pluginUpdateSchedulesService: PluginUpdateSchedulesService,
  ) {}

  findAll(query: QueryProjectsDto) {
    return this.repo.findAllPaginated(query);
  }

  findOne(id: number) {
    return this.repo.findById(BigInt(id));
  }

  create(dto: CreateProjectDto) {
    this.assertProjectDetailsAreNotCredentials(dto.notes, dto.links);
    return this.repo.create({
      name: dto.name,
      client_id: BigInt(dto.client_id),
      ...(dto.hosting_package_id && {
        hosting_package_id: BigInt(dto.hosting_package_id),
      }),
      ...(dto.support_package_id && {
        support_package_id: BigInt(dto.support_package_id),
      }),
      ...(dto.status && { status: dto.status }),
      notes: dto.notes,
      links: projectLinksJson(dto.links),
      ...(dto.github_repo !== undefined && { github_repo: dto.github_repo }),
    });
  }

  async update(id: number, dto: UpdateProjectDto) {
    this.assertProjectDetailsAreNotCredentials(dto.notes, dto.links);
    await this.findOne(id);
    return this.repo.update(BigInt(id), {
      ...(dto.name !== undefined && { name: dto.name }),
      ...(dto.client_id !== undefined && {
        client_id: BigInt(dto.client_id),
      }),
      ...(dto.hosting_package_id !== undefined && {
        hosting_package_id: BigInt(dto.hosting_package_id),
      }),
      ...(dto.support_package_id !== undefined && {
        support_package_id: BigInt(dto.support_package_id),
      }),
      ...(dto.status !== undefined && { status: dto.status }),
      ...(dto.notes !== undefined && { notes: dto.notes }),
      ...(dto.links !== undefined && { links: projectLinksJson(dto.links) }),
      ...(dto.github_repo !== undefined && { github_repo: dto.github_repo }),
    });
  }

  async remove(id: number) {
    const project = await this.findOne(id);
    const envs = project.environments ?? [];
    if (envs.length > 0) {
      // 1. Update project status to archived/inactive to show it is decommissioned/deleting
      await this.repo.update(BigInt(id), { status: "archived" });

      // 2. Disable monitors and cron schedules for all environments in this project
      const envIds = envs.map((e) => e.id);
      const { backupSchedules, pluginUpdateSchedules, monitors } =
        await this.repo.getSchedulesForEnvironments(envIds);

      await this.repo.disableEnvironmentSchedules(envIds);

      // Unregister repeatable jobs from BullMQ
      for (const monitor of monitors) {
        await this.monitorsService.unregisterRepeatable(monitor);
      }
      for (const bs of backupSchedules) {
        await this.backupSchedulesService.removeRepeatableJob(Number(bs.id));
      }
      for (const pus of pluginUpdateSchedules) {
        await this.pluginUpdateSchedulesService.removeRepeatableJob(Number(pus.id));
      }

      // 3. Create job execution for tracking decommissioning
      const firstEnv = envs[0];
      const jobExecution = await this.repo.createJobExecution({
        queue_name: QUEUES.PROJECTS,
        bull_job_id: "0",
        job_type: JOB_TYPES.PROJECT_ARCHIVE,
        environment_id: firstEnv ? firstEnv.id : undefined,
        server_id: firstEnv ? firstEnv.server.id : undefined,
        status: "queued",
        payload: {
          projectId: id,
          createBackup: false,
          deleteFromCyberpanel: true,
          deleteProject: true,
        },
      });

      // 4. Enqueue the BullMQ job
      await this.projectsQueue.add(
        JOB_TYPES.PROJECT_ARCHIVE,
        {
          projectId: id,
          jobExecutionId: Number(jobExecution.id),
          createBackup: false,
          deleteFromCyberpanel: true,
          deleteProject: true,
        },
        DEFAULT_JOB_OPTIONS,
      );

      return { message: "Decommissioning job queued. The project will be fully deleted once remote server resources are cleaned up." };
    } else {
      return this.repo.remove(BigInt(id));
    }
  }

  /**
   * Create a project + environment from an existing server folder in one transaction.
   * Typically called after a successful detect-bedrock validation.
   */
  async importFromServer(dto: ImportProjectDto) {
    const { project, environment } = await this.repo.importFromServer({
      name: dto.name,
      client_id: BigInt(dto.client_id),
      environment: {
        server_id: BigInt(dto.server_id),
        type: dto.type ?? "production",
        url: dto.url,
        root_path: dto.root_path,
      },
    });
    await this.autoCreateDomainAndMonitor({
      projectId: Number(project.id),
      environmentId: Number(environment.id),
      url: dto.url,
    });
    return { project, environment };
  }

  /**
   * Bulk-import multiple projects discovered by the server scanner.
   * Each entry creates Project + Environment + WpDbCredentials in one transaction.
   * After the transaction, auto-creates a domain record (+ WHOIS job) and a monitor
   * for each imported environment.
   */
  async importBulk(dto: BulkImportProjectsDto) {
    const entries = dto.projects.map((p) => ({
      name: p.name,
      client_id: BigInt(p.client_id),
      server_id: BigInt(p.server_id),
      type: p.type ?? "production",
      url: p.url,
      root_path: p.root_path,
      dbCredentials: p.db_credentials,
      mainDomain: p.main_domain,
    }));
    const results = await this.repo.importBulk(entries);

    // After the DB transaction: create domains and monitors (non-blocking per item)
    for (let i = 0; i < results.length; i++) {
      const { project, environment } = results[i];
      const entry = entries[i];
      await this.autoCreateDomainAndMonitor({
        projectId: Number(project.id),
        environmentId: Number(environment.id),
        url: environment.url,
        mainDomain: entry.mainDomain,
      });
    }

    return results;
  }

  /**
   * Auto-create a monitor (10 min interval) and domain record(s) for a newly
   * created environment. All errors are swallowed — this is best-effort.
   */
  private async autoCreateDomainAndMonitor(opts: {
    projectId: number;
    environmentId: number;
    url: string;
    mainDomain?: string;
  }) {
    const { projectId, environmentId, url, mainDomain } = opts;

    // Monitor — 10-minute interval
    try {
      await this.monitorsService.create({
        environment_id: environmentId,
        interval_seconds: 600,
        enabled: true,
      });
    } catch (err) {
      this.logger.warn(
        `[import] Failed to create monitor for env ${environmentId}: ${err}`,
      );
    }

    // Domain: prefer the root/apex domain (mainDomain) over the full hostname.
    // If mainDomain is available and differs from the hostname, the hostname is
    // a subdomain — skip it and only track the apex domain to avoid clutter.
    try {
      const hostname = new URL(url).hostname;
      const domainToCreate =
        mainDomain ?? this.extractRegistrableDomain(hostname);
      if (domainToCreate) {
        await this.domainsService.findOrCreate(domainToCreate);
      }
    } catch (err) {
      this.logger.warn(
        `[import] Failed to create domain for env ${environmentId}: ${err}`,
      );
    }
  }

  /**
   * Extract the registrable root domain from a hostname.
   * e.g. blog.example.com → example.com, shop.example.co.uk → example.co.uk
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

  async createBedrock(environmentId: number, jobExecutionId: bigint) {
    return this.projectsQueue.add(
      JOB_TYPES.PROJECT_CREATE_BEDROCK,
      { environmentId, jobExecutionId: Number(jobExecutionId) },
      DEFAULT_JOB_OPTIONS,
    );
  }

  /**
   * Provision a full Bedrock WordPress project end-to-end:
   * 1. Create Project + Environment records in DB
   * 2. Generate random DB credentials
   * 3. Enqueue a PROJECT_CREATE_BEDROCK job with CyberPanel config
   *    The worker handles: CyberPanel website/DB creation, Bedrock install,
   *    DB credential storage, monitor + domain auto-creation.
   */
  async createFull(dto: CreateProjectFullDto) {
    this.assertProjectDetailsAreNotCredentials(dto.notes, dto.links);
    const { name, client_id, server_id, domain, admin_email } = dto;
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

    // Create Project + Environment in a transaction
    const { project, environment, jobExecution } =
      await this.repo.createFull({
        name,
        client_id: BigInt(client_id),
        hosting_package_id: dto.hosting_package_id ? BigInt(dto.hosting_package_id) : undefined,
        server_id: BigInt(server_id),
        envType,
        siteUrl,
        rootPath,
        queueName: QUEUES.PROJECTS,
        jobType: JOB_TYPES.PROJECT_CREATE_BEDROCK,
        notes: dto.notes,
        links: projectLinksJson(dto.links),
      });

    // Enqueue the provisioning job
    const job = await this.projectsQueue.add(
      JOB_TYPES.PROJECT_CREATE_BEDROCK,
      {
        environmentId: Number(environment.id),
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

    // Back-fill the bull_job_id now that we have it
    await this.repo.updateBullJobId(jobExecution.id, String(job.id));

    return {
      project: { id: Number(project.id), name: project.name },
      environment: { id: Number(environment.id), url: siteUrl },
      jobExecutionId: Number(jobExecution.id),
      jobId: String(job.id),
    };
  }

  async archive(id: number, dto: ArchiveProjectDto) {
    const project = await this.repo.findById(BigInt(id));
    if (!project) throw new NotFoundException(`Project ${id} not found`);
    if (project.status === "archived") {
      throw new BadRequestException(`Project ${id} is already archived`);
    }

    const envs = project.environments ?? [];
    const firstEnv = envs[0];

    // 1. Update project status to archived
    await this.repo.update(BigInt(id), { status: "archived" });

    // 2. Disable monitors and cron schedules for all environments in this project
    const envIds = envs.map((e) => e.id);
    if (envIds.length > 0) {
      const { backupSchedules, pluginUpdateSchedules, monitors } =
        await this.repo.getSchedulesForEnvironments(envIds);

      await this.repo.disableEnvironmentSchedules(envIds);

      // Unregister repeatable jobs from BullMQ
      for (const monitor of monitors) {
        await this.monitorsService.unregisterRepeatable(monitor);
      }
      for (const bs of backupSchedules) {
        await this.backupSchedulesService.removeRepeatableJob(Number(bs.id));
      }
      for (const pus of pluginUpdateSchedules) {
        await this.pluginUpdateSchedulesService.removeRepeatableJob(Number(pus.id));
      }
    }

    // 3. Create job execution for tracking
    const jobExecution = await this.repo.createJobExecution({
      queue_name: QUEUES.PROJECTS,
      bull_job_id: "0",
      job_type: JOB_TYPES.PROJECT_ARCHIVE,
      environment_id: firstEnv ? firstEnv.id : undefined,
      server_id: firstEnv ? firstEnv.server.id : undefined,
      status: "queued",
      payload: {
        projectId: id,
        createBackup: dto.createBackup ?? true,
        deleteFromCyberpanel: dto.deleteFromCyberpanel ?? true,
      },
    });

    // 4. Enqueue the BullMQ job
    const job = await this.projectsQueue.add(
      JOB_TYPES.PROJECT_ARCHIVE,
      {
        projectId: id,
        jobExecutionId: Number(jobExecution.id),
        createBackup: dto.createBackup ?? true,
        deleteFromCyberpanel: dto.deleteFromCyberpanel ?? true,
      },
      DEFAULT_JOB_OPTIONS,
    );

    // Update job execution with bull job id
    await this.repo.updateBullJobId(jobExecution.id, String(job.id));

    return {
      projectId: id,
      jobExecutionId: Number(jobExecution.id),
      jobId: String(job.id),
    };
  }

  async restoreArchive(id: number, dto: RestoreProjectArchiveDto) {
    const project = await this.repo.findById(BigInt(id));
    if (!project) throw new NotFoundException(`Project ${id} not found`);
    if (project.status !== "archived") {
      throw new BadRequestException(`Project ${id} is not archived`);
    }

    const envs = project.environments ?? [];
    const firstEnv = envs[0];

    // 1. Update project status to active
    await this.repo.update(BigInt(id), { status: "active" });

    // 2. Enable monitors back
    const envIds = envs.map((e) => e.id);
    if (envIds.length > 0) {
      await this.repo.enableEnvironmentMonitors(envIds);

      // Register repeatable jobs back
      const { monitors } = await this.repo.getSchedulesForEnvironments(envIds);
      for (const m of monitors) {
        if (m.enabled) {
          await this.monitorsService.registerRepeatable(m);
        }
      }
    }

    // 3. Create job execution for tracking
    const jobExecution = await this.repo.createJobExecution({
      queue_name: QUEUES.PROJECTS,
      bull_job_id: "0",
      job_type: JOB_TYPES.PROJECT_RESTORE,
      environment_id: firstEnv ? firstEnv.id : undefined,
      server_id: firstEnv ? firstEnv.server.id : undefined,
      status: "queued",
      payload: {
        projectId: id,
        environmentBackups: dto.environmentBackups ?? {},
      },
    });

    // 4. Enqueue the BullMQ job
    const job = await this.projectsQueue.add(
      JOB_TYPES.PROJECT_RESTORE,
      {
        projectId: id,
        jobExecutionId: Number(jobExecution.id),
        environmentBackups: dto.environmentBackups ?? {},
      },
      DEFAULT_JOB_OPTIONS,
    );

    // Update job execution with bull job id
    await this.repo.updateBullJobId(jobExecution.id, String(job.id));

    return {
      projectId: id,
      jobExecutionId: Number(jobExecution.id),
      jobId: String(job.id),
    };
  }

  private assertProjectDetailsAreNotCredentials(
    notes?: string,
    links?: CreateProjectDto["links"],
  ): void {
    const values = [
      notes ?? "",
      ...(links ?? []).flatMap((link) => [link.value ?? "", link.url ?? ""]),
    ];
    const containsCredential =
      values.some(
        (value) =>
          PRIVATE_KEY_RE.test(value) ||
          CREDENTIAL_URL_RE.test(value) ||
          BEARER_TOKEN_RE.test(value) ||
          JWT_TOKEN_RE.test(value) ||
          containsSecretAssignment(value),
      ) ||
      (links ?? []).some(
        (link) =>
          link.isText === true &&
          SENSITIVE_LINK_LABEL_RE.test(link.label) &&
          Boolean(link.value?.trim()),
      );

    if (containsCredential) {
      throw new BadRequestException(
        "Project notes and custom info are not a secure credential store. Save secrets in the relevant server, integration, or environment credential settings.",
      );
    }
  }
}
