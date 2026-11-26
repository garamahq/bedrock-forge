import { Test } from "@nestjs/testing";
import { JOB_TYPES } from "@bedrock-forge/shared";
import { buildPgDumpConnection } from "./pg-dump.utils";
import { SystemBackupProcessor } from "../processors/system-backup/system-backup.processor";
import { PrismaService } from "../prisma/prisma.service";
import { RcloneService } from "../services/rclone.service";

const mockExecFile = jest.fn();

jest.mock("child_process", () => {
  const actual = jest.requireActual("child_process");
  return {
    ...actual,
    execFile: (...args: unknown[]) => {
      const cb = args[args.length - 1];
      if (typeof cb === "function") {
        mockExecFile(...args.slice(0, -1))
          .then((res: unknown) => cb(null, res))
          .catch((err: unknown) => cb(err));
        return {} as never;
      }
      return mockExecFile(...args);
    },
  };
});

describe("buildPgDumpConnection & SystemBackupProcessor libpq option handling (#45, #52)", () => {
  it("decodes encoded user/db, escapes .pgpass metacharacters, keeps libpq TLS options, and strips Prisma params (#52)", () => {
    const dbUrl =
      "postgresql://app%40user:pass%5Cword%3A123@db.internal.test:5433/forge%2Fprod?sslmode=verify-full&sslrootcert=%2Fetc%2Fssl%2Fca.pem&connect_timeout=15&schema=public&connection_limit=10&pgbouncer=true";

    const cfg = buildPgDumpConnection(dbUrl);

    // Escaped pgpass line handles '\' and ':' without corrupting credentials
    expect(cfg.pgpassLine).toBe(
      "db.internal.test:5433:forge/prod:app@user:pass\\\\word\\:123\n",
    );
    expect(cfg.connectionUri).toContain("sslmode=verify-full");
    expect(cfg.connectionUri).toContain("sslrootcert=%2Fetc%2Fssl%2Fca.pem");
    expect(cfg.connectionUri).toContain("connect_timeout=15");
    // Prisma-only options must be stripped
    expect(cfg.connectionUri).not.toContain("schema=");
    expect(cfg.connectionUri).not.toContain("connection_limit=");
    expect(cfg.connectionUri).not.toContain("pgbouncer=");
    // Password must NEVER appear inside the URI passed as CLI arg
    expect(cfg.connectionUri).not.toContain("pass");
    expect(cfg.connectionUri).not.toContain("123");
  });

  it("handles concurrent system backups on a frozen clock with unique filenames (#45)", async () => {
    const origDb = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://forge:secret@localhost:5432/forge?sslmode=require";
    mockExecFile.mockReset().mockResolvedValue({ stdout: "", stderr: "" });

    const prisma = {
      systemBackup: { create: jest.fn().mockResolvedValue({ id: BigInt(1) }), update: jest.fn().mockResolvedValue({}) },
      jobExecution: { create: jest.fn().mockResolvedValue({ id: BigInt(2) }), update: jest.fn().mockResolvedValue({}) },
    };
    const rclone = {
      writeConfig: jest.fn().mockResolvedValue(true),
      upload: jest.fn(async (_p: string, f: string, n: string) => `gdrive:${f}/${n}`),
    };

    const module = await Test.createTestingModule({
      providers: [
        SystemBackupProcessor,
        { provide: PrismaService, useValue: prisma },
        { provide: RcloneService, useValue: rclone },
      ],
    }).compile();
    const proc = module.get(SystemBackupProcessor);

    jest.useFakeTimers().setSystemTime(new Date("2026-11-26T12:00:00Z"));
    try {
      await proc.process({
        id: "sb-1",
        name: JOB_TYPES.SYSTEM_BACKUP_CREATE,
        data: { systemBackupId: 10, jobExecutionId: 20, folderId: "folderX" },
      } as never);
      await proc.process({
        id: "sb-2",
        name: JOB_TYPES.SYSTEM_BACKUP_CREATE,
        data: { systemBackupId: 11, jobExecutionId: 21, folderId: "folderX" },
      } as never);
    } finally {
      jest.useRealTimers();
      process.env.DATABASE_URL = origDb;
    }

    const f1 = rclone.upload.mock.calls[0][2];
    const f2 = rclone.upload.mock.calls[1][2];
    expect(f1).not.toBe(f2);
    expect(mockExecFile).toHaveBeenCalledWith(
      "pg_dump",
      expect.arrayContaining([expect.stringContaining("sslmode=require")]),
      expect.objectContaining({ env: expect.objectContaining({ PGPASSFILE: expect.any(String) }) }),
    );
  });
});
