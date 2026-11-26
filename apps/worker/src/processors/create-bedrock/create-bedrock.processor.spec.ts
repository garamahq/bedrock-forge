import { Test } from "@nestjs/testing";
import { getQueueToken } from "@nestjs/bullmq";
import { JOB_TYPES, QUEUES } from "@bedrock-forge/shared";
import { createRemoteExecutor } from "@bedrock-forge/remote-executor";
import { CreateBedrockProcessor } from "./create-bedrock.processor";
import { PrismaService } from "../../prisma/prisma.service";
import { SshKeyService } from "../../services/ssh-key.service";
import { EncryptionService } from "../../encryption/encryption.service";
import { callCpApi } from "../../utils/cyberpanel-http";

jest.mock("@bedrock-forge/remote-executor", () => ({
  createRemoteExecutor: jest.fn(),
}));

jest.mock("../../utils/cyberpanel-http", () => {
  const actual = jest.requireActual("../../utils/cyberpanel-http");
  return {
    ...actual,
    callCpApi: jest.fn().mockResolvedValue({ status: 1 }),
  };
});

jest.mock("../../utils/processor-utils", () => {
  const actual = jest.requireActual("../../utils/processor-utils");
  return {
    ...actual,
    fixCyberPanelOwnership: jest.fn().mockResolvedValue({}),
  };
});

describe("CreateBedrockProcessor credential resolution (#108)", () => {
  let processor: CreateBedrockProcessor;
  let prisma: {
    jobExecution: { update: jest.Mock };
    environment: {
      findUnique: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      count: jest.Mock;
    };
    wpDbCredentials: { findUnique: jest.Mock; upsert: jest.Mock };
    project: { delete: jest.Mock };
  };
  let encryption: { decrypt: jest.Mock; encrypt: jest.Mock };
  let executor: { execute: jest.Mock; pushFile: jest.Mock };

  beforeEach(async () => {
    prisma = {
      jobExecution: { update: jest.fn().mockResolvedValue({}) },
      environment: {
        findUnique: jest.fn().mockResolvedValue(null),
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: BigInt(42),
          project_id: BigInt(10),
          type: "production",
          url: "https://secure.example.test",
          root_path: "/home/secure.example.test/public_html",
          server: {
            id: BigInt(5),
            ip_address: "198.51.100.10",
            cyberpanel_login: "enc:cp",
          },
        }),
        count: jest.fn().mockResolvedValue(1),
      },
      wpDbCredentials: {
        findUnique: jest.fn(),
        upsert: jest.fn().mockResolvedValue({}),
      },
      project: { delete: jest.fn().mockResolvedValue({}) },
    };

    encryption = {
      decrypt: jest.fn((val: string) => {
        if (val === "enc:cp") {
          return JSON.stringify({
            url: "https://cp.example.test:8090",
            username: "admin",
            password: "cp-password",
          });
        }
        return val.replace(/^enc:/, "");
      }),
      encrypt: jest.fn((val: string) => `enc:${val}`),
    };

    executor = {
      execute: jest.fn().mockResolvedValue({ code: 0, stdout: "ok", stderr: "" }),
      pushFile: jest.fn().mockResolvedValue(undefined),
    };
    (createRemoteExecutor as jest.Mock).mockReturnValue(executor);
    (callCpApi as jest.Mock).mockClear();

    const module = await Test.createTestingModule({
      providers: [
        CreateBedrockProcessor,
        { provide: PrismaService, useValue: prisma },
        {
          provide: SshKeyService,
          useValue: {
            getSshConfig: jest.fn().mockResolvedValue({
              host: "198.51.100.10",
              port: 22,
              username: "root",
              privateKey: "key",
            }),
          },
        },
        { provide: EncryptionService, useValue: encryption },
        {
          provide: getQueueToken(QUEUES.BACKUPS),
          useValue: { add: jest.fn().mockResolvedValue({ id: "b1" }) },
        },
      ],
    }).compile();

    processor = module.get(CreateBedrockProcessor);
  });

  it("resolves DB password from encrypted WpDbCredentials when omitted from job payload", async () => {
    prisma.wpDbCredentials.findUnique.mockResolvedValue({
      db_password_encrypted: "enc:syntHetic-Stored-Pass-99",
    });

    const job = {
      id: "cb-1",
      name: JOB_TYPES.PROJECT_CREATE_BEDROCK,
      data: {
        environmentId: 42,
        jobExecutionId: 99,
        cyberpanel: {
          domain: "secure.example.test",
          dbName: "wp_sec",
          dbUser: "u_sec",
          dbHost: "localhost",
          phpVersion: "8.3",
          adminEmail: "admin@example.test",
        },
      },
      updateProgress: jest.fn().mockResolvedValue(undefined),
    } as any;

    await processor.process(job);

    expect(prisma.wpDbCredentials.findUnique).toHaveBeenCalledWith({
      where: { environment_id: BigInt(42) },
    });
    expect(callCpApi).toHaveBeenCalledWith(
      expect.any(Object),
      "/api/submitDBCreation",
      expect.objectContaining({
        dbName: "wp_sec",
        dbUsername: "u_sec",
        dbPassword: "syntHetic-Stored-Pass-99",
      }),
    );

    const envPushCall = executor.pushFile.mock.calls.find(
      ([arg]: [{ remotePath: string }]) => arg.remotePath.endsWith("/.env"),
    );
    expect(envPushCall).toBeDefined();
    expect(envPushCall[0].content.toString("utf-8")).toContain(
      "DB_PASSWORD='syntHetic-Stored-Pass-99'",
    );
  });

  it("throws when cyberpanel.dbPassword is omitted and WpDbCredentials is missing", async () => {
    prisma.wpDbCredentials.findUnique.mockResolvedValue(null);

    const job = {
      id: "cb-missing",
      name: JOB_TYPES.PROJECT_CREATE_BEDROCK,
      data: {
        environmentId: 42,
        jobExecutionId: 99,
        cyberpanel: {
          domain: "secure.example.test",
          dbName: "wp_sec",
          dbUser: "u_sec",
          dbHost: "localhost",
          phpVersion: "8.3",
        },
      },
      updateProgress: jest.fn().mockResolvedValue(undefined),
    } as any;

    await expect(processor.process(job)).rejects.toThrow(
      "has no stored DB credentials for provisioning",
    );
    expect(callCpApi).not.toHaveBeenCalled();
  });
});

