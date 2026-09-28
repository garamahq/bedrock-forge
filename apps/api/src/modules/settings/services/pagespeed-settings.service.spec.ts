import { Test } from "@nestjs/testing";
import { PagespeedSettingsService } from "./pagespeed-settings.service";
import { SettingsRepository } from "../settings.repository";
import { EncryptionService } from "../../../common/encryption/encryption.service";
import { ConfigService } from "@nestjs/config";

const makeRepo = () => ({
  findByKey: jest.fn(),
  upsert: jest.fn(),
  delete: jest.fn(),
});

const makeEnc = () => ({
  encrypt: jest.fn((v: string) => `enc:${v}`),
  decrypt: jest.fn((v: string) => v.replace("enc:", "")),
});

const makeConfig = () => ({
  get: jest.fn(() => null),
});

describe("PagespeedSettingsService", () => {
  let service: PagespeedSettingsService;
  let repo: ReturnType<typeof makeRepo>;
  let enc: ReturnType<typeof makeEnc>;

  beforeEach(async () => {
    repo = makeRepo();
    enc = makeEnc();
    const module = await Test.createTestingModule({
      providers: [
        PagespeedSettingsService,
        { provide: SettingsRepository, useValue: repo },
        { provide: EncryptionService, useValue: enc },
        { provide: ConfigService, useValue: makeConfig() },
      ],
    }).compile();
    service = module.get(PagespeedSettingsService);
  });

  it("returns unconfigured by default", async () => {
    repo.findByKey.mockResolvedValue(null);
    const res = await service.getPagespeedConfig();
    expect(res.configured).toBe(false);
    expect(res.provider).toBe("auto");
    expect(res.hasApiKey).toBe(false);
  });

  it("encrypts and stores apiKey and provider", async () => {
    await service.setPagespeedConfig({
      apiKey: "test-pagespeed-api-key",
      provider: "pagespeed",
    });
    expect(enc.encrypt).toHaveBeenCalledWith("test-pagespeed-api-key");
    expect(repo.upsert).toHaveBeenCalledWith(
      "pagespeed_api_key",
      "enc:test-pagespeed-api-key",
    );
    expect(repo.upsert).toHaveBeenCalledWith(
      "pagespeed_provider",
      "pagespeed",
    );
  });

  it("deletes key and provider on deletePagespeedConfig", async () => {
    await service.deletePagespeedConfig();
    expect(repo.delete).toHaveBeenCalledWith("pagespeed_api_key");
    expect(repo.delete).toHaveBeenCalledWith("pagespeed_provider");
  });
});
