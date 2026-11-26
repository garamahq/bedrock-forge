import { Test } from "@nestjs/testing";
import { getQueueToken } from "@nestjs/bullmq";
import { ConfigService } from "@nestjs/config";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { DelayedError, UnrecoverableError } from "bullmq";
import { createRemoteExecutor } from "@bedrock-forge/remote-executor";
import { JOB_TYPES, QUEUES } from "@bedrock-forge/shared";
import { BackupProcessor } from "./backup.processor";
import { PrismaService } from "../../prisma/prisma.service";
import { RcloneService } from "../../services/rclone.service";
import { SshKeyService } from "../../services/ssh-key.service";
import { EncryptionService } from "../../encryption/encryption.service";
import { StepTracker } from "../../services/step-tracker";
import { Logger } from "@nestjs/common";

jest.mock("@bedrock-forge/remote-executor", () => ({
  createRemoteExecutor: jest.fn(),
}));

jest.mock("fs/promises", () => {
  const actual = jest.requireActual("fs/promises");
  return {
    ...actual,
    mkdir: jest.fn(async (p: string, ...args: unknown[]) => {
      if (String(p).includes("forge-backups")) return undefined;
      return actual.mkdir(p, ...(args as []));
    }),
    rm: jest.fn(async (p: string, ...args: unknown[]) => {
      if (String(p).includes("forge-backups")) return undefined;
      return actual.rm(p, ...(args as []));
    }),
    stat: jest.fn(async (p: string, ...args: unknown[]) => {
      if (String(p).includes("forge-backups")) return { size: 2048 };
      return actual.stat(p, ...(args as []));
    }),
    statfs: jest.fn(async (p: string, ...args: unknown[]) => {
      if (String(p) === "/tmp") return { bavail: 1_000_000, bsize: 4096 };
      return actual.statfs(p, ...(args as []));
    }),
    readFile: jest.fn(async (p: string, ...args: unknown[]) => {
      if (String(p).includes("backup.php") || String(p).includes("search-replace.php")) {
        return Buffer.from("<?php echo 'stub';");
      }
      return actual.readFile(p, ...(args as []));
    }),
  };
});

