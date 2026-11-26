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

describe("CreateBedrockProcessor peer SSH host verification & key cleanup (#80, #81)", () => {
  let processor: CreateBedrockProcessor;
  let prisma: any;
  let sshKey: any;
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
            url: "https://clone.example.test",
            root_path: "/home/clone.example.test/public_html",
            server: {
              id: BigInt(5),
              name: "Target Server",
              ip_address: "198.51.100.10",
              ssh_port: 22,
              ssh_user: "root",
              ssh_private_key_encrypted: "enc:tgt",
              host_key_fingerprint: "SHA256:tgtfp",
              cyberpanel_login: null,
            },
          })
          .mockResolvedValueOnce({
            id: BigInt(7),
            project_id: BigInt(10),
            type: "production",
            url: "https://src.example.test",
            root_path: "/home/src.example.test/public_html",
            server: {
              id: BigInt(6),
              name: "Source Server",
              ip_address: "198.51.100.20",
              ssh_port: 2222,
              ssh_user: "deploy",
              ssh_private_key_encrypted: "enc:src",
              host_key_fingerprint: "SHA256:srcfp",
            },
            wp_db_credentials: {
              db_name_encrypted: "enc:s_db",
              db_user_encrypted: "enc:s_user",
              db_password_encrypted: "enc:s_pass",
              db_host_encrypted: "enc:localhost",
            },
          }),
        delete: jest.fn().mockResolvedValue({}),
        count: jest.fn().mockResolvedValue(1),
      },
      wpDbCredentials: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({}),
      },
      project: { delete: jest.fn().mockResolvedValue({}) },
    };

    sshKey = {
      getSshConfig: jest.fn().mockImplementation(async (s: any) => ({
        host: s.ip_address,
        port: s.ssh_port ?? 22,
        username: s.ssh_user ?? "root",
        privateKey: `key-${s.id}`,
      })),
      resolvePrivateKey: jest
        .fn()
        .mockResolvedValue("-----BEGIN OPENSSH PRIVATE KEY-----\nsrc\n-----END OPENSSH PRIVATE KEY-----"),
      preparePeerKnownHosts: jest.fn().mockResolvedValue({
        knownHostsPath: "/tmp/cb_known_hosts_cb-peer-1",
        sshOptions: "-o StrictHostKeyChecking=yes -o UserKnownHostsFile='/tmp/cb_known_hosts_cb-peer-1'",
      }),
    };

    srcExecutor = {
      execute: jest.fn().mockResolvedValue({ code: 0, stdout: "ok", stderr: "" }),
      pushFile: jest.fn().mockResolvedValue(undefined),
      pullFile: jest.fn().mockResolvedValue(Buffer.from("-- sql")),
    };
    tgtExecutor = {
      execute: jest.fn().mockResolvedValue({ code: 0, stdout: "ok", stderr: "" }),
      pushFile: jest.fn().mockResolvedValue(undefined),
      pullFile: jest.fn().mockResolvedValue(Buffer.from("")),
    };
    (createRemoteExecutor as jest.Mock).mockImplementation((cfg: any) =>
      cfg.host === "198.51.100.20" ? srcExecutor : tgtExecutor,
    );

    const module = await Test.createTestingModule({
      providers: [
        CreateBedrockProcessor,
        { provide: PrismaService, useValue: prisma },
        { provide: SshKeyService, useValue: sshKey },
        {
          provide: EncryptionService,
          useValue: {
            decrypt: jest.fn((v: string) => v.replace(/^enc:/, "")),
            encrypt: jest.fn((v: string) => `enc:${v}`),
          },
        },
        {
          provide: getQueueToken(QUEUES.BACKUPS),
          useValue: { add: jest.fn().mockResolvedValue({ id: "b1" }) },
        },
      ],
    }).compile();

    processor = module.get(CreateBedrockProcessor);
  });

  function makeJob() {
    return {
      id: "cb-peer-1",
      name: JOB_TYPES.PROJECT_CREATE_BEDROCK,
      data: {
        environmentId: 42,
        jobExecutionId: 99,
        sourceEnvironmentId: 7,
      },
      updateProgress: jest.fn().mockResolvedValue(undefined),
    } as any;
  }

  it("pins source host key via known_hosts instead of StrictHostKeyChecking=no and cleans temp key + known_hosts (#80, #81)", async () => {
    await processor.process(makeJob());

    const sshPipeCmd = tgtExecutor.execute.mock.calls
      .map(([cmd]: [string]) => cmd)
      .find((c) => c.includes("tar -cz") && c.includes("tar -xz"));
    expect(sshPipeCmd).toBeDefined();
    expect(sshPipeCmd).not.toContain("StrictHostKeyChecking=no");
    expect(sshPipeCmd).toContain("StrictHostKeyChecking=yes");
    expect(sshPipeCmd).toContain("UserKnownHostsFile='/tmp/cb_known_hosts_cb-peer-1'");

    expect(
      tgtExecutor.execute.mock.calls.some(
        ([cmd]: [string]) =>
          cmd.includes("rm -f") &&
          cmd.includes("/tmp/cb_key_cb-peer-1") &&
          cmd.includes("/tmp/cb_known_hosts_cb-peer-1"),
      ),
    ).toBe(true);
  });

  it("aborts before writing clone files and cleans temp key when host key verification fails (#80, #81)", async () => {
    sshKey.preparePeerKnownHosts.mockRejectedValueOnce(
      new Error("SSH host key verification failed for Source Server"),
    );

    await expect(processor.process(makeJob())).rejects.toThrow(
      /host key verification failed/i,
    );

    expect(
      tgtExecutor.execute.mock.calls.some(([cmd]: [string]) =>
        cmd.includes("tar -xz"),
      ),
    ).toBe(false);
    expect(
      tgtExecutor.execute.mock.calls.some(
        ([cmd]: [string]) =>
          cmd.includes("rm -f") && cmd.includes("/tmp/cb_key_cb-peer-1"),
      ),
    ).toBe(true);
  });
});
