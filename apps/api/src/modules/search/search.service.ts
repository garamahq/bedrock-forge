import { Injectable } from "@nestjs/common";
import { SearchRepository } from "./search.repository";

export type SearchResultType =
  | "page"
  | "project"
  | "environment"
  | "project_tab"
  | "client"
  | "server"
  | "domain"
  | "monitor"
  | "job"
  | "finding";

export interface SearchResult {
  type: SearchResultType;
  id: string;
  label: string;
  subtitle?: string;
  path: string;
  icon?: string;
  meta?: Record<string, string | number | boolean | null>;
}

const ROLE_WEIGHT: Record<string, number> = {
  admin: 4,
  manager: 3,
  maintainer: 2,
  client: 1,
};

const STATIC_PAGES: Array<{
  label: string;
  path: string;
  icon: string;
  minRole?: string;
}> = [
  {
    label: "Dashboard",
    path: "/dashboard",
    icon: "LayoutDashboard",
    minRole: "maintainer",
  },
  { label: "Clients", path: "/clients", icon: "Users" },
  { label: "Servers", path: "/servers", icon: "Server", minRole: "manager" },
  {
    label: "Projects",
    path: "/projects",
    icon: "FolderOpen",
    minRole: "manager",
  },
  { label: "Backups", path: "/backups", icon: "HardDrive" },
  { label: "Domains", path: "/domains", icon: "Globe" },
  { label: "Monitors", path: "/monitors", icon: "Activity" },
  { label: "Lighthouse", path: "/lighthouse", icon: "Gauge" },
  { label: "Activity", path: "/activity", icon: "ClipboardList" },
  {
    label: "Problems",
    path: "/problems",
    icon: "AlertTriangle",
    minRole: "maintainer",
  },
  {
    label: "Security",
    path: "/security",
    icon: "ShieldAlert",
    minRole: "manager",
  },
  {
    label: "Maintenance",
    path: "/maintenance-windows",
    icon: "Calendar",
    minRole: "manager",
  },
  { label: "Settings", path: "/settings", icon: "Settings" },
  { label: "Packages", path: "/packages", icon: "Package", minRole: "manager" },
  {
    label: "Invoices",
    path: "/invoices",
    icon: "FileText",
    minRole: "manager",
  },
  { label: "Tags", path: "/tags", icon: "Tag", minRole: "manager" },
  { label: "Users & Roles", path: "/users", icon: "Shield", minRole: "admin" },
  {
    label: "Audit Logs",
    path: "/audit-logs",
    icon: "ClipboardCheck",
    minRole: "admin",
  },
  {
    label: "Notifications",
    path: "/notifications",
    icon: "Bell",
    minRole: "admin",
  },
  {
    label: "Reports",
    path: "/reports",
    icon: "FileBarChart",
    minRole: "admin",
  },
];

const PROJECT_TABS = [
  { value: "environments", label: "Environments", terms: ["env", "site"] },
  { value: "backups", label: "Backups", terms: ["backup", "restore point"] },
  { value: "plugins", label: "Plugins", terms: ["plugin", "composer"] },
  { value: "sync", label: "Sync", terms: ["clone", "push"] },
  { value: "restore", label: "Restore", terms: ["rollback"] },
  { value: "tools", label: "Tools", terms: ["wp cli", "debug", "maintenance"] },
  { value: "drift", label: "Drift", terms: ["config"] },
  { value: "themes", label: "Themes", terms: ["theme"] },
  { value: "files-config", label: "Files & Config", terms: ["files", "env"] },
  { value: "wp-core", label: "WP Core", terms: ["wordpress core", "core"] },
  { value: "security", label: "Security", terms: ["scan", "hardening"] },
  { value: "activity", label: "Activity", terms: ["jobs", "log"] },
];

const SEVERITY_WEIGHT: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

function normalize(s: string) {
  return s.trim().toLowerCase();
}

function roleWeight(roles: string[]) {
  return Math.max(...roles.map((role) => ROLE_WEIGHT[role] ?? 0), 0);
}

function canSee(roles: string[], minRole?: string) {
  if (!minRole) return true;
  return roleWeight(roles) >= (ROLE_WEIGHT[minRole] ?? Number.MAX_SAFE_INTEGER);
}

@Injectable()
export class SearchService {
  constructor(private readonly repo: SearchRepository) {}

