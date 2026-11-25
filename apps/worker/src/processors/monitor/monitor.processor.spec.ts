import { Test } from "@nestjs/testing";
import { getQueueToken } from "@nestjs/bullmq";
import { ConfigService } from "@nestjs/config";
import * as dns from "dns";
import * as tls from "tls";
import { EventEmitter } from "events";
import { MonitorProcessor } from "./monitor.processor";

jest.mock("tls", () => {
  const actual = jest.requireActual("tls");
  return {
    ...actual,
    connect: jest.fn(),
  };
});
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

  it("fires monitor.up only after two consecutive successful probes", async () => {
    // Previously down: last_status=503
    const monitor = baseMonitor({
      last_checked_at: new Date(Date.now() - 300_000),
      last_status: 503,
    });
    prisma.monitor.findUnique.mockResolvedValue(monitor);
    prisma.monitorResult.count.mockResolvedValue(5);

    // Both the first recovery probe and its confirmation return 200.
    const checkHttpSpy = jest
      .spyOn(processor as any, "checkHttp")
      .mockResolvedValue({ statusCode: 200, body: "", responseMs: 441 });

    jest.spyOn(global, "setTimeout").mockImplementation((fn: TimerHandler) => {
      if (typeof fn === "function") fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });

    const job = { id: "j4", data: { monitorId: 1 } } as any;
    await processor.process(job);

    expect(checkHttpSpy).toHaveBeenCalledTimes(2);
    expect(notifQueue.add).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        eventType: "monitor.up",
        payload: expect.objectContaining({ transition: "recovered" }),
      }),
      expect.any(Object),
    );
  });

  it("does not send a recovery alert when the confirmation probe fails", async () => {
    const monitor = baseMonitor({
      last_checked_at: new Date(Date.now() - 300_000),
      last_status: 503,
    });
    prisma.monitor.findUnique.mockResolvedValue(monitor);
    prisma.monitorResult.count.mockResolvedValue(5);

    const checkHttpSpy = jest
      .spyOn(processor as any, "checkHttp")
      .mockResolvedValueOnce({ statusCode: 200, body: "", responseMs: 441 })
      .mockResolvedValueOnce({ statusCode: 503, body: "", responseMs: 512 });
    jest.spyOn(global, "setTimeout").mockImplementation((fn: TimerHandler) => {
      if (typeof fn === "function") fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });

    const job = {
      id: "j4b",
      data: { monitorId: 1 },
    } as unknown as Parameters<MonitorProcessor["process"]>[0];
    await processor.process(job);

    expect(checkHttpSpy).toHaveBeenCalledTimes(2);
    expect(prisma.monitorResult.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ is_up: false, status_code: 503 }),
      }),
    );
    expect(prisma.monitor.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ last_status: 503 }) }),
    );
    expect(notifQueue.add).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ eventType: "monitor.up" }),
      expect.any(Object),
    );
  });

  it("records connection errors as down so later recovery can be detected", async () => {
    const monitor = baseMonitor({
      last_checked_at: new Date(Date.now() - 300_000),
      last_status: 200,
    });
    prisma.monitor.findUnique.mockResolvedValue(monitor);
    prisma.monitorResult.count.mockResolvedValue(5);

    const checkHttpSpy = jest
      .spyOn(processor as any, "checkHttp")
      .mockRejectedValue(new Error("ECONNREFUSED"));
    jest.spyOn(global, "setTimeout").mockImplementation((fn: TimerHandler) => {
      if (typeof fn === "function") fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });

    const job = {
      id: "j4c",
      data: { monitorId: 1 },
    } as unknown as Parameters<MonitorProcessor["process"]>[0];
    await processor.process(job);

    expect(checkHttpSpy).toHaveBeenCalledTimes(2);
    expect(prisma.monitorResult.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ is_up: false, status_code: 0 }),
      }),
    );
    expect(prisma.monitor.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ last_status: 0 }) }),
    );
    expect(notifQueue.add).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        eventType: "monitor.down",
        payload: expect.objectContaining({ transition: "went_down" }),
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

  describe("DNS monitoring (#99)", () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it.each([
      {
        label: "A records only",
        v4: ["203.0.113.10"],
        v6: new Error("ENODATA"),
        expectedDns: true,
      },
      {
        label: "AAAA records only (IPv6-only)",
        v4: new Error("ENODATA"),
        v6: ["2001:db8::1"],
        expectedDns: true,
      },
      {
        label: "both A and AAAA records",
        v4: ["203.0.113.10"],
        v6: ["2001:db8::1"],
        expectedDns: true,
      },
      {
        label: "neither A nor AAAA records",
        v4: new Error("ENOTFOUND"),
        v6: new Error("ENOTFOUND"),
        expectedDns: false,
      },
    ])(
      "evaluates $label as dns_resolves=$expectedDns",
      async ({ v4, v6, expectedDns }) => {
        const monitor = baseMonitor({
          check_dns: true,
          environment: { id: BigInt(5), url: "https://ipv6.example.test" },
        });
        prisma.monitor.findUnique.mockResolvedValue(monitor);
        jest
          .spyOn(processor as any, "checkHttp")
          .mockResolvedValue({ statusCode: 200, body: "ok", responseMs: 50 });

        const resolve4Spy = jest
          .spyOn(dns.promises, "resolve4")
          .mockImplementation(() =>
            v4 instanceof Error ? Promise.reject(v4) : Promise.resolve(v4),
          );
        const resolve6Spy = jest
          .spyOn(dns.promises, "resolve6")
          .mockImplementation(() =>
            v6 instanceof Error ? Promise.reject(v6) : Promise.resolve(v6),
          );

        await processor.process({
          id: `dns-${expectedDns}`,
          data: { monitorId: 1 },
        } as any);

        expect(resolve4Spy).toHaveBeenCalledWith("ipv6.example.test");
        expect(resolve6Spy).toHaveBeenCalledWith("ipv6.example.test");
        expect(prisma.monitorResult.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ dns_resolves: expectedDns }),
          }),
        );
        expect(prisma.monitor.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ dns_resolves: expectedDns }),
          }),
        );
        if (expectedDns) {
          expect(notifQueue.add).not.toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({ eventType: "monitor.dns_failed" }),
            expect.any(Object),
          );
        } else {
          expect(notifQueue.add).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({ eventType: "monitor.dns_failed" }),
            expect.any(Object),
          );
        }
      },
    );
  });

  describe("SSL certificate monitoring (#98)", () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    function mockTlsConnect(cert: Record<string, unknown> | null) {
      const connectMock = tls.connect as unknown as jest.Mock;
      connectMock.mockReset();
      connectMock.mockImplementation((...args: unknown[]) => {
        const cb = args.find((arg) => typeof arg === "function") as
          | (() => void)
          | undefined;
        const socket = new EventEmitter() as unknown as tls.TLSSocket;
        (socket as unknown as { destroy: jest.Mock }).destroy = jest.fn();
        (socket as unknown as { setTimeout: jest.Mock }).setTimeout = jest.fn();
        (socket as unknown as { getPeerCertificate: jest.Mock }).getPeerCertificate =
          jest.fn().mockReturnValue(cert ?? {});
        queueMicrotask(() => {
          if (cert) {
            cb?.();
          } else {
            socket.emit("error", new Error("ECONNREFUSED"));
          }
        });
        return socket;
      });
      return connectMock;
    }

    it("uses default port 443 when HTTPS URL omits port", async () => {
      const monitor = baseMonitor({
        check_ssl: true,
        environment: { id: BigInt(5), url: "https://ssl.example.test" },
      });
      prisma.monitor.findUnique.mockResolvedValue(monitor);
      jest
        .spyOn(processor as any, "checkHttp")
        .mockResolvedValue({ statusCode: 200, body: "ok", responseMs: 25 });
      const futureDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      const tlsSpy = mockTlsConnect({
        valid_to: futureDate.toUTCString(),
        issuer: { O: "Let's Encrypt" },
      });

      await processor.process({
        id: "ssl-default-port",
        data: { monitorId: 1 },
      } as any);

      expect(tlsSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          host: "ssl.example.test",
          port: 443,
          servername: "ssl.example.test",
        }),
        expect.any(Function),
      );
      expect(prisma.monitor.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            ssl_issuer: "Let's Encrypt",
            ssl_days_remaining: expect.any(Number),
          }),
        }),
      );
    });

    it("uses custom port from HTTPS URL and clears stale SSL data on TLS failure", async () => {
      const monitor = baseMonitor({
        check_ssl: true,
        ssl_days_remaining: 45,
        ssl_issuer: "Old Issuer",
        ssl_expires_at: new Date(),
        environment: { id: BigInt(5), url: "https://ssl.example.test:8443" },
      });
      prisma.monitor.findUnique.mockResolvedValue(monitor);
      jest
        .spyOn(processor as any, "checkHttp")
        .mockResolvedValue({ statusCode: 200, body: "ok", responseMs: 25 });
      const tlsSpy = mockTlsConnect(null);

      await processor.process({
        id: "ssl-custom-port-fail",
        data: { monitorId: 1 },
      } as any);

      expect(tlsSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          host: "ssl.example.test",
          port: 8443,
          servername: "ssl.example.test",
        }),
        expect.any(Function),
      );
      expect(prisma.monitor.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            ssl_expires_at: null,
            ssl_issuer: null,
            ssl_days_remaining: null,
          }),
        }),
      );
    });
  });

  describe("Keyword monitoring on empty HTTP 200 body (#97)", () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it("marks keyword_found=false on empty HTTP 200, null on network error, and restores true when content returns", async () => {
      jest.spyOn(global, "setTimeout").mockImplementation((fn: TimerHandler) => {
        if (typeof fn === "function") fn();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      });

      const monitor = baseMonitor({
        check_keyword: true,
        keyword: "Bedrock Ready",
        environment: { id: BigInt(5), url: "https://kw.example.test" },
      });
      prisma.monitor.findUnique.mockResolvedValue(monitor);

      // 1. Page contains keyword
      const checkHttpSpy = jest
        .spyOn(processor as any, "checkHttp")
        .mockResolvedValueOnce({
          statusCode: 200,
          body: "<html>Bedrock Ready</html>",
          responseMs: 30,
        });

      await processor.process({ id: "kw-1", data: { monitorId: 1 } } as any);
      expect(prisma.monitor.update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ keyword_found: true }),
        }),
      );

      // 2. HTTP 200 with empty body -> must mark keyword_found=false and alert
      checkHttpSpy.mockResolvedValueOnce({
        statusCode: 200,
        body: "",
        responseMs: 30,
      });
      await processor.process({ id: "kw-2", data: { monitorId: 1 } } as any);
      expect(prisma.monitorResult.create).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            is_up: true,
            status_code: 200,
            keyword_found: false,
          }),
        }),
      );
      expect(prisma.monitor.update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ keyword_found: false }),
        }),
      );
      expect(notifQueue.add).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ eventType: "monitor.keyword_missing" }),
        expect.any(Object),
      );

      // 3. Network failure -> keyword_found=null (not false)
      checkHttpSpy
        .mockRejectedValueOnce(new Error("ECONNREFUSED"))
        .mockRejectedValueOnce(new Error("ECONNREFUSED"));
      await processor.process({ id: "kw-3", data: { monitorId: 1 } } as any);
      expect(prisma.monitorResult.create).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ is_up: false, status_code: 0 }),
        }),
      );
      expect(
        prisma.monitorResult.create.mock.calls.at(-1)[0].data.keyword_found,
      ).toBeUndefined();
      expect(prisma.monitor.update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ keyword_found: null }),
        }),
      );

      // 4. Content restored
      checkHttpSpy.mockResolvedValueOnce({
        statusCode: 200,
        body: "<html>Bedrock Ready again</html>",
        responseMs: 25,
      });
      await processor.process({ id: "kw-4", data: { monitorId: 1 } } as any);
      expect(prisma.monitor.update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ keyword_found: true }),
        }),
      );
    });
  });

  describe("Project-level maintenance window suppression (#100)", () => {
    it("checks project maintenance windows for environment project_id before queuing notifications", async () => {
      jest.spyOn(global, "setTimeout").mockImplementation((fn: TimerHandler) => {
        if (typeof fn === "function") fn();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      });

      const monitor = baseMonitor({
        last_checked_at: new Date(Date.now() - 300_000),
        last_status: 200,
        environment: {
          id: BigInt(5),
          project_id: BigInt(42),
          url: "https://proj.example.test",
          project: { status: "active" },
        },
      });
      prisma.monitor.findUnique.mockResolvedValue(monitor);
      prisma.maintenanceWindow.count.mockResolvedValue(1);
      jest
        .spyOn(processor as any, "checkHttp")
        .mockResolvedValue({ statusCode: 500, body: "", responseMs: 25 });

      await processor.process({
        id: "proj-maint-1",
        data: { monitorId: 1 },
      } as any);

      expect(prisma.maintenanceWindow.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: expect.arrayContaining([
              expect.objectContaining({
                resource_type: "project",
                resource_id: BigInt(42),
              }),
            ]),
          }),
        }),
      );
      expect(notifQueue.add).not.toHaveBeenCalled();
    });
  });

  describe("Streaming bounded HTTP monitoring (#106)", () => {
    it("destroys response stream immediately on availability-only checks without buffering body", async () => {
      const http = require("http");
      const mockRes = Object.assign(new EventEmitter(), {
        statusCode: 200,
        destroy: jest.fn(() => {
          mockRes.emit("close");
        }),
      });
      const mockReq = new EventEmitter();
      const getSpy = jest
        .spyOn(http, "get")
        .mockImplementation((_url: any, _opts: any, cb: any) => {
          queueMicrotask(() => cb(mockRes));
          return mockReq;
        });

      const result = await (processor as any).checkHttp(
        "http://stream.example.test",
        5000,
      );

      expect(mockRes.destroy).toHaveBeenCalled();
      expect(result.statusCode).toBe(200);
      expect(result.body).toBe("");
      getSpy.mockRestore();
    });

    it("detects keyword split across chunks while bounding retained memory", async () => {
      const http = require("http");
      const mockRes = Object.assign(new EventEmitter(), {
        statusCode: 200,
        destroy: jest.fn(() => {
          mockRes.emit("close");
        }),
      });
      const mockReq = new EventEmitter();
      const getSpy = jest
        .spyOn(http, "get")
        .mockImplementation((_url: any, _opts: any, cb: any) => {
          queueMicrotask(() => {
            cb(mockRes);
            mockRes.emit("data", Buffer.from("prefix noise --- Bed"));
            mockRes.emit("data", Buffer.from("rock Ready --- trailing"));
            mockRes.emit("end");
          });
          return mockReq;
        });

      const result = await (processor as any).checkHttp(
        "http://stream.example.test",
        5000,
        { keyword: "Bedrock Ready", maxBodyBytes: 1024 },
      );

      expect(result.statusCode).toBe(200);
      expect(result.keywordFound).toBe(true);
      expect(mockRes.destroy).toHaveBeenCalled();
      getSpy.mockRestore();
    });

    it("aborts keyword streaming cleanly when response exceeds maxBodyBytes limit", async () => {
      const http = require("http");
      const mockRes = Object.assign(new EventEmitter(), {
        statusCode: 200,
        destroy: jest.fn(() => {
          mockRes.emit("close");
        }),
      });
      const mockReq = new EventEmitter();
      const getSpy = jest
        .spyOn(http, "get")
        .mockImplementation((_url: any, _opts: any, cb: any) => {
          queueMicrotask(() => {
            cb(mockRes);
            mockRes.emit("data", Buffer.alloc(600, "a"));
            mockRes.emit("data", Buffer.alloc(600, "b"));
            mockRes.emit("end");
          });
          return mockReq;
        });

      const result = await (processor as any).checkHttp(
        "http://stream.example.test",
        5000,
        { keyword: "MissingNeedle", maxBodyBytes: 1024 },
      );

      expect(result.statusCode).toBe(200);
      expect(result.keywordFound).toBeNull();
      expect(result.keywordTruncated).toBe(true);
      expect(mockRes.destroy).toHaveBeenCalled();
      getSpy.mockRestore();
    });
  });
});
