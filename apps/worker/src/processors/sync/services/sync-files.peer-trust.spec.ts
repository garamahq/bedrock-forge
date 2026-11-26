import { JOB_TYPES } from "@bedrock-forge/shared";
import { SyncFilesService } from "./sync-files.service";
import { SshKeyService } from "../../../services/ssh-key.service";
import { fixCyberPanelOwnership } from "../../../utils/processor-utils";

jest.mock("../../../utils/processor-utils", () => {
  const actual = jest.requireActual("../../../utils/processor-utils");
  return {
    ...actual,
    fixCyberPanelOwnership: jest.fn().mockResolvedValue({ owner: "site", webGroup: "nogroup" }),
  };
});

describe("SyncFilesService peer trust, key cleanup & scoped permissions (#80, #81, #86)", () => {
  let service: SyncFilesService;
  let sshKey: jest.Mocked<SshKeyService>;

  beforeEach(() => {
    jest.clearAllMocks();
    sshKey = {
      resolvePrivateKey: jest
        .fn()
        .mockResolvedValue("-----BEGIN OPENSSH PRIVATE KEY-----\nkey\n-----END OPENSSH PRIVATE KEY-----"),
      getSshConfig: jest.fn(),
      preparePeerKnownHosts: jest.fn().mockResolvedValue({
        knownHostsPath: "/tmp/forge_known_hosts_sync-1",
        sshOptions: "-o StrictHostKeyChecking=yes -o UserKnownHostsFile='/tmp/forge_known_hosts_sync-1'",
      }),
    } as any;
    service = new SyncFilesService(sshKey);
  });

  function makeJob() {
    return {
      id: "sync-1",
      name: JOB_TYPES.SYNC_PUSH,
      data: { jobExecutionId: 10 },
      updateProgress: jest.fn(),
    } as any;
  }

  function makeTracker() {
    return {
      track: jest.fn().mockResolvedValue(undefined),
      trackCommand: jest.fn().mockResolvedValue(undefined),
    } as any;
  }

  it("enforces pinned known_hosts instead of StrictHostKeyChecking=no and aborts before rsync on mismatch (#80)", async () => {
    const sourceExecutor = {
      pushFile: jest.fn().mockResolvedValue(undefined),
      execute: jest.fn().mockResolvedValue({ code: 0, stdout: "ok", stderr: "" }),
    };
    const tracker = makeTracker();

    await (service as any).pushFilesViaRsync(
      makeJob(),
      "/src",
      "/tgt",
      {
        server: {
          name: "Target",
          ip_address: "198.51.100.5",
          ssh_port: 2222,
          ssh_user: "deploy",
          ssh_private_key_encrypted: "enc",
          host_key_fingerprint: "SHA256:expected",
        },
      },
      sourceExecutor as any,
      tracker,
      [],
    );

    const rsyncCmd = sourceExecutor.execute.mock.calls
      .map(([cmd]: [string]) => cmd)
      .find((c) => c.startsWith("rsync "));
    expect(rsyncCmd).toBeDefined();
    expect(rsyncCmd).not.toContain("StrictHostKeyChecking=no");
    expect(rsyncCmd).toContain("StrictHostKeyChecking=yes");
    expect(rsyncCmd).toContain("UserKnownHostsFile=");

    // Now simulate host key mismatch
    (sshKey as any).preparePeerKnownHosts.mockRejectedValueOnce(
      new Error("SSH host key verification failed for Target"),
    );
    sourceExecutor.execute.mockClear().mockResolvedValue({ code: 0, stdout: "", stderr: "" });

    await expect(
      (service as any).pushFilesViaRsync(
        makeJob(),
        "/src",
        "/tgt",
        {
          server: {
            name: "Target",
            ip_address: "198.51.100.5",
            ssh_port: 2222,
            ssh_user: "deploy",
            ssh_private_key_encrypted: "enc",
            host_key_fingerprint: "SHA256:expected",
          },
        },
        sourceExecutor as any,
        tracker,
        [],
      ),
    ).rejects.toThrow(/host key verification failed/i);

    expect(
      sourceExecutor.execute.mock.calls.some(([cmd]: [string]) =>
        cmd.startsWith("rsync "),
      ),
    ).toBe(false);
    // Temp key pushed before known_hosts failure was STILL cleaned up (#81)
    expect(
      sourceExecutor.execute.mock.calls.some(([cmd]: [string]) =>
        cmd.includes("rm -f") && cmd.includes("forge_push_key_sync-1"),
      ),
    ).toBe(true);
  });

  it("cleans temp key/excludes/known_hosts when transfer throws and logs observable warning if rm fails (#81)", async () => {
    const tracker = makeTracker();
    const sourceExecutor = {
      pushFile: jest.fn().mockResolvedValue(undefined),
      execute: jest.fn().mockImplementation(async (cmd: string) => {
        if (cmd.startsWith("rsync ")) {
          throw new Error("SSH connection reset by peer");
        }
        if (cmd.includes("rm -f")) {
          return { code: 1, stdout: "", stderr: "EIO: I/O error deleting temp key" };
        }
        return { code: 0, stdout: "", stderr: "" };
      }),
    };

    await expect(
      (service as any).pushFilesViaRsync(
        makeJob(),
        "/src",
        "/tgt",
        {
          server: {
            name: "Target",
            ip_address: "198.51.100.5",
            ssh_port: 22,
            ssh_user: "deploy",
            ssh_private_key_encrypted: null,
            host_key_fingerprint: "fp",
          },
        },
        sourceExecutor as any,
        tracker,
        [],
      ),
    ).rejects.toThrow("SSH connection reset by peer");

    expect(
      sourceExecutor.execute.mock.calls.some(
        ([cmd]: [string]) =>
          cmd.includes("rm -f") &&
          cmd.includes("forge_push_key_sync-1") &&
          cmd.includes("forge_rsync_exclude_sync-1.txt") &&
          cmd.includes("forge_known_hosts_sync-1"),
      ),
    ).toBe(true);

    expect(tracker.track).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        step: expect.stringContaining("cleanup"),
      }),
    );
  });

  it("does not run pre-sync global chmod/chattr and passes scoped excludes + +x preservation post-transfer (#86)", async () => {
    const targetCmdsDuringTransferFailure: string[] = [];
    const sourceExecutor = {
      pushFile: jest.fn().mockResolvedValue(undefined),
      execute: jest.fn().mockImplementation(async (cmd: string) => {
        if (cmd.startsWith("test -d")) return { code: 0, stdout: "ok", stderr: "" };
        if (cmd.startsWith("command -v rsync")) return { code: 0, stdout: "ok", stderr: "" };
        if (cmd.startsWith("rsync ")) {
          return { code: 12, stdout: "", stderr: "rsync connection unexpectedly closed" };
        }
        return { code: 0, stdout: "", stderr: "" };
      }),
    };
    const targetExecutor = {
      pushFile: jest.fn().mockResolvedValue(undefined),
      execute: jest.fn().mockImplementation(async (cmd: string) => {
        targetCmdsDuringTransferFailure.push(cmd);
        if (cmd.startsWith("command -v rsync")) return { code: 0, stdout: "ok", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      }),
    };

    const server = {
      name: "Target",
      ip_address: "198.51.100.5",
      ssh_port: 22,
      ssh_user: "deploy",
      ssh_private_key_encrypted: null,
      host_key_fingerprint: "fp",
    };

    // 1. Transfer fails -> zero chmod/chattr ran on target
    await expect(
      service.pushFiles(
        makeJob(),
        { root_path: "/src", type: "staging" },
        { root_path: "/tgt", type: "production", server },
        sourceExecutor as any,
        targetExecutor as any,
        makeTracker(),
        ["wp-content/uploads/protected.jpg"],
      ),
    ).rejects.toThrow("rsync failed (exit 12)");

    expect(
      targetCmdsDuringTransferFailure.some(
        (c) => c.includes("chmod") || c.includes("chattr"),
      ),
    ).toBe(false);
    expect(fixCyberPanelOwnership).not.toHaveBeenCalled();

    // 2. Transfer succeeds -> scoped fixCyberPanelOwnership called with exclusions & +x/private guards
    sourceExecutor.execute.mockResolvedValue({ code: 0, stdout: "ok", stderr: "" });
    await service.pushFiles(
      makeJob(),
      { root_path: "/src", type: "staging" },
      { root_path: "/tgt", type: "production", server },
      sourceExecutor as any,
      targetExecutor as any,
      makeTracker(),
      ["wp-content/uploads/protected.jpg"],
    );

    expect(fixCyberPanelOwnership).toHaveBeenCalledWith(
      targetExecutor,
      "/tgt",
      expect.any(Object),
      expect.objectContaining({
        preserveExecutable: true,
        preservePrivateFiles: true,
        excludePaths: expect.arrayContaining([
          ".env",
          "wp-config.php",
          "wp-content/uploads/",
          "wp-content/uploads/protected.jpg",
        ]),
      }),
    );
  });
});