  async search({
    query,
    limit,
    roles,
  }: {
    query: string;
    limit?: number;
    roles: string[];
  }): Promise<{ items: SearchResult[] }> {
    const q = normalize(query);
    const take = Math.min(Math.max(limit ?? 8, 1), 20);
    const results: SearchResult[] = [];

    results.push(...this.searchPages(q, roles));

    if (canSee(roles, "manager")) {
      const [
        projects,
        environments,
        servers,
        domains,
        monitors,
        jobs,
        clients,
      ] = await Promise.all([
        this.searchProjects(q, take),
        this.searchEnvironments(q, take),
        this.searchServers(q, take),
        this.searchDomains(q, take),
        this.searchMonitors(q, take),
        this.searchJobs(q, take),
        this.searchClients(q, take),
      ]);
      const findings = await this.searchFindings(q, take);

      results.push(...projects);
      results.push(...environments);
      results.push(...this.searchProjectTabs(q, projects));
      results.push(...servers);
      results.push(...domains);
      results.push(...monitors);
      results.push(...jobs);
      results.push(...findings);
      results.push(...clients);
    }

    return {
      items: results.slice(0, Math.max(take * 6, take)),
    };
  }

  private searchPages(q: string, roles: string[]): SearchResult[] {
    return STATIC_PAGES.filter((page) => canSee(roles, page.minRole))
      .filter((page) => !q || page.label.toLowerCase().includes(q))
      .slice(0, q ? 8 : 12)
      .map((page) => ({
        type: "page",
        id: page.path,
        label: page.label,
        subtitle: "Page",
        path: page.path,
        icon: page.icon,
      }));
  }

  private async searchClients(
    q: string,
    take: number,
  ): Promise<SearchResult[]> {
    if (!q) return [];
    const clients = await this.repo.findClients(q, take);

    return clients.map((client) => ({
      type: "client",
      id: String(client.id),
      label: client.name,
      subtitle: client.email ?? "Client",
      path: `/clients/${client.id}`,
      icon: "Users",
    }));
  }

  private async searchProjects(
    q: string,
    take: number,
  ): Promise<SearchResult[]> {
    if (!q) return [];
    const projects = await this.repo.findProjects(q, take);

    return projects.map((project) => ({
      type: "project",
      id: String(project.id),
      label: project.name,
      subtitle: `${project.client.name} · ${project._count.environments} environment${project._count.environments === 1 ? "" : "s"}`,
      path: `/projects/${project.id}`,
      icon: "FolderOpen",
      meta: { projectId: Number(project.id), projectName: project.name },
    }));
  }

  private async searchEnvironments(
    q: string,
    take: number,
  ): Promise<SearchResult[]> {
    if (!q) return [];
    const environments = await this.repo.findEnvironments(q, take);

    return environments.map((environment) => ({
      type: "environment",
      id: String(environment.id),
      label: `${environment.project.name} · ${environment.type}`,
      subtitle: [environment.url, environment.server.name]
        .filter(Boolean)
        .join(" · "),
      path: `/projects/${environment.project.id}?tab=environments&env=${environment.id}`,
      icon: "Globe",
      meta: {
        projectId: Number(environment.project.id),
        environmentId: Number(environment.id),
        environmentType: environment.type,
      },
    }));
  }

  private async searchServers(
    q: string,
    take: number,
  ): Promise<SearchResult[]> {
    if (!q) return [];
    const servers = await this.repo.findServers(q, take);

    return servers.map((server) => ({
      type: "server",
      id: String(server.id),
      label: server.name,
      subtitle: [server.ip_address, server.provider]
        .filter(Boolean)
        .join(" · "),
      path: `/servers/${server.id}`,
      icon: "Server",
    }));
  }

  private async searchDomains(
    q: string,
    take: number,
  ): Promise<SearchResult[]> {
    if (!q) return [];
    const domains = await this.repo.findDomains(q, take);

    return domains.map((domain) => ({
      type: "domain",
      id: String(domain.id),
      label: domain.name,
      subtitle: domain.expires_at
        ? `Domain expires ${domain.expires_at.toISOString().slice(0, 10)}`
        : "Domain",
      path: `/domains?search=${encodeURIComponent(domain.name)}`,
      icon: "Globe",
    }));
  }

