import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { promises as dns } from "dns";
import * as ipaddr from "ipaddr.js";
import { SettingsRepository } from "./settings.repository";
import { EncryptionService } from "../../common/encryption/encryption.service";

/** Keys whose values are stored AES-256-GCM encrypted in the DB. */
const SENSITIVE_KEYS = new Set([
  "global_ssh_private_key",
  "rclone_gdrive_config",
  "GITHUB_API_TOKEN",
  "cloudflare_api_token",
  "pagespeed_api_key",
]);

@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);

  constructor(
    private readonly repo: SettingsRepository,
    private readonly enc: EncryptionService,
  ) {}

  async getAll() {
    const settings = await this.repo.findAll();
    return Object.fromEntries(settings.map((s) => [s.key, s.value]));
  }

  async get(key: string) {
    const s = await this.repo.findByKey(key);
    if (!s) return null;
    // Never return plaintext for sensitive keys via the generic get() accessor.
    // Use getDecrypted() internally or hasEncrypted() for UI existence checks.
    if (SENSITIVE_KEYS.has(key)) {
      return { key: s.key, has_value: true };
    }
    return { key: s.key, value: s.value };
  }

  async set(key: string, value: string) {
    // Auto-encrypt sensitive values so callers don't need to know about encryption.
    const stored = SENSITIVE_KEYS.has(key) ? this.enc.encrypt(value) : value;
    return this.repo.upsert(key, stored);
  }

  async delete(key: string) {
    return this.repo.delete(key);
  }

  /** Store a sensitive value encrypted. The raw plaintext is never persisted. */
  async setEncrypted(key: string, plaintext: string): Promise<void> {
    const encrypted = this.enc.encrypt(plaintext);
    await this.repo.upsert(key, encrypted);
  }

  /** Retrieve and decrypt a sensitive value. Returns null if unset. */
  async getDecrypted(key: string): Promise<string | null> {
    const s = await this.repo.findByKey(key);
    if (!s) return null;
    try {
      return this.enc.decrypt(s.value);
    } catch {
      return null;
    }
  }

  /** Returns true/false — never exposes the key value. */
  async hasEncrypted(key: string): Promise<boolean> {
    const s = await this.repo.findByKey(key);
    return !!s;
  }

  /** Filter out sensitive keys from getAll() display. */
  async getAllPublic() {
    const settings = await this.repo.findAll();
    const visible = settings.filter((s) => !SENSITIVE_KEYS.has(s.key));
    return Object.fromEntries(visible.map((s) => [s.key, s.value]));
  }

  // ── Webhook Testing ─────────────────────────────────────────────────────

  async testWebhook(type: "slack" | "discord" | "google_chat", url: string) {
    if (!url) throw new BadRequestException("Webhook URL is required");

    if (!(await this.isSafeUrl(url))) {
      throw new BadRequestException("Invalid or unsafe webhook URL");
    }

    const payload =
      type === "slack" || type === "google_chat"
        ? { text: "✅ Bedrock Forge — Test Notification" }
        : { content: "✅ Bedrock Forge — Test Notification" };

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Status ${res.status}: ${text}`);
      }

      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new BadRequestException(`Failed to send test notification: ${msg}`);
    }
  }

  private isPrivateIp(ip: string): boolean {
    try {
      if (!ipaddr.isValid(ip)) return true;
      const addr = ipaddr.parse(ip);
      const range = addr.range();
      const privateRanges = [
        "unspecified",
        "broadcast",
        "multicast",
        "linkLocal",
        "loopback",
        "private",
        "reserved",
        "uniqueLocal",
      ];
      return privateRanges.includes(range);
    } catch {
      return true;
    }
  }

  private async isSafeUrl(urlString: string): Promise<boolean> {
    try {
      const parsed = new URL(urlString);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return false;
      }
      const hostname = parsed.hostname;
      if (!hostname) return false;

      if (ipaddr.isValid(hostname)) {
        return !this.isPrivateIp(hostname);
      }

      const addresses = await dns.lookup(hostname, { all: true });
      for (const addr of addresses) {
        if (this.isPrivateIp(addr.address)) {
          return false;
        }
      }
      return true;
    } catch {
      return false;
    }
  }
}
