export interface PgDumpConnection {
  host: string;
  port: string;
  database: string;
  username: string;
  pgpassLine: string;
  connectionUri: string;
}

const PRISMA_ONLY_QUERY_PARAMS = new Set([
  "schema",
  "connection_limit",
  "pool_timeout",
  "pgbouncer",
  "statement_cache_size",
  "socket_timeout",
]);

function escapePgpassField(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
}

/**
 * Parse DATABASE_URL for pg_dump execution:
 * - URI-decodes user, password, host, and database name
 * - Escapes `.pgpass` metacharacters (`\` and `:`)
 * - Preserves libpq connection/TLS query options while stripping Prisma-only params
 * - Strips the password from the connection URI passed on argv (`ps` safe)
 */
export function buildPgDumpConnection(databaseUrl: string): PgDumpConnection {
  const parsed = new URL(databaseUrl);
  if (!parsed.protocol.startsWith("postgres")) {
    throw new Error(`Unsupported DATABASE_URL protocol for pg_dump: ${parsed.protocol}`);
  }

  const host = decodeURIComponent(parsed.hostname);
  const port = parsed.port || "5432";
  const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  const username = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);

  if (!host || !database) {
    throw new Error("DATABASE_URL is missing required host or database name");
  }

  const pgpassLine =
    [
      escapePgpassField(host),
      escapePgpassField(port),
      escapePgpassField(database),
      escapePgpassField(username),
      escapePgpassField(password),
    ].join(":") + "\n";

  const sanitizedUri = new URL(parsed.toString());
  sanitizedUri.password = "";
  for (const param of Array.from(sanitizedUri.searchParams.keys())) {
    if (PRISMA_ONLY_QUERY_PARAMS.has(param)) {
      sanitizedUri.searchParams.delete(param);
    }
  }

  return {
    host,
    port,
    database,
    username,
    pgpassLine,
    connectionUri: sanitizedUri.toString(),
  };
}
