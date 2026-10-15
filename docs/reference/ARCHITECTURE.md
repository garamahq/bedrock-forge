# Architecture

---

## System Overview

Bedrock Forge is a self-hosted WordPress management dashboard. It connects to
managed WordPress servers via SSH and performs remote operations through a
connection pool. No permanent agent or sidecar process is installed on managed
servers. WP-CLI is used for workflows where WordPress provides the safest
interface, such as theme management, WordPress core updates, cache cleanup, and
selected plugin actions.

```
                         ┌────────────────────────────────────────────┐
                         │           forge (single container)         │
                         │                                            │
Browser ─────────────►  │  ┌─────────────────┐  ┌────────────────┐  │
         HTTP + WS       │  │  NestJS API      │  │  BullMQ Worker │  │
                         │  │  :3000           │  │  (no HTTP port)│  │
                         │  │                  │  │                │  │
                         │  │  REST routes     │  │  Worker jobs   │  │
                         │  │  WebSocket GW    │  │  SSH pool      │  │
                         │  │  Rate limiting   │  │  rclone        │  │
                         │  │  JWT auth        │  │  whois         │  │
                         │  └───────┬──────────┘  └───────┬────────┘  │
                         │          │  enqueue              │ execute  │
                         └──────────┼───────────────────────┼──────────┘
                                    │                       │
                         ┌──────────▼──┐          ┌────────▼──────────┐
                         │  PostgreSQL  │          │  Redis 7          │
                         │  :5432       │          │  BullMQ queues    │
                         │  Prisma data │          │  WS pub/sub       │
                         └─────────────┘          │  Rate limiting    │
                                                   └───────────────────┘

                ┌────────────────────────────────────────┐
                │         web (nginx container)          │
                │  :80 → serves React SPA static files   │
                │  /api/* → proxy → forge:3000           │
                │  /ws    → proxy+upgrade → forge:3000   │
                └────────────────────────────────────────┘

                   Managed servers (any Linux host with SSH)
                ┌──────────────────────────────────────────┐
                │  WordPress / Bedrock installations       │
                │  No agent installed — SSH only           │
                │  PHP/WP helpers pushed on-demand         │
                └──────────────────────────────────────────┘
```

---

## Service Breakdown

### API (`apps/api`)

NestJS 11 REST server. Responsible for:

- Authenticating and authorizing all HTTP requests (JWT + RBAC)
- Validating all inputs via `class-validator` DTOs
- Orchestrating business logic through services
- Enqueueing background jobs to BullMQ (never executes remote operations inline)
- Broadcasting real-time updates to WebSocket clients via the gateway

**Does not** touch managed servers directly. All remote work is delegated to the
Worker process via queues.

Feature modules follow `controller -> service -> repository`; Prisma access is
isolated to `*.repository.ts` files only.

### Worker (`apps/worker`)

NestJS standalone context running BullMQ consumers. Responsible for:

- Executing all long-running operations: backups, syncs, plugin/theme scans, WP
  actions, security scans, Lighthouse audits, monitor checks, WHOIS lookups,
  provisioning, notifications, and reports
- Maintaining the SSH connection pool (max 15 concurrent per server)
- Uploading backup archives to Google Drive via `rclone`
- Publishing job progress events to Redis pub/sub (consumed by the API WebSocket
  gateway)

No public HTTP port is exposed by the worker.

### Web (`web` container)

nginx serving the compiled React 19 SPA. Reverse proxies `/api/*` and WebSocket
`/ws` to the forge API. Applies security headers (CSP, X-Frame-Options,
X-Content-Type-Options) and gzip compression.

---

## Remote Execution Model

All SSH operations use the `@bedrock-forge/remote-executor` package:

- **`SshPoolManager`** — Global connection pool keyed by server ID. Reuses
  connections across concurrent jobs. Max 15 concurrent connections per server.
- **`RemoteExecutorService`** — Executes commands, pushes files (SFTP), and
  pulls files over existing pool connections. Implements stall detection
  (5-minute timeout with heartbeat).
- **`CredentialParserService`** — Extracts WordPress DB credentials from
  `wp-config.php` or Bedrock `.env` files using regex patterns. **Never sources,
  evals, or shells out the credential file.**

### Remote Helper Scripts

Remote helper scripts are maintained in `apps/worker/scripts/`:

