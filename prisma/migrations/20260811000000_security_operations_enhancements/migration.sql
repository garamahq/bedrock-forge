-- CreateEnum
CREATE TYPE "SecurityFindingStatus" AS ENUM ('new', 'investigating', 'acknowledged', 'remediated', 'resolved', 'ignored', 'false_positive');

-- CreateEnum
CREATE TYPE "SecurityIncidentStatus" AS ENUM ('open', 'investigating', 'contained', 'resolved', 'false_positive');

-- CreateEnum
CREATE TYPE "SecurityWatcherMode" AS ENUM ('agentless', 'agent');

-- CreateEnum
CREATE TYPE "SecurityWatcherStatus" AS ENUM ('online', 'degraded', 'offline', 'disabled');

-- CreateTable: security_incidents
CREATE TABLE "security_incidents" (
    "id" BIGSERIAL NOT NULL,
    "server_id" BIGINT,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "severity" "SecuritySeverity" NOT NULL,
    "status" "SecurityIncidentStatus" NOT NULL DEFAULT 'open',
    "confidence" TEXT NOT NULL DEFAULT 'high',
    "detected_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "security_incidents_pkey" PRIMARY KEY ("id")
);

-- CreateTable: security_findings
CREATE TABLE "security_findings" (
    "id" BIGSERIAL NOT NULL,
    "scan_id" BIGINT,
    "server_id" BIGINT,
    "environment_id" BIGINT,
    "incident_id" BIGINT,
    "category" VARCHAR(64) NOT NULL,
    "severity" "SecuritySeverity" NOT NULL,
    "status" "SecurityFindingStatus" NOT NULL DEFAULT 'new',
    "title" VARCHAR(256) NOT NULL,
    "description" TEXT NOT NULL,
    "evidence" JSONB,
    "resource" VARCHAR(512),
    "recommendation" TEXT,
    "remediation_available" BOOLEAN NOT NULL DEFAULT false,
    "remediation_type" VARCHAR(64),
    "remediation_meta" JSONB,
    "first_seen_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ,
    "scanner_version" VARCHAR(32),
    "dedup_key" VARCHAR(256),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "security_findings_pkey" PRIMARY KEY ("id")
);

