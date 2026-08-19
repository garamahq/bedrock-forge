import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { WpActionsProcessor, parseWpVersion, parseWpUpdatesJson } from "./wp-actions.processor";
import { PrismaService } from "../../prisma/prisma.service";
import { SshKeyService } from "../../services/ssh-key.service";
import { JOB_TYPES } from "@bedrock-forge/shared";
import { createRemoteExecutor } from "@bedrock-forge/remote-executor";

jest.mock("@bedrock-forge/remote-executor", () => ({
  createRemoteExecutor: jest.fn(),
}));

describe("parseWpVersion", () => {
  it("parses a clean version string", () => {
    expect(parseWpVersion("6.4.3")).toBe("6.4.3");
    expect(parseWpVersion("  6.4.3 \n")).toBe("6.4.3");
  });

  it("handles PHP warning prepended to version string", () => {
    const stdout = `
PHP Warning: Deprecated: Requests_Cookie_Jar::offsetExists() in /var/www/wp/wp-includes/Requests/Cookie/Jar.php on line 36
6.4.3
    `;
    expect(parseWpVersion(stdout)).toBe("6.4.3");
  });

  it("handles multiple warnings and a trailing version", () => {
    const stdout = `
Deprecated: Return type of Requests_Cookie_Jar::offsetExists($key)
PHP Deprecated: Automatically populating $HTTP_RAW_POST_DATA
6.5-RC1
    `;
    expect(parseWpVersion(stdout)).toBe("6.5-RC1");
  });

  it("parses $wp_version = '6.4.3'; from version.php format", () => {
    const stdout = "$wp_version = '6.4.3';";
    expect(parseWpVersion(stdout)).toBe("6.4.3");
  });

  it("falls back to the last line if no line matches standard version pattern", () => {
    expect(parseWpVersion("some random stdout line")).toBe("some random stdout line");
    expect(parseWpVersion("")).toBe("");
  });
});

describe("parseWpUpdatesJson", () => {
  it("parses clean JSON array", () => {
    const json = '[{"version":"6.5","update_type":"major"}]';
    expect(parseWpUpdatesJson(json)).toEqual([
      { version: "6.5", update_type: "major" },
    ]);
  });

  it("parses JSON array with prepended warnings", () => {
    const stdout = `
PHP Warning: Some notice here
[{"version":"6.5","update_type":"major"}]
    `;
    expect(parseWpUpdatesJson(stdout)).toEqual([
      { version: "6.5", update_type: "major" },
    ]);
  });

  it("throws on invalid JSON that does not contain array markers", () => {
    expect(() => parseWpUpdatesJson("not a json array")).toThrow();
  });
});

describe("WpActionsProcessor - processCoreCheck & processCoreUpdate", () => {
  let processor: WpActionsProcessor;
  let prisma: any;
  let executor: any;

  beforeEach(async () => {
    prisma = {
      jobExecution: {
        update: jest.fn().mockResolvedValue({}),
        create: jest.fn().mockResolvedValue({ id: BigInt(99) }),
      },
      environment: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: BigInt(3),
          root_path: "/var/www/site",
          server: {
            ip_address: "1.2.3.4",
            ssh_port: 22,
            ssh_user: "siteuser",
          },
        }),
      },
      stepLog: {
        create: jest.fn().mockResolvedValue({}),
      },
      commandExecution: {
        create: jest.fn().mockResolvedValue({}),
      },
    };

    executor = {
      execute: jest.fn().mockImplementation((cmd: string) => {
        if (cmd.includes("[ -d ")) {
          return Promise.resolve({ code: 0, stdout: "bedrock", stderr: "" });
        }
        if (cmd.includes("stat -c '%U'")) {
          return Promise.resolve({ code: 0, stdout: "siteuser", stderr: "" });
        }
        if (cmd.includes("core version")) {
          return Promise.resolve({
            code: 0,
            stdout: "PHP Warning: notice\n6.4.3\n",
            stderr: "",
          });
        }
        if (cmd.includes("core check-update")) {
          return Promise.resolve({
            code: 0,
            stdout: 'PHP Notice: deprecation\n[{"version":"6.5","update_type":"major"}]\n',
            stderr: "",
          });
        }
        if (cmd.includes("core update ")) {
          return Promise.resolve({
            code: 0,
            stdout: "WordPress updated successfully\n",
            stderr: "",
          });
        }
        if (cmd.includes("core update-db")) {
          return Promise.resolve({
            code: 0,
            stdout: "Database updated successfully\n",
            stderr: "",
          });
        }
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      }),
    };

    (createRemoteExecutor as jest.Mock).mockReturnValue(executor);

    const module = await Test.createTestingModule({
      providers: [
        WpActionsProcessor,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue("/tmp/scripts") } },
        {
          provide: SshKeyService,
          useValue: {
            resolvePrivateKey: jest.fn().mockResolvedValue("fake-key"),
            getSshConfig: jest.fn().mockImplementation(async (server: any) => ({
              host: server.ip_address,
              port: server.ssh_port,
              username: server.ssh_user,
              privateKey: "fake-key",
            })),
          },
        },
      ],
    }).compile();

    processor = module.get(WpActionsProcessor);
  });

  it("performs wp core-check successfully with warned outputs", async () => {
    const job = {
      id: "job-check-1",
      name: JOB_TYPES.WP_CORE_CHECK,
      data: { environmentId: 3, jobExecutionId: 101 },
      updateProgress: jest.fn(),
    } as any;

    const result = await processor.process(job);

    expect(result).toEqual({
      current_version: "6.4.3",
      updates: [{ version: "6.5", update_type: "major" }],
    });
    expect(prisma.jobExecution.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: BigInt(101) },
        data: expect.objectContaining({
          status: "completed",
        }),
      }),
    );
  });

  it("performs wp core-update successfully and cleans final version", async () => {
    const job = {
      id: "job-update-1",
      name: JOB_TYPES.WP_CORE_UPDATE,
      data: { environmentId: 3, jobExecutionId: 102 },
      updateProgress: jest.fn(),
    } as any;

    const result = await processor.process(job);

    expect(result).toEqual({
      updated: true,
      new_version: "6.4.3",
      update_output: "WordPress updated successfully\n",
      db_update_output: "Database updated successfully\n",
    });
    expect(prisma.jobExecution.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: BigInt(102) },
        data: expect.objectContaining({
          status: "completed",
        }),
      }),
    );
  });
});
