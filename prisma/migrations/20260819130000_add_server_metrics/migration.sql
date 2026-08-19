-- CreateTable: server_metrics
CREATE TABLE IF NOT EXISTS "server_metrics" (
    "id" BIGSERIAL PRIMARY KEY,
    "server_id" BIGINT NOT NULL,
    "cpu_usage" DOUBLE PRECISION,
    "memory_used_mb" INTEGER,
    "memory_total_mb" INTEGER,
    "disk_used_gb" DOUBLE PRECISION,
    "disk_total_gb" DOUBLE PRECISION,
    "uptime_seconds" INTEGER,
    "load_1m" DOUBLE PRECISION,
    "load_5m" DOUBLE PRECISION,
    "load_15m" DOUBLE PRECISION,
    "ping_ms" INTEGER,
    "recorded_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT "server_metrics_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "server_metrics_server_id_recorded_at_idx" ON "server_metrics"("server_id", "recorded_at");
