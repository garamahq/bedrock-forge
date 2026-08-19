import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SettingsRepository } from "../settings.repository";
import { EncryptionService } from "../../../common/encryption/encryption.service";
import { SetPagespeedSettingsDto } from "../dto/pagespeed-settings.dto";

export interface PagespeedConfigResponse {
  configured: boolean;
  provider: "auto" | "local" | "pagespeed";
  hasApiKey: boolean;
  apiKeyPreview: string | null;
}

@Injectable()
export class PagespeedSettingsService {
  private readonly logger = new Logger(PagespeedSettingsService.name);

  constructor(
    private readonly repo: SettingsRepository,
    private readonly enc: EncryptionService,
    private readonly config: ConfigService,
  ) {}

  async getPagespeedConfig(): Promise<PagespeedConfigResponse> {
    const keySetting = await this.repo.findByKey("pagespeed_api_key");
    const providerSetting = await this.repo.findByKey("pagespeed_provider");

    const envKey = this.config.get<string>("PAGESPEED_API_KEY");
    const envProvider = this.config.get<string>("LIGHTHOUSE_PROVIDER");

    const hasStoredKey = !!keySetting?.value;
    const hasEnvKey = !!envKey;
    const hasApiKey = hasStoredKey || hasEnvKey;

    let apiKeyPreview: string | null = null;
    if (hasStoredKey) {
      try {
        const decrypted = this.enc.decrypt(keySetting!.value);
        if (decrypted.length > 8) {
          apiKeyPreview = `${decrypted.slice(0, 4)}...${decrypted.slice(-4)}`;
        } else {
          apiKeyPreview = "****";
        }
      } catch {
        apiKeyPreview = "****";
      }
    } else if (hasEnvKey) {
      apiKeyPreview = `${envKey!.slice(0, 4)}...${envKey!.slice(-4)}`;
    }

    const provider = (
      providerSetting?.value ??
      envProvider ??
      "auto"
    ).toLowerCase() as "auto" | "local" | "pagespeed";

    return {
      configured: hasApiKey || provider === "local",
      provider: ["auto", "local", "pagespeed"].includes(provider)
        ? provider
        : "auto",
      hasApiKey,
      apiKeyPreview,
    };
  }

  async setPagespeedConfig(dto: SetPagespeedSettingsDto): Promise<void> {
    if (dto.apiKey !== undefined) {
      if (dto.apiKey.trim()) {
        const encrypted = this.enc.encrypt(dto.apiKey.trim());
        await this.repo.upsert("pagespeed_api_key", encrypted);
        this.logger.log("PageSpeed API key updated");
      } else {
        await this.repo.delete("pagespeed_api_key");
        this.logger.log("PageSpeed API key removed");
      }
    }

    if (dto.provider) {
      await this.repo.upsert("pagespeed_provider", dto.provider);
      this.logger.log(`PageSpeed / Lighthouse provider set to: ${dto.provider}`);
    }
  }

  async deletePagespeedConfig(): Promise<void> {
    await this.repo.delete("pagespeed_api_key");
    await this.repo.delete("pagespeed_provider");
    this.logger.log("PageSpeed / Lighthouse settings reset to defaults");
  }

  async testPagespeed(
    testUrl = "https://example.com",
  ): Promise<{ success: boolean; message: string; data?: unknown }> {
    const keySetting = await this.repo.findByKey("pagespeed_api_key");
    let apiKey = this.config.get<string>("PAGESPEED_API_KEY");

    if (keySetting?.value) {
      try {
        apiKey = this.enc.decrypt(keySetting.value);
      } catch (err) {
        return {
          success: false,
          message: `Failed to decrypt stored PageSpeed API key: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    const endpoint = new URL(
      "https://www.googleapis.com/pagespeedonline/v5/runPagespeed",
    );
    endpoint.searchParams.set("url", testUrl);
    endpoint.searchParams.set("strategy", "mobile");
    endpoint.searchParams.append("category", "performance");
    if (apiKey) {
      endpoint.searchParams.set("key", apiKey);
    }

    try {
      const res = await fetch(endpoint, {
        signal: AbortSignal.timeout(60_000),
      });
      const json = await res.json().catch(() => null);

      if (!res.ok) {
        const errorMsg =
          json?.error?.message ?? `HTTP ${res.status}: ${res.statusText}`;
        return {
          success: false,
          message: `Google PageSpeed API request failed: ${errorMsg}`,
        };
      }

      const score =
        json?.lighthouseResult?.categories?.performance?.score != null
          ? Math.round(json.lighthouseResult.categories.performance.score * 100)
          : null;

      return {
        success: true,
        message: `PageSpeed connection successful! Performance score for ${testUrl}: ${score ?? "n/a"}/100`,
        data: { score, timestamp: json?.analysisUTCTimestamp },
      };
    } catch (err) {
      return {
        success: false,
        message: `Connection test failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}
