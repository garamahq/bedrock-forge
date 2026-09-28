# Improvement Roadmap

This roadmap focuses on making Bedrock Forge easier to set up, edit, maintain,
and extend. It is intentionally separate from product feature requests.

## Setup and Local Development

- Create clear environment profiles for production, Docker development, and
  manual local development. The current `.env.example` mixes production Docker
  defaults with development hints.
- `doctor.sh` checks Docker, Compose, host tool versions, port conflicts, `.env`
  placeholders, Redis and database URL formats, and required secret lengths.
  Keep those checks aligned with the runtime's actual requirements.
- Make `install.sh`, `dev.sh`, `update.sh`, and `reset.sh` share common helper
  behavior for writing `.env` values, checking prerequisites, and printing next
  steps.
- Add clearer first-run output that separates production Docker URLs from local
  Vite development URLs.
- Add seed/reset documentation that explains which data is sample data, which
  credentials are default, and what must be changed before real use.

## Code Organization

- Keep feature code colocated, but make the folder shape consistent:
  `api.ts`, `hooks.ts`, `types.ts`, `utils.ts`, and local components when a page
  grows past a small route component.
- Split very large route pages and tabs into focused components and hooks. Start
  with project plugin management, security views, projects, invoices, monitors,
  reports, and remote operations.
- Split worker processors into orchestration and focused services:
  preflight/checks, command building, remote execution, result parsing,
  persistence, and notification side effects.
- Keep API feature modules on the existing controller -> service -> repository
  pattern, but extract shared orchestration helpers for repeated job enqueue,
  job execution, and failure-update behavior.
- Move repeated frontend form, table, status badge, date, error, and empty-state
  patterns into shared components/utilities only after at least two pages use
  the same behavior.

## Contracts and Types

- Strengthen shared types for the highest-risk boundaries first: job payloads,
  WebSocket events, execution logs, API errors, security findings, report data,
  and notification payloads.
- Reduce `any` at those boundaries before cleaning low-risk test mocks.
- Add a single frontend API error type and helper so toast messages, form
  errors, and retry states behave consistently.
- Add generated or documented API contracts for the Nest controllers so frontend
  changes can be made without searching controller implementations.
- Keep queue names, job types, and payload schemas in `packages/shared`; avoid
  string literals in API/worker modules.

## Testing and Quality Gates

- Keep TypeScript checks as the baseline for every package.
- Add ESLint after choosing rules that match the current codebase; start in
  warning mode for broad style rules and error mode for correctness rules.
- Add component tests for high-value frontend flows: login/session state, global
  search, project tabs, job progress panels, settings forms, and destructive
  confirmation dialogs.
- Add API integration tests around auth/RBAC, job enqueue failure handling,
  settings validation, and resource ownership checks.
- Add worker tests around preflight and failure paths for backup, sync, plugin,
  theme, security, and report processors.
- Add coverage thresholds only after critical flows are covered, so the gate
  improves quality instead of blocking unrelated maintenance.

## Documentation

- Keep the README short and operational.
- Keep current product boundaries in `docs/reference/LIMITATIONS.md`.
- Keep architecture and page/module maps in `docs/guides/ARCHITECTURE.md`.
- Keep deep technical details in `docs/reference/ARCHITECTURE.md` and
  `docs/reference/PROJECT.md`.
- Add short “how to edit this feature” notes for the largest domains once they
  are split into smaller modules.

## Suggested Order

1. Clean up setup profiles and script consistency.
2. Split the largest frontend pages into page-local modules.
3. Split the largest worker processors into services with focused tests.
4. Strengthen shared contracts for jobs, WebSockets, and API errors.
5. Add ESLint and targeted component/integration tests.
