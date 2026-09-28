import { Test } from "@nestjs/testing";
import { SettingsService } from "./settings.service";
import { SettingsRepository } from "./settings.repository";
import { EncryptionService } from "../../common/encryption/encryption.service";

const makeRepo = () => ({
  findAll: jest.fn(),
  findByKey: jest.fn(),
  upsert: jest.fn(),
  delete: jest.fn(),
});

const makeEnc = () => ({
  encrypt: jest.fn((v: string) => `enc:${v}`),
  decrypt: jest.fn((v: string) => v.replace("enc:", "")),
});

describe("SettingsService", () => {
  let service: SettingsService;
  let repo: ReturnType<typeof makeRepo>;
  let enc: ReturnType<typeof makeEnc>;

  beforeEach(async () => {
    repo = makeRepo();
    enc = makeEnc();
    const module = await Test.createTestingModule({
      providers: [
        SettingsService,
        { provide: SettingsRepository, useValue: repo },
        { provide: EncryptionService, useValue: enc },
      ],
    }).compile();

    service = module.get(SettingsService);
  });

  it("get returns null if key not found", async () => {
    repo.findByKey.mockResolvedValue(null);
    expect(await service.get("missing")).toBeNull();
  });

  it("get returns { key, value } when found", async () => {
    repo.findByKey.mockResolvedValue({ key: "site_name", value: "Forge" });
    expect(await service.get("site_name")).toEqual({
      key: "site_name",
      value: "Forge",
    });
  });

  it("get does not expose the encrypted PageSpeed API key", async () => {
    repo.findByKey.mockResolvedValue({
      key: "pagespeed_api_key",
      value: "encrypted-api-key",
    });
    expect(await service.get("pagespeed_api_key")).toEqual({
      key: "pagespeed_api_key",
      has_value: true,
    });
  });

  it("getAllPublic excludes encrypted PageSpeed API key material", async () => {
    repo.findAll.mockResolvedValue([
      { key: "pagespeed_api_key", value: "encrypted-api-key" },
      { key: "pagespeed_provider", value: "auto" },
    ]);
    expect(await service.getAllPublic()).toEqual({ pagespeed_provider: "auto" });
  });

  it("set delegates to repo.upsert", async () => {
    repo.upsert.mockResolvedValue({ key: "k", value: "v" });
    await service.set("k", "v");
    expect(repo.upsert).toHaveBeenCalledWith("k", "v");
  });

  it("setEncrypted stores encrypted value", async () => {
    repo.upsert.mockResolvedValue(undefined);
    await service.setEncrypted("api_key", "my-secret");
    expect(enc.encrypt).toHaveBeenCalledWith("my-secret");
    expect(repo.upsert).toHaveBeenCalledWith("api_key", "enc:my-secret");
  });

  it("getDecrypted returns null when key absent", async () => {
    repo.findByKey.mockResolvedValue(null);
    expect(await service.getDecrypted("missing")).toBeNull();
  });

  it("getDecrypted decrypts stored value", async () => {
    repo.findByKey.mockResolvedValue({
      key: "api_key",
      value: "enc:my-secret",
    });
    expect(await service.getDecrypted("api_key")).toBe("my-secret");
  });

  it("getDecrypted returns null if decryption throws", async () => {
    repo.findByKey.mockResolvedValue({ key: "api_key", value: "bad-cipher" });
    enc.decrypt.mockImplementation(() => {
      throw new Error("invalid");
    });
    expect(await service.getDecrypted("api_key")).toBeNull();
  });

  it("hasEncrypted returns false when absent", async () => {
    repo.findByKey.mockResolvedValue(null);
    expect(await service.hasEncrypted("k")).toBe(false);
  });

  it("hasEncrypted returns true when present", async () => {
    repo.findByKey.mockResolvedValue({ key: "k", value: "enc:x" });
    expect(await service.hasEncrypted("k")).toBe(true);
  });

  describe("testWebhook", () => {
    let originalFetch: typeof fetch;

    beforeAll(() => {
      originalFetch = global.fetch;
    });

    afterAll(() => {
      global.fetch = originalFetch;
    });

    it("throws BadRequestException if url is empty", async () => {
      const { BadRequestException } = await import("@nestjs/common");
      await expect(service.testWebhook("slack", "")).rejects.toThrow(BadRequestException);
    });

    it("throws BadRequestException for unsafe private IP URL", async () => {
      const { BadRequestException } = await import("@nestjs/common");
      await expect(service.testWebhook("slack", "http://127.0.0.1/webhook")).rejects.toThrow(
        "Invalid or unsafe webhook URL",
      );
      await expect(service.testWebhook("slack", "http://10.0.0.1/webhook")).rejects.toThrow(
        "Invalid or unsafe webhook URL",
      );
      await expect(service.testWebhook("slack", "http://localhost/webhook")).rejects.toThrow(
        "Invalid or unsafe webhook URL",
      );
    });

    it("throws BadRequestException for non-HTTP/HTTPS protocols", async () => {
      const { BadRequestException } = await import("@nestjs/common");
      await expect(service.testWebhook("slack", "ftp://example.com/webhook")).rejects.toThrow(
        "Invalid or unsafe webhook URL",
      );
    });

    it("calls fetch and returns success for safe public URL", async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
      });

      const result = await service.testWebhook("slack", "https://hooks.slack.com/services/mock-webhook-id");
      expect(result).toEqual({ success: true });
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("hooks.slack.com"),
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: "✅ Bedrock Forge — Test Notification" }),
        }),
      );
    });

    it("throws BadRequestException if fetch fails", async () => {
      const { BadRequestException } = await import("@nestjs/common");
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal Server Error"),
      });

      await expect(
        service.testWebhook("slack", "https://hooks.slack.com/services/mock-webhook-id"),
      ).rejects.toThrow("Failed to send test notification: Status 500: Internal Server Error");
    });
  });
});
