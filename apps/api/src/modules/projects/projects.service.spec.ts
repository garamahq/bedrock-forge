import { Test } from "@nestjs/testing";
import { getQueueToken } from "@nestjs/bullmq";
import { ProjectsService } from "./projects.service";
import { ProjectsRepository } from "./projects.repository";
import { PrismaService } from "../../prisma/prisma.service";
import { DomainsService } from "../domains/domains.service";
import { MonitorsService } from "../monitors/monitors.service";
import { BackupSchedulesService } from "../backups/backup-schedules.service";
import { PluginUpdateSchedulesService } from "../plugin-update-schedules/plugin-update-schedules.service";
import { QUEUES } from "@bedrock-forge/shared";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRepo() {
  return {
    findAllPaginated: jest.fn(),
    findById: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
    importFromServer: jest.fn(),
    importBulk: jest.fn(),
    getSchedulesForEnvironments: jest.fn().mockResolvedValue({
      backupSchedules: [],
      pluginUpdateSchedules: [],
      monitors: [],
    }),
    disableEnvironmentSchedules: jest.fn().mockResolvedValue([]),
    enableEnvironmentMonitors: jest.fn().mockResolvedValue([]),
    createJobExecution: jest.fn().mockResolvedValue({ id: BigInt(99) }),
    updateBullJobId: jest.fn().mockResolvedValue({}),
  };
}

function makePrisma() {
  return {
    backupSchedule: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({}),
    },
    pluginUpdateSchedule: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({}),
    },
    monitor: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({}),
    },
    cleanupSchedule: {
      updateMany: jest.fn().mockResolvedValue({}),
    },
    securityScanSchedule: {
      updateMany: jest.fn().mockResolvedValue({}),
    },
    jobExecution: {
      create: jest.fn().mockResolvedValue({ id: BigInt(99) }),
    },
    $transaction: jest.fn().mockImplementation((promises) => Promise.all(promises)),
  };
}

function makeQueue() {
  return { add: jest.fn().mockResolvedValue({ id: "job-abc" }) };
}

function makeDomainsService() {
  return { findOrCreate: jest.fn().mockResolvedValue({}) };
}

function makeMonitorsService() {
  return {
    create: jest.fn().mockResolvedValue({}),
    registerRepeatable: jest.fn().mockResolvedValue({}),
    unregisterRepeatable: jest.fn().mockResolvedValue({}),
  };
}

function makeBackupSchedulesService() {
  return { removeRepeatableJob: jest.fn().mockResolvedValue({}) };
}

function makePluginUpdateSchedulesService() {
  return { removeRepeatableJob: jest.fn().mockResolvedValue({}) };
}

function makeProject(id: bigint = BigInt(1)) {
  return { id, name: "My Site", client_id: BigInt(2) };
}