  private async searchMonitors(
    q: string,
    take: number,
  ): Promise<SearchResult[]> {
    if (!q) return [];
    const monitors = await this.repo.findMonitors(q, take);

    return monitors.map((monitor) => ({
      type: "monitor",
      id: String(monitor.id),
      label: `${monitor.environment.project.name} · ${monitor.environment.type}`,
      subtitle: [
        monitor.environment.url,
        monitor.enabled ? "enabled" : "disabled",
        monitor.last_status ? `HTTP ${monitor.last_status}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      path: `/monitors?search=${encodeURIComponent(monitor.environment.url)}`,
      icon: "Activity",
      meta: {
        projectId: Number(monitor.environment.project.id),
        environmentId: Number(monitor.environment.id),
      },
    }));
  }

  private async searchJobs(q: string, take: number): Promise<SearchResult[]> {
    const shouldShowRecent =
      !q ||
      ["job", "jobs", "activity", "running", "failed"].some((term) =>
        term.includes(q),
      );
    const jobs = await this.repo.findJobs(q, shouldShowRecent ? take : take);

    return jobs.map((job) => ({
      type: "job",
      id: String(job.id),
      label: `${job.job_type ?? job.queue_name} #${job.id}`,
      subtitle: [
        job.status,
        job.environment
          ? `${job.environment.project.name} / ${job.environment.type}`
          : job.server
            ? job.server.name
            : null,
      ]
        .filter(Boolean)
        .join(" · "),
      path: `/activity?job=${job.id}`,
      icon: job.status === "failed" ? "AlertTriangle" : "ClipboardList",
      meta: { status: job.status, queue: job.queue_name },
    }));
  }

  private async searchFindings(
    q: string,
    take: number,
  ): Promise<SearchResult[]> {
    if (!q) return [];
    const scans = await this.repo.findLatestSecurityScansWithFindings(take * 4);
    const findings = scans.flatMap((scan) => {
      const raw = Array.isArray(scan.findings) ? scan.findings : [];
      return raw.map((finding) => ({
        scan,
        finding: finding as {
          id?: string;
          severity?: string;
          category?: string;
          title?: string;
          description?: string;
          resource?: string;
        },
      }));
    });

    return findings
      .filter(({ finding }) => {
        const haystack = [
          finding.title,
          finding.category,
          finding.description,
          finding.resource,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return haystack.includes(q);
      })
      .sort(
        (a, b) =>
          (SEVERITY_WEIGHT[a.finding.severity ?? "info"] ?? 99) -
          (SEVERITY_WEIGHT[b.finding.severity ?? "info"] ?? 99),
      )
      .slice(0, take)
      .map(({ scan, finding }) => {
        const target = scan.environment
          ? `${scan.environment.project.name} / ${scan.environment.type}`
          : scan.server?.name;
        const environmentId = scan.environment
          ? Number(scan.environment.id)
          : null;
        return {
          type: "finding" as const,
          id: `${scan.id}:${finding.id ?? finding.title}`,
          label: finding.title ?? "Security finding",
          subtitle: [
            finding.severity?.toUpperCase(),
            finding.category?.replace(/_/g, " "),
            target,
          ]
            .filter(Boolean)
            .join(" · "),
          path: environmentId
            ? `/projects/${scan.environment!.project.id}?tab=security&env=${environmentId}`
            : "/security?tab=findings",
          icon: "ShieldAlert",
          meta: {
            severity: finding.severity ?? null,
            scanType: scan.scan_type,
            environmentId,
          },
        };
      });
  }

  private searchProjectTabs(
    q: string,
    projects: SearchResult[],
  ): SearchResult[] {
    if (!q || projects.length === 0) return [];

    const matchingTabs = PROJECT_TABS.filter((tab) => {
      const terms = [tab.label, tab.value, ...tab.terms].map((term) =>
        term.toLowerCase(),
      );
      return terms.some((term) => term.includes(q) || q.includes(term));
    });

    if (matchingTabs.length === 0) return [];

    return projects.slice(0, 5).flatMap((project) => {
      const projectId = project.meta?.projectId;
      if (!projectId) return [];
      return matchingTabs.slice(0, 3).map((tab) => ({
        type: "project_tab" as const,
        id: `${projectId}:${tab.value}`,
        label: `${project.label} · ${tab.label}`,
        subtitle: "Project tab",
        path: `/projects/${projectId}?tab=${tab.value}`,
        icon: "FolderOpen",
        meta: { projectId, tab: tab.value },
      }));
    });
  }
}
