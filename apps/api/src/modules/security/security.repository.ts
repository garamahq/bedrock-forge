import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import type { SecurityScanType } from "@bedrock-forge/shared";
import type { SecurityScanStatus, SecuritySeverity, SecurityFindingStatus } from "@prisma/client";

@Injectable()
export class SecurityRepository {
  constructor(private readonly prisma: PrismaService) {}

  createScan(data: {
    scan_type: SecurityScanType;
    server_id?: bigint;
    environment_id?: bigint;
    job_execution_id?: bigint;
  }) {
    return this.prisma.securityScan.create({
      data: data as Parameters<
        typeof this.prisma.securityScan.create
      >[0]["data"],
    });
  }

  updateScan(
    id: bigint,
    data: {
      status?: SecurityScanStatus;
      score?: number;
      summary?: Record<string, number>;
      findings?: unknown[];
      error?: string;
      started_at?: Date;
      completed_at?: Date;
    },
  ) {
    return this.prisma.securityScan.update({
      where: { id },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data: data as any,
    });
  }

  findScanById(id: bigint) {
    return this.prisma.securityScan.findUnique({ where: { id } });
  }

  /**
   * Get the latest completed scan per type for a server.
   */
  async findLatestServerScans(serverId: bigint) {
    return this.prisma.securityScan.findMany({
      where: { server_id: serverId, status: "completed" },
      orderBy: { completed_at: "desc" },
      take: 50,
    });
  }

  async findLatestEnvironmentScans(environmentId: bigint) {
    return this.prisma.securityScan.findMany({
      where: { environment_id: environmentId, status: "completed" },
      orderBy: { completed_at: "desc" },
      take: 50,
    });
  }

  async findServerScanHistory(serverId: bigint, page: number, limit: number) {
    const [data, total] = await Promise.all([
      this.prisma.securityScan.findMany({
        where: { server_id: serverId },
        orderBy: { created_at: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          scan_type: true,
          status: true,
          score: true,
          summary: true,
          error: true,
          started_at: true,
          completed_at: true,
          created_at: true,
        },
      }),
      this.prisma.securityScan.count({ where: { server_id: serverId } }),
    ]);
    return { data, total };
  }

  async findEnvironmentScanHistory(
    environmentId: bigint,
    page: number,
    limit: number,
  ) {
    const [data, total] = await Promise.all([
      this.prisma.securityScan.findMany({
        where: { environment_id: environmentId },
        orderBy: { created_at: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          scan_type: true,
          status: true,
          score: true,
          summary: true,
          error: true,
          started_at: true,
          completed_at: true,
          created_at: true,
        },
      }),
      this.prisma.securityScan.count({
        where: { environment_id: environmentId },
      }),
    ]);
    return { data, total };
  }

  /**
   * For the overview: latest scan per server (all types combined into worst-case score).
   */
  async findAllServersWithLatestScan() {
    const servers = await this.prisma.server.findMany({
      select: {
        id: true,
        name: true,
        ip_address: true,
        status: true,
        security_scans: {
          where: { status: "completed" },
          orderBy: { completed_at: "desc" },
          take: 100,
          select: {
            id: true,
            scan_type: true,
            score: true,
            summary: true,
            completed_at: true,
          },
        },
      },
    });
    return servers;
  }

  async findAllEnvironmentsWithLatestScan() {
    const envs = await this.prisma.environment.findMany({
      select: {
        id: true,
        type: true,
        url: true,
        root_path: true,
        project: { select: { id: true, name: true } },
        server: { select: { id: true, name: true } },
        security_scans: {
          where: { status: "completed" },
          orderBy: { completed_at: "desc" },
          take: 100,
          select: {
            id: true,
            scan_type: true,
            score: true,
            summary: true,
            completed_at: true,
          },
        },
      },
    });
    return envs;
  }

