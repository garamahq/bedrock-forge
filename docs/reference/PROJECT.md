# Bedrock Forge Project Reference

## Architecture Overview

Self-hosted WordPress operations dashboard for managing WordPress and Bedrock
sites over SSH.

**Core decisions:**

- REST API (not GraphQL — overrides orchestrator default for this project)
- TanStack Query v5 (not Apollo — consistent with REST)
- Prisma 7 + strict Repository pattern (Prisma access only inside
  `*.repository.ts` files)
- BullMQ for every background operation (no `setInterval`, no inline remote
  calls from controllers)
- Global SSH connection pool via `ssh2` (max 15 concurrent per server). No
  agent, no Go binary.
- No permanent remote agent. Helper scripts are pushed on demand, and WP-CLI is
  used only for workflows that need WordPress-native operations such as
  theme/core actions, cache cleanup, and selected plugin workflows.
- Zero `.env` sourcing. Credential extraction is regex-only via
  `CredentialParserService`.
- AES-256-GCM encryption for all credentials at rest
- 4 Docker Compose services: `postgres`, `redis`, `forge` (API + Worker), `web`
  (Nginx + static React)

---

## Tech Stack

| Layer              | Technology                                       |
| ------------------ | ------------------------------------------------ |
| Runtime            | Node.js 22                                       |
| Backend framework  | NestJS 11                                        |
| ORM                | Prisma 7                                         |
| Database           | PostgreSQL 16                                    |
| Queue              | BullMQ + Redis 7                                 |
| Remote execution   | ssh2 (connection pool)                           |
| Frontend framework | React 19 + Vite 6                                |
| UI components      | shadcn/ui + Tailwind CSS 4                       |
| Server state       | TanStack Query v5                                |
| Client state       | Zustand (UI/session only — never server data)    |
| Forms              | React Hook Form + Zod                            |
| Real-time          | NestJS WebSocket Gateway + Redis pub/sub adapter |
| Workspace          | pnpm workspaces + Turborepo                      |
| Containerization   | Docker Compose                                   |

---

## Monorepo Structure

```
bedrock-forge/
├── apps/
│   ├── api/                    # NestJS 11 REST API + WebSocket gateway
│   │   ├── src/
│   │   │   ├── modules/
│   │   │   │   ├── auth/
│   │   │   │   ├── clients/
│   │   │   │   ├── tags/
│   │   │   │   ├── packages/
│   │   │   │   ├── servers/
│   │   │   │   ├── projects/
│   │   │   │   ├── environments/
│   │   │   │   ├── cyberpanel/
│   │   │   │   ├── backups/
│   │   │   │   ├── plugin-scans/
│   │   │   │   ├── sync/
│   │   │   │   ├── domains/
│   │   │   │   ├── monitors/
│   │   │   │   ├── settings/
│   │   │   │   ├── users/
│   │   │   │   ├── invoices/
│   │   │   │   ├── notifications/
│   │   │   │   ├── reports/
│   │   │   │   ├── job-executions/
│   │   │   │   ├── maintenance/
│   │   │   │   ├── audit-logs/
│   │   │   │   └── health/
│   │   │   ├── gateways/       # WebSocket gateways
│   │   │   ├── common/         # Guards, filters, interceptors, decorators
│   │   │   ├── prisma/         # PrismaService
│   │   │   └── main.ts
│   │   └── package.json
│   ├── web/                    # React 19 + Vite 6 dashboard
│   │   ├── src/
│   │   │   ├── pages/          # Route pages and colocated feature modules
│   │   │   │   ├── project-detail/
│   │   │   │   ├── projects/
│   │   │   │   ├── security/
│   │   │   │   └── settings/
│   │   │   ├── components/
│   │   │   │   ├── ui/         # shadcn primitives (owned, not a package)
│   │   │   │   └── layout/     # AppLayout, Sidebar, Header
│   │   │   ├── hooks/          # Shared custom hooks
│   │   │   ├── lib/            # api-client, websocket, utils, cn
│   │   │   ├── store/          # Zustand stores (UI state only)
│   │   │   └── styles/
│   │   └── package.json
│   └── worker/                 # NestJS standalone — BullMQ consumers only
│       ├── src/
│       │   ├── processors/
│       │   │   ├── backup/
│       │   │   │   └── backup.processor.ts
│       │   │   ├── plugin-scan/
│       │   │   │   └── plugin-scan.processor.ts
│       │   │   ├── sync/
│       │   │   │   └── sync.processor.ts
│       │   │   ├── monitor/
│       │   │   │   └── monitor.processor.ts
│       │   │   ├── domain-whois/
│       │   │   │   └── domain-whois.processor.ts
│       │   │   ├── create-bedrock/
│       │   │   │   └── create-bedrock.processor.ts
│       │   │   ├── notification/
│       │   │   │   └── notification.processor.ts
│       │   │   └── report/
│       │   │       └── report.processor.ts
│       │   ├── utils/
│       │   │   ├── cyberpanel-http.ts  # CyberPanel REST API + escapeMysql
│       │   │   └── processor-utils.ts  # shellQuote, flipProtocol
│       │   └── main.ts
│       ├── scripts/
│       │   ├── backup.php
│       │   └── plugin-scan.php
│       └── package.json
├── packages/
│   ├── shared/                 # @bedrock-forge/shared — types, queue defs, Zod schemas
│   │   └── src/
│   │       ├── queues.ts
│   │       ├── roles.ts
│   │       ├── types.ts
│   │       └── index.ts
│   └── remote-executor/        # @bedrock-forge/remote-executor — SSH pool + credential parser
│       └── src/
│           ├── ssh-pool.manager.ts
│           ├── remote-executor.service.ts
│           ├── credential-parser.service.ts
│           └── index.ts
├── prisma/
│   ├── schema.prisma
│   └── migrations/
├── PROJECT.md
├── package.json
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.base.json
├── .env.example
├── .gitignore
├── docker-compose.yml
├── docker-compose.dev.yml
├── Dockerfile
└── entrypoint.sh
```