describe("CreateBedrockProcessor clone & git deploy safety (#90, #91, #92, #110, #113)", () => {
  let processor: CreateBedrockProcessor;
  let prisma: any;
  let encryption: { decrypt: jest.Mock; encrypt: jest.Mock };
  let sshKey: { getSshConfig: jest.Mock; resolvePrivateKey: jest.Mock };
  let srcExecutor: {
    execute: jest.Mock;
    pushFile: jest.Mock;
    pullFile: jest.Mock;
  };
  let tgtExecutor: {
    execute: jest.Mock;
    pushFile: jest.Mock;
    pullFile: jest.Mock;
  };

  function makeEnvRecord(overrides: Record<string, any> = {}) {
    return {
      id: BigInt(42),
      project_id: BigInt(10),
      type: "staging",
      url: "https://clone.example.test",
      root_path: "/home/clone.example.test/public_html",
      git_remote_url: "https://github.com/org/repo.git",
      git_branch: "main",
      server: {
        id: BigInt(5),
        name: "Target Server",
        ip_address: "198.51.100.10",
        ssh_port: 22,
        ssh_user: "root",
        ssh_private_key_encrypted: "enc:tgt-key",
        host_key_fingerprint: null,
        cyberpanel_login: "enc:cp",
      },
      project: { github_repo: "org/repo" },
      ...overrides,
    };
  }

  function makeSourceEnvRecord(overrides: Record<string, any> = {}) {
    return {
      id: BigInt(7),
      project_id: BigInt(10),
      type: "production",
      url: "https://source.example.test",
      root_path: "/home/source.example.test/public_html",
      server: {
        id: BigInt(5),
        name: "Source Server",
        ip_address: "198.51.100.20",
        ssh_port: 2222,
        ssh_user: "deploy",
        ssh_private_key_encrypted: "enc:src-key",
        host_key_fingerprint: null,
      },
      wp_db_credentials: {
        db_name_encrypted: "enc:src_db",
        db_user_encrypted: "enc:src_user",
        db_password_encrypted: "enc:src-secret-pass",
        db_host_encrypted: "enc:src-db.internal",
      },
      ...overrides,
    };
  }

  beforeEach(async () => {
    prisma = {
      jobExecution: {
        findUnique: jest.fn().mockResolvedValue({ execution_log: [] }),
        update: jest.fn().mockResolvedValue({}),
      },
      environment: {
        findUnique: jest.fn().mockResolvedValue(null),
        findUniqueOrThrow: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        delete: jest.fn().mockResolvedValue({}),
        count: jest.fn().mockResolvedValue(1),
      },
      wpDbCredentials: {
        findUnique: jest.fn().mockResolvedValue({
          db_password_encrypted: "enc:tgt-secret-pass",
        }),
        upsert: jest.fn().mockResolvedValue({}),
      },
      project: { delete: jest.fn().mockResolvedValue({}) },
    };

    encryption = {
      decrypt: jest.fn((val: string) => {
        if (val === "enc:cp") {
          return JSON.stringify({
            url: "https://cp.example.test:8090",
            username: "admin",
            password: "cp-password",
          });
        }
        return val.replace(/^enc:/, "");
      }),
      encrypt: jest.fn((val: string) => `enc:${val}`),
    };

    sshKey = {
      getSshConfig: jest.fn().mockImplementation(async (server: any) => ({
        host: server.ip_address,
        port: server.ssh_port ?? 22,
        username: server.ssh_user ?? "root",
        privateKey: `key-for-${server.id}`,
      })),
      resolvePrivateKey: jest
        .fn()
        .mockResolvedValue("-----BEGIN OPENSSH PRIVATE KEY-----\nsrc\n-----END OPENSSH PRIVATE KEY-----"),
    };

    srcExecutor = {
      execute: jest.fn().mockResolvedValue({ code: 0, stdout: "ok", stderr: "" }),
      pushFile: jest.fn().mockResolvedValue(undefined),
      pullFile: jest.fn().mockResolvedValue(Buffer.from("-- sql dump\n")),
    };
    tgtExecutor = {
      execute: jest.fn().mockResolvedValue({ code: 0, stdout: "ok", stderr: "" }),
      pushFile: jest.fn().mockResolvedValue(undefined),
      pullFile: jest.fn().mockResolvedValue(Buffer.from("")),
    };

    (createRemoteExecutor as jest.Mock).mockImplementation((cfg: any) =>
      cfg.host === "198.51.100.20" ? srcExecutor : tgtExecutor,
    );
    (callCpApi as jest.Mock).mockClear();

    const module = await Test.createTestingModule({
      providers: [
        CreateBedrockProcessor,
        { provide: PrismaService, useValue: prisma },
        { provide: SshKeyService, useValue: sshKey },
        { provide: EncryptionService, useValue: encryption },
        {
          provide: getQueueToken(QUEUES.BACKUPS),
          useValue: { add: jest.fn().mockResolvedValue({ id: "b1" }) },
        },
      ],
    }).compile();

    processor = module.get(CreateBedrockProcessor);
  });

  function makeCloneJob(dbHost?: string) {
    return {
      id: "clone-1",
      name: JOB_TYPES.PROJECT_CREATE_BEDROCK,
      data: {
        environmentId: 42,
        jobExecutionId: 99,
        sourceEnvironmentId: 7,
        cyberpanel: {
          domain: "clone.example.test",
          dbName: "wp_tgt",
          dbUser: "u_tgt",
          ...(dbHost !== undefined ? { dbHost } : {}),
          phpVersion: "8.3",
          adminEmail: "admin@example.test",
        },
      },
      updateProgress: jest.fn().mockResolvedValue(undefined),
    } as any;
  }

  it("checks root_path and rsync exit codes before emitting Files synced on same-server clone (#90)", async () => {
    const tgtEnv = makeEnvRecord();
    const srcSameMissingPath = makeSourceEnvRecord({
      root_path: "",
      server: tgtEnv.server,
    });
    prisma.environment.findUniqueOrThrow
      .mockResolvedValueOnce(tgtEnv)
      .mockResolvedValueOnce(srcSameMissingPath);

    const jobMissingPath = makeCloneJob("localhost");
    await expect(processor.process(jobMissingPath)).rejects.toThrow(/root_path/i);
    expect(jobMissingPath.updateProgress).not.toHaveBeenCalledWith(
      expect.objectContaining({ step: "Files synced" }),
    );

    // Non-zero exit (unavailable rsync 127 & transfer failure 23)
    for (const exitCode of [127, 23]) {
      const tgtEnv2 = makeEnvRecord();
      const srcSameServer = makeSourceEnvRecord({ server: tgtEnv2.server });
      prisma.environment.findUniqueOrThrow
        .mockResolvedValueOnce(tgtEnv2)
        .mockResolvedValueOnce(srcSameServer);
      tgtExecutor.execute.mockImplementation(async (cmd: string) => {
        if (cmd.includes("rsync -a --delete")) {
          return {
            code: exitCode,
            stdout: "",
            stderr: exitCode === 127 ? "rsync: command not found" : "rsync error",
          };
        }
        return { code: 0, stdout: "ok", stderr: "" };
      });
      srcExecutor.execute.mockResolvedValue({ code: 0, stdout: "ok", stderr: "" });

      const jobFailRsync = makeCloneJob("localhost");
      await expect(processor.process(jobFailRsync)).rejects.toThrow(/rsync/i);
      expect(jobFailRsync.updateProgress).not.toHaveBeenCalledWith(
        expect.objectContaining({ step: "Files synced" }),
      );
      expect(jobFailRsync.updateProgress).toHaveBeenCalledWith(
        expect.objectContaining({ step: "Database imported" }),
      );
    }
  });

  it("threads custom source ssh_port and surfaces copy-stage failure after DB import (#91)", async () => {
    const tgtEnv = makeEnvRecord();
    const srcEnvCustomPort = makeSourceEnvRecord({
      server: {
        id: BigInt(6),
        name: "Remote Custom Port",
        ip_address: "198.51.100.20",
        ssh_port: 2222,
        ssh_user: "deploy",
        ssh_private_key_encrypted: "enc:src-key",
        host_key_fingerprint: null,
      },
    });
    prisma.environment.findUniqueOrThrow
      .mockResolvedValueOnce(tgtEnv)
      .mockResolvedValueOnce(srcEnvCustomPort);

    await processor.process(makeCloneJob("localhost"));

    const sshPipeCmd = tgtExecutor.execute.mock.calls
      .map(([cmd]: [string]) => cmd)
      .find((cmd) => cmd.includes("tar -cz") && cmd.includes("tar -xz"));
    expect(sshPipeCmd).toBeDefined();
    expect(sshPipeCmd).toContain("-p 2222");

    // Standard port 22 also explicitly passed & error identifies copy stage
    prisma.environment.findUniqueOrThrow
      .mockResolvedValueOnce(tgtEnv)
      .mockResolvedValueOnce({
        ...srcEnvCustomPort,
        server: { ...srcEnvCustomPort.server, ssh_port: 22 },
      });
    tgtExecutor.execute.mockImplementation(async (cmd: string) => {
      if (cmd.includes("tar -cz") && cmd.includes("tar -xz")) {
        expect(cmd).toContain("-p 22");
        return { code: 255, stdout: "", stderr: "Connection refused" };
      }
      return { code: 0, stdout: "ok", stderr: "" };
    });

    await expect(processor.process(makeCloneJob("localhost"))).rejects.toThrow(
      /transfer files.*after DB import|copy stage/i,
    );
  });

  it("threads consistent target dbHost across import, search-replace, .env, and credential storage (#110)", async () => {
    for (const host of ["localhost", "db.custom.internal"]) {
      tgtExecutor.execute.mockClear().mockResolvedValue({ code: 0, stdout: "ok", stderr: "" });
      tgtExecutor.pushFile.mockClear();
      prisma.wpDbCredentials.upsert.mockClear();
      (callCpApi as jest.Mock).mockClear();

      const tgtEnv = makeEnvRecord();
      const srcEnv = makeSourceEnvRecord({
        server: {
          id: BigInt(6),
          name: "Remote Source",
          ip_address: "198.51.100.20",
          ssh_port: 22,
          ssh_user: "deploy",
          ssh_private_key_encrypted: "enc:src-key",
          host_key_fingerprint: null,
        },
      });
      prisma.environment.findUniqueOrThrow
        .mockResolvedValueOnce(tgtEnv)
        .mockResolvedValueOnce(srcEnv);

      await processor.process(makeCloneJob(host));

      const myCnfPayloads = tgtExecutor.pushFile.mock.calls
        .filter(([arg]: [{ remotePath: string }]) => arg.remotePath.endsWith(".cnf"))
        .map(([arg]: [{ content: Buffer }]) => arg.content.toString("utf-8"));
      expect(myCnfPayloads.length).toBeGreaterThanOrEqual(2);
      for (const cnf of myCnfPayloads) {
        expect(cnf).toContain(`host=${host}\n`);
      }

      const envCall = tgtExecutor.pushFile.mock.calls.find(
        ([arg]: [{ remotePath: string }]) =>
          arg.remotePath === "/home/clone.example.test/public_html/.env",
      );
      expect(envCall).toBeDefined();
      const envText = envCall[0].content.toString("utf-8");
      expect(envText).toContain(`DB_HOST='${host}'`);
      expect(envText).toContain("DB_PASSWORD='tgt-secret-pass'");
      expect(envText).not.toContain("src-secret-pass");

      expect(prisma.wpDbCredentials.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            db_host_encrypted: `enc:${host}`,
            db_password_encrypted: "enc:tgt-secret-pass",
          }),
        }),
      );
    }

    // Rejects invalid/unsafe dbHost before touching CyberPanel resources
    (callCpApi as jest.Mock).mockClear();
    prisma.environment.findUniqueOrThrow.mockResolvedValueOnce(makeEnvRecord());
    await expect(
      processor.process(makeCloneJob("bad host; rm -rf /")),
    ).rejects.toThrow(/dbHost|database host/i);
    expect(callCpApi).not.toHaveBeenCalled();
  });

  it("removes copied source .env and writes target .env BEFORE any WP-CLI commands in both same-server and cross-server clones (#113)", async () => {
    for (const sameServer of [true, false]) {
      const events: string[] = [];
      tgtExecutor.execute.mockImplementation(async (cmd: string) => {
        if (cmd.includes("rm -f") && cmd.includes("/.env")) {
          events.push("rm-source-env");
        } else if (cmd.includes("cache flush")) {
          events.push("wp-cache-flush");
        } else if (cmd.includes("rewrite flush")) {
          events.push("wp-rewrite-flush");
        }
        return { code: 0, stdout: "ok", stderr: "" };
      });
      tgtExecutor.pushFile.mockImplementation(
        async (arg: { remotePath: string; content: Buffer }) => {
          if (arg.remotePath === "/home/clone.example.test/public_html/.env") {
            events.push("write-target-env");
          }
        },
      );

      const tgtEnv = makeEnvRecord();
      const srcEnv = makeSourceEnvRecord({
        server: sameServer
          ? tgtEnv.server
          : {
              id: BigInt(6),
              name: "Remote Source",
              ip_address: "198.51.100.20",
              ssh_port: 2222,
              ssh_user: "deploy",
              ssh_private_key_encrypted: "enc:src-key",
              host_key_fingerprint: null,
            },
      });
      prisma.environment.findUniqueOrThrow
        .mockResolvedValueOnce(tgtEnv)
        .mockResolvedValueOnce(srcEnv);

      await processor.process(makeCloneJob("127.0.0.1"));

      const rmIdx = events.indexOf("rm-source-env");
      const writeIdx = events.indexOf("write-target-env");
      const cacheIdx = events.indexOf("wp-cache-flush");
      const rewriteIdx = events.indexOf("wp-rewrite-flush");
      expect(rmIdx).toBeGreaterThanOrEqual(0);
      expect(writeIdx).toBeGreaterThan(rmIdx);
      expect(cacheIdx).toBeGreaterThan(writeIdx);
      expect(rewriteIdx).toBeGreaterThan(writeIdx);
    }

    // If writing target .env fails, copied source .env was removed and zero WP-CLI commands run
    const wpCmdsAfterEnvFail: string[] = [];
    tgtExecutor.execute.mockImplementation(async (cmd: string) => {
      if (cmd.includes("cache flush") || cmd.includes("rewrite flush")) {
        wpCmdsAfterEnvFail.push(cmd);
      }
      return { code: 0, stdout: "ok", stderr: "" };
    });
    tgtExecutor.pushFile.mockImplementation(
      async (arg: { remotePath: string }) => {
        if (arg.remotePath === "/home/clone.example.test/public_html/.env") {
          throw new Error("SFTP permission denied writing .env");
        }
      },
    );
    const tgtEnv = makeEnvRecord();
    prisma.environment.findUniqueOrThrow
      .mockResolvedValueOnce(tgtEnv)
      .mockResolvedValueOnce(makeSourceEnvRecord({ server: tgtEnv.server }));

    await expect(processor.process(makeCloneJob("localhost"))).rejects.toThrow(
      /SFTP permission denied writing \.env/,
    );
    expect(wpCmdsAfterEnvFail).toHaveLength(0);
  });

  function makeGitDeployJob(overrides: Record<string, any> = {}) {
    return {
      id: "gd-1",
      name: JOB_TYPES.PROJECT_GIT_DEPLOY,
      data: {
        environmentId: 42,
        jobExecutionId: 99,
        branch: "main",
        runComposer: true,
        updateDb: true,
        flushCache: true,
        ...overrides,
      },
      updateProgress: jest.fn().mockResolvedValue(undefined),
    } as any;
  }

  it.each([
    ["git fetch failure", "git fetch", 128, "fatal: could not read from remote"],
    ["git checkout failure", "git checkout", 1, "error: pathspec did not match"],
    ["composer install failure", "composer install", 2, "Your lock file does not contain a compatible set of packages"],
    ["wp core update-db failure", "core update-db", 1, "Error establishing a database connection"],
  ])(
    "aborts git deploy and fails job on %s without bumping git_last_deployed_at (#92)",
    async (_label, failingCmdFragment, exitCode, stderr) => {
      prisma.environment.findUniqueOrThrow.mockResolvedValue(makeEnvRecord());
      const executed: string[] = [];
      tgtExecutor.execute.mockImplementation(async (cmd: string) => {
        executed.push(cmd);
        if (cmd.includes("command -v git") || cmd.includes("test -d") || cmd.includes("test -f")) {
          return { code: 0, stdout: cmd.includes("test -f") ? "found" : "yes", stderr: "" };
        }
        if (cmd.includes("git rev-parse HEAD")) {
          return { code: 0, stdout: "abcdef1234567890\nabcdef1234567890\n", stderr: "" };
        }
        if (cmd.includes(failingCmdFragment)) {
          return { code: exitCode, stdout: "", stderr };
        }
        return { code: 0, stdout: "ok", stderr: "" };
      });

      await expect(processor.process(makeGitDeployJob())).rejects.toThrow();
      expect(prisma.environment.update).not.toHaveBeenCalled();
      expect(prisma.jobExecution.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: BigInt(99) },
          data: expect.objectContaining({ status: "failed" }),
        }),
      );
      if (failingCmdFragment === "git fetch") {
        expect(executed.some((c) => c.includes("git checkout"))).toBe(false);
        expect(executed.some((c) => c.includes("composer install"))).toBe(false);
      }
      if (failingCmdFragment === "composer install") {
        expect(executed.some((c) => c.includes("core update-db"))).toBe(false);
        expect(executed.some((c) => c.includes("cache flush"))).toBe(false);
      }
      if (failingCmdFragment === "core update-db") {
        expect(executed.some((c) => c.includes("cache flush"))).toBe(false);
      }
    },
  );

  it("fails git deploy if verified HEAD does not match requested commitSha or remote ref (#92)", async () => {
    prisma.environment.findUniqueOrThrow.mockResolvedValue(makeEnvRecord());
    const executed: string[] = [];
    tgtExecutor.execute.mockImplementation(async (cmd: string) => {
      executed.push(cmd);
      if (cmd.includes("test -d") || cmd.includes("command -v git")) {
        return { code: 0, stdout: "yes", stderr: "" };
      }
      if (cmd.includes("git rev-parse HEAD")) {
        return { code: 0, stdout: "1111111111111111\n2222222222222222\n", stderr: "" };
      }
      return { code: 0, stdout: "ok", stderr: "" };
    });

    await expect(
      processor.process(makeGitDeployJob({ commitSha: "2222222222222222" })),
    ).rejects.toThrow(/HEAD|revision|commit/i);
    expect(prisma.environment.update).not.toHaveBeenCalled();
    expect(executed.some((c) => c.includes("composer install"))).toBe(false);
  });
});