  /**
   * Security logs: pull FAILED_LOGINS + SUCCESSFUL_LOGINS + AUTHORIZED_KEYS findings
   * from all completed SSH_AUDIT scans ordered by scan completion date.
   */
  async findSecurityLogs(
    filter: {
      server_id?: number;
      date_from?: Date;
      date_to?: Date;
    },
    page: number,
    limit: number,
  ) {
    const where: Record<string, unknown> = {
      scan_type: "SSH_AUDIT",
      status: "completed",
    };
    if (filter.server_id) where["server_id"] = BigInt(filter.server_id);
    if (filter.date_from || filter.date_to) {
      where["completed_at"] = {
        ...(filter.date_from && { gte: filter.date_from }),
        ...(filter.date_to && { lte: filter.date_to }),
      };
    }

    const [scans, total] = await Promise.all([
      this.prisma.securityScan.findMany({
        where,
        orderBy: { completed_at: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          findings: true,
          completed_at: true,
          server: { select: { id: true, name: true, ip_address: true } },
        },
      }),
      this.prisma.securityScan.count({ where }),
    ]);

    return { scans, total };
  }

  // ─── Security Scan Schedules ─────────────────────────────────────────────────

  upsertServerSchedule(
    serverId: bigint,
    data: {
      scan_types: string[];
      frequency: string;
      hour: number;
      minute: number;
      day_of_week?: number | null;
      day_of_month?: number | null;
      enabled?: boolean;
      notify_enabled?: boolean;
      notify_threshold?: SecuritySeverity;
    },
  ) {
    return this.prisma.securityScanSchedule.upsert({
      where: { server_id: serverId },
      create: { server_id: serverId, ...data },
      update: data,
    });
  }

  upsertEnvironmentSchedule(
    environmentId: bigint,
    data: {
      scan_types: string[];
      frequency: string;
      hour: number;
      minute: number;
      day_of_week?: number | null;
      day_of_month?: number | null;
      enabled?: boolean;
      notify_enabled?: boolean;
      notify_threshold?: SecuritySeverity;
    },
  ) {
    return this.prisma.securityScanSchedule.upsert({
      where: { environment_id: environmentId },
      create: { environment_id: environmentId, ...data },
      update: data,
    });
  }

  findServerSchedule(serverId: bigint) {
    return this.prisma.securityScanSchedule.findUnique({
      where: { server_id: serverId },
    });
  }

  findEnvironmentSchedule(environmentId: bigint) {
    return this.prisma.securityScanSchedule.findUnique({
      where: { environment_id: environmentId },
    });
  }

  deleteServerSchedule(serverId: bigint) {
    return this.prisma.securityScanSchedule.deleteMany({
      where: { server_id: serverId },
    });
  }

  deleteEnvironmentSchedule(environmentId: bigint) {
    return this.prisma.securityScanSchedule.deleteMany({
      where: { environment_id: environmentId },
    });
  }

  // ─── Server Security Alerts ────────────────────────────────────────────────

  findServerAlertSetting(serverId: bigint) {
    return this.prisma.serverSecurityAlertSetting.findUnique({
      where: { server_id: serverId },
    });
  }

  upsertServerAlertSetting(
    serverId: bigint,
    data: {
      enabled: boolean;
      ssh_login_alerts_enabled: boolean;
      file_change_alerts_enabled: boolean;
      interval_minutes: number;
      file_watch_paths: string[];
    },
  ) {
    return this.prisma.serverSecurityAlertSetting.upsert({
      where: { server_id: serverId },
      create: { server_id: serverId, ...data },
      update: data,
    });
  }

  // ─── Finding Acknowledgements ────────────────────────────────────────────────

  upsertAck(data: {
    scope_key: string;
    category: string;
    title: string;
    userId: bigint;
    serverId?: bigint;
    environmentId?: bigint;
    note?: string | null;
  }) {
    const payload = {
      scope_key: data.scope_key,
      category: data.category,
      title: data.title,
      acknowledged_by: data.userId,
      server_id: data.serverId ?? null,
      environment_id: data.environmentId ?? null,
      note: data.note ?? null,
    };
    return this.prisma.securityFindingAck.upsert({
      where: {
        scope_key_category_title: {
          scope_key: data.scope_key,
          category: data.category,
          title: data.title,
        },
      },
      create: payload,
      update: {
        acknowledged_by: data.userId,
        note: data.note ?? null,
      },
    });
  }

