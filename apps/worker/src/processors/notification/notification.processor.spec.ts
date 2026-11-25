import { Test } from "@nestjs/testing";
import { NotificationProcessor } from "./notification.processor";
import { PrismaService } from "../../prisma/prisma.service";
import { EncryptionService } from "../../encryption/encryption.service";
import { JOB_TYPES } from "@bedrock-forge/shared";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makePrisma() {
  return {
    notificationChannel: {
      findMany: jest.fn(),
    },
    notificationLog: {
      create: jest.fn().mockResolvedValue({}),
    },
    user: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    userNotification: {
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };
}

function makeEncryption() {
  return { decrypt: jest.fn().mockReturnValue("xoxb-fake-token") };
}

function makeJob(name: string, data: object) {
  const job = {
    name,
    data: { ...data },
    updateData: jest.fn().mockImplementation(async (nextData: object) => {
      job.data = nextData;
    }),
  };
  return job as any;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("NotificationProcessor", () => {
  let processor: NotificationProcessor;
  let prisma: ReturnType<typeof makePrisma>;
  let encryption: ReturnType<typeof makeEncryption>;

  beforeEach(async () => {
    prisma = makePrisma();
    encryption = makeEncryption();

    const module = await Test.createTestingModule({
      providers: [
        NotificationProcessor,
        { provide: PrismaService, useValue: prisma },
        { provide: EncryptionService, useValue: encryption },
      ],
    }).compile();

    processor = module.get(NotificationProcessor);
  });

  it("does nothing for unknown job names", async () => {
    const job = makeJob("unknown:job", {
      eventType: "backup.completed",
      payload: {},
    });
    await processor.process(job);
    expect(prisma.notificationChannel.findMany).not.toHaveBeenCalled();
  });

  it("exits early when no active channels match the event", async () => {
    prisma.notificationChannel.findMany.mockResolvedValue([]);
    const job = makeJob(JOB_TYPES.NOTIFICATION_SEND, {
      eventType: "backup.completed",
      payload: { environmentId: 1 },
    });
    await processor.process(job);
    expect(prisma.notificationLog.create).not.toHaveBeenCalled();
  });

  it('logs "failed" when channel is missing bot token', async () => {
    prisma.notificationChannel.findMany.mockResolvedValue([
      {
        id: BigInt(1),
        name: "no-token-channel",
        type: "slack",
        slack_bot_token_enc: null,
        slack_channel_id: null,
        google_chat_webhook_url_enc: null,
        active: true,
        events: ["backup.completed"],
      },
    ]);

    const job = makeJob(JOB_TYPES.NOTIFICATION_SEND, {
      eventType: "backup.completed",
      payload: { environmentId: 1 },
    });
    await expect(processor.process(job)).rejects.toThrow(/no-token-channel/);

    expect(prisma.notificationLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "failed",
          event_type: "backup.completed",
        }),
      }),
    );
  });

  describe("buildMessage (via process with mocked Slack)", () => {
    const channel = {
      id: BigInt(2),
      name: "test-channel",
      type: "slack",
      slack_bot_token_enc: "enc-token",
      slack_channel_id: "C123",
      google_chat_webhook_url_enc: null,
      active: true,
      events: ["backup.completed"],
    };

    beforeEach(() => {
      prisma.notificationChannel.findMany.mockResolvedValue([channel]);
      // Mock @slack/web-api so we don't need a real Slack connection
      jest.mock("@slack/web-api", () => ({
        WebClient: jest.fn().mockImplementation(() => ({
          chat: {
            postMessage: jest.fn().mockResolvedValue({ ok: true }),
          },
        })),
      }));
    });

    it('logs "sent" status on successful Slack delivery', async () => {
      const job = makeJob(JOB_TYPES.NOTIFICATION_SEND, {
        eventType: "backup.completed",
        payload: { environmentId: 5, backupType: "full", sizeBytes: 1024 },
      });
      await processor.process(job);

      expect(prisma.notificationLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ event_type: "backup.completed" }),
        }),
      );
    });
  });

  describe("Google Chat delivery", () => {
    beforeEach(() => {
      prisma.notificationChannel.findMany.mockResolvedValue([
        {
          id: BigInt(3),
          name: "google-chat-channel",
          type: "google_chat",
          slack_bot_token_enc: null,
          slack_channel_id: null,
          google_chat_webhook_url_enc: "enc-webhook",
          active: true,
          events: ["backup.completed"],
        },
      ]);
      encryption.decrypt.mockReturnValue("https://chat.googleapis.com/test");
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
      } as Response);
    });

    it("posts text payloads to Google Chat webhooks", async () => {
      const job = makeJob(JOB_TYPES.NOTIFICATION_SEND, {
        eventType: "backup.completed",
        payload: { environmentId: 5, backupType: "full", sizeBytes: 1024 },
      });

      await processor.process(job);

      expect(global.fetch).toHaveBeenCalledWith(
        "https://chat.googleapis.com/test",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining("backup.completed"),
        }),
      );
      expect(prisma.notificationLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            channel_id: BigInt(3),
            status: "sent",
          }),
        }),
      );
    });
  });

  describe("security alert message formatting", () => {
    function build(eventType: string, payload: Record<string, unknown>) {
      return (processor as any).buildMessage(eventType, payload) as string;
    }

    it("formats SSH login details", () => {
      const message = build("security.ssh_login", {
        serverName: "prod-1",
        serverIp: "203.0.113.10",
        user: "deploy",
        sourceIp: "198.51.100.4",
        authMethod: "publickey",
        timestamp: "2026-05-14T10:00:00Z",
        rawExcerpt:
          "Accepted publickey for deploy from 198.51.100.4 port 51234",
      });

      expect(message).toContain("SSH login accepted");
      expect(message).toContain("prod-1 (203.0.113.10)");
      expect(message).toContain("deploy");
      expect(message).toContain("198.51.100.4");
      expect(message).toContain("publickey");
    });

    it("formats failed login spikes", () => {
      const message = build("security.ssh_failed_login_spike", {
        serverName: "prod-1",
        serverIp: "203.0.113.10",
        sourceIp: "198.51.100.8",
        count: 14,
        threshold: 10,
        windowStart: "2026-05-14T09:55:00Z",
        windowEnd: "2026-05-14T10:00:00Z",
      });

      expect(message).toContain("Failed SSH login spike");
      expect(message).toContain("Attempts: 14");
      expect(message).toContain("Threshold: 10");
      expect(message).toContain("198.51.100.8");
    });

    it("formats batched file changes", () => {
      const message = build("security.file_changes", {
        serverName: "prod-1",
        serverIp: "203.0.113.10",
        addedCount: 1,
        modifiedCount: 2,
        deletedCount: 3,
        topChangedPaths: [
          "/etc/ssh/sshd_config",
          "/var/www/site/wp-config.php",
        ],
      });

      expect(message).toContain("Sensitive file changes detected");
      expect(message).toContain("Added: 1 | Modified: 2 | Deleted: 3");
      expect(message).toContain("/etc/ssh/sshd_config");
      expect(message).toContain("/var/www/site/wp-config.php");
    });
  });

  describe("retry handling and per-recipient idempotency (#95)", () => {
    const originalFetch = global.fetch;

    afterEach(() => {
      global.fetch = originalFetch;
      jest.restoreAllMocks();
    });

    it("throws on transient failure and retries only failed channels without duplicating in-app alerts", async () => {
      prisma.user.findMany.mockResolvedValue([{ id: BigInt(1) }]);
      prisma.notificationChannel.findMany.mockResolvedValue([
        {
          id: BigInt(10),
          name: "gchat-ok",
          type: "google_chat",
          slack_bot_token_enc: null,
          slack_channel_id: null,
          google_chat_webhook_url_enc: "enc-gchat",
          webhook_url_enc: null,
          webhook_secret_enc: null,
          active: true,
          events: ["backup.failed"],
        },
        {
          id: BigInt(20),
          name: "hook-flaky",
          type: "webhook",
          slack_bot_token_enc: null,
          slack_channel_id: null,
          google_chat_webhook_url_enc: null,
          webhook_url_enc: "enc-hook",
          webhook_secret_enc: null,
          active: true,
          events: ["backup.failed"],
        },
      ]);

      encryption.decrypt.mockImplementation((v: string) =>
        v === "enc-gchat"
          ? "https://chat.example.test/ok"
          : "https://hook.example.test/flaky",
      );

      const fetchMock = jest
        .fn()
        // Attempt 1: gchat succeeds, webhook fails with 503
        .mockResolvedValueOnce({ ok: true } as Response)
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          text: async () => "Service Unavailable",
        } as Response)
        // Attempt 2: only webhook is retried and succeeds
        .mockResolvedValueOnce({ ok: true } as Response);
      global.fetch = fetchMock;

      const job = makeJob(JOB_TYPES.NOTIFICATION_SEND, {
        eventType: "backup.failed",
        payload: { environmentId: 1, error: "disk full" },
      });

      // Attempt 1 throws so BullMQ schedules retry
      await expect(processor.process(job)).rejects.toThrow(/hook-flaky/);
      expect(prisma.userNotification.createMany).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(job.data.inAppCreated).toBe(true);
      expect(job.data.deliveredChannelIds).toEqual(["10"]);

      // Attempt 2 completes cleanly without duplicating gchat or in-app notifications
      await expect(processor.process(job)).resolves.toBeUndefined();
      expect(prisma.userNotification.createMany).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(fetchMock.mock.calls[2][0]).toBe("https://hook.example.test/flaky");
      expect(job.data.deliveredChannelIds).toEqual(["10", "20"]);
    });

    it("surfaces permanent failure when all channels continue failing", async () => {
      prisma.notificationChannel.findMany.mockResolvedValue([
        {
          id: BigInt(30),
          name: "always-down",
          type: "webhook",
          slack_bot_token_enc: null,
          slack_channel_id: null,
          google_chat_webhook_url_enc: null,
          webhook_url_enc: "enc-down",
          webhook_secret_enc: null,
          active: true,
          events: ["backup.completed"],
        },
      ]);
      encryption.decrypt.mockReturnValue("https://hook.example.test/down");
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => "Internal Error",
      } as Response);

      const job = makeJob(JOB_TYPES.NOTIFICATION_SEND, {
        eventType: "backup.completed",
        payload: { environmentId: 1 },
      });

      await expect(processor.process(job)).rejects.toThrow(/always-down/);
      expect(prisma.notificationLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            channel_id: BigInt(30),
            status: "failed",
          }),
        }),
      );
    });
  });
});