describe("Phase 7A Backup concurrency lock, SSH indeterminate state, stream error cleanup, and cancellation (#51, #53, #59, #31, #30)", () => {
  let processor: BackupProcessor;
  let prisma: {
    environment: { findUniqueOrThrow: jest.Mock };
    backup: { update: jest.Mock; findUniqueOrThrow: jest.Mock; create: jest.Mock; findMany: jest.Mock };
    backupSchedule: { findUnique: jest.Mock; update: jest.Mock };
    jobExecution: { create: jest.Mock; findFirst: jest.Mock; update: jest.Mock; updateMany: jest.Mock };
    wpDbCredentials: { findUnique: jest.Mock };
  };
  let rclone: {
    writeConfig: jest.Mock;
    upload: jest.Mock;
    downloadStream: jest.Mock;
  };
  let queueClient: {
    get: jest.Mock;
    set: jest.Mock;
    eval: jest.Mock;
    pexpire: jest.Mock;
  };
  let queue: {
    add: jest.Mock;
    getRepeatableJobs: jest.Mock;
    client: Promise<typeof queueClient>;
  };
  let executor: {
    execute: jest.Mock;
    pushFile: jest.Mock;
    pullFileToPath: jest.Mock;
    pushFileFromStream: jest.Mock;
  };

  beforeEach(async () => {
    executor = {
      execute: jest.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" }),
      pushFile: jest.fn().mockResolvedValue(undefined),
      pullFileToPath: jest.fn().mockResolvedValue(undefined),
      pushFileFromStream: jest.fn().mockResolvedValue(undefined),
    };
    (createRemoteExecutor as jest.Mock).mockReturnValue(executor);

    queueClient = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue("OK"),
      eval: jest.fn().mockResolvedValue(1),
      pexpire: jest.fn().mockResolvedValue(1),
    };

    prisma = {
      environment: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: BigInt(10),
          project_id: BigInt(1),
          type: "production",
          url: "https://site.test",
          root_path: "/home/site.test/public_html",
          google_drive_folder_id: "folder-1",
          server: { ip_address: "198.51.100.1", ssh_port: 22, ssh_user: "root" },
          project: { name: "site" },
        }),
      },
      backup: {
        update: jest.fn().mockResolvedValue({}),
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: BigInt(77),
          environment_id: BigInt(10),
          status: "completed",
          file_path: "gdrive:folder-1/site.tar.gz",
          size_bytes: BigInt(0),
          environment: { id: BigInt(10), url: "https://site.test" },
        }),
        create: jest.fn().mockResolvedValue({ id: BigInt(99) }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      backupSchedule: {
        findUnique: jest.fn().mockResolvedValue({
          id: BigInt(5),
          enabled: true,
          retention_count: null,
          retention_days: null,
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      jobExecution: {
        create: jest.fn().mockResolvedValue({ id: BigInt(200) }),
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      wpDbCredentials: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
    };

    rclone = {
      writeConfig: jest.fn().mockResolvedValue(true),
      upload: jest.fn().mockResolvedValue("gdrive:folder-1/out.tar.gz"),
      downloadStream: jest.fn(),
    };

    queue = {
      add: jest.fn().mockResolvedValue({ id: "q-1" }),
      getRepeatableJobs: jest.fn().mockResolvedValue([]),
      client: Promise.resolve(queueClient),
    };

    const mod = await Test.createTestingModule({
      providers: [
        BackupProcessor,
        { provide: PrismaService, useValue: prisma },
        { provide: RcloneService, useValue: rclone },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue("/scripts") } },
        { provide: SshKeyService, useValue: { getSshConfig: jest.fn().mockResolvedValue({}) } },
        { provide: EncryptionService, useValue: { decrypt: jest.fn((v: string) => v) } },
        { provide: getQueueToken(QUEUES.BACKUPS), useValue: queue },
      ],
    }).compile();

    processor = mod.get(BackupProcessor);
  });

  it("defers scheduled backup cleanly without creating Backup rows when an active Sync or Restore is running (#51)", async () => {
    prisma.jobExecution.findFirst.mockResolvedValueOnce({
      id: BigInt(901),
      queue_name: QUEUES.SYNC,
      status: "active",
    });

    const moveToDelayed = jest.fn().mockResolvedValue(undefined);
    await expect(
      processor.process({
        id: "sched-1",
        name: JOB_TYPES.BACKUP_SCHEDULED,
        token: "tok-1",
        data: { scheduleId: 5, environmentId: 10, type: "full" },
        moveToDelayed,
        updateProgress: jest.fn(),
      } as never),
    ).rejects.toThrow(DelayedError);

    expect(moveToDelayed).toHaveBeenCalledWith(expect.any(Number), "tok-1");
    expect(prisma.backup.create).not.toHaveBeenCalled();
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it("defers manual backup cleanly with DelayedError when Redis environment lock is held by another worker (#51)", async () => {
    queueClient.set.mockResolvedValueOnce(null); // lock NX not acquired!

    const moveToDelayed = jest.fn().mockResolvedValue(undefined);
    await expect(
      processor.process({
        id: "create-busy",
        name: JOB_TYPES.BACKUP_CREATE,
        token: "tok-2",
        data: { environmentId: 10, type: "full", jobExecutionId: 201, backupId: 88 },
        moveToDelayed,
        updateProgress: jest.fn(),
      } as never),
    ).rejects.toThrow(DelayedError);

    expect(moveToDelayed).toHaveBeenCalledWith(expect.any(Number), "tok-2");
    expect(executor.pushFile).not.toHaveBeenCalled();
    expect(prisma.backup.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "failed" }) }),
    );
  });

  it("defers restore cleanly with DelayedError when Redis environment lock is held (#51)", async () => {
    queueClient.set.mockResolvedValueOnce(null);

    const moveToDelayed = jest.fn().mockResolvedValue(undefined);
    await expect(
      processor.process({
        id: "restore-busy",
        name: JOB_TYPES.BACKUP_RESTORE,
        token: "tok-r",
        data: { backupId: 77, environmentId: 10, jobExecutionId: 209 },
        moveToDelayed,
        updateProgress: jest.fn(),
      } as never),
    ).rejects.toThrow(DelayedError);

    expect(moveToDelayed).toHaveBeenCalledWith(expect.any(Number), "tok-r");
    expect(executor.pushFile).not.toHaveBeenCalled();
  });

  it("kills active rclone child cleanly in finally when SFTP pushFileFromStream fails mid-stream (#31)", async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      killed: false,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: jest.fn(),
    });
    rclone.downloadStream.mockReturnValue({ child, stream: child.stdout });
    executor.pushFileFromStream.mockRejectedValueOnce(new Error("SFTP write stream error"));

    await expect(
      processor.process({
        id: "restore-sftp-fail",
        name: JOB_TYPES.BACKUP_RESTORE,
        data: { backupId: 77, environmentId: 10, jobExecutionId: 202 },
        updateProgress: jest.fn(),
      } as never),
    ).rejects.toThrow(/SFTP write stream error/);

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("fails restore immediately if rclone emits immediate spawn error (#31)", async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      killed: false,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: jest.fn(),
    });
    rclone.downloadStream.mockReturnValue({ child, stream: child.stdout });
    executor.pushFileFromStream.mockImplementation(
      () => new Promise<void>(() => {}), // would hang forever if child error isn't bound!
    );

    process.nextTick(() => {
      child.emit("error", new Error("spawn rclone ENOENT"));
    });

    await expect(
      processor.process({
        id: "restore-rclone-err",
        name: JOB_TYPES.BACKUP_RESTORE,
        data: { backupId: 77, environmentId: 10, jobExecutionId: 203 },
        updateProgress: jest.fn(),
      } as never),
    ).rejects.toThrow(/ENOENT|rclone/i);
  });

  it("treats indeterminate SSH close on restore script as UnrecoverableError so retries never re-wipe target (#59)", async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: 0,
      killed: false,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: jest.fn(),
    });
    rclone.downloadStream.mockReturnValue({ child, stream: child.stdout });
    executor.pushFileFromStream.mockImplementation(async () => {
      child.stdout.end();
    });
    executor.execute.mockImplementation(async (cmd: string) => {
      if (cmd.includes("--restore")) {
        return { code: 1, indeterminate: true, signal: "SIGTERM", stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const err = await processor
      .process({
        id: "restore-indet",
        name: JOB_TYPES.BACKUP_RESTORE,
        data: { backupId: 77, environmentId: 10, jobExecutionId: 204 },
        updateProgress: jest.fn(),
      } as never)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(UnrecoverableError);
    expect((err as Error).message).toMatch(/indeterminate|signal/i);
  });

  it("fails restore when rclone is terminated by signal mid-stream without hanging (#31)", async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      killed: false,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: jest.fn(),
    });
    rclone.downloadStream.mockReturnValue({ child, stream: child.stdout });
    executor.pushFileFromStream.mockImplementation(
      () => new Promise<void>(() => {}),
    );

    process.nextTick(() => {
      child.signalCode = "SIGKILL";
      child.emit("close", null, "SIGKILL");
    });

    await expect(
      processor.process({
        id: "restore-rclone-sigkill",
        name: JOB_TYPES.BACKUP_RESTORE,
        data: { backupId: 77, environmentId: 10, jobExecutionId: 210 },
        updateProgress: jest.fn(),
      } as never),
    ).rejects.toThrow(/SIGKILL|signal/i);
  });

  it("requires structured JSON output from restore script even on exit 0 (#59)", async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: 0,
      killed: false,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: jest.fn(),
    });
    rclone.downloadStream.mockReturnValue({ child, stream: child.stdout });
    executor.pushFileFromStream.mockImplementation(async () => {
      child.stdout.end();
    });
    executor.execute.mockImplementation(async (cmd: string) => {
      if (cmd.includes("--restore")) {
        return { code: 0, stdout: "partial truncated output", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const err = await processor
      .process({
        id: "restore-bad-json",
        name: JOB_TYPES.BACKUP_RESTORE,
        data: { backupId: 77, environmentId: 10, jobExecutionId: 211 },
        updateProgress: jest.fn(),
      } as never)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(UnrecoverableError);
    expect((err as Error).message).toMatch(/valid structured result|unverified/i);
  });

  it("uses activity idleTimeoutMs/maxTimeoutMs for backup.php and skips temp deletion when remote process is still active (#53)", async () => {
    executor.execute.mockImplementation(async (cmd: string) => {
      if (cmd.includes("--output=")) {
        throw new Error("Command idle timeout after 900000ms");
      }
      if (cmd.includes("pgrep -f")) {
        return { code: 0, stdout: "running", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    await expect(
      processor.process({
        id: "create-timeout-1",
        name: JOB_TYPES.BACKUP_CREATE,
        data: { environmentId: 10, type: "full", jobExecutionId: 212, backupId: 90 },
        updateProgress: jest.fn(),
      } as never),
    ).rejects.toThrow(/idle timeout/i);

    const backupCall = executor.execute.mock.calls.find(([c]: [string]) =>
      c.includes("--output="),
    );
    expect(backupCall?.[1]).toEqual(
      expect.objectContaining({
        idleTimeoutMs: expect.any(Number),
        maxTimeoutMs: expect.any(Number),
      }),
    );
    const rmCalls = executor.execute.mock.calls.filter(([c]: [string]) =>
      c.startsWith("rm -f"),
    );
    expect(rmCalls).toHaveLength(0);
  });

  it("aborts handleCreate when cancellation is requested while paused during rclone upload and deletes uploaded file (#30)", async () => {
    let cancelActive = false;
    let releaseUpload!: () => void;
    const uploadBarrier = new Promise<void>((res) => {
      releaseUpload = res;
    });
    queueClient.get.mockImplementation(async (key: string) =>
      cancelActive && key === "forge:cancel:create-upload-cancel" ? "1" : null,
    );
    executor.execute.mockImplementation(async (cmd: string) => {
      if (cmd.includes("--output=")) {
        return { code: 0, stdout: JSON.stringify({ filename: "/tmp/out.tar.gz", size: 2048 }), stderr: "" };
      }
      if (cmd.includes("stat -c%s")) {
        return { code: 0, stdout: "2048", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    rclone.upload.mockImplementationOnce(async () => {
      cancelActive = true; // Simulate user cancelling while upload is in progress
      releaseUpload();
      return "gdrive:folder-1/uploaded-cancelled.tar.gz";
    });

    const err = await processor
      .process({
        id: "create-upload-cancel",
        name: JOB_TYPES.BACKUP_CREATE,
        data: { environmentId: 10, type: "full", jobExecutionId: 213, backupId: 91 },
        updateProgress: jest.fn(),
      } as never)
      .catch((e: unknown) => e);
    await uploadBarrier;

    expect(err).toBeInstanceOf(UnrecoverableError);
    expect(queue.add).toHaveBeenCalledWith(
      JOB_TYPES.BACKUP_DELETE_FILE,
      { filePath: "gdrive:folder-1/uploaded-cancelled.tar.gz" },
      expect.any(Object),
    );
    expect(prisma.backup.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "completed" }) }),
    );
  });

  it("aborts handleCreate with UnrecoverableError when cancelled before/during upload and releases env lock (#30)", async () => {
    queueClient.get.mockImplementation(async (key: string) =>
      key === "forge:cancel:create-cancel-1" ? "1" : null,
    );

    const err = await processor
      .process({
        id: "create-cancel-1",
        name: JOB_TYPES.BACKUP_CREATE,
        data: { environmentId: 10, type: "full", jobExecutionId: 205, backupId: 89 },
        updateProgress: jest.fn(),
      } as never)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(UnrecoverableError);
    expect((err as Error).message).toMatch(/Cancelled by user/i);
    expect(rclone.upload).not.toHaveBeenCalled();
    // Env lock released cleanly in finally
    expect(queueClient.eval).toHaveBeenCalled();
  });

  it("prevents StepTracker.complete() and StepTracker.fail() from overwriting an existing terminal status (#30)", async () => {
    const mockPrisma = {
      jobExecution: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        update: jest.fn().mockResolvedValue({}),
      },
    } as unknown as PrismaService;
    const tracker = new StepTracker(mockPrisma, BigInt(300), new Logger("Test"), "job-term");

    await tracker.complete();
    await tracker.fail(new Error("late failure"), "Upload");

    expect(mockPrisma.jobExecution.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: { id: BigInt(300), status: { in: ["queued", "active"] } },
        data: expect.objectContaining({ status: "completed" }),
      }),
    );
    expect(mockPrisma.jobExecution.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { id: BigInt(300), status: { in: ["queued", "active"] } },
        data: expect.objectContaining({ status: "failed" }),
      }),
    );
  });
});