  deleteAck(scope_key: string, category: string, title: string) {
    return this.prisma.securityFindingAck.deleteMany({
      where: { scope_key, category, title },
    });
  }

  async findAcksByScopeKeys(scopeKeys: string[]): Promise<
    Map<
      string,
      {
        note: string | null;
        acknowledged_by_name: string;
        created_at: Date;
      }
    >
  > {
    if (scopeKeys.length === 0) return new Map();
    const acks = await this.prisma.securityFindingAck.findMany({
      where: { scope_key: { in: scopeKeys } },
      include: { user: { select: { name: true } } },
    });
    const map = new Map<
      string,
      { note: string | null; acknowledged_by_name: string; created_at: Date }
    >();
    for (const ack of acks) {
      const key = `${ack.scope_key}::${ack.category}::${ack.title}`;
      map.set(key, {
        note: ack.note,
        acknowledged_by_name: ack.user.name,
        created_at: ack.created_at,
      });
    }
    return map;
  }

  /**
   * Returns the latest completed scan per (server_id, scan_type) and per
   * (environment_id, scan_type) using DISTINCT ON to avoid duplicating findings.
   * Includes server name/IP and environment type/project name for display.
   *
   * NOTE: PostgreSQL forbids ORDER BY inside individual parts of a UNION ALL.
   * Each DISTINCT ON query must live in its own CTE so the ORDER BY is scoped
   * to that CTE, then we union the CTEs together at the outer level.
   */
  async findLatestCompletedScansWithFindings(): Promise<
    {
      id: bigint;
      scan_type: string;
      completed_at: Date | null;
      findings: unknown;
      server_id: bigint | null;
      server_name: string | null;
      server_ip: string | null;
      environment_id: bigint | null;
      environment_type: string | null;
      project_name: string | null;
    }[]
  > {
    // Use raw SQL for DISTINCT ON which Prisma doesn't support natively.
    // Each DISTINCT ON query is wrapped in a CTE so each can have its own
    // ORDER BY clause; the outer SELECT then UNIONs the two CTEs.
    const rows = await this.prisma.$queryRaw<
      {
        id: bigint;
        scan_type: string;
        completed_at: Date | null;
        findings: unknown;
        server_id: bigint | null;
        server_name: string | null;
        server_ip: string | null;
        environment_id: bigint | null;
        environment_type: string | null;
        project_name: string | null;
      }[]
    >`
			WITH server_latest AS (
				SELECT DISTINCT ON (ss.server_id, ss.scan_type)
					ss.id,
					ss.scan_type,
					ss.completed_at,
					ss.findings,
					ss.server_id,
					srv.name           AS server_name,
					srv.ip_address     AS server_ip,
					NULL::BIGINT       AS environment_id,
					NULL::TEXT         AS environment_type,
					NULL::TEXT         AS project_name
				FROM security_scans ss
				LEFT JOIN servers srv ON srv.id = ss.server_id
				WHERE ss.status = 'completed'
				  AND ss.server_id IS NOT NULL
				  AND ss.findings IS NOT NULL
				ORDER BY ss.server_id, ss.scan_type, ss.completed_at DESC
			),
			env_latest AS (
				SELECT DISTINCT ON (ss.environment_id, ss.scan_type)
					ss.id,
					ss.scan_type,
					ss.completed_at,
					ss.findings,
					NULL::BIGINT       AS server_id,
					NULL::TEXT         AS server_name,
					NULL::TEXT         AS server_ip,
					ss.environment_id,
					env.type           AS environment_type,
					prj.name           AS project_name
				FROM security_scans ss
				LEFT JOIN environments env ON env.id = ss.environment_id
				LEFT JOIN projects     prj ON prj.id = env.project_id
				WHERE ss.status = 'completed'
				  AND ss.environment_id IS NOT NULL
				  AND ss.findings IS NOT NULL
				ORDER BY ss.environment_id, ss.scan_type, ss.completed_at DESC
			)
			SELECT * FROM server_latest
			UNION ALL
			SELECT * FROM env_latest
		`;
    return rows;
  }

