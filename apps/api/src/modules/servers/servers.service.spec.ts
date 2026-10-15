import { ServersService } from "./servers.service";
import { ServersRepository } from "./servers.repository";
import { EncryptionService } from "../../common/encryption/encryption.service";
import { SettingsService } from "../settings/settings.service";

describe("ServersService", () => {
  it("uses the global SSH key when a server has no per-server key", async () => {
    const server = {
      id: BigInt(1),
      name: "Example server",
      ip_address: "192.0.2.1",
      ssh_port: 22,
      ssh_user: "root",
      ssh_private_key_encrypted: null,
      host_key_fingerprint: null,
    };
    const repository = {
      findByIdWithKey: jest.fn().mockResolvedValue(server),
      updateHostKeyFingerprint: jest.fn(),
    };
    const encryption = { decrypt: jest.fn() };
    const settings = {
      getDecrypted: jest
        .fn()
        .mockResolvedValue(
          "-----BEGIN OPENSSH PRIVATE KEY-----test-----END OPENSSH PRIVATE KEY-----",
        ),
    };
    const service = new ServersService(
      repository as unknown as ServersRepository,
      encryption as unknown as EncryptionService,
      settings as unknown as SettingsService,
    );

    await expect(service.getServerSshConfig(1)).resolves.toMatchObject({
      host: "192.0.2.1",
      port: 22,
      username: "root",
      privateKey:
        "-----BEGIN OPENSSH PRIVATE KEY-----test-----END OPENSSH PRIVATE KEY-----",
    });
    expect(settings.getDecrypted).toHaveBeenCalledWith(
      "global_ssh_private_key",
    );
  });
});
