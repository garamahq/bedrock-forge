import { join } from "node:path";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { Test } from "@nestjs/testing";
import { getQueueToken } from "@nestjs/bullmq";
import { ConfigService } from "@nestjs/config";
import { JOB_TYPES, QUEUES } from "@bedrock-forge/shared";
import { createRemoteExecutor } from "@bedrock-forge/remote-executor";
import { BackupProcessor } from "./backup.processor";
import { PrismaService } from "../../prisma/prisma.service";
import { RcloneService } from "../../services/rclone.service";
import { SshKeyService } from "../../services/ssh-key.service";
import { EncryptionService } from "../../encryption/encryption.service";

jest.mock("@bedrock-forge/remote-executor", () => ({
  createRemoteExecutor: jest.fn(),
}));

jest.mock("fs/promises", () => {
  const actual = jest.requireActual("fs/promises");
  return {
    ...actual,
    mkdir: jest.fn().mockResolvedValue(undefined),
    rm: jest.fn().mockResolvedValue(undefined),
    readFile: jest.fn().mockResolvedValue(Buffer.from("<?php // mock script")),
    stat: jest.fn().mockResolvedValue({ size: 1024 }),
    statfs: jest.fn().mockResolvedValue({ bfree: 10_000_000, bsize: 4096 }),
  };
});

jest.mock("../../utils/processor-utils", () => {
  const actual = jest.requireActual("../../utils/processor-utils");
  return {
    ...actual,
    fixCyberPanelOwnership: jest.fn().mockResolvedValue({}),
  };
});

