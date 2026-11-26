import { Test } from "@nestjs/testing";
import { getQueueToken } from "@nestjs/bullmq";
import { JOB_TYPES, QUEUES } from "@bedrock-forge/shared";
import { createRemoteExecutor } from "@bedrock-forge/remote-executor";
import { CreateBedrockProcessor } from "./create-bedrock.processor";
import { PrismaService } from "../../prisma/prisma.service";
import { SshKeyService } from "../../services/ssh-key.service";
import { EncryptionService } from "../../encryption/encryption.service";

jest.mock("@bedrock-forge/remote-executor", () => ({
  createRemoteExecutor: jest.fn(),
}));

jest.mock("../../utils/cyberpanel-http", () => {
  const actual = jest.requireActual("../../utils/cyberpanel-http");
  return { ...actual, callCpApi: jest.fn().mockResolvedValue({ status: 1 }) };
});

jest.mock("../../utils/processor-utils", () => {
  const actual = jest.requireActual("../../utils/processor-utils");
  return { ...actual, fixCyberPanelOwnership: jest.fn().mockResolvedValue({}) };
});

describe("CreateBedrockProcessor clone serialized URL replace & Bedrock layout (#111, #112)", () => {
  let processor: CreateBedrockProcessor;
  let prisma: any;
  let srcExecutor: { execute: jest.Mock; pushFile: jest.Mock; pullFile: jest.Mock };
  let tgtExecutor: { execute: jest.Mock; pushFile: jest.Mock; pullFile: jest.Mock };

  beforeEach(async () => {
    prisma = {
      jobExecution: { update: jest.fn().mockResolvedValue({}) },
      environment: {
        findUnique: jest.fn().mockResolvedValue(null),
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValueOnce({
            id: BigInt(42),
            project_id: BigInt(10),
            type: "staging",
            url: "https://new-longer-clone.test",
            root_path: "/home/new-longer-clone.test/public_html",
            server: {
              id: BigInt(5),
              name: "Same",
              ip_address: "198.51.100.10",
              ssh_port: 22,
              ssh_user: "root",
              ssh_private_key_encrypted: "enc",
              host_key_fingerprint: null,
              cyberpanel_login: null,
            },
          })
          .mockResolvedValueOnce({
            id: BigInt(7),
            project_id: BigInt(10),
            type: "production",
            url: "https://old.test",
            root_path: "/home/old.test/public_html",
            server: {
              id: BigInt(5),
              name: "Same",
              ip_address: "198.51.100.10",
              ssh_port: 22,
              ssh_user: "root",
              ssh_private_key_encrypted: "enc",
              host_key_fingerprint: null,
            },
            wp_db_credentials: {
              db_name_encrypted: "s_db",
              db_user_encrypted: "s_user",
              db_password_encrypted: "s_pass",
              db_host_encrypted: "localhost",
            },
          }),
        delete: jest.fn().mockResolvedValue({}),
        count: jest.fn().mockResolvedValue(1),
      },
      wpDbCredentials: { findUnique: jest.fn(), upsert: jest.fn().mockResolvedValue({}) },
      project: { delete: jest.fn().mockResolvedValue({}) },
    };

    srcExecutor = {
      execute: jest.fn().mockResolvedValue({ code: 0, stdout: "ok", stderr: "" }),
      pushFile: jest.fn().mockResolvedValue(undefined),
      pullFile: jest.fn().mockResolvedValue(Buffer.from("-- sql")),
    };
    tgtExecutor = {
      execute: jest.fn().mockImplementation(async (cmd: string) => {
        if (cmd.includes("information_schema.tables")) {
          return { code: 0, stdout: "wp_", stderr: "" };
        }
        if (cmd.includes("php ") && cmd.includes("forge_sr_")) {
          return {
            code: 0,
            stdout: JSON.stringify({ tables_scanned: 12, rows_affected: 8, errors: [] }),
            stderr: "",
          };
        }
        if (cmd.includes("grep -nHF")) {
          return { code: 1, stdout: "", stderr: "" };
        }
        if (cmd.includes("web/app")) {
          return { code: 0, stdout: "ok", stderr: "" };
        }
        return { code: 0, stdout: "ok", stderr: "" };
      }),
      pushFile: jest.fn().mockResolvedValue(undefined),
      pullFile: jest.fn().mockResolvedValue(Buffer.from("")),
    };
    (createRemoteExecutor as jest.Mock).mockImplementation(() => tgtExecutor);

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
            resolvePrivateKey: jest.fn().mockResolvedValue("key"),
          },
        },
        {
          provide: EncryptionService,
          useValue: { decrypt: jest.fn((v: string) => v), encrypt: jest.fn((v: string) => v) },
        },
        { provide: getQueueToken(QUEUES.BACKUPS), useValue: { add: jest.fn() } },
      ],
    }).compile();

    processor = module.get(CreateBedrockProcessor);
  });

  function makeCloneJob() {
    return {
      id: "cb-sr-1",
      name: JOB_TYPES.PROJECT_CREATE_BEDROCK,
      data: { environmentId: 42, jobExecutionId: 99, sourceEnvironmentId: 7 },
      updateProgress: jest.fn().mockResolvedValue(undefined),
    } as any;
  }

  it("uses search-replace.php instead of raw SQL REPLACE and detects Bedrock web/app with escaped literal sed (#111, #112)", async () => {
    await processor.process(makeCloneJob());

    // Must invoke search-replace.php
    expect(
      tgtExecutor.execute.mock.calls.some(
        ([cmd]: [string]) => cmd.includes("php ") && cmd.includes("forge_sr_"),
      ),
    ).toBe(true);

    // Must NEVER push or execute raw SQL UPDATE REPLACE statements
    expect(
      tgtExecutor.pushFile.mock.calls.some(([arg]: [{ remotePath: string }]) =>
        arg.remotePath.includes("cb_sr_"),
      ),
    ).toBe(false);

    // Must scan web/app and escape dots literally in sed
    const sedCall = tgtExecutor.execute.mock.calls
      .map(([cmd]: [string]) => cmd)
      .find((c) => c.includes("sed -i"));
    expect(sedCall).toBeDefined();
    expect(sedCall).toContain("/home/new-longer-clone.test/public_html/web/app");
    expect(sedCall).toContain("old\\.test");
  });

  it("fails clone cleanly when search-replace.php fails instead of reporting URL search-replace done (#111)", async () => {
    tgtExecutor.execute.mockImplementation(async (cmd: string) => {
      if (cmd.includes("information_schema.tables")) {
        return { code: 0, stdout: "wp_", stderr: "" };
      }
      if (cmd.includes("php ") && cmd.includes("forge_sr_")) {
        return {
          code: 1,
          stdout: JSON.stringify({ tables_scanned: 5, rows_affected: 0, errors: ["UPDATE wp_options failed"] }),
          stderr: "mysql error",
        };
      }
      return { code: 0, stdout: "ok", stderr: "" };
    });

    const job = makeCloneJob();
    await expect(processor.process(job)).rejects.toThrow(/wp_options failed|search-replace/i);
    expect(job.updateProgress).not.toHaveBeenCalledWith(
      expect.objectContaining({ step: "URL search-replace done" }),
    );
  });
});
