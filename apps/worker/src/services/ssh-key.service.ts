import { Injectable, Logger } from "@nestjs/common";
import { createHash } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { EncryptionService } from "../encryption/encryption.service";
import { RemoteExecutorService, SshServerConfig } from "@bedrock-forge/remote-executor";
import { shellQuote } from "../utils/processor-utils";

export interface PeerTrustArtifacts {
  knownHostsPath: string;
  sshOptions: string;
}

function normalizeSshSha256Fingerprint(raw: string): string {
  return raw.trim().replace(/^SHA256:/i, "").replace(/=+$/, "");
}

/**
 * SshKeyService
 *
 * Shared helper for resolving SSH private keys across all worker processors.
 * Mirrors the robust logic in the API's ServersService.resolvePrivateKey().
 *
 * Resolution order:
 *   1. Per-server key (ssh_private_key_encrypted field)
 *   2. Global key (app_settings.global_ssh_private_key)
 *
 * For each candidate key:
 *   - Decryption is wrapped in try/catch (guards against wrong ENCRYPTION_KEY)
 *   - Result is validated to be a PEM header (-----BEGIN ...)
 *
 * Throws a clear actionable error if no valid key is found.
 */
@Injectable()
export class SshKeyService {
  private readonly logger = new Logger(SshKeyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly enc: EncryptionService,
  ) {}

  async resolvePrivateKey(server: {
    name: string;
    ssh_private_key_encrypted: string | null;
  }): Promise<string> {
    if (server.ssh_private_key_encrypted) {
      try {
        const decrypted = this.enc.decrypt(server.ssh_private_key_encrypted);
        if (decrypted && decrypted.trimStart().startsWith("-----BEGIN")) {
          return decrypted;
        }
        this.logger.warn(
          `Per-server key for "${server.name}" decrypted but is not PEM-formatted — falling back to global key.`,
        );
      } catch (e) {
        this.logger.warn(
          `Per-server key decryption failed for "${server.name}" ` +
            `(ENCRYPTION_KEY mismatch or corrupted payload) — ` +
            `falling back to global key. Cause: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    const globalSetting = await this.prisma.appSetting.findUnique({
      where: { key: "global_ssh_private_key" },
    });
    if (globalSetting?.value) {
      try {
        const decrypted = this.enc.decrypt(globalSetting.value);
        if (decrypted && decrypted.trimStart().startsWith("-----BEGIN")) {
          return decrypted;
        }
      } catch {
        // Global key is also corrupted — fall through to the throw below
      }
    }

    throw new Error(
      `No valid SSH key available for server "${server.name}". ` +
        "Set a PEM-formatted private key on the server edit page, " +
        "or configure a global SSH key in Settings → SSH Key.",
    );
  }

  async getSshConfig(server: {
    id: bigint;
    name: string;
    ip_address: string;
    ssh_port: number;
    ssh_user: string;
    ssh_private_key_encrypted: string | null;
    host_key_fingerprint: string | null;
  }): Promise<SshServerConfig> {
    const privateKey = await this.resolvePrivateKey(server);
    return {
      host: server.ip_address,
      port: server.ssh_port,
      username: server.ssh_user,
      privateKey,
      expectedHostKeyFingerprint: server.host_key_fingerprint ?? undefined,
      onHostKeyFingerprint: async (fingerprint) => {
        await this.prisma.server.update({
          where: { id: server.id },
          data: { host_key_fingerprint: fingerprint },
        });
      },
    };
  }

  /**
   * Scan the peer server's SSH host keys from the initiating server, verify at least
   * one presented key matches Forge's stored SHA-256 fingerprint, and write a strict
   * single-purpose known_hosts file (chmod 600) on the initiator host (#80).
   */
  async preparePeerKnownHosts(
    initiatorExecutor: Pick<RemoteExecutorService, "execute" | "pushFile">,
    peerServer: {
      name: string;
      ip_address: string;
      ssh_port?: number | null;
      host_key_fingerprint?: string | null;
    },
    remoteKnownHostsPath: string,
  ): Promise<PeerTrustArtifacts> {
    const expectedFp = peerServer.host_key_fingerprint
      ? normalizeSshSha256Fingerprint(peerServer.host_key_fingerprint)
      : "";
    if (!expectedFp) {
      throw new Error(
        `Peer server "${peerServer.name}" has no stored SSH host_key_fingerprint in Forge; cannot establish trusted peer transfer.`,
      );
    }

    const peerPort = Number(peerServer.ssh_port || 22);
    const scanRes = await initiatorExecutor.execute(
      `ssh-keyscan -p ${peerPort} -T 10 ${shellQuote(peerServer.ip_address)} 2>/dev/null`,
    );
    if (scanRes.code !== 0 || !scanRes.stdout.trim()) {
      throw new Error(
        `Failed to probe SSH host key for peer "${peerServer.name}" (${peerServer.ip_address}:${peerPort}).`,
      );
    }

    const matchedLines: string[] = [];
    for (const rawLine of scanRes.stdout.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const parts = line.split(/\s+/);
      if (parts.length < 3) continue;

      let keyBuffer: Buffer;
      try {
        keyBuffer = Buffer.from(parts[2], "base64");
      } catch {
        continue;
      }
      if (keyBuffer.length === 0) continue;

      const digest = createHash("sha256")
        .update(keyBuffer)
        .digest("base64")
        .replace(/=+$/, "");
      if (digest === expectedFp) {
        matchedLines.push(line);
      }
    }

    if (matchedLines.length === 0) {
      throw new Error(
        `SSH host key verification failed for peer "${peerServer.name}" (${peerServer.ip_address}:${peerPort}): expected fingerprint did not match any presented host key.`,
      );
    }

    await initiatorExecutor.pushFile({
      remotePath: remoteKnownHostsPath,
      content: Buffer.from(matchedLines.join("\n") + "\n", "utf8"),
    });
    await initiatorExecutor.execute(
      `chmod 600 ${shellQuote(remoteKnownHostsPath)}`,
    );

    return {
      knownHostsPath: remoteKnownHostsPath,
      sshOptions: `-o StrictHostKeyChecking=yes -o UserKnownHostsFile=${shellQuote(remoteKnownHostsPath)}`,
    };
  }
}