| Script                      | Purpose                                                                       |
| --------------------------- | ----------------------------------------------------------------------------- |
| `backup.php`                | Creates WordPress backup archives and reports progress.                       |
| `plugin-scan.php`           | Reads plugin registry and Composer metadata.                                  |
| `composer-manager.php`      | Adds, removes, updates, and changes constraints for Composer-managed plugins. |
| `custom-plugin-manager.php` | Installs, updates, and removes custom GitHub plugins/themes.                  |
| `wp-actions.php`            | Runs selected WP-CLI backed maintenance, logs, cleanup, and core workflows.   |
| `wp-users.php`              | Reads WordPress users for environment inspection.                             |

Scripts are pushed to a temp path on the remote server, executed, and then
cleaned up. They are versioned in `execution_scripts` table so cached versions
are not re-pushed unnecessarily.

---

## Database Schema

The Prisma schema is grouped across identity, infrastructure, operations,
security, monitoring, billing, notifications, and system domains. All
migrations live in `prisma/migrations/`.

### Identity & Access (4 models)

| Model          | Key Fields                                                  |
| -------------- | ----------------------------------------------------------- |
| `User`         | email (unique), name, password_hash (bcrypt)                |
| `Role`         | name — 4 values: `admin`, `manager`, `maintainer`, `client` |
| `UserRole`     | composite PK (user_id, role_id) — many-to-many              |
| `RefreshToken` | token_hash (SHA-256), expires_at, revoked_at                |

### Client Management (4 models)

| Model            | Key Fields                            |
| ---------------- | ------------------------------------- |
| `Client`         | name, email, phone, notes             |
| `Tag`            | name (unique), color (hex)            |
| `ClientTag`      | composite PK (client_id, tag_id)      |
| `EnvironmentTag` | composite PK (environment_id, tag_id) |

### Packages (2 models)

| Model            | Key Fields                                                       |
| ---------------- | ---------------------------------------------------------------- |
| `HostingPackage` | name, price_monthly, storage_gb, bandwidth_gb, max_sites, active |
| `SupportPackage` | name, price_monthly, response_hours, includes_updates, active    |

### Infrastructure (3 models)

| Model         | Key Fields                                                                                   |
| ------------- | -------------------------------------------------------------------------------------------- |
| `Server`      | name, ip_address, ssh_port, ssh_user, ssh_private_key_encrypted, provider, status            |
| `Project`     | name, status (active/inactive/archived), client_id, hosting/support package FKs              |
| `Environment` | type, url, root_path, backup_path, google_drive_folder_id — unique on (server_id, root_path) |

### Operations (11 models)

| Model                  | Key Fields                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------- |
| `Backup`               | type, status, file_path, size_bytes, environment_id                                 |
| `BackupSchedule`       | frequency, hour, minute, day_of_week/month, retention_count, retention_days         |
| `PluginScan`           | plugins (JSONB: `{is_bedrock, plugins[]}`)                                          |
| `ThemeScan`            | themes (JSONB), environment_id                                                      |
| `PluginUpdateSchedule` | enabled, schedule (cron), auto_update_minor, environment_id                         |
| `CleanupSchedule`      | enabled, schedule (cron), delete_revisions, delete_transients, environment_id       |
| `Domain`               | name, whois_json (JSONB), expires_at, ssl_expires_at — unique on (project_id, name) |
| `Monitor`              | enabled, interval_seconds (default 600), uptime_pct, last_response_ms, last_status  |
| `MonitorResult`        | status_code, response_ms, is_up, checked_at — rolling history                       |
| `MonitorLog`           | event_type (down/up/degraded), duration_seconds, resolved_at                        |
| `WpDbCredentials`      | db_name, db_user, db_password, db_host — all AES-256-GCM encrypted                  |

### System (7 models)

| Model                     | Key Fields                                                                             |
| ------------------------- | -------------------------------------------------------------------------------------- |
| `ExecutionScript`         | name (unique), version, content_hash, content (PHP source)                             |
| `JobExecution`            | queue_name, bull_job_id, job_type, status, progress 0–100, execution_log (JSONB trace) |
| `AppSetting`              | key (unique), value                                                                    |
| `SystemBackup`            | file_path, size_bytes, status, created_at                                              |
| `CustomPlugin`            | name, repo_url, description — GitHub-hosted private plugins                            |
| `EnvironmentCustomPlugin` | composite PK (environment_id, custom_plugin_id), installed_version                     |
| `AuditLog`                | action, resource_type, resource_id, metadata (JSONB), ip_address                       |

