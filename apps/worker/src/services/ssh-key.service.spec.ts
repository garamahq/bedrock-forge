import { createHash } from "crypto";
import { SshKeyService } from "./ssh-key.service";

describe("SshKeyService peer SSH host key verification (#80)", () => {
  let service: SshKeyService;
  let prisma: { appSetting: { findUnique: jest.Mock }; server: { update: jest.Mock } };
  let encryption: { decrypt: jest.Mock };

  beforeEach(() => {
    prisma = {
      appSetting: { findUnique: jest.fn().mockResolvedValue(null) },
      server: { update: jest.fn().mockResolvedValue({}) },
    };
    encryption = {
      decrypt: jest.fn((v: string) => v),
    };
    service = new SshKeyService(prisma as any, encryption as any);
  });

  function makeHostKeySample(seed = "peer-host-key-1") {
    const keyBytes = Buffer.from(seed);
    const base64Key = keyBytes.toString("base64");
    const fpNoPad = createHash("sha256")
      .update(keyBytes)
      .digest("base64")
      .replace(/=+$/, "");
    return { base64Key, fpNoPad };
  }

  it("writes verified known_hosts entry and returns StrictHostKeyChecking=yes options when fingerprint matches", async () => {
    const { base64Key, fpNoPad } = makeHostKeySample("ed25519-peer-A");
    const initiatorExecutor = {
      execute: jest.fn().mockImplementation(async (cmd: string) => {
        if (cmd.includes("ssh-keyscan")) {
          return {
            code: 0,
            stdout: `[203.0.113.10]:2222 ssh-ed25519 ${base64Key}\n`,
            stderr: "",
          };
        }
        return { code: 0, stdout: "", stderr: "" };
      }),
      pushFile: jest.fn().mockResolvedValue(undefined),
    };

    const result = await (service as any).preparePeerKnownHosts(
      initiatorExecutor as any,
      {
        name: "Peer A",
        ip_address: "203.0.113.10",
        ssh_port: 2222,
        host_key_fingerprint: `SHA256:${fpNoPad}=`,
      },
      "/tmp/forge_kh_1",
    );

    expect(initiatorExecutor.execute).toHaveBeenCalledWith(
      expect.stringContaining("ssh-keyscan"),
    );
    expect(initiatorExecutor.execute).toHaveBeenCalledWith(
      expect.stringContaining("chmod 600 '/tmp/forge_kh_1'"),
    );
    expect(initiatorExecutor.pushFile).toHaveBeenCalledWith({
      remotePath: "/tmp/forge_kh_1",
      content: Buffer.from(`[203.0.113.10]:2222 ssh-ed25519 ${base64Key}\n`, "utf8"),
    });
    expect(result.knownHostsPath).toBe("/tmp/forge_kh_1");
    expect(result.sshOptions).toContain("StrictHostKeyChecking=yes");
    expect(result.sshOptions).toContain("UserKnownHostsFile='/tmp/forge_kh_1'");
  });

  it("rejects mismatched host key fingerprint before writing known_hosts or returning SSH options", async () => {
    const attacker = makeHostKeySample("attacker-mitm-key");
    const expected = makeHostKeySample("legit-server-key");

    const initiatorExecutor = {
      execute: jest.fn().mockResolvedValue({
        code: 0,
        stdout: `203.0.113.10 ssh-ed25519 ${attacker.base64Key}\n`,
        stderr: "",
      }),
      pushFile: jest.fn().mockResolvedValue(undefined),
    };

    await expect(
      (service as any).preparePeerKnownHosts(
        initiatorExecutor as any,
        {
          name: "Peer A",
          ip_address: "203.0.113.10",
          ssh_port: 22,
          host_key_fingerprint: expected.fpNoPad,
        },
        "/tmp/forge_kh_2",
      ),
    ).rejects.toThrow(/host key verification failed|fingerprint/i);

    expect(initiatorExecutor.pushFile).not.toHaveBeenCalled();
  });

  it("rejects peer transfer when stored host_key_fingerprint is missing in Forge", async () => {
    const initiatorExecutor = {
      execute: jest.fn(),
      pushFile: jest.fn(),
    };

    await expect(
      (service as any).preparePeerKnownHosts(
        initiatorExecutor as any,
        {
          name: "Unpinned Server",
          ip_address: "203.0.113.99",
          ssh_port: 22,
          host_key_fingerprint: null,
        },
        "/tmp/forge_kh_3",
      ),
    ).rejects.toThrow(/host_key_fingerprint|fingerprint/i);

    expect(initiatorExecutor.execute).not.toHaveBeenCalled();
    expect(initiatorExecutor.pushFile).not.toHaveBeenCalled();
  });
});
