import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Test } from "@nestjs/testing";
import { getQueueToken } from "@nestjs/bullmq";
import { ConfigService } from "@nestjs/config";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createRemoteExecutor } from "@bedrock-forge/remote-executor";
import { JOB_TYPES, QUEUES } from "@bedrock-forge/shared";
import { BackupProcessor } from "./backup.processor";
import { PrismaService } from "../../prisma/prisma.service";
import { RcloneService } from "../../services/rclone.service";
import { SshKeyService } from "../../services/ssh-key.service";
import { EncryptionService } from "../../encryption/encryption.service";
import { resolveSitePhpBinary } from "../../utils/processor-utils";

jest.mock("@bedrock-forge/remote-executor", () => ({
  createRemoteExecutor: jest.fn(),
}));

jest.mock("fs/promises", () => {
  const actual = jest.requireActual("fs/promises");
  return {
    ...actual,
    stat: jest.fn(async (p: string) => {
      if (String(p).includes("forge_backup_")) {
        return { size: 4096 };
      }
      return actual.stat(p);
    }),
    statfs: jest.fn().mockResolvedValue({ bavail: 10_000_000, bsize: 4096 }),
    readFile: jest.fn(async (p: string, ...args: unknown[]) => {
      if (String(p).includes("backup.php") || String(p).includes("search-replace.php")) {
        return Buffer.from("<?php echo 'stub';");
      }
      if (String(p).includes("forge_backup_") && String(p).endsWith(".tar.gz")) {
        // Minimal valid gzip magic bytes when checking archive header
        return Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00]);
      }
      return actual.readFile(p, ...(args as []));
    }),
  };
});

