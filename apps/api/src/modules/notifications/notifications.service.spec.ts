import { Test } from "@nestjs/testing";
import { getQueueToken } from "@nestjs/bullmq";
import { createHmac } from "crypto";
import { QUEUES } from "@bedrock-forge/shared";
import { NotificationsService } from "./notifications.service";
import { NotificationsRepository } from "./notifications.repository";
import { EncryptionService } from "../../common/encryption/encryption.service";

describe("NotificationsService", () => {
  let service: NotificationsService;
  let repo: {
    findChannelById: jest.Mock;
    createLog: jest.Mock;
  };
  let encryption: {
    decrypt: jest.Mock;
    encrypt: jest.Mock;
  };

  const originalFetch = global.fetch;

  beforeEach(async () => {
    repo = {
      findChannelById: jest.fn(),
      createLog: jest.fn().mockResolvedValue({}),
    };
    encryption = {
      decrypt: jest.fn((v: string) => v.replace(/^enc:/, "")),
      encrypt: jest.fn((v: string) => `enc:${v}`),
    };

    const module = await Test.createTestingModule({
      providers: [
        NotificationsService,
        { provide: NotificationsRepository, useValue: repo },
        { provide: EncryptionService, useValue: encryption },
        {
          provide: getQueueToken(QUEUES.NOTIFICATIONS),
          useValue: { add: jest.fn().mockResolvedValue({ id: "1" }) },
        },
      ],
    }).compile();

    service = module.get(NotificationsService);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  describe("testChannel webhook signing (#96)", () => {
    it("signs the exact JSON body with X-Forge-Signature and includes source=bedrock-forge when secret is configured", async () => {
      repo.findChannelById.mockResolvedValue({
        id: BigInt(10),
        name: "signed-hook",
        type: "webhook",
        webhook_url_enc: "enc:https://hooks.example.test/webhook",
        webhook_secret_enc: "enc:super-secret-signing-key",
        slack_bot_token_enc: null,
        slack_channel_id: null,
        google_chat_webhook_url_enc: null,
        events: ["backup.completed"],
        active: true,
      });

      const fetchMock = jest.fn().mockResolvedValue({ ok: true } as Response);
      global.fetch = fetchMock;

      const res = await service.testChannel(10);

      expect(res).toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [
        string,
        { method: string; headers: Record<string, string>; body: string },
      ];
      expect(url).toBe("https://hooks.example.test/webhook");
      expect(init.method).toBe("POST");
      expect(init.headers["X-Forge-Event"]).toBe("test");

      const expectedSig = createHmac("sha256", "super-secret-signing-key")
        .update(init.body)
        .digest("hex");
      expect(init.headers["X-Forge-Signature"]).toBe(`sha256=${expectedSig}`);

      const parsed = JSON.parse(init.body) as Record<string, unknown>;
      expect(parsed).toMatchObject({
        event: "test",
        source: "bedrock-forge",
        payload: { message: "Test from channel signed-hook" },
      });
      expect(JSON.stringify(res)).not.toContain("super-secret-signing-key");
    });

    it("omits X-Forge-Signature when no webhook secret is configured", async () => {
      repo.findChannelById.mockResolvedValue({
        id: BigInt(11),
        name: "unsigned-hook",
        type: "webhook",
        webhook_url_enc: "enc:https://hooks.example.test/unsigned",
        webhook_secret_enc: null,
        slack_bot_token_enc: null,
        slack_channel_id: null,
        google_chat_webhook_url_enc: null,
        events: ["backup.completed"],
        active: true,
      });

      const fetchMock = jest.fn().mockResolvedValue({ ok: true } as Response);
      global.fetch = fetchMock;

      const res = await service.testChannel(11);

      expect(res).toEqual({ ok: true });
      const [, init] = fetchMock.mock.calls[0] as [
        string,
        { headers: Record<string, string>; body: string },
      ];
      expect(init.headers["X-Forge-Signature"]).toBeUndefined();
      expect(init.headers["X-Forge-Event"]).toBe("test");
      expect(JSON.parse(init.body)).toMatchObject({
        event: "test",
        source: "bedrock-forge",
      });
    });
  });
});