  findAllEnabledSchedules() {
    return this.prisma.securityScanSchedule.findMany({
      where: { enabled: true },
      include: {
        server: { select: { id: true, name: true } },
        environment: { select: { id: true, type: true } },
      },
    });
  }

  updateScheduleLastRun(id: bigint, lastRunAt: Date) {
    return this.prisma.securityScanSchedule.update({
      where: { id },
      data: { last_run_at: lastRunAt },
    });
  }

  findGlobalScanHistory(since: Date) {
    return this.prisma.securityScan.findMany({
      where: {
        completed_at: { gte: since },
        status: "completed",
        score: { not: null },
      },
      select: {
        completed_at: true,
        score: true,
      },
      orderBy: { completed_at: "asc" },
    });
  }

  // ─── Job Execution helpers ───────────────────────────────────────────────────

  createJobExecution(data: {
    queue_name: string;
    job_type: string;
    status: string;
    server_id?: bigint | null;
    environment_id?: bigint | null;
    payload?: Record<string, unknown>;
  }) {
    return this.prisma.jobExecution.create({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data: {
        queue_name: data.queue_name,
        bull_job_id: "pending",
        job_type: data.job_type,
        status: data.status as any,
        server_id: data.server_id ?? null,
        environment_id: data.environment_id ?? null,
        payload: (data.payload ?? {}) as any,
      },
    });
  }

  updateJobExecutionBullId(id: bigint, bullJobId: string) {
    return this.prisma.jobExecution.update({
      where: { id },
      data: { bull_job_id: bullJobId },
    });
  }

  updateJobExecution(
    id: bigint,
    data: {
      status?: "queued" | "active" | "completed" | "failed" | "dead_letter";
      last_error?: string;
      completed_at?: Date;
    },
  ) {
    return this.prisma.jobExecution.update({ where: { id }, data });
  }

  failSecurityScans(ids: bigint[]) {
    return this.prisma.securityScan.updateMany({
      where: { id: { in: ids } },
      data: { status: "failed" },
    });
  }

  findSecurityReportHistory() {
    return this.prisma.jobExecution.findMany({
      where: {
        queue_name: "reports",
        job_type: "security:report-generate",
      },
      orderBy: { created_at: "desc" },
      take: 20,
      select: {
        id: true,
        status: true,
        progress: true,
        last_error: true,
        payload: true,
        execution_log: true,
        started_at: true,
        completed_at: true,
        created_at: true,
      },
    });
  }

  listServers() {
    return this.prisma.server.findMany({
      where: { status: "online" },
      select: {
        id: true,
        name: true,
        ip_address: true,
        status: true,
      },
    });
  }

  findServerById(id: bigint) {
    return this.prisma.server.findUnique({ where: { id } });
  }

  findEnvironmentById(id: bigint) {
    return this.prisma.environment.findUnique({ where: { id } });
  }

  createServerScansTransaction(
    serverId: bigint,
    executionId: bigint,
    types: string[],
  ) {
    return this.prisma.$transaction(
      types.map((scanType) =>
        this.prisma.securityScan.create({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          data: {
            scan_type: scanType as SecurityScanType,
            server_id: serverId,
            job_execution_id: executionId,
          } as any,
        }),
      ),
    );
  }

  createEnvironmentScansTransaction(
    environmentId: bigint,
    executionId: bigint,
    types: string[],
  ) {
    return this.prisma.$transaction(
      types.map((scanType) =>
        this.prisma.securityScan.create({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          data: {
            scan_type: scanType as SecurityScanType,
            environment_id: environmentId,
            job_execution_id: executionId,
          } as any,
        }),
      ),
    );
  }

  // ─── First-Class Security Findings Lifecycle ─────────────────────────────────