---

## Module Structure Convention

Every backend module follows this exact structure:

```
src/modules/<feature>/
├── <feature>.module.ts      # @Module() — imports, controllers, providers, exports
├── <feature>.controller.ts  # HTTP handlers only. Validates input, calls service, returns DTO.
├── <feature>.service.ts     # Business logic. Calls repository. Never touches Prisma directly.
├── <feature>.repository.ts  # Prisma access ONLY. No business rules here.
├── dto/
│   ├── create-<feature>.dto.ts
│   ├── update-<feature>.dto.ts
│   └── query-<feature>.dto.ts
├── models/
│   └── <feature>.model.ts   # TypeScript interfaces for domain objects
└── tests/
    ├── <feature>.service.spec.ts
    └── <feature>.repository.spec.ts
```

**Hard rules:**

- Controllers never call repositories directly
- Services never import or use `PrismaClient` or `PrismaService`
- Repositories never contain conditional business logic
- DTOs use `class-validator` decorators for validation
- All controller methods are async, return typed responses

---

## Domain Model

### Identity & Access

- `users` — platform users (admin, manager, maintainer, client)
- `roles` — exactly 4 roles: admin, manager, maintainer, client
- `user_roles` — many-to-many join
- `refresh_tokens` — hashed JWT refresh tokens for rotation

### Client Management

- `clients` — managed clients / companies
- `tags` — color-coded labels
- `client_tags` — many-to-many: clients ↔ tags

### Packages

- `hosting_packages` — hosting tier definitions (price, storage, bandwidth,
  max_sites)
- `support_packages` — support tier definitions (price, response_hours)

### Infrastructure

- `servers` — managed servers (SSH credentials encrypted)
- `projects` — WordPress projects (linked to client + packages)
- `environments` — deployments of a project on a server (production/staging)
- `cyberpanel_users` — saved auto-login credentials per environment

### Operations

- `backups` — backup records (status, file_path, size)
- `plugin_scans` — plugin inventory snapshots (JSONB)
- `domains` — domain names with WHOIS cache (JSONB)
- `monitors` — uptime monitor config per environment
- `monitor_results` — individual uptime check results (rolling history)
- `wp_db_credentials` — encrypted DB\_\* credentials per environment

### System

- `execution_scripts` — versioned PHP scripts pushed to servers
- `job_executions` — BullMQ job audit trail (status, progress, errors)
- `app_settings` — key-value config store
- `audit_logs` — user action audit trail (actor, action, resource)
- `backup_schedules` — cron-based backup scheduling per environment
- `system_backups` — Forge DB backups (pg_dump + rclone to Google Drive)
- `system_backup_schedules` — repeatable schedule config for system backups
- `security_scans` — scan results (SSH_AUDIT, SERVER_HARDENING, WP_AUDIT,
  PROJECT_MALWARE, MALWARE_SCAN)
- `security_scan_schedules` — cron-based scan scheduling per server/environment
- `security_finding_acks` — acknowledged/accepted findings with notes
- `ssh_keys` — server SSH private keys (encrypted at rest)

### Billing & Notifications