### Billing & Notifications (4 models)

| Model                 | Key Fields                                                                               |
| --------------------- | ---------------------------------------------------------------------------------------- |
| `Invoice`             | invoice_number (unique: INV-YYYY-NNN), amounts, status, period, client/project snapshots |
| `NotificationChannel` | name, type (slack/google_chat/webhook), encrypted channel credentials, events[] (string array) |
| `NotificationLog`     | event_type, payload, status (sent/failed), error                                         |
| `UserNotification`    | user_id, type, message, read_at                                                          |

---

## Queue System

All background work goes through BullMQ. Controllers call `queue.add()` and
return immediately. Workers process jobs asynchronously and publish progress via
Redis pub/sub.

| Queue            | Job Types                                                                                                                               | Concurrency | Retries | Timeout |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------- | ------- |
| `backups`        | `backup:create`, `backup:restore`, `backup:scheduled`, `backup:delete-file`                                                             | 1           | 3       | 30 min  |
| `plugin-scans`   | `plugin-scan:run`, `plugin:manage`                                                                                                      | 2           | 3       | 5 min   |
| `plugin-updates` | `plugin:scheduled-update`                                                                                                               | 1           | 3       | 10 min  |
| `custom-plugins` | `custom-plugin:manage`                                                                                                                  | 1           | 3       | 10 min  |
| `theme-scans`    | `theme-scan:run`, `theme:manage`                                                                                                        | 2           | 3       | 5 min   |
| `sync`           | `sync:clone`, `sync:push`                                                                                                               | 1           | 3       | 30 min  |
| `monitors`       | `monitor:check` (repeatable), `lighthouse:audit`                                                                                        | 3           | 2       | varies  |
| `domains`        | `domain:whois`, `domain:ssl-check`                                                                                                      | 2           | 3       | 30 s    |
| `projects`       | `project:create-bedrock`                                                                                                                | 1           | 2       | 20 min  |
| `notifications`  | `notification:send`                                                                                                                     | 3           | 3       | 30 s    |
| `reports`        | `report:generate`                                                                                                                       | 1           | 3       | 2 min   |
| `wp-actions`     | `wp:fix-action`, `wp:debug-toggle`, `wp:debug-revert`, `wp:logs-fetch`, `wp:cron-list`, `wp:cleanup`, `wp:core-check`, `wp:core-update` | 2           | 3       | 5 min   |
| `system-backups` | `system-backup:create`                                                                                                                  | 1           | 3       | 30 min  |

Default jobs use exponential backoff with retained completed/failed job history
(`removeOnComplete: 1000`, `removeOnFail: 5000`). Some scheduled/internal jobs
override those retention counts.

Job payloads are validated at enqueue time with Zod schemas (defined in
`@bedrock-forge/shared`).

### Failed Jobs

BullMQ failed jobs remain accessible through the original queue's failed job
set. The Activity page and job execution views expose failed/dead-letter status
from Forge's `job_executions` records where that status is tracked. Separate
`<queue>-dlq` queues are not currently implemented.

---

## Real-Time Updates

```
Worker process
  │
  ├─ publishes to Redis channel: job.progress / job.completed / job.failed
  │
API WebSocket Gateway (NestJS)
  │
  ├─ subscribes to Redis pub/sub via @nestjs/socket-io Redis adapter
  │
  └─ broadcasts to authenticated WebSocket client:
       { type: 'job.progress', jobId, progress, log }
       { type: 'job.completed', jobId, result }
       { type: 'job.failed', jobId, error }
       { type: 'monitor.result', environmentId, status, responseMs }

Frontend (Socket.IO client in apps/web/src/lib/websocket.ts)
  │
  └─ on job completion → invalidates TanStack Query cache for affected resource
```

The `ExecutionLogPanel` component polls a specific job execution log and renders
status, elapsed time, progress, and structured log lines with timestamps.

`GET /search` powers the global Cmd/K command palette. It returns typed links
for pages, projects, environments, clients, servers, and project tabs.

Monitor processing retries a failed HTTP probe after five seconds. If the
stored state is down and the next probe succeeds, a second successful probe
five seconds later is required before recovery is recorded or an up transition
is announced. This confirmation reduces single-response false alerts but uses
the same worker network path.

