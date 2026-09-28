import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTransientDatabaseError(error: unknown): boolean {
  const code = isRecord(error) && typeof error.code === "string" ? error.code : "";
  const message = error instanceof Error ? error.message : "";
  return (
    ["P1001", "P1017"].includes(code) ||
    /ECONNRESET|ETIMEDOUT|connection pool|Pool timeout|too many connections/i.test(message)
  );
}

function isRetryableReadOperation(operation: string): boolean {
  return [
    "findUnique",
    "findUniqueOrThrow",
    "findFirst",
    "findFirstOrThrow",
    "findMany",
    "count",
    "aggregate",
    "groupBy",
  ].includes(operation);
}

type ExtendedPrismaLifecycle = {
  onModuleInit: () => Promise<void>;
  onModuleDestroy: () => Promise<void>;
  $connect: () => Promise<void>;
  $disconnect: () => Promise<void>;
};

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    const pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL ?? "",
    });
    const adapter = new PrismaPg(pool);
    super({ adapter });

    const maxRetries = 3;
    const client = this.$extends({
      query: {
        $allOperations({ operation, args, query }) {
          let delay = 100;
          const canRetry = isRetryableReadOperation(operation);
          const execute = async (attempt: number): Promise<unknown> => {
            try {
              return await query(args);
            } catch (error: unknown) {
              if (
                canRetry &&
                isTransientDatabaseError(error) &&
                attempt < maxRetries
              ) {
                await new Promise((res) => setTimeout(res, delay));
                delay *= 2;
                return execute(attempt + 1);
              }
              throw error;
            }
          };
          return execute(1);
        },
      },
    });

    // Prisma's extension type omits Nest lifecycle methods although the
    // runtime proxy still supports the base client's connect methods.
    const lifecycleClient = client as unknown as ExtendedPrismaLifecycle;
    lifecycleClient.onModuleInit = async () => {
      await lifecycleClient.$connect();
      this.logger.log("Database connected");
    };

    lifecycleClient.onModuleDestroy = async () => {
      await lifecycleClient.$disconnect();
      this.logger.log("Database disconnected");
    };

    return client as unknown as PrismaService;
  }

  // Dummy methods to satisfy TypeScript implements clause
  async onModuleInit() {}
  async onModuleDestroy() {}
}
