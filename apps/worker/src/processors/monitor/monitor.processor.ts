import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectQueue } from "@nestjs/bullmq";
import { Job, Queue } from "bullmq";
import * as https from "https";
import * as http from "http";
import * as tls from "tls";
import * as dns from "dns";
import { PrismaService } from "../../prisma/prisma.service";
import { EncryptionService } from "../../encryption/encryption.service";
import {
  isHttpStatusWorking,
  JOB_TYPES,
  LighthouseAuditPayloadSchema,
  MonitorCheckPayloadSchema,
  QUEUES,
  type LighthouseAuditPayload,
} from "@bedrock-forge/shared";
import { toPrismaJsonValue } from "../../utils/prisma-json";

interface HttpCheckResult {
  statusCode: number;
  body: string;
  responseMs: number;
}

interface SslCheckResult {
  daysRemaining: number;
  expiresAt: Date;
  issuer: string | null;
}

type LighthouseStrategy = LighthouseAuditPayload["strategy"];

type LighthouseProvider = "auto" | "local" | "pagespeed";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

// concurrency=3: HTTP pings are I/O-bound and fast — 3 concurrent is safe.
@Processor(QUEUES.MONITORS, { concurrency: 3 })
export class MonitorProcessor extends WorkerHost {
  private readonly logger = new Logger(MonitorProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly encryption: EncryptionService,
    @InjectQueue(QUEUES.MONITORS)
    private readonly monitorsQueue: Queue,
    @InjectQueue(QUEUES.NOTIFICATIONS)
    private readonly notificationsQueue: Queue,
  ) {
    super();
  }