- `invoices` — yearly invoices linked to a project (hosting + support cost)
- `notification_channels` — Slack webhook channels (with event subscriptions)
- `notification_logs` — delivery log per notification dispatch

---

## BullMQ Queue Registry

| Queue            | Job Types                                                                | Concurrency | Retries | Timeout |
| ---------------- | ------------------------------------------------------------------------ | ----------- | ------- | ------- |
| `backups`        | `create`, `restore`                                                      | 3/server    | 3       | 30min   |
| `plugin-scans`   | `run`                                                                    | 5           | 3       | 5min    |
| `sync`           | `clone`, `push`                                                          | 2/server    | 3       | 15min   |
| `monitors`       | `monitor:check`, `lighthouse:audit`                                      | varies      | varies  | varies  |
| `domains`        | `whois`                                                                  | 10          | 3       | 30s     |
| `projects`       | `create-bedrock`                                                         | 2/server    | 2       | 20min   |
| `notifications`  | `send`                                                                   | 20          | 3       | 30s     |
| `reports`        | `report:generate`, `security:report-generate`                            | 1           | 3       | varies  |
| `security`       | `server-scan`, `environment-scan`, `server-harden`, `environment-harden` | 4           | 3       | 15min   |
| `system-backups` | `system-backup:create`, `system-backup:scheduled`                        | 1           | 2       | 20min   |
| `theme-scans`    | `theme-scan:run`, `theme-scan:manage`                                    | 3           | 3       | 10min   |

Default jobs use exponential backoff with retained completed/failed job history.
Separate `<queue>-dlq` queues are not currently implemented; failed jobs remain
available through BullMQ failed job history and Forge `job_executions` records.

---

## Security Conventions

- **Credential encryption:** AES-256-GCM via `EncryptionService`. Key from
  `ENCRYPTION_KEY` env var. Never stored in DB.
- **SSH keys:** Encrypted at rest. Decrypted in memory only during SSH
  connection. Never returned in API responses.
- **JWT:** 4h access token + 30d refresh session by default, configurable via
  `JWT_ACCESS_EXPIRES_IN` and `JWT_REFRESH_EXPIRES_IN`. Refresh tokens are
  delivered as scoped `httpOnly` cookies, stored as SHA-256 hashes server-side,
  and rotated on every refresh.
- **Validation:** `ValidationPipe` global with `whitelist: true`,
  `forbidNonWhitelisted: true`, `transform: true`.
- **Rate limiting:** 5 login attempts/15min (Redis-backed), 100 req/min general.
- **No eval, no `require()`, no child_process shell:** Remote operations go
  through `RemoteExecutorService` only.

---

## Docker Compose Services

| Service    | Image               | Purpose                                             | External Port        |
| ---------- | ------------------- | --------------------------------------------------- | -------------------- |
| `postgres` | postgres:16-alpine  | Primary database                                    | 5432 (internal only) |
| `redis`    | redis:7-alpine      | BullMQ + WebSocket pub/sub + rate limiting          | 6379 (internal only) |
| `forge`    | (multi-stage build) | NestJS API + NestJS Worker (two parallel processes) | 3001 → 3000          |
| `web`      | nginx:alpine        | Static React build served by Nginx + reverse proxy  | 3002 → 80            |

`forge` container entrypoint: runs `prisma migrate deploy`, then starts API
(`apps/api`) and Worker (`apps/worker`) as parallel Node processes via
`entrypoint.sh`. The API exposes `/health` on internal port 3000. The worker
exposes `/worker/health` on internal port 3001 so Docker health checks can fail
the combined `forge` container when either runtime is unavailable.

---

## UI Board Description

**Layout:** Fixed left sidebar (240px) + main content area. Sidebar collapses to
icon-only on md breakpoint.

**Sidebar navigation:** 21 destinations grouped into Overview, Management,
Operations, Billing & Admin, and System Admin. Items are hidden below their
required role level.

**Dashboard home:** Active projects, managed servers, average monitor uptime,
and domains expiring within 30 days; real 24-hour operation counts; environment
health; attention items; running jobs; and recent completed activity.

**Project detail:** Tabs cover Environments, Backups, Sync, Restore, Plugins,
Themes, WP Core, Tools, Remote Ops and Files, Drift, Git Deploy, and Security.

**Live updates:** Backup progress bars, toast notifications for job
completion/failure, activity feed — all via WebSocket subscription with TanStack
Query cache invalidation on completion.

**Design:** shadcn/ui components, Tailwind CSS 4, dark mode via `.dark` class on
`<html>`, HSL CSS variables, lucide-react icons. Mobile-first, responsive.
