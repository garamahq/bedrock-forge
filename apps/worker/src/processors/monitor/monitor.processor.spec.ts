import { Test } from "@nestjs/testing";
import { getQueueToken } from "@nestjs/bullmq";
import { ConfigService } from "@nestjs/config";
import { MonitorProcessor } from "./monitor.processor";
import { PrismaService } from "../../prisma/prisma.service";
import { EncryptionService } from "../../encryption/encryption.service";
import { JOB_TYPES, QUEUES } from "@bedrock-forge/shared";

// ── Helpers ──────────────────────────────────────────────────────────────────

type MockPrisma = {
  monitor: {
    findUnique: jest.Mock;
    update: jest.Mock;
  };
  monitorResult: {
    create: jest.Mock;
    deleteMany: jest.Mock;
    count: jest.Mock;
  };
  monitorLog: {
    create: jest.Mock;
    findFirst: jest.Mock;
    update: jest.Mock;
  };
  jobExecution: {
    create: jest.Mock;
    update: jest.Mock;
  };
  lighthouseAudit: {
    update: jest.Mock;
  };
  maintenanceWindow: {
    count: jest.Mock;
  };
  appSetting: {
    findUnique: jest.Mock;
  };
};

function makePrisma(): MockPrisma {
  return {
    monitor: {
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
    monitorResult: {
      create: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(0),
    },
    monitorLog: {
      create: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
    },
    jobExecution: {
      create: jest.fn().mockResolvedValue({ id: BigInt(99) }),
      update: jest.fn().mockResolvedValue({}),
    },
    lighthouseAudit: {
      update: jest.fn().mockResolvedValue({}),
    },
    maintenanceWindow: {
      count: jest.fn().mockResolvedValue(0),
    },
    appSetting: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
  };
}

function makeNotifQueue() {
  return { add: jest.fn().mockResolvedValue({}) };
}

function baseMonitor(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: BigInt(1),
    environment_id: BigInt(5),
    enabled: true,
    interval_seconds: 300,
    last_checked_at: null,
    last_status: null,
    last_response_ms: null,
    uptime_pct: 100,
    environment: { id: BigInt(5), url: "http://localhost:12345/never-exists" },
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("MonitorProcessor", () => {
  let processor: MonitorProcessor;
  let prisma: MockPrisma;
  let monitorsQueue: any;
  let notifQueue: ReturnType<typeof makeNotifQueue>;

  beforeEach(async () => {
    prisma = makePrisma();
    notifQueue = makeNotifQueue();
    monitorsQueue = {
      getRepeatableJobs: jest.fn().mockResolvedValue([]),
      removeRepeatableByKey: jest.fn().mockResolvedValue({}),
    };

    const module = await Test.createTestingModule({
      providers: [
        MonitorProcessor,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        {
          provide: EncryptionService,
          useValue: {
            decrypt: jest.fn((v: string) => v),
            encrypt: jest.fn((v: string) => v),
          },
        },
        { provide: getQueueToken(QUEUES.MONITORS), useValue: monitorsQueue },
        { provide: getQueueToken(QUEUES.NOTIFICATIONS), useValue: notifQueue },
      ],
    }).compile();

    processor = module.get(MonitorProcessor);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("exits early if monitor not found", async () => {
    prisma.monitor.findUnique.mockResolvedValue(null);
    const job = { id: "1", data: { monitorId: 999 } } as any;
    await processor.process(job);
    expect(prisma.monitorResult.create).not.toHaveBeenCalled();
  });

  it("does NOT create a JobExecution row (monitors run too frequently)", async () => {
    prisma.monitor.findUnique.mockResolvedValue(baseMonitor());
    const job = { id: "j1", data: { monitorId: 1 } } as any;
    jest
      .spyOn(processor as any, "checkHttp")
      .mockRejectedValue(new Error("ECONNREFUSED"));
    jest.spyOn(global, "setTimeout").mockImplementation((fn: TimerHandler) => {
      if (typeof fn === "function") fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });
    await processor.process(job).catch(() => {});
    expect(prisma.jobExecution.create).not.toHaveBeenCalled();
  });

  it("does NOT fire notification when there is no previous state", async () => {
    // prevIsUp === null → first ever check for this monitor
    const monitor = baseMonitor({ last_checked_at: null, last_status: null });
    prisma.monitor.findUnique.mockResolvedValue(monitor);
    prisma.monitorResult.count.mockResolvedValue(1);

    // Spy on checkHttp to return a controlled response
    jest
      .spyOn(processor as any, "checkHttp")
      .mockResolvedValue({ statusCode: 200, body: "" });

    const job = { id: "j2", data: { monitorId: 1 } } as any;
    await processor.process(job);

    expect(notifQueue.add).not.toHaveBeenCalled();
  });

  it.each([301, 302, 304])(
    "treats HTTP %i redirect responses as working",
    async (statusCode) => {
      const monitor = baseMonitor({
        last_checked_at: new Date(Date.now() - 300_000),
        last_status: 200,
      });
      prisma.monitor.findUnique.mockResolvedValue(monitor);
      prisma.monitorResult.count.mockResolvedValue(5);

      const checkHttpSpy = jest
        .spyOn(processor as any, "checkHttp")
        .mockResolvedValue({ statusCode, body: "", responseMs: 123 });

      const job = {
        id: `redirect-${statusCode}`,
        data: { monitorId: 1 },
      } as any;
      await processor.process(job);

      expect(checkHttpSpy).toHaveBeenCalledTimes(1);
      expect(prisma.monitorResult.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            is_up: true,
            status_code: statusCode,
          }),
        }),
      );
      expect(notifQueue.add).not.toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ eventType: "monitor.down" }),
        expect.any(Object),
      );
      expect(prisma.monitorLog.create).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ event_type: "down" }),
        }),
      );
    },
  );

  it.each([404, 500])(
    "treats HTTP %i responses as down after confirmation retry",
    async (statusCode) => {
      const monitor = baseMonitor({
        last_checked_at: new Date(Date.now() - 300_000),
        last_status: 200,
      });
      prisma.monitor.findUnique.mockResolvedValue(monitor);
      prisma.monitorResult.count.mockResolvedValue(5);
      jest
        .spyOn(global, "setTimeout")
        .mockImplementation((fn: TimerHandler) => {
          if (typeof fn === "function") fn();
          return 0 as unknown as ReturnType<typeof setTimeout>;
        });

      const checkHttpSpy = jest
        .spyOn(processor as any, "checkHttp")
        .mockResolvedValue({ statusCode, body: "", responseMs: 456 });

      const job = {
        id: `failure-${statusCode}`,
        data: { monitorId: 1 },
      } as any;
      await processor.process(job);

      expect(checkHttpSpy).toHaveBeenCalledTimes(2);
      expect(prisma.monitorResult.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            is_up: false,
            status_code: statusCode,
          }),
        }),
      );
      expect(prisma.monitorLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            event_type: "down",
            status_code: statusCode,
          }),
        }),
      );
      expect(notifQueue.add).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          eventType: "monitor.down",
          payload: expect.objectContaining({ transition: "went_down" }),
        }),
        expect.any(Object),
      );
    },
  );

  it("fires monitor.down notification on up→down transition", async () => {
    // Previously up: last_status=200, last_checked_at set
    const monitor = baseMonitor({
      last_checked_at: new Date(Date.now() - 300_000),
      last_status: 200,
    });
    prisma.monitor.findUnique.mockResolvedValue(monitor);
    prisma.monitorResult.count.mockResolvedValue(5);

    // Both check and retry return 503 → confirmed down
    const checkHttpSpy = jest
      .spyOn(processor as any, "checkHttp")
      .mockResolvedValue({ statusCode: 503, body: "" });

    // Skip the real 5 s retry delay
    jest.spyOn(global, "setTimeout").mockImplementation((fn: TimerHandler) => {
      if (typeof fn === "function") fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });

    const job = { id: "j3", data: { monitorId: 1 } } as any;
    await processor.process(job);

    // Must have been called twice: initial attempt + confirmation retry
    expect(checkHttpSpy).toHaveBeenCalledTimes(2);

    expect(notifQueue.add).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        eventType: "monitor.down",
        payload: expect.objectContaining({ transition: "went_down" }),
      }),
      expect.any(Object),
    );
  });

  it("does NOT fire down notification when retry succeeds after first failure", async () => {
    // Previously up
    const monitor = baseMonitor({
      last_checked_at: new Date(Date.now() - 300_000),
      last_status: 200,
    });
    prisma.monitor.findUnique.mockResolvedValue(monitor);
    prisma.monitorResult.count.mockResolvedValue(5);

    // First call fails, second (retry) succeeds → transient blip, not down
    const checkHttpSpy = jest
      .spyOn(processor as any, "checkHttp")
      .mockResolvedValueOnce({ statusCode: 503, body: "" })
      .mockResolvedValueOnce({ statusCode: 200, body: "" });

    jest.spyOn(global, "setTimeout").mockImplementation((fn: TimerHandler) => {
      if (typeof fn === "function") fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });

    const job = { id: "j3b", data: { monitorId: 1 } } as any;
    await processor.process(job);

    expect(checkHttpSpy).toHaveBeenCalledTimes(2);
    // No state transition to 'down' — retry recovered
    expect(notifQueue.add).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ eventType: "monitor.down" }),
      expect.any(Object),
    );
  });

  it("fires monitor.up notification on down→up transition", async () => {
    // Previously down: last_status=503
    const monitor = baseMonitor({
      last_checked_at: new Date(Date.now() - 300_000),
      last_status: 503,
    });
    prisma.monitor.findUnique.mockResolvedValue(monitor);
    prisma.monitorResult.count.mockResolvedValue(5);

    // Current check returns 200 → isUp = true
    jest
      .spyOn(processor as any, "checkHttp")
      .mockResolvedValue({ statusCode: 200, body: "" });

    const job = { id: "j4", data: { monitorId: 1 } } as any;
    await processor.process(job);

    expect(notifQueue.add).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        eventType: "monitor.up",
        payload: expect.objectContaining({ transition: "recovered" }),
      }),
      expect.any(Object),
    );
  });

  it("does not update JobExecution when site is up (no tracking in monitor processor)", async () => {
    const monitor = baseMonitor();
    prisma.monitor.findUnique.mockResolvedValue(monitor);
    jest
      .spyOn(processor as any, "checkHttp")
      .mockResolvedValue({ statusCode: 200, body: "" });

    const job = { id: "j5", data: { monitorId: 1 } } as any;
    await processor.process(job);

    expect(prisma.jobExecution.update).not.toHaveBeenCalled();
  });

  it("does not update JobExecution when site is down (no tracking in monitor processor)", async () => {
    const monitor = baseMonitor();
    prisma.monitor.findUnique.mockResolvedValue(monitor);
    jest
      .spyOn(processor as any, "checkHttp")
      .mockResolvedValue({ statusCode: 503, body: "" });
    jest.spyOn(global, "setTimeout").mockImplementation((fn: TimerHandler) => {
      if (typeof fn === "function") fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });

    const job = { id: "j6", data: { monitorId: 1 } } as any;
    await processor.process(job);

    expect(prisma.jobExecution.update).not.toHaveBeenCalled();
  });

  it("stores Lighthouse scores for audit jobs", async () => {
    jest.spyOn(processor as any, "runLighthouseAudit").mockResolvedValue({
      provider: "local",
      result: {
        id: "https://example.test/",
        analysisUTCTimestamp: "2026-06-03T08:00:00.000Z",
        lighthouseResult: {
          lighthouseVersion: "12.0.0",
          fetchTime: "2026-06-03T08:00:00.000Z",
          finalDisplayedUrl: "https://example.test/",
          categories: {
            performance: { score: 0.91 },
            accessibility: { score: 0.88 },
            "best-practices": { score: 1 },
            seo: { score: 0.96 },
          },
          audits: {
            "first-contentful-paint": { numericValue: 1200 },
            "largest-contentful-paint": { numericValue: 2400 },
            "cumulative-layout-shift": { numericValue: 0.035 },
            "total-blocking-time": { numericValue: 80 },
            "speed-index": { numericValue: 1800 },
            "unused-javascript": {
              id: "unused-javascript",
              title: "Reduce unused JavaScript",
              score: 0.5,
              displayValue: "20 KiB",
              numericValue: 20000,
              details: { type: "opportunity" },
            },
          },
        },
      },
    });

    await processor.process({
      name: JOB_TYPES.LIGHTHOUSE_AUDIT,
      data: {
        auditId: 7,
        environmentId: 5,
        url: "https://example.test/",
        strategy: "mobile",
        jobExecutionId: 9,
      },
    } as any);

    expect(prisma.lighthouseAudit.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: BigInt(7) },
        data: expect.objectContaining({
          status: "completed",
          performance_score: 91,
          accessibility_score: 88,
          best_practices_score: 100,
          seo_score: 96,
          lcp_ms: 2400,
          cls: 0.035,
        }),
      }),
    );
    expect(prisma.jobExecution.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: BigInt(9) },
        data: expect.objectContaining({ status: "completed", progress: 100 }),
      }),
    );
  });

  it("records PageSpeed quota failures clearly", async () => {
    jest
      .spyOn(processor as any, "runLighthouseAudit")
      .mockRejectedValue(
        new Error(
          "PageSpeed quota exceeded. Switch LIGHTHOUSE_PROVIDER=local or wait for Google quota reset.",
        ),
      );

    await expect(
      processor.process({
        name: JOB_TYPES.LIGHTHOUSE_AUDIT,
        data: {
          auditId: 8,
          environmentId: 5,
          url: "https://example.test/",
          strategy: "mobile",
          jobExecutionId: 10,
        },
      } as any),
    ).rejects.toThrow("PageSpeed quota exceeded");

    expect(prisma.lighthouseAudit.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: BigInt(8) },
        data: expect.objectContaining({
          status: "failed",
          error_message: expect.stringContaining("PageSpeed quota exceeded"),
        }),
      }),
    );
    expect(prisma.jobExecution.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: BigInt(10) },
        data: expect.objectContaining({
          status: "failed",
          last_error: expect.stringContaining("PageSpeed quota exceeded"),
        }),
      }),
    );
  });
});