---

## Security Model

### Credential Encryption

`EncryptionService` wraps every sensitive value using AES-256-GCM:

- SSH private keys (and passphrases)
- The global fallback SSH private key configured in Settings
- CyberPanel auto-login passwords
- WordPress DB credentials (`wp_db_credentials` table)
- Slack bot tokens

The `ENCRYPTION_KEY` env var (32 bytes / 64 hex chars) is the only secret not
stored in the database. It must be backed up separately. Data encrypted with a
key is permanently unreadable without it.

For SSH connection setup, the per-server key takes precedence. If a server has
no key, the worker resolves the global encrypted key from Settings. A missing
key at both levels is a connection configuration error.

### JWT Authentication

- **Access tokens:** 4-hour TTL by default, signed with `JWT_SECRET`
- **Refresh sessions:** 30-day TTL by default. Refresh tokens are delivered as
  scoped `httpOnly` cookies, stored as SHA-256 hashes server-side, and rotated
  on every refresh.
- **Login throttle:** 5 attempts per 15 minutes per IP (Redis counter)
- **Refresh throttle:** 30 requests per minute

The web API client shares one refresh request across concurrent calls. Protected
route guards hold the route in a loading state while the refresh runs and
redirect to login only if it fails.

### Role-Based Access Control

4-tier hierarchy enforced on every API route and frontend navigation item:

```
admin  > manager  > maintainer  > client
```

`hasMinimumRole(user, requiredRole)` is the single point of role evaluation (in
`@bedrock-forge/shared`). No role check is performed inline in business logic —
all protected routes use `@Roles()` decorator + `RolesGuard`.

### Request Validation

Global `ValidationPipe`:

- `whitelist: true` — strips unknown fields
- `forbidNonWhitelisted: true` — rejects requests with unknown fields rather
  than silently stripping
- `transform: true` — coerces primitives to declared types

All controller inputs use explicitly typed DTOs with `class-validator`
decorators.

---

## Backend Module Convention

Every feature module is structured identically:

```
src/modules/<feature>/
├── <feature>.module.ts       # @Module() declaration
├── <feature>.controller.ts   # HTTP handlers — validate input, call service, return DTO
├── <feature>.service.ts      # Business logic — calls repository only
├── <feature>.repository.ts   # Prisma access only — no business logic
├── dto/
│   ├── create-<feature>.dto.ts
│   ├── update-<feature>.dto.ts
│   └── query-<feature>.dto.ts
├── models/
│   └── <feature>.model.ts    # TypeScript interfaces for domain objects
└── tests/
    ├── <feature>.service.spec.ts
    └── <feature>.repository.spec.ts
```

Hard rules:

- Controllers never call repositories directly
- Services never import `PrismaService` or `PrismaClient`
- Repositories never contain conditional business logic
- All controller methods are `async` and return typed responses

---

## Frontend Architecture

React 19 SPA with route-level pages and colocated page helpers:

```
apps/web/src/
├── App.tsx             # Route table, lazy-loaded pages, auth guards
├── components/
│   ├── ui/             # Shared UI primitives
│   ├── crud/           # Data table, page header, pagination, state views
│   └── layout/         # AppLayout, Sidebar, Header
├── hooks/              # Shared custom hooks (useClientsList, useServersList, etc.)
├── lib/                # api-client.ts, websocket.ts, utils.ts
├── pages/              # Route pages and page-specific feature folders
│   ├── project-detail/ # Project workspace tabs and tab-specific api/hooks/types/utils
│   ├── security/       # Security page tabs, charts, dialogs, types, utils
│   └── settings/       # Settings tabs and tab-specific api/hooks/types
├── store/              # Zustand stores — auth.store.ts, ui.store.ts (UI state only)
└── index.css           # Global CSS + Tailwind styles
```

Top-level routes are defined in `apps/web/src/App.tsx`. The project detail page
is the largest workspace and includes tabs for environments, backups, sync,
restore, plugins, themes, WP core, tools, remote operations/files/config, drift,
and security.

For a higher-level page and feature map, see
[`docs/guides/ARCHITECTURE.md`](../guides/ARCHITECTURE.md).

State rules:

- **TanStack Query** — all server data (fetch, mutate, cache invalidation)
- **Zustand** — UI-only state (sidebar open/closed, modals, active tab, theme)
- Server data is **never** stored in Zustand