function makeEnvironment(id: bigint = BigInt(10)) {
  return {
    id,
    type: "production",
    url: "https://mysite.com",
    root_path: "/var/www/html",
    server_id: BigInt(5),
    project_id: BigInt(1),
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("ProjectsService", () => {
  let svc: ProjectsService;
  let repo: ReturnType<typeof makeRepo>;
  let domainsService: ReturnType<typeof makeDomainsService>;
  let monitorsService: ReturnType<typeof makeMonitorsService>;
  let backupSchedulesService: ReturnType<typeof makeBackupSchedulesService>;
  let pluginUpdateSchedulesService: ReturnType<typeof makePluginUpdateSchedulesService>;
  let queue: ReturnType<typeof makeQueue>;

  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(async () => {
    repo = makeRepo();
    domainsService = makeDomainsService();
    monitorsService = makeMonitorsService();
    backupSchedulesService = makeBackupSchedulesService();
    pluginUpdateSchedulesService = makePluginUpdateSchedulesService();
    queue = makeQueue();
    prisma = makePrisma();

    const module = await Test.createTestingModule({
      providers: [
        ProjectsService,
        { provide: ProjectsRepository, useValue: repo },
        { provide: PrismaService, useValue: prisma },
        { provide: getQueueToken(QUEUES.PROJECTS), useValue: queue },
        { provide: DomainsService, useValue: domainsService },
        { provide: MonitorsService, useValue: monitorsService },
        { provide: BackupSchedulesService, useValue: backupSchedulesService },
        { provide: PluginUpdateSchedulesService, useValue: pluginUpdateSchedulesService },
      ],
    }).compile();

    svc = module.get(ProjectsService);
  });

  // ── CRUD ────────────────────────────────────────────────────────────────

  describe("findOne", () => {
    it("delegates to repo with BigInt id", () => {
      repo.findById.mockResolvedValue(makeProject());
      svc.findOne(5);
      expect(repo.findById).toHaveBeenCalledWith(BigInt(5));
    });
  });

  describe("create", () => {
    it("converts ids to BigInt before delegating", async () => {
      repo.create.mockResolvedValue(makeProject());
      await svc.create({
        name: "New Site",
        client_id: 3,
        hosting_package_id: 7,
        support_package_id: 2,
      } as any);
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          client_id: BigInt(3),
          hosting_package_id: BigInt(7),
          support_package_id: BigInt(2),
        }),
      );
    });
  });

  // ── importFromServer ────────────────────────────────────────────────────

  describe("importFromServer", () => {
    it("calls repo.importFromServer and then auto-creates domain + monitor", async () => {
      const project = makeProject(BigInt(1));
      const environment = makeEnvironment(BigInt(10));
      repo.importFromServer.mockResolvedValue({ project, environment });

      const result = await svc.importFromServer({
        name: "My Site",
        client_id: 2,
        server_id: 5,
        url: "https://mysite.com",
        root_path: "/var/www/html",
      } as any);

      expect(repo.importFromServer).toHaveBeenCalled();
      expect(monitorsService.create).toHaveBeenCalledWith(
        expect.objectContaining({ environment_id: 10, enabled: true }),
      );
      expect(domainsService.findOrCreate).toHaveBeenCalledWith("mysite.com");
      expect(result).toEqual({ project, environment });
    });

    it("still returns result when domain auto-creation fails", async () => {
      const project = makeProject(BigInt(1));
      const environment = makeEnvironment(BigInt(10));
      repo.importFromServer.mockResolvedValue({ project, environment });
      domainsService.findOrCreate.mockRejectedValue(
        new Error("Domain conflict"),
      );

      // Should not throw
      await expect(
        svc.importFromServer({
          name: "My Site",
          client_id: 2,
          server_id: 5,
          url: "https://mysite.com",
          root_path: "/var/www/html",
        } as any),
      ).resolves.toEqual({ project, environment });
    });
  });

  // ── importBulk ──────────────────────────────────────────────────────────

  describe("importBulk", () => {
    it("creates monitors and domains for each imported environment", async () => {
      const results = [
        {
          project: makeProject(BigInt(1)),
          environment: makeEnvironment(BigInt(10)),
        },
        {
          project: makeProject(BigInt(2)),
          environment: {
            ...makeEnvironment(BigInt(11)),
            url: "https://site2.com",
            id: BigInt(11),
          },
        },
      ];
      repo.importBulk.mockResolvedValue(results);

      await svc.importBulk({
        projects: [
          {
            name: "Site 1",
            client_id: 1,
            server_id: 5,
            url: "https://mysite.com",
            root_path: "/a",
          },
          {
            name: "Site 2",
            client_id: 1,
            server_id: 5,
            url: "https://site2.com",
            root_path: "/b",
          },
        ],
      } as any);

      expect(monitorsService.create).toHaveBeenCalledTimes(2);
      expect(domainsService.findOrCreate).toHaveBeenCalledTimes(2);
    });

    it("creates main domain entry when mainDomain is provided", async () => {
      const results = [
        {
          project: makeProject(BigInt(1)),
          // environment URL matches the subdomain from input
          environment: {
            ...makeEnvironment(BigInt(10)),
            url: "https://sub.mysite.com",
          },
        },
      ];
      repo.importBulk.mockResolvedValue(results);

      await svc.importBulk({
        projects: [
          {
            name: "Site 1",
            client_id: 1,
            server_id: 5,
            url: "https://sub.mysite.com",
            root_path: "/a",
            main_domain: "mysite.com",
          },
        ],
      } as any);

      // domain.findOrCreate called once with mainDomain (subdomain is skipped in favour of apex)
      expect(domainsService.findOrCreate).toHaveBeenCalledTimes(1);
      expect(domainsService.findOrCreate).toHaveBeenCalledWith("mysite.com");
    });

    it("still completes when monitor/domain creation fails for one entry", async () => {
      const results = [
        {
          project: makeProject(BigInt(1)),
          environment: makeEnvironment(BigInt(10)),
        },
      ];
      repo.importBulk.mockResolvedValue(results);
      monitorsService.create.mockRejectedValue(new Error("Monitor quota"));
      domainsService.findOrCreate.mockRejectedValue(
        new Error("Domain conflict"),
      );

      // Should not throw
      await expect(
        svc.importBulk({
          projects: [
            {
              name: "x",
              client_id: 1,
              server_id: 5,
              url: "https://x.com",
              root_path: "/x",
            },
          ],
        } as any),
      ).resolves.toBeDefined();
    });
  });

  // ── remove ──────────────────────────────────────────────────────────────
  describe("remove", () => {
    it("deletes project directly from repository when it has no environments", async () => {
      const project = { ...makeProject(), environments: [] };
      repo.findById.mockResolvedValue(project);
      repo.remove.mockResolvedValue(project);

      await svc.remove(1);

      expect(repo.findById).toHaveBeenCalledWith(BigInt(1));
      expect(repo.remove).toHaveBeenCalledWith(BigInt(1));
      expect(queue.add).not.toHaveBeenCalled();
    });

    it("queues a decommissioning job when it has environments", async () => {
      const env = { ...makeEnvironment(), server: { id: BigInt(5), name: "Server 1", ip_address: "1.1.1.1", status: "active" } };
      const project = { ...makeProject(), environments: [env] };
      repo.findById.mockResolvedValue(project);
      repo.update.mockResolvedValue(project);

      const result = await svc.remove(1) as any;

      expect(repo.findById).toHaveBeenCalledWith(BigInt(1));
      expect(repo.update).toHaveBeenCalledWith(BigInt(1), { status: "archived" });
      expect(queue.add).toHaveBeenCalledWith(
        "project:archive",
        expect.objectContaining({
          projectId: 1,
          createBackup: false,
          deleteFromCyberpanel: true,
          deleteProject: true,
          jobExecutionId: 99,
        }),
        expect.any(Object),
      );
      expect(result).toHaveProperty("message");
      expect(result.message).toContain("Decommissioning job queued");
    });
  });
});