describe("BackupProcessor restore URL search-replace & literal file safety (#19, #54, #60)", () => {
  let processor: BackupProcessor;
  let prisma: any;
  let executor: {
    execute: jest.Mock;
    pushFile: jest.Mock;
    pullFileToPath: jest.Mock;
    pushFileFromStream: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      jobExecution: { update: jest.fn().mockResolvedValue({}) },
      backup: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: BigInt(7),
          environment_id: BigInt(1),
          type: "full",
          file_path: "gdrive:folder/backup.tar.gz",
          environment: { id: BigInt(1), url: "https://old.test" },
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      environment: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: BigInt(2),
          type: "staging",
          url: "https://new.test/?a=1&b=2",
          root_path: "/home/new.test/public_html",
          server: {
            id: BigInt(5),
            name: "Tgt",
            ip_address: "198.51.100.5",
            ssh_port: 22,
            ssh_user: "root",
            ssh_private_key_encrypted: null,
            host_key_fingerprint: null,
          },
        }),
      },
      wpDbCredentials: {
        findUnique: jest.fn().mockResolvedValue({
          db_name_encrypted: "tgt_db",
          db_user_encrypted: "tgt_user",
          db_password_encrypted: "tgt_pass",
          db_host_encrypted: "localhost",
        }),
      },
    };

    executor = {
      execute: jest.fn().mockImplementation(async (cmd: string) => {
        if (cmd.includes("backup.php")) {
          return { code: 0, stdout: JSON.stringify({ status: "ok" }), stderr: "" };
        }
        if (cmd.includes("information_schema.tables")) {
          return { code: 0, stdout: "wp_", stderr: "" };
        }
        if (cmd.includes("grep -nHF")) {
          return { code: 1, stdout: "", stderr: "" };
        }
        if (cmd.includes("web/app")) {
          return { code: 0, stdout: "ok", stderr: "" };
        }
        if (cmd.includes("php ") && cmd.includes("forge_sr_")) {
          return {
            code: 0,
            stdout: JSON.stringify({ tables_scanned: 5, rows_affected: 3, errors: [] }),
            stderr: "",
          };
        }
        return { code: 0, stdout: "", stderr: "" };
      }),
      pushFile: jest.fn().mockResolvedValue(undefined),
      pullFileToPath: jest.fn().mockResolvedValue(undefined),
      pushFileFromStream: jest.fn().mockResolvedValue(undefined),
    };
    (createRemoteExecutor as jest.Mock).mockReturnValue(executor);

    const module = await Test.createTestingModule({
      providers: [
        BackupProcessor,
        { provide: PrismaService, useValue: prisma },
        {
          provide: RcloneService,
          useValue: {
            writeConfig: jest.fn().mockResolvedValue(true),
            downloadFile: jest.fn().mockResolvedValue(undefined),
            downloadStream: jest.fn().mockImplementation(() => {
              const child = Object.assign(new EventEmitter(), {
                stderr: new EventEmitter(),
                exitCode: 0,
                kill: jest.fn(),
              });
              return { child, stream: Readable.from(Buffer.from("tar")) };
            }),
          },
        },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(join(__dirname, "../../scripts")) },
        },
        {
          provide: SshKeyService,
          useValue: {
            getSshConfig: jest.fn().mockResolvedValue({
              host: "198.51.100.5",
              port: 22,
              username: "root",
              privateKey: "key",
            }),
          },
        },
        {
          provide: EncryptionService,
          useValue: { decrypt: jest.fn((v: string) => v), encrypt: jest.fn((v: string) => v) },
        },
        {
          provide: getQueueToken(QUEUES.BACKUPS),
          useValue: {
            add: jest.fn(),
            client: Promise.resolve({ get: jest.fn().mockResolvedValue(null) }),
          },
        },
      ],
    }).compile();

    processor = module.get(BackupProcessor);
  });

  function makeRestoreJob() {
    return {
      id: "res-1",
      name: JOB_TYPES.BACKUP_RESTORE,
      data: { backupId: 7, environmentId: 2, jobExecutionId: 99 },
      updateProgress: jest.fn().mockResolvedValue(undefined),
    } as any;
  }

  it("fails restore when search-replace.php reports error and NEVER runs plain SQL REPLACE fallback (#19, #60)", async () => {
    executor.execute.mockImplementation(async (cmd: string) => {
      if (cmd.includes("backup.php")) {
        return { code: 0, stdout: JSON.stringify({ status: "ok" }), stderr: "" };
      }
      if (cmd.includes("information_schema.tables")) {
        return { code: 0, stdout: "wp_", stderr: "" };
      }
      if (cmd.includes("php ") && cmd.includes("forge_sr_")) {
        return {
          code: 1,
          stdout: JSON.stringify({
            tables_scanned: 5,
            rows_affected: 1,
            errors: ["UPDATE batch on wp_options failed"],
          }),
          stderr: "mysql error",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    await expect(processor.process(makeRestoreJob())).rejects.toThrow(
      /wp_options failed|search-replace/i,
    );

    // Must NEVER push forge_sr_restore_*.sql or execute raw SQL UPDATE REPLACE
    expect(
      executor.pushFile.mock.calls.some(([arg]: [{ remotePath: string }]) =>
        arg.remotePath.includes("forge_sr_") && arg.remotePath.endsWith(".sql"),
      ),
    ).toBe(false);
    expect(
      executor.execute.mock.calls.some(([cmd]: [string]) =>
        cmd.includes("forge_sr_restore_") && cmd.includes(".sql"),
      ),
    ).toBe(false);
  });

  it("uses literal escaped sed pattern & replacement (& safe) inside detected Bedrock web/app and throws on sed error (#54)", async () => {
    await processor.process(makeRestoreJob());

    const sedCall = executor.execute.mock.calls
      .map(([cmd]: [string]) => cmd)
      .find((c) => c.includes("sed -i"));
    expect(sedCall).toBeDefined();
    expect(sedCall).toContain("/home/new.test/public_html/web/app");
    expect(sedCall).toContain("old\\.test");
    expect(sedCall).toContain("\\&b=2");

    // Non-zero exit from sed must fail restore rather than swallowing
    executor.execute.mockImplementation(async (cmd: string) => {
      if (cmd.includes("backup.php")) {
        return { code: 0, stdout: JSON.stringify({ status: "ok" }), stderr: "" };
      }
      if (cmd.includes("information_schema.tables")) {
        return { code: 0, stdout: "wp_", stderr: "" };
      }
      if (cmd.includes("sed -i")) {
        return { code: 4, stdout: "", stderr: "sed: permission denied" };
      }
      if (cmd.includes("grep -nHF")) {
        return { code: 1, stdout: "", stderr: "" };
      }
      if (cmd.includes("web/app")) {
        return { code: 0, stdout: "ok", stderr: "" };
      }
      if (cmd.includes("php ") && cmd.includes("forge_sr_")) {
        return {
          code: 0,
          stdout: JSON.stringify({ tables_scanned: 5, rows_affected: 3, errors: [] }),
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    await expect(processor.process(makeRestoreJob())).rejects.toThrow(/permission denied|exit 4/i);
  });
});