  async process(job: Job) {
    if (job.name === JOB_TYPES.LIGHTHOUSE_AUDIT) {
      const payload = LighthouseAuditPayloadSchema.parse(job.data);
      await this.processLighthouseAudit(payload);
      return;
    }

    const { monitorId } = MonitorCheckPayloadSchema.parse(job.data);
    const timeout = 30_000;
    const checkedAt = new Date();
    let statusCode: number | null = null;
    let responseTimeMs: number | null = null;
    let isUp = false;
    let responseBody = "";

    const monitor = await this.prisma.monitor.findUnique({
      where: { id: BigInt(monitorId) },
      include: {
        environment: {
          select: {
            id: true,
            url: true,
            project: { select: { status: true } },
          },
        },
      },
    });
    if (!monitor) return;

    const isProjectArchived =
      monitor.environment?.project?.status === "archived";

    if (!monitor.enabled || isProjectArchived) {
      this.logger.log(
        `Monitor ${monitorId} is disabled or project is archived (${isProjectArchived}) — skipping check and removing repeatable job`,
      );
      const jobId = `monitor-${monitor.id}`;
      try {
        const repeatableJobs = await this.monitorsQueue.getRepeatableJobs();
        for (const rj of repeatableJobs) {
          if (rj.id === jobId) {
            await this.monitorsQueue.removeRepeatableByKey(rj.key);
            this.logger.log(
              `Self-healed: removed repeatable job key ${rj.key} for disabled/archived monitor ${monitor.id}`,
            );
          }
        }
      } catch (err) {
        this.logger.warn(
          `Failed to remove repeatable job for disabled/archived monitor ${monitor.id}: ${err}`,
        );
      }
      return;
    }

    // Capture previous state before running the check
    const prevIsUp =
      monitor.last_checked_at !== null && monitor.last_status !== null
        ? isHttpStatusWorking(monitor.last_status)
        : null;

    const url = monitor.environment.url;
    const start = Date.now();

    try {
      const result = await this.checkHttp(url, timeout);
      statusCode = result.statusCode;
      responseTimeMs = result.responseMs;
      responseBody = result.body;
      isUp = isHttpStatusWorking(result.statusCode);
    } catch {
      isUp = false;
      responseTimeMs = Date.now() - start;
    }

    // Confirmation retry: if first check failed, wait 5 s then try once more
    if (!isUp) {
      this.logger.warn(
        `Monitor ${monitorId}: first check failed (HTTP ${statusCode ?? 0}) — retrying in 5 s`,
      );
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      const retryStart = Date.now();
      try {
        const retryResult = await this.checkHttp(url, timeout);
        statusCode = retryResult.statusCode;
        responseTimeMs = retryResult.responseMs;
        responseBody = retryResult.body;
        isUp = isHttpStatusWorking(retryResult.statusCode);
        if (isUp) {
          this.logger.log(
            `Monitor ${monitorId}: retry succeeded (HTTP ${statusCode}) — not marking as down`,
          );
        }
      } catch {
        isUp = false;
        responseTimeMs = Date.now() - retryStart;
        this.logger.warn(
          `Monitor ${monitorId}: retry also failed — confirming down`,
        );
      }
    }

    // ── Advanced checks (run in parallel after HTTP check) ─────────────────
    let sslResult: SslCheckResult | null = null;
    let dnsResolves: boolean | null = null;
    let keywordFound: boolean | null = null;

    try {
      const hostname = new URL(url).hostname;
      const [ssl, dns_] = await Promise.all([
        monitor.check_ssl ? this.checkSsl(hostname) : Promise.resolve(null),
        monitor.check_dns ? this.checkDns(hostname) : Promise.resolve(null),
      ]);
      sslResult = ssl;
      dnsResolves = dns_;
    } catch (err) {
      this.logger.warn(`Monitor ${monitorId}: advanced check error: ${err}`);
    }

    if (monitor.check_keyword && monitor.keyword && responseBody) {
      keywordFound = responseBody.includes(monitor.keyword);
    }

    // ── Persist result ──────────────────────────────────────────────────────
    await this.prisma.monitorResult.create({
      data: {
        monitor_id: BigInt(monitorId),
        is_up: isUp,
        status_code: statusCode ?? 0,
        response_ms: responseTimeMs ?? 0,
        checked_at: checkedAt,
        ...(sslResult !== null && {
          ssl_days_remaining: sslResult.daysRemaining,
        }),
        ...(dnsResolves !== null && { dns_resolves: dnsResolves }),
        ...(keywordFound !== null && { keyword_found: keywordFound }),
      },
    });

    // Prune results older than 30 days
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await this.prisma.monitorResult.deleteMany({
      where: { monitor_id: BigInt(monitorId), checked_at: { lt: cutoff } },
    });

    // Update monitor uptime % — use aggregate COUNT queries instead of fetching all rows
    const [totalCount, upCount] = await Promise.all([
      this.prisma.monitorResult.count({
        where: { monitor_id: BigInt(monitorId) },
      }),
      this.prisma.monitorResult.count({
        where: { monitor_id: BigInt(monitorId), is_up: true },
      }),
    ]);
    const uptime = totalCount > 0 ? (upCount / totalCount) * 100 : 100;

    await this.prisma.monitor.update({
      where: { id: BigInt(monitorId) },
      data: {
        last_checked_at: checkedAt,
        last_status: statusCode,
        last_response_ms: responseTimeMs,
        uptime_pct: uptime,
        // Cache latest advanced check results on the monitor
        ...(sslResult !== null && {
          ssl_expires_at: sslResult.expiresAt,
          ssl_issuer: sslResult.issuer,
          ssl_days_remaining: sslResult.daysRemaining,
        }),
        ...(dnsResolves !== null && { dns_resolves: dnsResolves }),
        ...(keywordFound !== null && { keyword_found: keywordFound }),
      },
    });

    // ── Notifications: advanced check failures ──────────────────────────────
    if (
      sslResult !== null &&
      monitor.ssl_alert_days !== null &&
      monitor.ssl_alert_days !== undefined
    ) {
      if (sslResult.daysRemaining <= monitor.ssl_alert_days) {
        this.logger.warn(
          `Monitor ${monitorId}: SSL expiring in ${sslResult.daysRemaining} days (threshold: ${monitor.ssl_alert_days})`,
        );
        await this.prisma.monitorLog.create({
          data: {
            monitor_id: BigInt(monitorId),
            event_type: "ssl_expiry",
            message: `SSL certificate expires in ${sslResult.daysRemaining} days (${sslResult.expiresAt.toISOString().slice(0, 10)})`,
          },
        });
        await this.dispatchNotification("monitor.ssl_expiry", {
          monitorId: Number(monitorId),
          environmentId: Number(monitor.environment.id),
          url,
          daysRemaining: sslResult.daysRemaining,
          expiresAt: sslResult.expiresAt.toISOString(),
          issuer: sslResult.issuer,
        });
      }
    }

    if (dnsResolves === false) {
      this.logger.warn(
        `Monitor ${monitorId}: DNS resolution failed for ${url}`,
      );
      await this.prisma.monitorLog.create({
        data: {
          monitor_id: BigInt(monitorId),
          event_type: "dns_failed",
          message: `DNS resolution failed for hostname`,
        },
      });
      await this.dispatchNotification("monitor.dns_failed", {
        monitorId: Number(monitorId),
        environmentId: Number(monitor.environment.id),
        url,
        checkedAt: checkedAt.toISOString(),
      });
    }

    if (keywordFound === false) {
      this.logger.warn(
        `Monitor ${monitorId}: keyword "${monitor.keyword}" not found in response`,
      );
      await this.prisma.monitorLog.create({
        data: {
          monitor_id: BigInt(monitorId),
          event_type: "keyword_missing",
          message: `Keyword "${monitor.keyword}" not found in response body`,
        },
      });
      await this.dispatchNotification("monitor.keyword_missing", {
        monitorId: Number(monitorId),
        environmentId: Number(monitor.environment.id),
        url,
        keyword: monitor.keyword,
        checkedAt: checkedAt.toISOString(),
      });
    }

    // Detect degraded state: site responded but is slower than 5 s threshold
    const isDegraded = isUp && (responseTimeMs ?? 0) > 5_000;
    if (isDegraded) {
      this.logger.warn(
        `Monitor ${monitorId}: site is degraded — ${responseTimeMs}ms response time`,
      );
      await this.prisma.monitorLog.create({
        data: {
          monitor_id: BigInt(monitorId),
          event_type: "degraded",
          status_code: statusCode,
          response_ms: responseTimeMs,
          message: `Site responding slowly: ${responseTimeMs}ms (threshold: 5000ms)`,
        },
      });
      await this.dispatchNotification("monitor.degraded", {
        monitorId: Number(monitorId),
        environmentId: Number(monitor.environment.id),
        url,
        statusCode: statusCode ?? 0,
        responseMs: responseTimeMs ?? 0,
        checkedAt: checkedAt.toISOString(),
      });
    }

    // Persist state-transition log and fire notification on change (up→down or down→up)
    if (prevIsUp !== null && prevIsUp !== isUp) {
      const eventType = isUp ? "monitor.up" : "monitor.down";
      this.logger.log(
        `Monitor ${monitorId} state transition: ${prevIsUp ? "up" : "down"} → ${isUp ? "up" : "down"}`,
      );

      if (isUp) {
        await this.prisma.monitorLog.create({
          data: {
            monitor_id: BigInt(monitorId),
            event_type: "up",
            status_code: statusCode,
            response_ms: responseTimeMs,
          },
        });
        const openDownLog = await this.prisma.monitorLog.findFirst({
          where: {
            monitor_id: BigInt(monitorId),
            event_type: "down",
            resolved_at: null,
          },
          orderBy: { occurred_at: "desc" },
        });
        if (openDownLog) {
          const resolvedAt = checkedAt;
          const durationSeconds = Math.floor(
            (resolvedAt.getTime() - openDownLog.occurred_at.getTime()) / 1000,
          );
          await this.prisma.monitorLog.update({
            where: { id: openDownLog.id },
            data: {
              resolved_at: resolvedAt,
              duration_seconds: durationSeconds,
            },
          });
        }
      } else {
        await this.prisma.monitorLog.create({
          data: {
            monitor_id: BigInt(monitorId),
            event_type: "down",
            status_code: statusCode,
            response_ms: responseTimeMs,
            message:
              statusCode === 0
                ? "Request timed out or connection refused"
                : `HTTP ${statusCode} — site unreachable`,
          },
        });
      }

      await this.dispatchNotification(eventType, {
        monitorId: Number(monitorId),
        environmentId: Number(monitor.environment.id),
        url,
        statusCode: statusCode ?? 0,
        responseMs: responseTimeMs ?? 0,
        transition: isUp ? "recovered" : "went_down",
        checkedAt: checkedAt.toISOString(),
      });
    }

    // ── Notifications: status transitions ───────────────────────────────────────
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async processLighthouseAudit(payload: LighthouseAuditPayload) {
    const startedAt = new Date();
    await Promise.all([
      this.prisma.lighthouseAudit.update({
        where: { id: BigInt(payload.auditId) },
        data: { status: "running", started_at: startedAt },
      }),
      payload.jobExecutionId
        ? this.prisma.jobExecution.update({
            where: { id: BigInt(payload.jobExecutionId) },
            data: { status: "active", started_at: startedAt, progress: 10 },
          })
        : Promise.resolve(),
    ]);

    try {
      const { result, provider } = await this.runLighthouseAudit(
        payload.url,
        payload.strategy,
      );
      const mapped = this.mapLighthouseResult(result);
      await this.prisma.lighthouseAudit.update({
        where: { id: BigInt(payload.auditId) },
        data: {
          status: "completed",
          performance_score: mapped.performanceScore,
          accessibility_score: mapped.accessibilityScore,
          best_practices_score: mapped.bestPracticesScore,
          seo_score: mapped.seoScore,
          fcp_ms: mapped.fcpMs,
          lcp_ms: mapped.lcpMs,
          cls: mapped.cls,
          tbt_ms: mapped.tbtMs,
          speed_index_ms: mapped.speedIndexMs,
          opportunities: mapped.opportunities,
          summary: mapped.summary,
          raw_result: mapped.rawResult,
          completed_at: new Date(),
        },
      });
      if (payload.jobExecutionId) {
        await this.prisma.jobExecution.update({
          where: { id: BigInt(payload.jobExecutionId) },
          data: {
            status: "completed",
            progress: 100,
            completed_at: new Date(),
            execution_log: [
              {
                timestamp: new Date().toISOString(),
                level: "info",
                step: "Lighthouse audit complete",
                detail: `${provider} ${payload.strategy} score ${mapped.performanceScore ?? "n/a"}`,
              },
            ],
          },
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await Promise.all([
        this.prisma.lighthouseAudit.update({
          where: { id: BigInt(payload.auditId) },
          data: {
            status: "failed",
            error_message: message,
            completed_at: new Date(),
          },
        }),
        payload.jobExecutionId
          ? this.prisma.jobExecution.update({
              where: { id: BigInt(payload.jobExecutionId) },
              data: {
                status: "failed",
                progress: 100,
                last_error: message,
                completed_at: new Date(),
                execution_log: [
                  {
                    timestamp: new Date().toISOString(),
                    level: "error",
                    step: "Lighthouse audit failed",
                    detail: message,
                  },
                ],
              },
            })
          : Promise.resolve(),
      ]);
      throw err;
    }
  }

  private async getResolvedPagespeedConfig(): Promise<{
    apiKey: string | null;
    provider: LighthouseProvider;
  }> {
    let apiKey = this.config.get<string>("pagespeed.apiKey") ?? null;
    let provider = String(
      this.config.get<string>("pagespeed.provider") ?? "auto",
    ).toLowerCase() as LighthouseProvider;

    try {
      const [keySetting, providerSetting] = await Promise.all([
        this.prisma.appSetting.findUnique({
          where: { key: "pagespeed_api_key" },
        }),
        this.prisma.appSetting.findUnique({
          where: { key: "pagespeed_provider" },
        }),
      ]);

      if (keySetting?.value) {
        try {
          apiKey = this.encryption.decrypt(keySetting.value);
        } catch {
          apiKey = keySetting.value;
        }
      }

      if (providerSetting?.value) {
        const storedProvider = providerSetting.value.toLowerCase();
        if (["auto", "local", "pagespeed"].includes(storedProvider)) {
          provider = storedProvider as LighthouseProvider;
        }
      }
    } catch (err) {
      this.logger.warn(`Failed to read stored pagespeed settings: ${err}`);
    }

    return { apiKey, provider };
  }

  private async fetchPageSpeed(
    url: string,
    strategy: LighthouseStrategy,
    apiKey: string | null,
  ) {
    const endpoint = new URL(
      "https://www.googleapis.com/pagespeedonline/v5/runPagespeed",
    );
    endpoint.searchParams.set("url", url);
    endpoint.searchParams.set("strategy", strategy);
    for (const category of [
      "performance",
      "accessibility",
      "best-practices",
      "seo",
    ]) {
      endpoint.searchParams.append("category", category);
    }
    if (apiKey) endpoint.searchParams.set("key", apiKey);

    const res = await fetch(endpoint, { signal: AbortSignal.timeout(120_000) });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const error = isRecord(body) ? body.error : undefined;
      const rawMessage =
        isRecord(error) && typeof error.message === "string"
          ? error.message
          : `PageSpeed request failed with HTTP ${res.status}`;
      const message = /quota/i.test(rawMessage)
        ? `PageSpeed quota exceeded. Configure a Google PageSpeed API key in Settings > Integrations > PageSpeed, switch LIGHTHOUSE_PROVIDER=local, or wait for Google quota reset. ${rawMessage}`
        : rawMessage;
      throw new Error(message);
    }
    return body;
  }

  private async runLighthouseAudit(
    url: string,
    strategy: LighthouseStrategy,
  ): Promise<{ provider: "local" | "pagespeed"; result: unknown }> {
    const { apiKey, provider } = await this.getResolvedPagespeedConfig();

    if (!["auto", "local", "pagespeed"].includes(provider)) {
      throw new Error(
        `Invalid LIGHTHOUSE_PROVIDER=${provider}. Use auto, local, or pagespeed.`,
      );
    }

    if (provider !== "pagespeed") {
      try {
        return {
          provider: "local",
          result: await this.runLocalLighthouse(url, strategy),
        };
      } catch (err) {
        if (provider === "local") throw err;
        this.logger.warn(
          `Local Lighthouse failed, falling back to Google PageSpeed Insights: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    try {
      return {
        provider: "pagespeed",
        result: await this.fetchPageSpeed(url, strategy, apiKey),
      };
    } catch (err) {
      if (!apiKey) {
        throw new Error(
          `Local Lighthouse failed and Google PageSpeed Insights returned an error: ${
            err instanceof Error ? err.message : String(err)
          }. Tip: Add a Google PageSpeed API key in Settings > Integrations to ensure reliable audits.`,
        );
      }
      throw err;
    }
  }

  private async runLocalLighthouse(url: string, strategy: LighthouseStrategy) {
    const mod = await import("lighthouse");
    const { launch: launchChrome } = await import("chrome-launcher");
    const lighthouse = mod.default;
    const chromePath = this.config.get<string>("pagespeed.chromePath");
    const chrome = await launchChrome({
      chromePath,
      logLevel: "silent",
      chromeFlags: [
        "--headless=new",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });
    let result: Awaited<ReturnType<typeof lighthouse>>;
    try {
      result = await lighthouse(url, {
        port: chrome.port,
        output: "json",
        logLevel: "error",
        onlyCategories: [
          "performance",
          "accessibility",
          "best-practices",
          "seo",
        ],
        formFactor: strategy,
        screenEmulation: strategy === "desktop" ? { disabled: true } : undefined,
      });
    } finally {
      chrome.kill();
    }
    if (!result?.lhr) {
      throw new Error("Local Lighthouse returned no report");
    }
    return {
      id: result.lhr.requestedUrl ?? url,
      analysisUTCTimestamp: result.lhr.fetchTime,
      lighthouseResult: result.lhr,
    };
  }

  private mapLighthouseResult(result: unknown) {
    const response = recordOrEmpty(result);
    const lighthouse = recordOrEmpty(response.lighthouseResult);
    if (Object.keys(lighthouse).length === 0) {
      throw new Error("Lighthouse returned an invalid report");
    }
    const categories = recordOrEmpty(lighthouse.categories);
    const audits = recordOrEmpty(lighthouse.audits);
    const score = (category: string) => {
      const raw = recordOrEmpty(categories[category]).score;
      return typeof raw === "number" ? Math.round(raw * 100) : null;
    };
    const numericAudit = (id: string) => {
      const value = recordOrEmpty(audits[id]).numericValue;
      return typeof value === "number" ? Math.round(value) : null;
    };
    const clsValue = recordOrEmpty(audits["cumulative-layout-shift"]).numericValue;
    const opportunities = Object.entries(audits)
      .filter(([, rawAudit]) => {
        const details = recordOrEmpty(recordOrEmpty(rawAudit).details);
        return details.type === "opportunity";
      })
      .map(([id, rawAudit]) => {
        const audit = recordOrEmpty(rawAudit);
        return {
          id,
          title: typeof audit.title === "string" ? audit.title : id,
          description:
            typeof audit.description === "string" ? audit.description : "",
          score: typeof audit.score === "number" ? audit.score : null,
          displayValue:
            typeof audit.displayValue === "string" ? audit.displayValue : null,
          numericValue:
            typeof audit.numericValue === "number" ? audit.numericValue : null,
        };
      })
      .slice(0, 10);

    return {
      performanceScore: score("performance"),
      accessibilityScore: score("accessibility"),
      bestPracticesScore: score("best-practices"),
      seoScore: score("seo"),
      fcpMs: numericAudit("first-contentful-paint"),
      lcpMs: numericAudit("largest-contentful-paint"),
      cls: typeof clsValue === "number" ? clsValue : null,
      tbtMs: numericAudit("total-blocking-time"),
      speedIndexMs: numericAudit("speed-index"),
      opportunities: toPrismaJsonValue(opportunities),
      summary: toPrismaJsonValue({
        fetchTime:
          typeof lighthouse.fetchTime === "string" ? lighthouse.fetchTime : null,
        finalUrl:
          typeof lighthouse.finalDisplayedUrl === "string"
            ? lighthouse.finalDisplayedUrl
            : typeof lighthouse.finalUrl === "string"
              ? lighthouse.finalUrl
              : null,
        requestedUrl: typeof response.id === "string" ? response.id : null,
      }),
      rawResult: toPrismaJsonValue({
        id: typeof response.id === "string" ? response.id : null,
        analysisUTCTimestamp:
          typeof response.analysisUTCTimestamp === "string"
            ? response.analysisUTCTimestamp
            : null,
        lighthouseVersion:
          typeof lighthouse.lighthouseVersion === "string"
            ? lighthouse.lighthouseVersion
            : null,
        categories,
        audits: {
          "first-contentful-paint": audits["first-contentful-paint"],
          "largest-contentful-paint": audits["largest-contentful-paint"],
          "cumulative-layout-shift": audits["cumulative-layout-shift"],
          "total-blocking-time": audits["total-blocking-time"],
          "speed-index": audits["speed-index"],
        },
      }),
    };
  }

  private checkHttp(url: string, timeout: number): Promise<HttpCheckResult> {
    return new Promise((resolve, reject) => {
      const mod = url.startsWith("https") ? https : http;
      const chunks: Buffer[] = [];
      const start = Date.now();
      const req = mod.get(url, { timeout }, (res) => {
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
            responseMs: Date.now() - start,
          }),
        );
      });
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Request timed out"));
      });
    });
  }

  private checkSsl(hostname: string): Promise<SslCheckResult | null> {
    return new Promise((resolve) => {
      const socket = tls.connect(
        {
          host: hostname,
          port: 443,
          servername: hostname,
          rejectUnauthorized: false,
        },
        () => {
          const cert = socket.getPeerCertificate();
          socket.destroy();
          if (!cert || !Object.keys(cert).length) {
            resolve(null);
            return;
          }
          const expiresAt = cert.valid_to ? new Date(cert.valid_to) : null;
          if (!expiresAt || isNaN(expiresAt.getTime())) {
            resolve(null);
            return;
          }
          const msRemaining = expiresAt.getTime() - Date.now();
          const daysRemaining = Math.max(
            0,
            Math.floor(msRemaining / (1000 * 60 * 60 * 24)),
          );
          const issuer =
            (cert.issuer as Record<string, string> | undefined)?.O ?? null;
          resolve({ daysRemaining, expiresAt, issuer });
        },
      );
      socket.on("error", () => {
        socket.destroy();
        resolve(null);
      });
      socket.setTimeout(15_000, () => {
        socket.destroy();
        resolve(null);
      });
    });
  }

  private async checkDns(hostname: string): Promise<boolean> {
    try {
      const addresses = await dns.promises.resolve4(hostname);
      return addresses.length > 0;
    } catch {
      return false;
    }
  }

  private async dispatchNotification(
    eventType: string,
    payload: Record<string, unknown>,
  ) {
    try {
      if (payload.environmentId) {
        const envId = BigInt(payload.environmentId as number);
        const now = new Date();
        const activeMaintenance = await this.prisma.maintenanceWindow.count({
          where: {
            OR: [
              {
                resource_type: "environment",
                resource_id: envId,
                starts_at: { lte: now },
                ends_at: { gte: now },
              },
              {
                resource_type: "server",
                server: {
                  environments: {
                    some: { id: envId },
                  },
                },
                starts_at: { lte: now },
                ends_at: { gte: now },
              },
            ],
          },
        });
        if (activeMaintenance > 0) {
          this.logger.log(
            `Suppressing notification ${eventType} for environment ${payload.environmentId} due to active maintenance window.`,
          );
          return;
        }
      }

      await this.notificationsQueue.add(
        JOB_TYPES.NOTIFICATION_SEND,
        { eventType, payload },
        { attempts: 3, removeOnComplete: 100, removeOnFail: 1000 },
      );
    } catch (err) {
      this.logger.warn(`Failed to enqueue ${eventType} notification: ${err}`);
    }
  }
}
