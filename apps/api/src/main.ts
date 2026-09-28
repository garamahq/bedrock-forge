import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe, Logger } from "@nestjs/common";
import { WinstonModule } from "nest-winston";
import { winstonLoggerOptions } from "./common/logging/winston.config";
import helmet from "helmet";
import { json } from "express";
import cookieParser from "cookie-parser";
import { ConfigService } from "@nestjs/config";
import { AppModule } from "./app.module";
import { SocketIoAdapter } from "./gateways/socket-io.adapter";

// Express JSON.stringify cannot handle BigInt (Prisma autoincrement IDs).
// Convert BigInt → Number; IDs never exceed Number.MAX_SAFE_INTEGER here.
(BigInt.prototype as unknown as { toJSON: () => number }).toJSON = function () {
  return Number(this);
};

// ── Pre-flight: fail fast on missing production secrets ──────────────────────
const isProd = process.env.NODE_ENV === "production";
if (isProd) {
  const required: [string, string][] = [
    ["DATABASE_URL", process.env.DATABASE_URL ?? ""],
    ["REDIS_URL", process.env.REDIS_URL ?? ""],
    ["POSTGRES_PASSWORD", process.env.POSTGRES_PASSWORD ?? ""],
    ["REDIS_PASSWORD", process.env.REDIS_PASSWORD ?? ""],
    ["JWT_SECRET", process.env.JWT_SECRET ?? ""],
    ["JWT_REFRESH_SECRET", process.env.JWT_REFRESH_SECRET ?? ""],
    ["ENCRYPTION_KEY", process.env.ENCRYPTION_KEY ?? ""],
    ["CORS_ORIGIN", process.env.CORS_ORIGIN ?? ""],
  ];
  const missing = required.filter(([, v]) => !v).map(([k]) => k);
  if (missing.length > 0) {
    console.error(
      `[Bootstrap] FATAL: Missing required environment variables in production: ${missing.join(", ")}`,
    );
    process.exit(1);
  }

  const placeholders = required
    .filter(([, v]) => /change_me|forge_password|dev-|test-/i.test(v))
    .map(([k]) => k);
  if (placeholders.length > 0) {
    console.error(
      `[Bootstrap] FATAL: Placeholder or development secrets are not allowed in production: ${placeholders.join(", ")}`,
    );
    process.exit(1);
  }

  if (!/^[a-f0-9]{64}$/i.test(process.env.ENCRYPTION_KEY ?? "")) {
    console.error(
      "[Bootstrap] FATAL: ENCRYPTION_KEY must be exactly 64 hex characters in production.",
    );
    process.exit(1);
  }

  if (process.env.JWT_SECRET === process.env.JWT_REFRESH_SECRET) {
    console.error(
      "[Bootstrap] FATAL: JWT_SECRET and JWT_REFRESH_SECRET must be different in production.",
    );
    process.exit(1);
  }
}

async function bootstrap() {
  const logger = new Logger("Bootstrap");
  const app = await NestFactory.create(AppModule, {
    logger: WinstonModule.createLogger(winstonLoggerOptions),
  });

  // Global validation pipe — whitelist + forbid unknown + auto-transform
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // Global API prefix — all routes under /api
  // Health is excluded so Docker/k8s/LB probes resolve at /health (no prefix)
  app.setGlobalPrefix("api", { exclude: ["health"] });

  // Security headers
  app.use(
    helmet({
      hsts: { maxAge: 63072000, includeSubDomains: true, preload: true },
      contentSecurityPolicy: isProd ? undefined : false,
    }),
  );

  // Request body size limit
  app.use(cookieParser());
  app.use(
    json({
      limit: "10mb",
      verify: (req, _res, buffer) => {
        const requestPath = (req.url ?? "").split("?", 1)[0];
        if (
          requestPath.startsWith("/api/webhooks/deploy/") ||
          requestPath.startsWith("/webhooks/deploy/")
        ) {
          (req as typeof req & { rawBody?: Buffer }).rawBody = buffer;
        }
      },
    }),
  );

  // CORS — in production, CORS_ORIGIN must be set (validated above)
  app.enableCors({
    origin: process.env.CORS_ORIGIN ?? "http://localhost:8080",
    credentials: true,
  });

  // Graceful shutdown — lets Prisma/BullMQ finish in-flight work on SIGTERM
  app.enableShutdownHooks();

  // WebSocket CORS — must use adapter so origin is read from validated
  // ConfigService, not from process.env at module-load time.
  const config = app.get(ConfigService);
  app.useWebSocketAdapter(new SocketIoAdapter(app, config));

  const port = parseInt(process.env.API_PORT ?? "3000", 10);
  await app.listen(port);
  logger.log(`Bedrock Forge API running on port ${port}`);
}

bootstrap().catch((err) => {
  console.error("Fatal bootstrap error:", err);
  process.exit(1);
});
