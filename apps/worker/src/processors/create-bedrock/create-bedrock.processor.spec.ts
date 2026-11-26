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
    jobExecution: { update: jest.Mock; updateMany: jest.Mock };
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
      jobExecution: {
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
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
