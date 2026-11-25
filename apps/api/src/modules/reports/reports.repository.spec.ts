import { Test } from "@nestjs/testing";
import { ReportsRepository } from "./reports.repository";
import { PrismaService } from "../../prisma/prisma.service";
import { QUEUES } from "@bedrock-forge/shared";

const makePrisma = () => ({
  jobExecution: {
    findMany: jest.fn(),
  },
  notificationChannel: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
  },
});

describe("ReportsRepository", () => {
  let repository: ReportsRepository;
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(async () => {
    prisma = makePrisma();
    const module = await Test.createTestingModule({
      providers: [
        ReportsRepository,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    repository = module.get(ReportsRepository);
  });

  describe("findHistory", () => {
    it("returns and serializes BigInt IDs", async () => {
      prisma.jobExecution.findMany.mockResolvedValue([
        {
          id: BigInt(123),
          bull_job_id: "bull-123",
          job_type: "REPORT_GENERATE",
          status: "COMPLETED",
          progress: 100,
          last_error: null,
          payload: {},
          execution_log: [],
          started_at: new Date(),
          completed_at: new Date(),
          created_at: new Date(),
        },
      ]);

      const res = await repository.findHistory();
      expect(prisma.jobExecution.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { queue_name: QUEUES.REPORTS },
          take: 50,
        }),
      );
      expect(res[0].id).toBe("123");
    });
  });

  describe("findAvailableChannels", () => {
    it("maps and transforms channel entities", async () => {
      prisma.notificationChannel.findMany.mockResolvedValue([
        {
          id: BigInt(1),
          name: "Slack Alert",
          type: "SLACK",
          slack_channel_id: "C12345",
          slack_bot_token_enc: "enc-token",
          google_chat_webhook_url_enc: null,
          webhook_url_enc: null,
          active: true,
          events: ["report.weekly", "backup.success"],
        },
        {
          id: BigInt(2),
          name: "Ops Webhook",
          type: "webhook",
          slack_channel_id: null,
          slack_bot_token_enc: null,
          google_chat_webhook_url_enc: null,
          webhook_url_enc: "enc-webhook-url",
          active: true,
          events: ["report.weekly"],
        },
      ]);

      const res = await repository.findAvailableChannels();
      expect(res[0]).toEqual({
        id: 1,
        name: "Slack Alert",
        type: "SLACK",
        slack_channel_id: "C12345",
        has_token: true,
        has_webhook: false,
        has_webhook_url: false,
        active: true,
        subscribed: true,
      });
      expect(res[1]).toEqual({
        id: 2,
        name: "Ops Webhook",
        type: "webhook",
        slack_channel_id: null,
        has_token: false,
        has_webhook: false,
        has_webhook_url: true,
        active: true,
        subscribed: true,
      });
    });
  });

  describe("findChannelById", () => {
    it("queries single channel with BigInt", async () => {
      prisma.notificationChannel.findUnique.mockResolvedValue({
        id: BigInt(5),
      });

      const res = await repository.findChannelById(5);
      expect(prisma.notificationChannel.findUnique).toHaveBeenCalledWith({
        where: { id: BigInt(5) },
      });
      expect(res).toBeDefined();
    });
  });

  describe("updateChannelEvents", () => {
    it("updates channel events list and returns mapped subscription status", async () => {
      prisma.notificationChannel.update.mockResolvedValue({
        id: BigInt(2),
        name: "Slack Alert",
        events: ["report.weekly"],
      });

      const res = await repository.updateChannelEvents(2, ["report.weekly"]);
      expect(prisma.notificationChannel.update).toHaveBeenCalledWith({
        where: { id: BigInt(2) },
        data: { events: ["report.weekly"] },
      });
      expect(res).toEqual({
        id: 2,
        name: "Slack Alert",
        subscribed: true,
      });
    });
  });
});
