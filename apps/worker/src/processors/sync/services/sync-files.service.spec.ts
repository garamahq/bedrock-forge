import { SyncFilesService } from "./sync-files.service";
import { SshKeyService } from "../../../services/ssh-key.service";
import { StepTracker } from "../../../services/step-tracker";
import { JOB_TYPES } from "@bedrock-forge/shared";

describe("SyncFilesService", () => {
  let service: SyncFilesService;
  let sshKey: jest.Mocked<SshKeyService>;

  beforeEach(() => {
    sshKey = {
      resolvePrivateKey: jest
        .fn()
        .mockResolvedValue("-----BEGIN PRIVATE KEY-----"),
      getSshConfig: jest.fn().mockImplementation(async (server: any) => ({
        host: server.ip_address,
        port: server.ssh_port,
        username: server.ssh_user,
        privateKey: "-----BEGIN PRIVATE KEY-----",
      })),
    } as any;
    service = new SyncFilesService(sshKey);
  });

  describe("getProductionPromotionExcludes()", () => {
    it("preserves production robots policy and uploads during staging promotion", () => {
      expect(
        (service as any).getProductionPromotionExcludes(
          "staging",
          "production",
        ),
      ).toEqual([
        "robots.txt",
        "web/robots.txt",
        "wp-content/uploads/",
        "app/uploads/",
        "web/app/uploads/",
        "wp-content/plugins/wp-secure-guard/",
        "app/plugins/wp-secure-guard/",
        "web/app/plugins/wp-secure-guard/",
        "wp-content/mu-plugins/secure-guard-watchdog.php",
        "app/mu-plugins/secure-guard-watchdog.php",
        "web/app/mu-plugins/secure-guard-watchdog.php",
      ]);
    });

    it("does not apply production-only file protections to other sync directions", () => {
      expect(
        (service as any).getProductionPromotionExcludes(
          "production",
          "staging",
        ),
      ).toEqual([]);
      expect(
        (service as any).getProductionPromotionExcludes(
          "production",
          "production",
        ),
      ).toEqual([]);
      expect(
        (service as any).getProductionPromotionExcludes("staging", null),
      ).toContain("web/robots.txt");
    });
  });

  function makeJob(name: string, data: object) {
    return {
      id: "sync-job-001",
      name,
      data,
      updateProgress: jest.fn(),
    } as any;
  }

  describe("replaceUrlsInFiles()", () => {
    function makeExecutorForFiles({
      sedExitCode,
      grepCode = 1,
      grepOutput = "",
    }: {
      sedExitCode: number;
      grepCode?: number;
      grepOutput?: string;
    }) {
      return {
        execute: jest.fn().mockImplementation((cmd: string) => {
          if (cmd.includes("test -d"))
            return Promise.resolve({ code: 0, stdout: "ok", stderr: "" });
          if (cmd.includes("grep -nHF -m 1"))
            return Promise.resolve({
              code: grepCode,
              stdout: grepOutput,
              stderr: grepCode > 1 ? "grep failed" : "",
            });
          return Promise.resolve({
            code: sedExitCode,
            stdout: "",
            stderr: sedExitCode !== 0 ? "permission denied" : "",
          });
        }),
      };
    }

    it("resolves when all sed replacements succeed", async () => {
      const executor = makeExecutorForFiles({ sedExitCode: 0 });
      const tracker = { track: jest.fn().mockResolvedValue(undefined) } as any;

      await expect(
        service.replaceUrlsInFiles(
          "https://staging.example.com",
          "https://example.com",
          "/var/www/html/wp-content",
          executor as any,
          tracker,
          makeJob(JOB_TYPES.SYNC_CLONE, { jobExecutionId: 1 }),
        ),
      ).resolves.toBeUndefined();
    });

    it("throws when any sed replacement fails", async () => {
      const executor = makeExecutorForFiles({ sedExitCode: 1 });
      const tracker = { track: jest.fn().mockResolvedValue(undefined) } as any;

      await expect(
        service.replaceUrlsInFiles(
          "https://staging.example.com",
          "https://example.com",
          "/var/www/html/wp-content",
          executor as any,
          tracker,
          makeJob(JOB_TYPES.SYNC_CLONE, { jobExecutionId: 1 }),
        ),
      ).rejects.toThrow("File URL replacement failed");
    });

    it("throws when stale source URLs remain in text assets after sed", async () => {
      const executor = makeExecutorForFiles({
        sedExitCode: 0,
        grepCode: 0,
        grepOutput:
          "/var/www/html/wp-content/cache/file.css:12:https://staging.example.com/banner",
      });
      const tracker = { track: jest.fn().mockResolvedValue(undefined) } as any;

      await expect(
        service.replaceUrlsInFiles(
          "https://staging.example.com",
          "https://example.com",
          "/var/www/html/wp-content",
          executor as any,
          tracker,
          makeJob(JOB_TYPES.SYNC_CLONE, { jobExecutionId: 1 }),
        ),
      ).rejects.toThrow("File URL replacement did not complete");
    });
  });

  describe("pushFilesViaRsync()", () => {
    function makeRsyncArgs(result: {
      code: number;
      stdout?: string;
      stderr?: string;
    }) {
      const sourceExecutor = {
        pushFile: jest.fn().mockResolvedValue(undefined),
        execute: jest.fn().mockResolvedValue({
          code: result.code,
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
        }),
      };
      const tracker = {
        track: jest.fn().mockResolvedValue(undefined),
        trackCommand: jest.fn().mockResolvedValue(undefined),
      };
      return { sourceExecutor, tracker };
    }

    it("resolves cleanly when rsync exits with code 0", async () => {
      const { sourceExecutor, tracker } = makeRsyncArgs({
        code: 0,
        stdout: "rsync complete",
      });

      await expect(
        (service as any).pushFilesViaRsync(
          makeJob(JOB_TYPES.SYNC_CLONE, { jobExecutionId: 1 }),
          "/src/path",
          "/tgt/path",
          {
            server: {
              ip_address: "1.2.3.4",
              ssh_port: 22,
              ssh_user: "user",
              ssh_private_key_encrypted: null,
            },
          },
          sourceExecutor as any,
          tracker as any,
          [],
        ),
      ).resolves.toBeUndefined();

      expect(tracker.track).toHaveBeenLastCalledWith(
        expect.objectContaining({
          step: "File sync complete (rsync)",
          detail: "rsync complete",
        }),
      );
    });

    it("resolves with warning when rsync exits with code 23 due only to permission errors on root files", async () => {
      const { sourceExecutor, tracker } = makeRsyncArgs({
        code: 23,
        stderr:
          'rsync: chown "/tgt/path/wp-config.php" failed: Operation not permitted (1)\n' +
          "rsync error: some files/attrs were not transferred (see previous errors) (code 23) at main.c(1333) [sender=3.2.3]",
      });

      await expect(
        (service as any).pushFilesViaRsync(
          makeJob(JOB_TYPES.SYNC_CLONE, { jobExecutionId: 1 }),
          "/src/path",
          "/tgt/path",
          {
            server: {
              ip_address: "1.2.3.4",
              ssh_port: 22,
              ssh_user: "user",
              ssh_private_key_encrypted: null,
            },
          },
          sourceExecutor as any,
          tracker as any,
          [],
        ),
      ).resolves.toBeUndefined();

      expect(tracker.track).toHaveBeenLastCalledWith(
        expect.objectContaining({
          step: expect.stringContaining(
            "some attrs skipped (root-owned files)",
          ),
          level: "warn",
        }),
      );
    });

    it("throws error when rsync exits with code 23 but output contains non-permission failures", async () => {
      const { sourceExecutor, tracker } = makeRsyncArgs({
        code: 23,
        stderr:
          "rsync: read error: Connection reset by peer (104)\n" +
          "rsync error: some files/attrs were not transferred (see previous errors) (code 23) at main.c(1333) [sender=3.2.3]",
      });

      await expect(
        (service as any).pushFilesViaRsync(
          makeJob(JOB_TYPES.SYNC_CLONE, { jobExecutionId: 1 }),
          "/src/path",
          "/tgt/path",
          {
            server: {
              ip_address: "1.2.3.4",
              ssh_port: 22,
              ssh_user: "user",
              ssh_private_key_encrypted: null,
            },
          },
          sourceExecutor as any,
          tracker as any,
          [],
        ),
      ).rejects.toThrow("rsync failed (exit 23)");
    });

    it("throws error when rsync exits with any other non-zero code", async () => {
      const { sourceExecutor, tracker } = makeRsyncArgs({
        code: 12,
        stderr: "rsync: connection timed out",
      });

      await expect(
        (service as any).pushFilesViaRsync(
          makeJob(JOB_TYPES.SYNC_CLONE, { jobExecutionId: 1 }),
          "/src/path",
          "/tgt/path",
          {
            server: {
              ip_address: "1.2.3.4",
              ssh_port: 22,
              ssh_user: "user",
              ssh_private_key_encrypted: null,
            },
          },
          sourceExecutor as any,
          tracker as any,
          [],
        ),
      ).rejects.toThrow("rsync failed (exit 12): rsync: connection timed out");
    });
  });
});
