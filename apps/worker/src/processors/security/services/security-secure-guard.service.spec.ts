import { SecuritySecureGuardService } from "./security-secure-guard.service";
import { StepTracker } from "../../../services/step-tracker";

const mockExecute = jest.fn();
const mockPushFile = jest.fn();

jest.mock("@bedrock-forge/remote-executor", () => ({
  createRemoteExecutor: jest.fn(() => ({
    execute: mockExecute,
    pushFile: mockPushFile,
  })),
}));

jest.mock("../../../services/step-tracker", () => ({
  StepTracker: {
    start: jest.fn().mockResolvedValue({
      track: jest.fn(),
      trackCommand: jest.fn(),
      complete: jest.fn(),
      fail: jest.fn(),
    }),
  },
}));

describe("SecuritySecureGuardService", () => {
  let service: SecuritySecureGuardService;
  let prismaMock: any;
  let sshKeyMock: any;

  beforeEach(() => {
    jest.clearAllMocks();

    prismaMock = {
      environment: {
        findUnique: jest.fn().mockResolvedValue({
          id: 10n,
          type: "production",
          root_path: "/home/example.com/public_html",
          server: {
            id: 1n,
            name: "Test Server",
            ip_address: "1.2.3.4",
            ssh_port: 22,
            ssh_user: "root",
          },
        }),
      },
    };

    sshKeyMock = {
      getSshConfig: jest.fn().mockResolvedValue({
        host: "1.2.3.4",
        port: 22,
        username: "root",
        privateKey: "dummy-key",
      }),
    };

    service = new SecuritySecureGuardService(prismaMock, sshKeyMock);
  });

  describe("installSecureGuard", () => {
    it("installs, activates, and configures preset on Bedrock layout", async () => {
      mockExecute.mockImplementation(async (cmd: string) => {
        if (cmd.includes("test -d") && cmd.includes("web/app/plugins")) {
          return { code: 0, stdout: "bedrock", stderr: "" };
        }
        if (cmd.includes("test -d") && cmd.includes(".git")) {
          return { code: 0, stdout: "none", stderr: "" };
        }
        if (cmd.includes("git clone")) {
          return { code: 0, stdout: "Cloning into...", stderr: "" };
        }
        if (cmd.includes("secure-guard-watchdog.php")) {
          return { code: 0, stdout: "root", stderr: "" };
        }
        if (cmd.includes("wp plugin activate")) {
          return { code: 0, stdout: "Plugin 'wp-secure-guard' activated.", stderr: "" };
        }
        if (cmd.includes("wp option update secure_guard_preset")) {
          return { code: 0, stdout: "Success: Updated 'secure_guard_preset' option.", stderr: "" };
        }
        if (cmd.includes("stat -c '%U %G'")) {
          return { code: 0, stdout: "example example", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      });

      const job = {
        data: {
          environmentId: 10,
          jobExecutionId: 101,
          preset: "maximum",
          deployWatchdog: true,
        },
      } as any;

      const result = await service.installSecureGuard(job);

      expect(result).toEqual({ success: true, environmentId: 10 });
      expect(mockExecute).toHaveBeenCalledWith(
        expect.stringContaining("git clone --depth 1 https://github.com/garamahq/wp-secure-guard.git"),
      );
      expect(mockExecute).toHaveBeenCalledWith(
        expect.stringContaining("wp plugin activate wp-secure-guard"),
      );
      expect(mockExecute).toHaveBeenCalledWith(
        expect.stringContaining("wp option update secure_guard_preset 'maximum'"),
      );
    });

    it("falls back to tarball archive if git clone fails", async () => {
      mockExecute.mockImplementation(async (cmd: string) => {
        if (cmd.includes("test -d") && cmd.includes("web/app/plugins")) {
          return { code: 0, stdout: "standard", stderr: "" };
        }
        if (cmd.includes("test -d") && cmd.includes(".git")) {
          return { code: 0, stdout: "none", stderr: "" };
        }
        if (cmd.includes("git clone")) {
          return { code: 1, stdout: "", stderr: "fatal: clone failed" };
        }
        if (cmd.includes("curl -sL") && cmd.includes("tar -xz")) {
          return { code: 0, stdout: "Archive extracted", stderr: "" };
        }
        if (cmd.includes("secure-guard-watchdog.php")) {
          return { code: 0, stdout: "none", stderr: "" };
        }
        if (cmd.includes("wp plugin activate")) {
          return { code: 0, stdout: "Plugin activated.", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      });

      const job = {
        data: {
          environmentId: 10,
          jobExecutionId: 102,
          deployWatchdog: true,
        },
      } as any;

      const result = await service.installSecureGuard(job);

      expect(result).toEqual({ success: true, environmentId: 10 });
      expect(mockExecute).toHaveBeenCalledWith(
        expect.stringContaining("curl -sL https://github.com/garamahq/wp-secure-guard/archive/refs/heads/main.tar.gz"),
      );
      expect(mockPushFile).toHaveBeenCalledWith(
        expect.objectContaining({
          remotePath: expect.stringContaining("secure-guard-watchdog.php"),
        }),
      );
    });

    it("throws when environment is not found", async () => {
      prismaMock.environment.findUnique.mockResolvedValueOnce(null);

      const job = {
        data: {
          environmentId: 999,
          jobExecutionId: 103,
        },
      } as any;

      await expect(service.installSecureGuard(job)).rejects.toThrow(
        "Environment 999 not found",
      );
    });
  });

  describe("deployWatchdog", () => {
    it("copies watchdog when present in plugin source directory", async () => {
      mockExecute.mockImplementation(async (cmd: string) => {
        if (cmd.includes("test -d") && cmd.includes("web/app/plugins")) {
          return { code: 0, stdout: "bedrock", stderr: "" };
        }
        if (cmd.includes("secure-guard-watchdog.php")) {
          return { code: 0, stdout: "root", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      });

      const job = {
        data: {
          environmentId: 10,
          jobExecutionId: 104,
        },
      } as any;

      const result = await service.deployWatchdog(job);

      expect(result).toEqual({ success: true, environmentId: 10 });
      expect(mockExecute).toHaveBeenCalledWith(
        expect.stringContaining("cp '/home/example.com/public_html/web/app/plugins/wp-secure-guard/secure-guard-watchdog.php'"),
      );
    });

    it("pushes standalone watchdog PHP content if not found in plugin", async () => {
      mockExecute.mockImplementation(async (cmd: string) => {
        if (cmd.includes("test -d") && cmd.includes("web/app/plugins")) {
          return { code: 0, stdout: "bedrock", stderr: "" };
        }
        if (cmd.includes("secure-guard-watchdog.php")) {
          return { code: 0, stdout: "none", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      });

      const job = {
        data: {
          environmentId: 10,
          jobExecutionId: 105,
        },
      } as any;

      const result = await service.deployWatchdog(job);

      expect(result).toEqual({ success: true, environmentId: 10 });
      expect(mockPushFile).toHaveBeenCalledWith(
        expect.objectContaining({
          remotePath: "/home/example.com/public_html/web/app/mu-plugins/secure-guard-watchdog.php",
          content: expect.any(Buffer),
        }),
      );
    });
  });
});
