import { Test } from "@nestjs/testing";
import { getQueueToken } from "@nestjs/bullmq";
import { JOB_TYPES, QUEUES } from "@bedrock-forge/shared";
import { createRemoteExecutor } from "@bedrock-forge/remote-executor";
import { mkdtemp, rm, stat, writeFile, readdir } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Readable } from "stream";
import { CreateBedrockProcessor } from "./create-bedrock.processor";
import { PrismaService } from "../../prisma/prisma.service";
import { SshKeyService } from "../../services/ssh-key.service";
import { EncryptionService } from "../../encryption/encryption.service";

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

async function drainStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

describe("CreateBedrockProcessor clone DB streaming transfer (#107)", () => {
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
  let targetExecutor: {
    execute: jest.Mock;
    pushFile: jest.Mock;
    pullFile: jest.Mock;
    pullFileToPath: jest.Mock;
    pushFileFromStream: jest.Mock;
  };
  let sourceExecutor: {
    execute: jest.Mock;
    pushFile: jest.Mock;
    pullFile: jest.Mock;
    pullFileToPath: jest.Mock;
    pushFileFromStream: jest.Mock;
  };
  let sandboxPrefix: string;
  let observedLocalDirs: string[];

  beforeEach(async () => {
    sandboxPrefix = `bf-cb-stream-${Date.now()}-${Math.random().toString(36).slice(2, 7)}-`;
    observedLocalDirs = [];

    prisma = {
      jobExecution: { update: jest.fn().mockResolvedValue({}) },
      environment: {
        findUnique: jest.fn().mockResolvedValue(null),
        findUniqueOrThrow: jest.fn().mockImplementation(async ({ where }: { where: { id: bigint } }) => {
          if (where.id === BigInt(10)) {
            return {
              id: BigInt(10),
              project_id: BigInt(1),
              type: "staging",
              url: "https://source.test",
              root_path: "/home/source.test/public_html",
              server: {
                id: BigInt(1),
                name: "source-host",
                ip_address: "198.51.100.1",
                ssh_port: 22,
                ssh_user: "root",
                cyberpanel_login: null,
              },
              wp_db_credentials: {
                db_name_encrypted: "enc:src_db",
                db_user_encrypted: "enc:src_user",
                db_password_encrypted: "enc:src_pass",
                db_host_encrypted: "enc:localhost",
              },
            };
          }
          return {
            id: BigInt(20),
            project_id: BigInt(1),
            type: "production",
            url: "https://target.test",
            root_path: "/home/target.test/public_html",
            server: {
              id: BigInt(2),
              name: "target-host",
              ip_address: "198.51.100.2",
              ssh_port: 22,
              cyberpanel_login: null,
            },
          };
        }),
        count: jest.fn().mockResolvedValue(1),
      },
      wpDbCredentials: {
        findUnique: jest.fn(),
        upsert: jest.fn().mockResolvedValue({}),
      },
      project: { delete: jest.fn().mockResolvedValue({}) },
    };

    const payloadChunks = [
      Buffer.from("-- SQL header\n".repeat(4000)),
      Buffer.from("INSERT INTO wp_posts VALUES (1, 'https://source.test');\n".repeat(3000)),
    ];
    const fullDump = Buffer.concat(payloadChunks);

    sourceExecutor = {
      execute: jest.fn().mockResolvedValue({ code: 0, stdout: "ok", stderr: "" }),
      pushFile: jest.fn().mockResolvedValue(undefined),
      pullFile: jest.fn().mockRejectedValue(new Error("pullFile must NOT be used for large DB dumps")),
      pullFileToPath: jest.fn(async (_remotePath: string, localPath: string) => {
        observedLocalDirs.push(join(localPath, ".."));
        await writeFile(localPath, fullDump);
      }),
      pushFileFromStream: jest.fn(),
    };

    let capturedStreamMode = 0;
    let capturedBytes: Buffer | null = null;
    targetExecutor = {
      execute: jest.fn().mockResolvedValue({ code: 0, stdout: "ok", stderr: "" }),
      pushFile: jest.fn().mockImplementation(async ({ remotePath }: { remotePath: string }) => {
        if (remotePath.includes("cb_clone_")) {
          throw new Error("pushFile(Buffer) must NOT be used for DB dump upload");
        }
      }),
      pullFile: jest.fn(),
      pullFileToPath: jest.fn(),
      pushFileFromStream: jest.fn(async (_remotePath: string, stream: Readable) => {
        // Verify local staged file was tightened to 0600 before streaming out
        const localDir = observedLocalDirs[0];
        if (localDir) {
          const files = await readdir(localDir);
          if (files[0]) {
            const st = await stat(join(localDir, files[0]));
            capturedStreamMode = st.mode & 0o777;
          }
        }
        capturedBytes = await drainStream(stream);
      }),
    };
    (targetExecutor as Record<string, unknown>).getCapturedStats = () => ({
      mode: capturedStreamMode,
      size: capturedBytes?.length ?? 0,
      match: capturedBytes ? capturedBytes.equals(fullDump) : false,
    });

    (createRemoteExecutor as jest.Mock).mockImplementation((cfg: { host?: string }) =>
      cfg?.host === "198.51.100.1" ? sourceExecutor : targetExecutor,
    );

    const module = await Test.createTestingModule({
      providers: [
        CreateBedrockProcessor,
        { provide: PrismaService, useValue: prisma },
        {
          provide: SshKeyService,
          useValue: {
            getSshConfig: jest.fn().mockImplementation(async (srv: { ip_address: string }) => ({
              host: srv.ip_address,
              port: 22,
              username: "root",
              privateKey: "key",
            })),
            resolvePrivateKey: jest.fn().mockResolvedValue("private-key"),
          },
        },
        {
          provide: EncryptionService,
          useValue: {
            decrypt: jest.fn((v: string) => v.replace(/^enc:/, "")),
            encrypt: jest.fn((v: string) => `enc:${v}`),
          },
        },
        {
          provide: getQueueToken(QUEUES.BACKUPS),
          useValue: { add: jest.fn().mockResolvedValue({ id: "b-1" }) },
        },
      ],
    }).compile();

    processor = module.get(CreateBedrockProcessor);
  });

  afterEach(async () => {
    for (const dir of observedLocalDirs) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    const tmpEntries = await readdir(tmpdir()).catch(() => []);
    for (const entry of tmpEntries) {
      if (entry.startsWith(sandboxPrefix)) {
        await rm(join(tmpdir(), entry), { recursive: true, force: true }).catch(() => {});
      }
    }
  });

  function makeCloneJob(id = "cb-stream-1") {
    return {
      id,
      name: JOB_TYPES.PROJECT_CREATE_BEDROCK,
      data: {
        environmentId: 20,
        jobExecutionId: 101,
        sourceEnvironmentId: 10,
      },
      updateProgress: jest.fn().mockResolvedValue(undefined),
    } as never;
  }

  it("streams clone database dump with bounded memory via pullFileToPath and pushFileFromStream and cleans temporary files", async () => {
    await processor.process(makeCloneJob("cb-stream-ok"));

    expect(sourceExecutor.pullFile).not.toHaveBeenCalled();
    expect(sourceExecutor.pullFileToPath).toHaveBeenCalledTimes(1);
    expect(targetExecutor.pushFileFromStream).toHaveBeenCalledTimes(1);

    const stats = (targetExecutor as unknown as {
      getCapturedStats: () => { mode: number; size: number; match: boolean };
    }).getCapturedStats();
    expect(stats.size).toBeGreaterThan(100_000);
    expect(stats.match).toBe(true);
    expect(stats.mode).toBe(0o600);

    // Local temporary directory must be cleaned up after completion
    expect(observedLocalDirs.length).toBe(1);
    expect(existsSync(observedLocalDirs[0])).toBe(false);

    // Both source and target remote dumps must be removed
    expect(sourceExecutor.execute).toHaveBeenCalledWith(
      expect.stringContaining("rm -f '/tmp/cb_clone_cb-stream-ok.sql'"),
    );
    expect(targetExecutor.execute).toHaveBeenCalledWith(
      expect.stringContaining("rm -f '/tmp/cb_clone_cb-stream-ok.sql'"),
    );
  });

  it("identifies download stage failure and cleans source and local temporary resources", async () => {
    sourceExecutor.pullFileToPath.mockImplementationOnce(async (_remote: string, localPath: string) => {
      observedLocalDirs.push(join(localPath, ".."));
      await writeFile(localPath, "partial-sql-before-drop");
      throw new Error("SFTP stream reset mid-transfer");
    });

    await expect(processor.process(makeCloneJob("cb-stream-dl-fail"))).rejects.toThrow(
      /download.*source/i,
    );

    expect(targetExecutor.pushFileFromStream).not.toHaveBeenCalled();
    expect(sourceExecutor.execute).toHaveBeenCalledWith(
      expect.stringContaining("rm -f '/tmp/cb_clone_cb-stream-dl-fail.sql'"),
    );
    expect(observedLocalDirs.length).toBe(1);
    expect(existsSync(observedLocalDirs[0])).toBe(false);
  });

  it("identifies upload stage failure and cleans partial target and local temporary dumps", async () => {
    targetExecutor.pushFileFromStream.mockRejectedValueOnce(new Error("SFTP target disk full"));

    await expect(processor.process(makeCloneJob("cb-stream-ul-fail"))).rejects.toThrow(
      /upload.*target/i,
    );

    expect(
      targetExecutor.execute.mock.calls.some(([cmd]: [string]) =>
        cmd.includes("mysql ") && cmd.includes("cb_clone_cb-stream-ul-fail.sql"),
      ),
    ).toBe(false);
    expect(targetExecutor.execute).toHaveBeenCalledWith(
      expect.stringContaining("rm -f '/tmp/cb_clone_cb-stream-ul-fail.sql'"),
    );
    expect(observedLocalDirs.length).toBe(1);
    expect(existsSync(observedLocalDirs[0])).toBe(false);
  });
});
