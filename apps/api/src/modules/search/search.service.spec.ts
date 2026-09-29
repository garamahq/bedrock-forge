import { SearchService } from "./search.service";
import { SearchRepository } from "./search.repository";

describe("SearchService", () => {
  let repo: jest.Mocked<SearchRepository>;
  let service: SearchService;

  beforeEach(() => {
    repo = {
      findClients: jest.fn(),
      findProjects: jest.fn(),
      findRecentProjects: jest.fn(),
      findEnvironments: jest.fn(),
      findServers: jest.fn(),
      findDomains: jest.fn(),
      findMonitors: jest.fn(),
      findJobs: jest.fn(),
      findSecurityFindings: jest.fn(),
      findLatestInventoryScans: jest.fn(),
    } as unknown as jest.Mocked<SearchRepository>;
    repo.findClients.mockResolvedValue([]);
    repo.findProjects.mockResolvedValue([]);
    repo.findRecentProjects.mockResolvedValue([]);
    repo.findEnvironments.mockResolvedValue([]);
    repo.findServers.mockResolvedValue([]);
    repo.findDomains.mockResolvedValue([]);
    repo.findMonitors.mockResolvedValue([]);
    repo.findJobs.mockResolvedValue([]);
    repo.findSecurityFindings.mockResolvedValue([]);
    repo.findLatestInventoryScans.mockResolvedValue([]);
    service = new SearchService(repo);
  });

  it("returns visible static pages for blank queries", async () => {
    const result = await service.search({
      query: "",
      roles: ["maintainer"],
      limit: 8,
    });

    expect(result.items.some((item) => item.path === "/dashboard")).toBe(true);
    expect(result.items.some((item) => item.path === "/users")).toBe(false);
    expect(repo.findProjects).not.toHaveBeenCalled();
  });

  it("searches projects, environments, servers, and clients for managers", async () => {
    repo.findProjects.mockResolvedValue([
      {
        id: BigInt(7),
        name: "Acme Site",
        client: { name: "Acme" },
        _count: { environments: 2 },
      },
    ]);
    repo.findEnvironments.mockResolvedValue([
      {
        id: BigInt(11),
        type: "production",
        url: "https://acme.test",
        project: { id: BigInt(7), name: "Acme Site" },
        server: { name: "prod-1" },
        environment_tags: [],
      },
    ]);
    repo.findServers.mockResolvedValue([
      {
        id: BigInt(3),
        name: "prod-1",
        ip_address: "192.0.2.10",
        provider: "hetzner",
      },
    ]);
    repo.findDomains.mockResolvedValue([
      {
        id: BigInt(4),
        name: "acme.test",
        expires_at: new Date("2026-12-31T00:00:00.000Z"),
      },
    ]);
    repo.findMonitors.mockResolvedValue([
      {
        id: BigInt(8),
        enabled: true,
        last_status: 200,
        environment: {
          id: BigInt(11),
          type: "production",
          url: "https://acme.test",
          project: { id: BigInt(7), name: "Acme Site" },
        },
      },
    ]);
    repo.findJobs.mockResolvedValue([
      {
        id: BigInt(12),
        queue_name: "security",
        job_type: "environment-harden",
        status: "completed",
        environment: {
          id: BigInt(11),
          type: "production",
          url: "https://acme.test",
          project: { id: BigInt(7), name: "Acme Site" },
        },
        server: null,
      },
    ]);
    repo.findClients.mockResolvedValue([
      {
        id: BigInt(5),
        name: "Acme",
        email: "ops@example.com",
        client_tags: [],
      },
    ]);

    const result = await service.search({
      query: "acme",
      roles: ["manager"],
      limit: 8,
    });

    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "project",
          path: "/projects/7",
        }),
        expect.objectContaining({
          type: "environment",
          path: "/projects/7?tab=environments&env=11",
        }),
        expect.objectContaining({
          type: "server",
          path: "/servers/3",
        }),
        expect.objectContaining({
          type: "domain",
          path: "/domains?search=acme.test",
        }),
        expect.objectContaining({
          type: "monitor",
          path: "/monitors?search=https%3A%2F%2Facme.test",
        }),
        expect.objectContaining({
          type: "job",
          path: "/activity?job=12",
        }),
        expect.objectContaining({
          type: "client",
          path: "/clients/5",
        }),
      ]),
    );
  });

  it("returns matching project tab shortcuts for project results", async () => {
    repo.findProjects.mockResolvedValue([
      {
        id: BigInt(9),
        name: "Composer Site",
        client: { name: "Client" },
        _count: { environments: 1 },
      },
    ]);
    repo.findEnvironments.mockResolvedValue([]);
    repo.findServers.mockResolvedValue([]);
    repo.findClients.mockResolvedValue([]);

    const result = await service.search({
      query: "composer",
      roles: ["manager"],
      limit: 8,
    });

    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "project_tab",
          path: "/projects/9?tab=plugins",
        }),
      ]),
    );
  });

  it("returns matching security findings", async () => {
    repo.findSecurityFindings.mockResolvedValue([
      {
        id: BigInt(22),
        severity: "critical",
        status: "new",
        category: "VERSION_DISCLOSURE",
        title: "composer.json is publicly accessible",
        description: "Package metadata is exposed.",
        resource: "/app/composer.json",
        server: null,
        environment: {
          id: BigInt(11),
          type: "staging",
          url: "https://acme.test",
          project: { id: BigInt(7), name: "Acme Site" },
        },
      } as Awaited<
        ReturnType<SearchRepository["findSecurityFindings"]>
      >[number],
    ]);

    const result = await service.search({
      query: "composer",
      roles: ["manager"],
      limit: 8,
    });

    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "finding",
          path: "/security?tab=findings&findingId=22",
        }),
      ]),
    );
  });

  it("searches installed plugin and theme inventories", async () => {
    repo.findLatestInventoryScans.mockResolvedValue([
      {
        id: BigInt(11),
        type: "production",
        url: "https://acme.test",
        project: { id: BigInt(7), name: "Acme Site" },
        plugin_scans: [
          {
            plugins: {
              is_bedrock: true,
              plugins: [
                {
                  slug: "elementor",
                  name: "Elementor",
                  version: "3.25.0",
                  latest_version: "3.25.1",
                  update_available: true,
                  author: "Elementor",
                  plugin_uri: null,
                  description: null,
                  managed_by_composer: false,
                  composer_constraint: null,
                  status: "active",
                },
              ],
            },
            scanned_at: new Date("2026-09-01T00:00:00.000Z"),
          },
        ],
        theme_scans: [
          {
            themes: [
              {
                name: "generatepress",
                slug: "generatepress",
                title: "GeneratePress",
                status: "active",
                version: "3.5.1",
                update_version: null,
                update: "none",
                description: null,
                author: "Tom",
              },
            ],
            scanned_at: new Date("2026-09-01T00:00:00.000Z"),
          },
        ],
      },
    ] as unknown as Awaited<
      ReturnType<SearchRepository["findLatestInventoryScans"]>
    >);

    const pluginResults = await service.search({
      query: "Elementor",
      roles: ["manager"],
      limit: 8,
    });
    const themeResults = await service.search({
      query: "GeneratePress",
      roles: ["manager"],
      limit: 8,
    });

    expect(pluginResults.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "plugin",
          label: "Elementor",
          path: "/projects/7?tab=plugins&env=11",
        }),
      ]),
    );
    expect(themeResults.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "theme",
          label: "GeneratePress",
          path: "/projects/7?tab=themes&env=11",
        }),
      ]),
    );
  });
});