describe("Phase 6C Backup/Restore interpreter, stdout JSON, collisions, staging privacy, space check, and size integrity (#32, #33, #34, #45, #46, #47, #61, #62, #63)", () => {
  const backupPhpSource = readFileSync(
    join(__dirname, "../../../scripts/backup.php"),
    "utf8",
  );

  describe("resolveSitePhpBinary (#34)", () => {
    it("prefers detected lsphp binary when default php lacks mysqli or fails", async () => {
      const executor = {
        execute: jest.fn(async (cmd: string) => {
          if (cmd.includes("vhost.conf")) {
            return { code: 0, stdout: "/usr/local/lsws/lsphp82/bin/lsphp", stderr: "" };
          }
          if (cmd.includes("/usr/local/lsws/lsphp82/bin/php")) {
            if (cmd.includes("-r ")) return { code: 0, stdout: "", stderr: "" };
            return { code: 0, stdout: "yes", stderr: "" };
          }
          if (cmd.startsWith("php -r")) {
            return { code: 127, stdout: "", stderr: "php: command not found" };
          }
          return { code: 1, stdout: "", stderr: "" };
        }),
      };

      const bin = await resolveSitePhpBinary(
        executor as never,
        "/home/site.test/public_html",
        ["json", "mysqli"],
      );
      expect(bin).toBe("/usr/local/lsws/lsphp82/bin/php");
    });

    it("throws when neither lsphp nor system php satisfies required extensions", async () => {
      const executor = {
        execute: jest.fn().mockResolvedValue({ code: 1, stdout: "", stderr: "missing" }),
      };

      await expect(
        resolveSitePhpBinary(executor as never, "/home/site.test/public_html", ["mysqli"]),
      ).rejects.toThrow(/supported PHP interpreter/i);
    });
  });

  describe("BackupProcessor hardening", () => {
    let processor: BackupProcessor;
    let prisma: {
      environment: { findUniqueOrThrow: jest.Mock };
      backup: { update: jest.Mock; findUniqueOrThrow: jest.Mock };
      jobExecution: { update: jest.Mock };
      wpDbCredentials: { findUnique: jest.Mock };
    };
    let rclone: {
      writeConfig: jest.Mock;
      upload: jest.Mock;
      downloadStream: jest.Mock;
    };
    let executor: {
      execute: jest.Mock;
      pushFile: jest.Mock;
      pullFileToPath: jest.Mock;
      pushFileFromStream: jest.Mock;
    };

    beforeEach(async () => {
      executor = {
        execute: jest.fn(async (cmd: string) => {
          if (cmd.includes("stat -c%s")) return { code: 0, stdout: "4096", stderr: "" };
          if (cmd.includes("tar -tzf")) return { code: 0, stdout: "", stderr: "" };
          if (cmd.includes("df -Pk") || cmd.includes("df -PB1")) {
            return { code: 0, stdout: "Filesystem 1024-blocks Used Available Capacity Mounted\n/dev/sda1 10000000 100000 9000000 2% /", stderr: "" };
          }
          if (cmd.includes("-r ")) return { code: 0, stdout: "", stderr: "" };
          if (cmd.includes("command -v php")) return { code: 0, stdout: "/usr/bin/php", stderr: "" };
          if (cmd.includes("backup.php")) {
            return {
              code: 0,
              stdout: JSON.stringify({
                filename: "/tmp/forge_b1/out.tar.gz",
                size: 4096,
                archive_verified: true,
              }),
              stderr: "",
            };
          }
          return { code: 0, stdout: "yes", stderr: "" };
        }),
        pushFile: jest.fn().mockResolvedValue(undefined),
        pullFileToPath: jest.fn().mockResolvedValue(undefined),
        pushFileFromStream: jest.fn().mockResolvedValue(undefined),
      };
      (createRemoteExecutor as jest.Mock).mockReturnValue(executor);

      prisma = {
        environment: {
          findUniqueOrThrow: jest.fn().mockResolvedValue({
            id: BigInt(10),
            project_id: BigInt(7),
            type: "production",
            url: "https://site.test",
            root_path: "/home/site.test/public_html",
            backup_path: "/var/backups/forge-stage",
            google_drive_folder_id: "folderABC123",
            server: { ip_address: "198.51.100.1", ssh_port: 22, ssh_user: "root" },
            project: { name: "موقع تجريبي" }, // Arabic project name!
          }),
        },
        backup: {
          update: jest.fn().mockResolvedValue({}),
          findUniqueOrThrow: jest.fn(),
        },
        jobExecution: { update: jest.fn().mockResolvedValue({}) },
        wpDbCredentials: { findUnique: jest.fn().mockResolvedValue(null) },
      };

      rclone = {
        writeConfig: jest.fn().mockResolvedValue(true),
        upload: jest.fn(async (_local: string, folder: string, name: string) => `gdrive:${folder}/${name}`),
        downloadStream: jest.fn(),
      };

      const module = await Test.createTestingModule({
        providers: [
          BackupProcessor,
          { provide: PrismaService, useValue: prisma },
          { provide: RcloneService, useValue: rclone },
          { provide: SshKeyService, useValue: { getSshConfig: jest.fn().mockResolvedValue({}) } },
          { provide: EncryptionService, useValue: { decrypt: jest.fn((v: string) => v) } },
          { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue("/scripts") } },
          { provide: getQueueToken(QUEUES.BACKUPS), useValue: { add: jest.fn(), client: Promise.resolve({ get: jest.fn().mockResolvedValue(null) }) } },
        ],
      }).compile();

      processor = module.get(BackupProcessor);
    });

    it("produces unique GDrive backup filenames for concurrent runs on frozen clock and Arabic project names (#45)", async () => {
      jest.useFakeTimers().setSystemTime(new Date("2026-11-26T10:00:00Z"));
      try {
        await processor.process({
          id: "job-arabic-1",
          name: JOB_TYPES.BACKUP_CREATE,
          data: { environmentId: 10, type: "full", jobExecutionId: 1, backupId: 100 },
          updateProgress: jest.fn(),
        } as never);

        prisma.environment.findUniqueOrThrow.mockResolvedValueOnce({
          id: BigInt(11),
          project_id: BigInt(8),
          type: "production",
          url: "https://site2.test",
          root_path: "/home/site2.test/public_html",
          google_drive_folder_id: "folderABC123",
          server: { ip_address: "198.51.100.1", ssh_port: 22, ssh_user: "root" },
          project: { name: "موقع ثان" },
        });

        await processor.process({
          id: "job-arabic-2",
          name: JOB_TYPES.BACKUP_CREATE,
          data: { environmentId: 11, type: "full", jobExecutionId: 2, backupId: 101 },
          updateProgress: jest.fn(),
        } as never);
      } finally {
        jest.useRealTimers();
      }

      const name1 = rclone.upload.mock.calls[0][2];
      const name2 = rclone.upload.mock.calls[1][2];
      expect(name1).not.toBe(name2);
    });

    it("extracts trailing valid JSON when PHP emits leading warning lines (#33) and aborts upload if pulled size != reported size (#62)", async () => {
      executor.execute.mockImplementation(async (cmd: string) => {
        if (cmd.includes("stat -c%s")) return { code: 0, stdout: "4096", stderr: "" };
        if (cmd.includes("-r ")) return { code: 0, stdout: "", stderr: "" };
        if (cmd.includes("command -v php")) return { code: 0, stdout: "/usr/bin/php", stderr: "" };
        if (cmd.includes("backup.php")) {
          return {
            code: 0,
            stdout:
              "PHP Deprecated: Function foo() is deprecated\n" +
              JSON.stringify({ filename: "/tmp/out.tar.gz", size: 999999, archive_verified: true }),
            stderr: "",
          };
        }
        return { code: 0, stdout: "yes", stderr: "" };
      });

      await expect(
        processor.process({
          id: "job-mismatch",
          name: JOB_TYPES.BACKUP_CREATE,
          data: { environmentId: 10, type: "full", jobExecutionId: 3, backupId: 102 },
          updateProgress: jest.fn(),
        } as never),
      ).rejects.toThrow(/size mismatch|truncated|4096.*999999|999999.*4096/i);

      expect(rclone.upload).not.toHaveBeenCalled();
    });

    it("enforces private 0700 remote dir and 0600 fileMode on restore transfer + verifies size/integrity BEFORE calling backup.php --restore (#32, #46, #62)", async () => {
      prisma.backup.findUniqueOrThrow.mockResolvedValueOnce({
        id: BigInt(77),
        environment_id: BigInt(10),
        status: "completed",
        file_path: "gdrive:folderABC123/site.tar.gz",
        size_bytes: BigInt(5000),
        environment: { id: BigInt(10), url: "https://site.test" },
      });

      const child = Object.assign(new EventEmitter(), {
        exitCode: 0,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: jest.fn(),
      });
      rclone.downloadStream.mockReturnValue({ child, stream: child.stdout });
      executor.pushFileFromStream.mockImplementation(
        async (_p: string, _s: unknown, _t: number, onProg?: (n: number) => void) => {
          onProg?.(1200); // truncated transfer!
          child.stdout.end();
        },
      );
      executor.execute.mockImplementation(async (cmd: string) => {
        if (cmd.includes("stat -c%s")) return { code: 0, stdout: "1200", stderr: "" };
        if (cmd.includes("df -Pk")) {
          return { code: 0, stdout: "Fs 1024 Used Avail Use Mount\n/dev/sda1 100000 1000 90000 2% /", stderr: "" };
        }
        return { code: 0, stdout: "ok", stderr: "" };
      });

      await expect(
        processor.process({
          id: "job-res-mismatch",
          name: JOB_TYPES.BACKUP_RESTORE,
          data: { backupId: 77, environmentId: 10, jobExecutionId: 44 },
          updateProgress: jest.fn(),
        } as never),
      ).rejects.toThrow(/size mismatch|truncated|5000.*1200|1200.*5000/i);

      // Must pass restrictive fileMode 0o600 and create 0o700 dir before stream, and NEVER invoke backup.php --restore on mismatch
      expect(executor.execute).toHaveBeenCalledWith(
        expect.stringMatching(/mkdir -p -m 700/),
      );
      expect(executor.pushFileFromStream).toHaveBeenCalledWith(
        expect.stringContaining("forge_restore_job-res-mismatch"),
        expect.anything(),
        expect.any(Number),
        expect.any(Function),
        0o600,
      );
      expect(
        executor.execute.mock.calls.some(([cmd]: [string]) =>
          cmd.includes("backup.php") && cmd.includes("--restore"),
        ),
      ).toBe(false);
    });
  });

  describe("backup.php script safeguards (#32, #33, #45, #46, #47, #61, #63)", () => {
    it("enforces stderr diagnostics, symlinked docroot archival, isolated incremental env cache, private 0700/0600 staging, disk check, and tar warning classification", () => {
      expect(backupPhpSource).toContain("display_errors");
      expect(backupPhpSource).toContain("set_error_handler");
      expect(backupPhpSource).toContain("is_link(");
      expect(backupPhpSource).toContain("realpath(");
      expect(backupPhpSource).toContain("disk_free_space");
      expect(backupPhpSource).toContain("chmod($mycnfFile, 0600)");
      expect(backupPhpSource).toContain("0700");
      expect(backupPhpSource).toContain("sha256");
      expect(backupPhpSource).toContain("tar -tzf");
      expect(backupPhpSource).toContain("critical_files");
      expect(backupPhpSource).toContain("--staging-dir");
    });
  });
});