-- CreateTable: security_finding_transitions
CREATE TABLE "security_finding_transitions" (
    "id" BIGSERIAL NOT NULL,
    "finding_id" BIGINT NOT NULL,
    "from_status" "SecurityFindingStatus",
    "to_status" "SecurityFindingStatus" NOT NULL,
    "actor_id" BIGINT,
    "note" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "security_finding_transitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable: security_baselines
CREATE TABLE "security_baselines" (
    "id" BIGSERIAL NOT NULL,
    "server_id" BIGINT,
    "environment_id" BIGINT,
    "label" TEXT,
    "created_by_id" BIGINT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "security_baselines_pkey" PRIMARY KEY ("id")
);

-- CreateTable: security_baseline_items
CREATE TABLE "security_baseline_items" (
    "id" BIGSERIAL NOT NULL,
    "baseline_id" BIGINT NOT NULL,
    "category" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "security_baseline_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable: security_drift_events
CREATE TABLE "security_drift_events" (
    "id" BIGSERIAL NOT NULL,
    "server_id" BIGINT,
    "environment_id" BIGINT,
    "baseline_id" BIGINT NOT NULL,
    "category" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "change_type" TEXT NOT NULL,
    "old_value" JSONB,
    "new_value" JSONB,
    "detected_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finding_id" BIGINT,

    CONSTRAINT "security_drift_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable: security_alert_rules
CREATE TABLE "security_alert_rules" (
    "id" BIGSERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "min_severity" "SecuritySeverity",
    "categories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "server_ids" BIGINT[] DEFAULT ARRAY[]::BIGINT[],
    "channel_ids" BIGINT[] DEFAULT ARRAY[]::BIGINT[],
    "create_incident" BOOLEAN NOT NULL DEFAULT false,
    "cooldown_minutes" INTEGER NOT NULL DEFAULT 30,
    "last_fired_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "security_alert_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable: security_watchers
CREATE TABLE "security_watchers" (
    "id" BIGSERIAL NOT NULL,
    "server_id" BIGINT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "mode" "SecurityWatcherMode" NOT NULL DEFAULT 'agentless',
    "status" "SecurityWatcherStatus" NOT NULL DEFAULT 'offline',
    "interval_minutes" INTEGER NOT NULL DEFAULT 5,
    "last_heartbeat" TIMESTAMPTZ,
    "last_event_at" TIMESTAMPTZ,
    "collector_version" TEXT,
    "watcher_errors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "watch_processes" BOOLEAN NOT NULL DEFAULT true,
    "watch_files" BOOLEAN NOT NULL DEFAULT true,
    "watch_auth" BOOLEAN NOT NULL DEFAULT true,
    "watch_services" BOOLEAN NOT NULL DEFAULT true,
    "watch_cron" BOOLEAN NOT NULL DEFAULT true,
    "watch_wordpress" BOOLEAN NOT NULL DEFAULT true,
    "extra_watch_paths" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "excluded_paths" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "security_watchers_pkey" PRIMARY KEY ("id")
);

-- AlterTable: security_finding_acks
ALTER TABLE "security_finding_acks" ADD COLUMN IF NOT EXISTS "finding_id" BIGINT;

-- CreateIndex: security_incidents
CREATE INDEX "security_incidents_server_id_status_idx" ON "security_incidents"("server_id", "status");

-- CreateIndex: security_findings
CREATE INDEX "security_findings_server_id_status_severity_idx" ON "security_findings"("server_id", "status", "severity");
CREATE INDEX "security_findings_environment_id_status_severity_idx" ON "security_findings"("environment_id", "status", "severity");
CREATE INDEX "security_findings_dedup_key_idx" ON "security_findings"("dedup_key");
CREATE INDEX "security_findings_status_severity_first_seen_at_idx" ON "security_findings"("status", "severity", "first_seen_at");
CREATE INDEX "security_findings_incident_id_idx" ON "security_findings"("incident_id");

-- CreateIndex: security_finding_transitions
CREATE INDEX "security_finding_transitions_finding_id_idx" ON "security_finding_transitions"("finding_id");
CREATE INDEX "security_finding_transitions_actor_id_idx" ON "security_finding_transitions"("actor_id");

-- CreateIndex: security_baselines
CREATE INDEX "security_baselines_server_id_idx" ON "security_baselines"("server_id");
CREATE INDEX "security_baselines_environment_id_idx" ON "security_baselines"("environment_id");

-- CreateIndex: security_baseline_items
CREATE UNIQUE INDEX "security_baseline_items_baseline_id_category_key_key" ON "security_baseline_items"("baseline_id", "category", "key");
CREATE INDEX "security_baseline_items_baseline_id_idx" ON "security_baseline_items"("baseline_id");

-- CreateIndex: security_drift_events
CREATE INDEX "security_drift_events_server_id_detected_at_idx" ON "security_drift_events"("server_id", "detected_at");
CREATE INDEX "security_drift_events_environment_id_detected_at_idx" ON "security_drift_events"("environment_id", "detected_at");

-- CreateIndex: security_watchers
CREATE UNIQUE INDEX "security_watchers_server_id_key" ON "security_watchers"("server_id");
CREATE INDEX "security_watchers_enabled_status_idx" ON "security_watchers"("enabled", "status");

-- CreateIndex: security_finding_acks
CREATE INDEX IF NOT EXISTS "security_finding_acks_finding_id_idx" ON "security_finding_acks"("finding_id");

-- AddForeignKey: security_incidents
ALTER TABLE "security_incidents" ADD CONSTRAINT "security_incidents_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: security_findings
ALTER TABLE "security_findings" ADD CONSTRAINT "security_findings_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "security_findings" ADD CONSTRAINT "security_findings_environment_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "environments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "security_findings" ADD CONSTRAINT "security_findings_scan_id_fkey" FOREIGN KEY ("scan_id") REFERENCES "security_scans"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "security_findings" ADD CONSTRAINT "security_findings_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "security_incidents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: security_finding_transitions
ALTER TABLE "security_finding_transitions" ADD CONSTRAINT "security_finding_transitions_finding_id_fkey" FOREIGN KEY ("finding_id") REFERENCES "security_findings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "security_finding_transitions" ADD CONSTRAINT "security_finding_transitions_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: security_baselines
ALTER TABLE "security_baselines" ADD CONSTRAINT "security_baselines_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "security_baselines" ADD CONSTRAINT "security_baselines_environment_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "environments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "security_baselines" ADD CONSTRAINT "security_baselines_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: security_baseline_items
ALTER TABLE "security_baseline_items" ADD CONSTRAINT "security_baseline_items_baseline_id_fkey" FOREIGN KEY ("baseline_id") REFERENCES "security_baselines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: security_drift_events
ALTER TABLE "security_drift_events" ADD CONSTRAINT "security_drift_events_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "security_drift_events" ADD CONSTRAINT "security_drift_events_environment_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "environments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: security_watchers
ALTER TABLE "security_watchers" ADD CONSTRAINT "security_watchers_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: security_finding_acks
ALTER TABLE "security_finding_acks" ADD CONSTRAINT "security_finding_acks_finding_id_fkey" FOREIGN KEY ("finding_id") REFERENCES "security_findings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
