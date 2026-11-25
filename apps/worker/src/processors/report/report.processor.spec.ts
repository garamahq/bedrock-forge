import { createHmac } from "crypto";
import { Test } from "@nestjs/testing";
import { PrismaService } from "../../prisma/prisma.service";
import { EncryptionService } from "../../encryption/encryption.service";
import { RcloneService } from "../../services/rclone.service";
import { JOB_TYPES } from "@bedrock-forge/shared";
import {
  ReportProcessor,
  computeDateRange,
  summarizePeriodBackups,
  buildDocDef,
} from "./report.processor";

jest.mock("@slack/web-api", () => ({
  WebClient: jest.fn().mockImplementation(() => ({
    filesUploadV2: jest.fn().mockResolvedValue({ ok: true }),
  })),
}));

jest.mock("pdfmake/js/Printer.js", () => ({
  default: jest.fn().mockImplementation(() => ({
    createPdfKitDocument: jest.fn().mockResolvedValue({
      on: jest.fn((event: string, cb: (arg?: unknown) => void) => {
        if (event === "data") cb(Buffer.from("%PDF-1.4 mock"));
        if (event === "end") cb();
      }),
      end: jest.fn(),
    }),
  })),
}));

describe("ReportProcessor (#72, #73, #74)", () => {
  let processor: ReportProcessor;
  let prisma: {
    jobExecution: { create: jest.Mock; update: jest.Mock };
    server: { findMany: jest.Mock };
    backup: { findMany: jest.Mock };
    monitor: { findMany: jest.Mock };
    appSetting: { findUnique: jest.Mock };
    notificationChannel: { findMany: jest.Mock };
    notificationLog: { create: jest.Mock };
  };
  let encryption: { decrypt: jest.Mock };
  let rclone: { writeConfig: jest.Mock; upload: jest.Mock; getShareLink: jest.Mock };

  beforeEach(async () => {
    prisma = {
      jobExecution: {
        create: jest.fn().mockResolvedValue({ id: BigInt(101) }),
        update: jest.fn().mockResolvedValue({ id: BigInt(101) }),
      },
      server: { findMany: jest.fn().mockResolvedValue([]) },
      backup: { findMany: jest.fn().mockResolvedValue([]) },
      monitor: { findMany: jest.fn().mockResolvedValue([]) },
      appSetting: { findUnique: jest.fn().mockResolvedValue(null) },
      notificationChannel: { findMany: jest.fn().mockResolvedValue([]) },
      notificationLog: { create: jest.fn().mockResolvedValue({ id: BigInt(1) }) },
    };
    encryption = {
      decrypt: jest.fn((v: string) => v.replace(/^enc:/, "")),
    };
    rclone = {
      writeConfig: jest.fn().mockResolvedValue(false),
      upload: jest.fn(),
      getShareLink: jest.fn(),
    };

    const mod = await Test.createTestingModule({
      providers: [
        ReportProcessor,
        { provide: PrismaService, useValue: prisma },
        { provide: EncryptionService, useValue: encryption },
        { provide: RcloneService, useValue: rclone },
      ],
    }).compile();

    processor = mod.get(ReportProcessor);
    jest.restoreAllMocks();
  });

  describe("computeDateRange (#72)", () => {
    it("supports last_90d, this_month, and last_month with UTC boundaries", () => {
      const ref = new Date("2026-11-24T12:00:00.000Z");

      const r90 = computeDateRange("last_90d", ref);
      expect(r90.periodLabel).toBe("Last 90 Days");
      expect(r90.startDate.toISOString()).toBe("2026-08-26T12:00:00.000Z");

      const rThis = computeDateRange("this_month", ref);
      expect(rThis.periodLabel).toBe("November 2026");
      expect(rThis.startDate.toISOString()).toBe("2026-11-01T00:00:00.000Z");
      expect(rThis.dateRange).toBe("2026-11-01 to 2026-11-24");

      const rLast = computeDateRange("last_month", ref);
      expect(rLast.periodLabel).toBe("October 2026");
      expect(rLast.startDate.toISOString()).toBe("2026-10-01T00:00:00.000Z");
      expect(rLast.dateRange).toBe("2026-10-01 to 2026-10-31");
      expect((rLast as { endExclusive?: Date }).endExclusive?.toISOString()).toBe(
        "2026-11-01T00:00:00.000Z",
      );
    });

    it("handles year boundary cleanly when last_month is computed in January", () => {
      const jan = new Date("2027-01-15T08:00:00.000Z");
      const rLast = computeDateRange("last_month", jan) as ReturnType<
        typeof computeDateRange
      > & { endExclusive?: Date };
      expect(rLast.periodLabel).toBe("December 2026");
      expect(rLast.startDate.toISOString()).toBe("2026-12-01T00:00:00.000Z");
      expect(rLast.dateRange).toBe("2026-12-01 to 2026-12-31");
      expect(rLast.endExclusive?.toISOString()).toBe("2027-01-01T00:00:00.000Z");
    });

    it("applies exclusive endExclusive bound to backup and monitor queries for last_month", async () => {
      jest.useFakeTimers().setSystemTime(new Date("2026-11-24T12:00:00.000Z"));
      try {
        await processor.process({
          id: "job-1",
          name: JOB_TYPES.REPORT_GENERATE,
          data: { period: "last_month" },
        } as never);

        expect(prisma.backup.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: {
              created_at: {
                gte: new Date("2026-10-01T00:00:00.000Z"),
                lt: new Date("2026-11-01T00:00:00.000Z"),
              },
            },
          }),
        );
        expect(prisma.monitor.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            include: expect.objectContaining({
              monitor_results: expect.objectContaining({
                where: {
                  checked_at: {
                    gte: new Date("2026-10-01T00:00:00.000Z"),
                    lt: new Date("2026-11-01T00:00:00.000Z"),
                  },
                },
              }),
            }),
          }),
        );
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe("period backup summary aggregation (#73)", () => {
    it("counts all operations in the period including earlier failures before a later success", () => {
      const summary = summarizePeriodBackups([
        { status: "completed" },
        { status: "completed" },
        { status: "failed" },
      ]);

      expect(summary).toEqual({
        totalOperations: 3,
        completedOperations: 2,
        failedOperations: 1,
      });

      const doc = buildDocDef(
        "2026-11-17 to 2026-11-24",
        "Weekly Report",
        new Date("2026-11-24T12:00:00.000Z"),
        [
          {
            projectName: "Site A",
            envType: "production",
            serverName: "srv-1",
            backupType: "full",
            status: "completed",
            completedAt: new Date("2026-11-24T10:00:00.000Z"),
            sizeBytes: BigInt(1024),
          },
        ],
        [],
        [],
        summary,
      );

      const serialized = JSON.stringify(doc);
      expect(serialized).toContain("2 / 3");
      expect(serialized).toContain("Latest Backup per Environment");
    });
  });

  describe("webhook & partial channel delivery reporting (#74)", () => {
    it("delivers signed webhook payloads for report.weekly and marks job completed", async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: jest.fn().mockResolvedValue("ok"),
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      prisma.notificationChannel.findMany.mockResolvedValue([
        {
          id: BigInt(9),
          name: "Ops Webhook",
          type: "webhook",
          webhook_url_enc: "enc:https://hooks.example.test/reports",
          webhook_secret_enc: "enc:top-secret",
          slack_bot_token_enc: null,
          slack_channel_id: null,
          google_chat_webhook_url_enc: null,
          active: true,
          events: ["report.weekly"],
        },
      ]);

      await processor.process({
        id: "job-74a",
        name: JOB_TYPES.REPORT_GENERATE,
        data: { period: "last_7d", channelIds: [9] },
      } as never);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [
        string,
        { headers: Record<string, string>; body: string },
      ];
      expect(url).toBe("https://hooks.example.test/reports");
      expect(init.headers["X-Forge-Event"]).toBe("report.weekly");
      const expectedSig =
        "sha256=" +
        createHmac("sha256", "top-secret").update(init.body).digest("hex");
      expect(init.headers["X-Forge-Signature"]).toBe(expectedSig);
      expect(prisma.jobExecution.update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: "completed",
            last_error: null,
          }),
        }),
      );
    });

    it("fails execution when all selected channels fail delivery", async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: jest.fn().mockResolvedValue("boom"),
      }) as unknown as typeof fetch;

      prisma.notificationChannel.findMany.mockResolvedValue([
        {
          id: BigInt(10),
          name: "Broken Webhook",
          type: "webhook",
          webhook_url_enc: "enc:https://hooks.example.test/fail",
          webhook_secret_enc: null,
          slack_bot_token_enc: null,
          slack_channel_id: null,
          google_chat_webhook_url_enc: null,
          active: true,
          events: ["report.weekly"],
        },
      ]);

      await expect(
        processor.process({
          id: "job-74b",
          name: JOB_TYPES.REPORT_GENERATE,
          data: { period: "last_7d", channelIds: [10] },
        } as never),
      ).rejects.toThrow(/Broken Webhook/);

      expect(prisma.jobExecution.update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "failed" }),
        }),
      );
    });

    it("records partial delivery warnings when one channel fails and another succeeds", async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: jest.fn().mockResolvedValue("ok"),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 502,
          text: jest.fn().mockResolvedValue("bad gateway"),
        }) as unknown as typeof fetch;

      prisma.notificationChannel.findMany.mockResolvedValue([
        {
          id: BigInt(11),
          name: "Good Webhook",
          type: "webhook",
          webhook_url_enc: "enc:https://hooks.example.test/good",
          webhook_secret_enc: null,
          slack_bot_token_enc: null,
          slack_channel_id: null,
          google_chat_webhook_url_enc: null,
          active: true,
          events: ["report.weekly"],
        },
        {
          id: BigInt(12),
          name: "Failing GChat",
          type: "google_chat",
          webhook_url_enc: null,
          webhook_secret_enc: null,
          slack_bot_token_enc: null,
          slack_channel_id: null,
          google_chat_webhook_url_enc: "enc:https://chat.example.test/fail",
          active: true,
          events: ["report.weekly"],
        },
      ]);

      await processor.process({
        id: "job-74c",
        name: JOB_TYPES.REPORT_GENERATE,
        data: { period: "last_7d", channelIds: [11, 12] },
      } as never);

      expect(prisma.jobExecution.update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: "completed",
            last_error: expect.stringContaining("Failing GChat"),
          }),
        }),
      );
    });
  });
});
