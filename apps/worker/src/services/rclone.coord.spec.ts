import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RcloneService } from "./rclone.service";
import { PrismaService } from "../prisma/prisma.service";
import { EncryptionService } from "../encryption/encryption.service";

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

function makeRcloneIni(accessToken: string, refreshToken: string, expiryIso: string) {
  return `[gdrive]\ntype = drive\nscope = drive\ntoken = ${JSON.stringify({
    access_token: accessToken,
    token_type: "Bearer",
    refresh_token: refreshToken,
    expiry: expiryIso,
  })}\n`;
}

describe("RcloneService coordination, Drive folder ID validation, and deletion safety (#36, #37, #40, #27)", () => {
  let tmpDir: string;
  let configPath: string;
  let service: RcloneService;
  let prisma: {
    appSetting: {
      findUnique: jest.Mock;
      updateMany: jest.Mock;
    };
  };
  let enc: {
    encrypt: jest.Mock;
    decrypt: jest.Mock;
  };

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bf-rclone-test-"));
    configPath = join(tmpDir, "rclone.conf");
    mockExecFile.mockReset();

    prisma = {
      appSetting: {
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    enc = {
      encrypt: jest.fn((v: string) => `enc:${v}`),
      decrypt: jest.fn((v: string) => {
        if (!v.startsWith("enc:")) throw new Error("Decrypt failure");
        return v.slice(4);
      }),
    };

    const module = await Test.createTestingModule({
      providers: [
        RcloneService,
        { provide: PrismaService, useValue: prisma },
        { provide: EncryptionService, useValue: enc },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === "rclone.configPath") return configPath;
              if (key === "rclone.remoteName") return "gdrive";
              return undefined;
            }),
          },
        },
      ],
    }).compile();

    service = module.get(RcloneService);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("extracts canonical Drive folder IDs from URLs and rejects invalid folder paths (#37)", async () => {
    expect(
      RcloneService.parseFilePath(
        "gdrive:  https://drive.google.com/drive/u/1/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz?usp=sharing  /site_backup.tar.gz",
      ),
    ).toEqual({
      folderId: "1AbCdEfGhIjKlMnOpQrStUvWxYz",
      filename: "site_backup.tar.gz",
    });

    expect(() =>
      RcloneService.parseFilePath("gdrive:https://evil.example.com/folders/1AbCdEf/site.tar.gz"),
    ).toThrow(/invalid/i);

    mockExecFile.mockResolvedValue({ stdout: "", stderr: "" });
    const stored = await service.upload(
      "/tmp/a.tar.gz",
      " https://drive.google.com/drive/folders/1ZyXwVuTsRqPoNmLkJiHgFeDcBa?usp=share_link ",
      "a.tar.gz",
    );
    expect(stored).toBe("gdrive:1ZyXwVuTsRqPoNmLkJiHgFeDcBa/a.tar.gz");
    expect(mockExecFile).toHaveBeenCalledWith(
      "rclone",
      expect.arrayContaining([
        "--drive-root-folder-id",
        "1ZyXwVuTsRqPoNmLkJiHgFeDcBa",
      ]),
      expect.any(Object),
    );
  });

  it("removes stale configPath and returns false when DB setting is missing or corrupt (#40, #58)", async () => {
    await writeFile(configPath, makeRcloneIni("stale-tok", "ref-1", "2025-01-01T00:00:00Z"), {
      mode: 0o600,
    });
    prisma.appSetting.findUnique.mockResolvedValue(null);

    expect(await service.writeConfig()).toBe(false);
    expect(existsSync(configPath)).toBe(false);

    await writeFile(configPath, makeRcloneIni("stale-tok", "ref-1", "2025-01-01T00:00:00Z"), {
      mode: 0o600,
    });
    prisma.appSetting.findUnique.mockResolvedValue({
      key: "rclone_gdrive_config",
      value: "corrupt-ciphertext",
      updated_at: new Date(),
    });

    expect(await service.writeConfig()).toBe(false);
    expect(existsSync(configPath)).toBe(false);
  });

  it("preserves newer locally refreshed OAuth config version B and syncs to DB without logging secrets (#36)", async () => {
    const versionA = makeRcloneIni("access-A", "refresh-shared", "2026-01-01T01:00:00Z");
    const versionB = makeRcloneIni("access-B-refreshed", "refresh-shared", "2026-01-01T03:00:00Z");

    const dbUpdatedAt = new Date("2026-01-01T00:00:00Z");
    prisma.appSetting.findUnique.mockResolvedValue({
      key: "rclone_gdrive_config",
      value: `enc:${versionA}`,
      updated_at: dbUpdatedAt,
    });

    // Simulate rclone locally refreshing configPath on disk at T1 > dbUpdatedAt
    await writeFile(configPath, versionB, { mode: 0o600 });
    const later = new Date("2026-01-01T02:00:00Z");
    await utimes(configPath, later, later);

    const logSpy = jest.spyOn(
      (service as unknown as { logger: { log: (...a: unknown[]) => void } }).logger,
      "log",
    );

    const ok = await service.writeConfig();
    expect(ok).toBe(true);

    const onDisk = await readFile(configPath, "utf8");
    expect(onDisk).toBe(versionB);
    expect(prisma.appSetting.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: "rclone_gdrive_config", value: `enc:${versionA}` },
        data: expect.objectContaining({ value: `enc:${versionB}` }),
      }),
    );

    const loggedText = logSpy.mock.calls.flat().join(" ");
    expect(loggedText).not.toContain("access-B-refreshed");
    expect(loggedText).not.toContain("refresh-shared");
  });

  it("overwrites local config cleanly when DB has an intentional relink newer than disk mtime (#36)", async () => {
    const versionOld = makeRcloneIni("access-old", "refresh-old", "2026-01-01T01:00:00Z");
    const versionRelinked = makeRcloneIni("access-new-relink", "refresh-new", "2026-01-02T01:00:00Z");

    await writeFile(configPath, versionOld, { mode: 0o600 });
    const oldTime = new Date("2026-01-01T02:00:00Z");
    await utimes(configPath, oldTime, oldTime);

    prisma.appSetting.findUnique.mockResolvedValue({
      key: "rclone_gdrive_config",
      value: `enc:${versionRelinked}`,
      updated_at: new Date("2026-01-02T00:00:00Z"),
    });

    const ok = await service.writeConfig();
    expect(ok).toBe(true);

    const onDisk = await readFile(configPath, "utf8");
    expect(onDisk).toBe(versionRelinked);
    const st = await stat(configPath);
    expect(st.mode & 0o777).toBe(0o600);
  });

  it("distinguishes verified already-deleted remote files from transient Drive errors in deleteFile (#27)", async () => {
    mockExecFile
      .mockRejectedValueOnce(new Error("ERROR : old.tar.gz: object not found"))
      .mockResolvedValueOnce({ stdout: "", stderr: "" }); // rclone lsf confirms empty

    const missingResult = await (
      service.deleteFile("gdrive:1AbCdEfGhIjK/old.tar.gz") as unknown as Promise<unknown>
    );
    expect(missingResult).toEqual({ deleted: false, alreadyMissing: true });

    mockExecFile.mockRejectedValueOnce(new Error("503 backend transient error"));
    await expect(service.deleteFile("gdrive:1AbCdEfGhIjK/old.tar.gz")).rejects.toThrow(
      /503 backend transient error/,
    );
  });
});