  async findFindingById(id: bigint) {
    return this.prisma.securityFinding.findUnique({
      where: { id },
      include: {
        server: { select: { id: true, name: true, ip_address: true } },
        environment: {
          select: {
            id: true,
            type: true,
            url: true,
            project: { select: { id: true, name: true } },
          },
        },
        scan: { select: { id: true, scan_type: true, completed_at: true } },
        transitions: {
          orderBy: { created_at: "desc" },
          include: { actor: { select: { id: true, name: true, email: true } } },
        },
      },
    });
  }

  async listSecurityFindings(
    filter: {
      server_id?: number;
      environment_id?: number;
      severity?: string;
      status?: string;
      category?: string;
      search?: string;
    },
    page: number,
    limit: number,
  ) {
    const where: any = {};

    if (filter.server_id) {
      where.server_id = BigInt(filter.server_id);
    }
    if (filter.environment_id) {
      where.environment_id = BigInt(filter.environment_id);
    }
    if (filter.severity) {
      const severities = filter.severity
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      if (severities.length === 1) {
        where.severity = severities[0] as SecuritySeverity;
      } else if (severities.length > 1) {
        where.severity = { in: severities as SecuritySeverity[] };
      }
    }
    if (filter.status) {
      const statuses = filter.status
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      if (statuses.length === 1) {
        where.status = statuses[0] as SecurityFindingStatus;
      } else if (statuses.length > 1) {
        where.status = { in: statuses as SecurityFindingStatus[] };
      }
    }
    if (filter.category) {
      where.category = filter.category;
    }
    if (filter.search) {
      const q = filter.search.trim();
      where.OR = [
        { title: { contains: q, mode: "insensitive" } },
        { description: { contains: q, mode: "insensitive" } },
        { resource: { contains: q, mode: "insensitive" } },
      ];
    }

    const [data, total] = await Promise.all([
      this.prisma.securityFinding.findMany({
        where,
        orderBy: [{ severity: "asc" }, { last_seen_at: "desc" }],
        skip: (page - 1) * limit,
        take: limit,
        include: {
          server: { select: { id: true, name: true, ip_address: true } },
          environment: {
            select: {
              id: true,
              type: true,
              url: true,
              project: { select: { id: true, name: true } },
            },
          },
          transitions: {
            take: 3,
            orderBy: { created_at: "desc" },
            include: { actor: { select: { id: true, name: true, email: true } } },
          },
        },
      }),
      this.prisma.securityFinding.count({ where }),
    ]);

    return { data, total };
  }

  async updateFindingStatus(
    id: bigint,
    status: SecurityFindingStatus,
    note?: string,
    actorId?: bigint,
  ) {
    const existing = await this.prisma.securityFinding.findUnique({
      where: { id },
    });
    if (!existing) return null;

    const fromStatus = existing.status;
    const isResolving =
      status === "resolved" ||
      status === "remediated" ||
      status === "false_positive";

    const [updated] = await this.prisma.$transaction([
      this.prisma.securityFinding.update({
        where: { id },
        data: {
          status,
          resolved_at: isResolving ? new Date() : null,
        },
        include: {
          server: { select: { id: true, name: true, ip_address: true } },
          environment: {
            select: {
              id: true,
              type: true,
              url: true,
              project: { select: { id: true, name: true } },
            },
          },
          transitions: {
            orderBy: { created_at: "desc" },
            include: { actor: { select: { id: true, name: true, email: true } } },
          },
        },
      }),
      this.prisma.securityFindingTransition.create({
        data: {
          finding_id: id,
          from_status: fromStatus,
          to_status: status,
          note: note ?? null,
          actor_id: actorId ?? null,
        },
      }),
    ]);

    return updated;
  }

  // ─── Baseline & Drift ────────────────────────────────────────────────────────

  getActiveBaseline(scope: { serverId?: bigint; environmentId?: bigint }) {
    return this.prisma.securityBaseline.findFirst({
      where:
        scope.serverId !== undefined
          ? { server_id: scope.serverId }
          : { environment_id: scope.environmentId },
      orderBy: { created_at: "desc" },
      include: {
        items: true,
        created_by: { select: { id: true, name: true, email: true } },
      },
    });
  }

