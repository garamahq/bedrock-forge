import { Test } from "@nestjs/testing";
import { getQueueToken } from "@nestjs/bullmq";
import {
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat, utimes, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { JOB_TYPES, QUEUES, ROLES } from "@bedrock-forge/shared";
import { CreateEnvironmentDto } from "../environments/dto/environment.dto";
import { SettingsService } from "../settings/settings.service";
import { SettingsRepository } from "../settings/settings.repository";
import { GdriveSettingsService } from "../settings/services/gdrive-settings.service";
import { EncryptionService } from "../../common/encryption/encryption.service";
import { BackupsService } from "./backups.service";
import { BackupsRepository } from "./backups.repository";
import { BackupsController } from "./backups.controller";

jest.mock("node:child_process", () => {
  const actual = jest.requireActual("node:child_process");
  return {
    ...actual,
    spawn: jest.fn(),
  };
});

class MockChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = jest.fn();
}

function makeMockResponse() {
  const headers: Record<string, string> = {};
  const chunks: Buffer[] = [];
  const res = new EventEmitter() as EventEmitter & {
    statusCode: number;
    headersSent: boolean;
    writableEnded: boolean;
    writableFinished: boolean;
    destroyed: boolean;
    setHeader: (k: string, v: string) => void;
    getHeaders: () => Record<string, string>;
    status: (code: number) => typeof res;
    json: (body: unknown) => typeof res;
    write: (chunk: Buffer | string) => boolean;
    end: (chunk?: Buffer | string) => typeof res;
    destroy: (err?: Error) => typeof res;
    bodyChunks: Buffer[];
    jsonBody?: unknown;
    destroyError?: Error;
  };
  res.statusCode = 200;
  res.headersSent = false;
  res.writableEnded = false;
  res.writableFinished = false;
  res.destroyed = false;
  res.bodyChunks = chunks;
  res.setHeader = jest.fn((k: string, v: string) => {
    headers[k.toLowerCase()] = v;
  });
  res.getHeaders = () => headers;
  res.status = jest.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = jest.fn((body: unknown) => {
    res.headersSent = true;
    res.writableEnded = true;
    res.jsonBody = body;
    return res;
  });
  res.write = jest.fn((chunk: Buffer | string) => {
    res.headersSent = true;
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return true;
  });
  res.end = jest.fn((chunk?: Buffer | string) => {
    if (chunk) res.write(chunk);
    res.headersSent = true;
    res.writableEnded = true;
    res.writableFinished = true;
    return res;
  });
  res.destroy = jest.fn((err?: Error) => {
    res.destroyed = true;
    res.destroyError = err;
    res.emit("close");
    return res;
  });
  return res;
}

