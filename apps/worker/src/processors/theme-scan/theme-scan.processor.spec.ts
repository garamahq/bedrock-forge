/// <reference types="jest" />

import { ThemeScanProcessor, parseThemeListJson } from "./theme-scan.processor";
import { PrismaService } from "../../prisma/prisma.service";
import { SshKeyService } from "../../services/ssh-key.service";
import { ConfigService } from "@nestjs/config";
import { JOB_TYPES } from "@bedrock-forge/shared";
import { createRemoteExecutor } from "@bedrock-forge/remote-executor";

jest.mock("@bedrock-forge/remote-executor", () => ({
  createRemoteExecutor: jest.fn(),
}));

function makePrisma() {
  return {
    jobExecution: {
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    environment: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        id: BigInt(8),
        root_path: "/home/example.com/public_html",
        server: {
          ip_address: "203.0.113.10",
          ssh_port: 22,
          ssh_user: "root",
        },
      }),
    },
    themeScan: {
      create: jest.fn().mockResolvedValue({}),
    },
  };
}

function makeExecutor(
  resolver?: (cmd: string) => { code: number; stdout: string; stderr: string },
) {
  return {
    execute: jest.fn().mockImplementation((cmd: string) => {
      if (resolver) return Promise.resolve(resolver(cmd));
      if (cmd.startsWith("[ -d ")) {
        return Promise.resolve({ code: 0, stdout: "bedrock\n", stderr: "" });
      }
      if (cmd.startsWith("stat -c '%U'")) {
        return Promise.resolve({ code: 0, stdout: "siteuser\n", stderr: "" });
      }
      if (cmd.startsWith("ls /usr/local/lsws/")) {
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      }
      if (cmd.includes("theme list")) {
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify([
            {
              name: "twentytwentyfour",
              status: "active",
              version: "1.2",
              update: "none",
              title: "Twenty Twenty-Four",
              description: "Default theme",
              author: "WordPress.org",
            },
          ]),
          stderr: "",
        });
      }
      if (cmd.includes("core version")) {
        return Promise.resolve({ code: 0, stdout: "6.5.5\n", stderr: "" });
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    }),
  };
}

function makeJob() {
  return {
    id: "theme-job-001",
    name: JOB_TYPES.THEME_SCAN_RUN,
    data: { environmentId: 8, jobExecutionId: 99 },
    updateProgress: jest.fn(),
  } as any;
}

describe("theme scan parsing", () => {
  it("derives slug from WP-CLI theme name", () => {
    const result = parseThemeListJson(
      JSON.stringify([
        {
          name: "twentytwentyfour",
          status: "active",
          version: "1.0",
          update: "available",
          update_version: "1.1",
        },
      ]),
    );

    expect(result).toEqual([
      expect.objectContaining({
        name: "twentytwentyfour",
        slug: "twentytwentyfour",
        status: "active",
        title: "twentytwentyfour",
      }),
    ]);
  });

  it("throws a useful error for invalid JSON", () => {
    expect(() => parseThemeListJson("not-json")).toThrow(
      "wp theme list returned invalid JSON",
    );
  });
});

describe("ThemeScanProcessor", () => {
  let prisma: ReturnType<typeof makePrisma>;
  let executor: ReturnType<typeof makeExecutor>;
  let processor: ThemeScanProcessor;

  beforeEach(() => {
    prisma = makePrisma();
    executor = makeExecutor();
    (createRemoteExecutor as jest.Mock).mockReturnValue(executor);
    processor = new ThemeScanProcessor(
      prisma as unknown as PrismaService,
      {} as ConfigService,
      {
        resolvePrivateKey: jest.fn().mockResolvedValue("private-key"),
        getSshConfig: jest.fn().mockResolvedValue({
          host: "203.0.113.10",
          port: 22,
          username: "root",
          privateKey: "private-key",
        }),
      } as unknown as SshKeyService,
    );
  });

  it("runs wp theme list without requesting unsupported slug field", async () => {
    await processor.process(makeJob());

    const themeListCommand = executor.execute.mock.calls.find(
      ([cmd]: [string]) => cmd.includes("theme list"),
    )?.[0] as string;

    expect(themeListCommand).toContain(
      "--fields=name,status,version,update_version,update,title,description,author",
    );
    expect(themeListCommand).not.toContain("slug");
    expect(prisma.themeScan.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          themes: [
            expect.objectContaining({
              name: "twentytwentyfour",
              slug: "twentytwentyfour",
            }),
          ],
        }),
      }),
    );
  });

  it("retries without field filter when WP-CLI rejects requested fields", async () => {
    let themeListCalls = 0;
    executor = makeExecutor((cmd: string) => {
      if (cmd.startsWith("[ -d "))
        return { code: 0, stdout: "bedrock\n", stderr: "" };
      if (cmd.startsWith("stat -c '%U'"))
        return { code: 0, stdout: "siteuser\n", stderr: "" };
      if (cmd.startsWith("ls /usr/local/lsws/"))
        return { code: 0, stdout: "", stderr: "" };
      if (cmd.includes("theme list")) {
        themeListCalls += 1;
        if (themeListCalls === 1) {
          return {
            code: 1,
            stdout: "",
            stderr: "Error: Invalid field: title.",
          };
        }
        return {
          code: 0,
          stdout: JSON.stringify([
            {
              name: "custom-theme",
              status: "inactive",
              version: "2.0",
              update: "none",
            },
          ]),
          stderr: "",
        };
      }
      if (cmd.includes("core version"))
        return { code: 0, stdout: "6.5.5\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    (createRemoteExecutor as jest.Mock).mockReturnValue(executor);
    processor = new ThemeScanProcessor(
      prisma as unknown as PrismaService,
      {} as ConfigService,
      {
        resolvePrivateKey: jest.fn().mockResolvedValue("private-key"),
        getSshConfig: jest.fn().mockResolvedValue({
          host: "203.0.113.10",
          port: 22,
          username: "root",
          privateKey: "private-key",
        }),
      } as unknown as SshKeyService,
    );

    await processor.process(makeJob());

    const themeCommands = executor.execute.mock.calls
      .map(([cmd]: [string]) => cmd)
      .filter((cmd: string) => cmd.includes("theme list"));
    expect(themeCommands).toHaveLength(2);
    expect(themeCommands[0]).toContain("--fields=");
    expect(themeCommands[1]).not.toContain("--fields=");
    expect(prisma.themeScan.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          themes: [expect.objectContaining({ slug: "custom-theme" })],
        }),
      }),
    );
  });
});