  async listDriftEvents(params: {
    serverId?: bigint;
    environmentId?: bigint;
    page?: number;
    limit?: number;
  }) {
    const page = Math.max(1, params.page ?? 1);
    const limit = Math.min(100, Math.max(1, params.limit ?? 20));
    const skip = (page - 1) * limit;

    const where: any = {};
    if (params.serverId !== undefined) where.server_id = params.serverId;
    if (params.environmentId !== undefined) where.environment_id = params.environmentId;

    const [total, data] = await Promise.all([
      this.prisma.securityDriftEvent.count({ where }),
      this.prisma.securityDriftEvent.findMany({
        where,
        skip,
        take: limit,
        orderBy: { detected_at: "desc" },
        include: {
          server: { select: { id: true, name: true } },
          environment: {
            select: {
              id: true,
              type: true,
              project: { select: { id: true, name: true } },
            },
          },
        },
      }),
    ]);

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  // ─── Incidents ─────────────────────────────────────────────────────────────

  async listIncidents(params: {
    status?: any;
    serverId?: bigint;
    page?: number;
    limit?: number;
  }) {
    const page = Math.max(1, params.page ?? 1);
    const limit = Math.min(100, Math.max(1, params.limit ?? 20));
    const skip = (page - 1) * limit;

    const where: any = {};
    if (params.status) where.status = params.status;
    if (params.serverId !== undefined) where.server_id = params.serverId;

    const [total, data] = await Promise.all([
      this.prisma.securityIncident.count({ where }),
      this.prisma.securityIncident.findMany({
        where,
        skip,
        take: limit,
        orderBy: { detected_at: "desc" },
        include: {
          server: { select: { id: true, name: true, ip_address: true } },
          findings: {
            select: {
              id: true,
              category: true,
              severity: true,
              status: true,
              title: true,
              resource: true,
            },
          },
        },
      }),
    ]);

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  findIncidentById(id: bigint) {
    return this.prisma.securityIncident.findUnique({
      where: { id },
      include: {
        server: { select: { id: true, name: true, ip_address: true } },
        findings: true,
      },
    });
  }

  updateIncidentStatus(id: bigint, status: any) {
    return this.prisma.securityIncident.update({
      where: { id },
      data: {
        status,
        resolved_at: status === "resolved" || status === "false_positive" ? new Date() : null,
      },
      include: {
        server: { select: { id: true, name: true } },
        findings: true,
      },
    });
  }

  // ─── Alert Rules ───────────────────────────────────────────────────────────

  listAlertRules() {
    return this.prisma.securityAlertRule.findMany({
      orderBy: { created_at: "desc" },
    });
  }

  findAlertRuleById(id: bigint) {
    return this.prisma.securityAlertRule.findUnique({
      where: { id },
    });
  }

  createAlertRule(data: {
    name: string;
    enabled?: boolean;
    min_severity?: any;
    categories?: string[];
    server_ids?: bigint[];
    channel_ids?: bigint[];
    create_incident?: boolean;
    cooldown_minutes?: number;
  }) {
    return this.prisma.securityAlertRule.create({
      data: {
        name: data.name,
        enabled: data.enabled ?? true,
        min_severity: data.min_severity ?? null,
        categories: data.categories ?? [],
        server_ids: data.server_ids ?? [],
        channel_ids: data.channel_ids ?? [],
        create_incident: data.create_incident ?? false,
        cooldown_minutes: data.cooldown_minutes ?? 30,
      },
    });
  }

  updateAlertRule(
    id: bigint,
    data: {
      name?: string;
      enabled?: boolean;
      min_severity?: any;
      categories?: string[];
      server_ids?: bigint[];
      channel_ids?: bigint[];
      create_incident?: boolean;
      cooldown_minutes?: number;
    },
  ) {
    return this.prisma.securityAlertRule.update({
      where: { id },
      data,
    });
  }

  deleteAlertRule(id: bigint) {
    return this.prisma.securityAlertRule.delete({
      where: { id },
    });
  }
}