describe("Phase 6A API download tickets, streaming truncation, GDrive config coordination, and Drive URL validation (#23, #24, #27, #36, #37, #58)", () => {
  it("rejects non-Drive URLs in CreateEnvironmentDto and SettingsService (#37)", async () => {
    const badDto = plainToInstance(CreateEnvironmentDto, {
      server_id: 1,
      type: "production",
      url: "https://site.test",
      root_path: "/home/site.test/public_html",
      google_drive_folder_id: "https://example.com/not-drive/abc",
    });
    const errors = await validate(badDto);
    expect(errors.some((e) => e.property === "google_drive_folder_id")).toBe(true);

    const urlDto = plainToInstance(CreateEnvironmentDto, {
      server_id: 1,
      type: "production",
      url: "https://site.test",
      root_path: "/home/site.test/public_html",
      google_drive_folder_id: " https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnO?usp=sharing ",
    });
    expect(await validate(urlDto)).toHaveLength(0);

    const repo = {
      findAll: jest.fn(),
      findByKey: jest.fn(),
      upsert: jest.fn().mockResolvedValue({}),
      delete: jest.fn(),
    };
    const settingsSvc = new SettingsService(
      repo as unknown as SettingsRepository,
      { encrypt: (v: string) => `enc:${v}`, decrypt: (v: string) => v } as unknown as EncryptionService,
    );
    await expect(
      settingsSvc.set("forge_system_backup_folder_id", "not valid / slash"),
    ).rejects.toThrow(BadRequestException);

    await settingsSvc.set(
      "forge_system_backup_folder_id",
      " https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnO?usp=sharing ",
    );
    expect(repo.upsert).toHaveBeenCalledWith(
      "forge_system_backup_folder_id",
      "1AbCdEfGhIjKlMnO",
    );
  });

  it("provisions rclone config from DB on fresh filesystem and removes stale file on unlink (#58, #36)", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "bf-api-rclone-"));
    const configPath = join(tmpDir, "rclone.conf");
    try {
      const ini =
        '[gdrive]\ntype = drive\nscope = drive\ntoken = {"access_token":"a1","refresh_token":"r1","expiry":"2026-01-01T00:00:00Z"}\n';
      const repo = {
        findByKey: jest.fn().mockResolvedValue({
          key: "rclone_gdrive_config",
          value: `enc:${ini}`,
          updated_at: new Date("2026-01-01T00:00:00Z"),
        }),
        upsert: jest.fn(),
        delete: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      };
      const gdriveSvc = new GdriveSettingsService(
        repo as never,
        {
          encrypt: (v: string) => `enc:${v}`,
          decrypt: (v: string) => v.replace(/^enc:/, ""),
        } as never,
        {
          get: jest.fn((k: string) => {
            if (k === "app.rcloneConfigPath") return configPath;
            if (k === "app.rcloneRemoteName" || k === "RCLONE_REMOTE_NAME") return "gdrive";
            return undefined;
          }),
        } as never,
      );

      // Fresh API container: file does not exist yet
      expect(existsSync(configPath)).toBe(false);
      const provisioned = await (
        gdriveSvc as unknown as {
          ensureRcloneConfig: () => Promise<{ configPath: string; remoteName: string }>;
        }
      ).ensureRcloneConfig();
      expect(provisioned.configPath).toBe(configPath);
      expect(await readFile(configPath, "utf8")).toBe(ini);
      expect((await stat(configPath)).mode & 0o777).toBe(0o600);

      // Simulate unlink while stale file exists
      repo.findByKey.mockResolvedValue(null);
      await expect(
        (
          gdriveSvc as unknown as {
            ensureRcloneConfig: () => Promise<unknown>;
          }
        ).ensureRcloneConfig(),
      ).rejects.toThrow(NotFoundException);
      expect(existsSync(configPath)).toBe(false);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("keeps Backup DB record in deleting status until worker confirms Drive deletion (#27)", async () => {
    const repo = {
      findById: jest.fn().mockResolvedValue({
        id: BigInt(15),
        environment_id: BigInt(2),
        status: "completed",
        file_path: "gdrive:1AbCdEf/backup.tar.gz",
      }),
      updateStatus: jest.fn().mockResolvedValue({ id: BigInt(15), status: "deleting" }),
      delete: jest.fn(),
    };
    const queue = { add: jest.fn().mockResolvedValue({ id: "del-15" }), client: Promise.resolve({}) };
    const svc = new BackupsService(repo as unknown as BackupsRepository, queue as never);

    await svc.remove(15);

    expect(repo.updateStatus).toHaveBeenCalledWith(BigInt(15), {
      status: "deleting",
      error_message: null,
    });
    expect(queue.add).toHaveBeenCalledWith(
      JOB_TYPES.BACKUP_DELETE_FILE,
      { filePath: "gdrive:1AbCdEf/backup.tar.gz", backupId: 15 },
      expect.objectContaining({ attempts: 5 }),
    );
    expect(repo.delete).not.toHaveBeenCalled();
  });

  it("handles rclone cat pre-byte error (502) and mid-stream truncation (res.destroy) on download (#23, #24)", async () => {
    const gdrive = {
      ensureRcloneConfig: jest.fn().mockResolvedValue({
        configPath: "/tmp/rclone.conf",
        remoteName: "gdrive",
        dbValueSnapshot: "enc:ini",
      }),
      syncRefreshedRcloneConfig: jest.fn().mockResolvedValue(undefined),
    };
    const svc = {
      findOne: jest.fn().mockResolvedValue({
        id: BigInt(9),
        status: "completed",
        file_path: "gdrive:1AbCdEfGhIjK/site.tar.gz",
        size_bytes: BigInt(100),
      }),
      createDownloadTicket: jest.fn(),
    };

    const controller = new BackupsController(
      svc as never,
      { get: jest.fn() } as unknown as ConfigService,
      gdrive as never,
    );

    // Case 1: rclone exits 1 BEFORE sending any bytes -> HTTP 502 instead of 200 OK 0 bytes
    const childPreErr = new MockChild();
    (spawn as jest.Mock).mockReturnValueOnce(childPreErr);
    const req1 = new EventEmitter();
    const res1 = makeMockResponse();
    const dl1 = (
      controller.download as unknown as (
        id: number,
        req: EventEmitter,
        res: typeof res1,
      ) => Promise<void>
    )(9, req1, res1);
    await new Promise((r) => setTimeout(r, 10));
    childPreErr.stderr.write("404 remote file missing");
    childPreErr.stdout.end();
    childPreErr.emit("close", 1);
    await dl1;

    expect(res1.status).toHaveBeenCalledWith(502);
    expect(res1.bodyChunks).toHaveLength(0);

    // Case 2: rclone sends 10 bytes then exits non-zero (expected 100) -> res.destroy so client detects truncation
    const childMidErr = new MockChild();
    (spawn as jest.Mock).mockReturnValueOnce(childMidErr);
    const req2 = new EventEmitter();
    const res2 = makeMockResponse();
    const dl2 = (
      controller.download as unknown as (
        id: number,
        req: EventEmitter,
        res: typeof res2,
      ) => Promise<void>
    )(9, req2, res2);
    await new Promise((r) => setTimeout(r, 10));
    childMidErr.stdout.write(Buffer.from("1234567890"));
    await new Promise((r) => setTimeout(r, 10));
    childMidErr.stderr.write("unexpected EOF from Google Drive");
    childMidErr.emit("close", 1);
    await dl2;

    expect(res2.getHeaders()["content-length"]).toBe("100");
    expect(res2.destroy).toHaveBeenCalled();

    // Case 3: client aborts connection mid-transfer -> child.kill called
    const childAbort = new MockChild();
    (spawn as jest.Mock).mockReturnValueOnce(childAbort);
    const req3 = new EventEmitter();
    const res3 = makeMockResponse();
    const dl3 = (
      controller.download as unknown as (
        id: number,
        req: EventEmitter,
        res: typeof res3,
      ) => Promise<void>
    )(9, req3, res3);
    await new Promise((r) => setTimeout(r, 10));
    req3.emit("close");
    childAbort.emit("close", null);
    await dl3;
    expect(childAbort.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
