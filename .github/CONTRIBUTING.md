# Contributing to Bedrock Forge

Thank you for considering a contribution to Bedrock Forge. This guide explains
how to get started.

## Getting Started

1. Fork the repository.
2. Clone your fork:
   ```bash
   git clone https://github.com/<your-fork>/bedrock-forge.git
   cd bedrock-forge
   ```
3. Follow the development setup in
   [docs/guides/DEVELOPMENT.md](docs/guides/DEVELOPMENT.md).
4. Create a feature branch:
   ```bash
   git checkout -b feat/my-feature
   ```

## Development Workflow

- **Backend:** `apps/api/` (NestJS REST API) and `apps/worker/` (BullMQ
  processors)
- **Frontend:** `apps/web/` (React + Vite)
- **Shared:** `packages/shared/` (types, queue definitions, Zod schemas)

See [PROJECT.md](docs/reference/PROJECT.md) for architecture conventions and
module structure.

Before opening a pull request, run `pnpm verify` from the repository root. It
runs the workspace type/lint checks and all test suites, building required
packages in dependency order.

## Code Style

- `pnpm lint` runs TypeScript checks; Prettier is available through
  `pnpm format`. ESLint is not configured yet.
- Run `pnpm lint` before committing. Use `pnpm format` only for files you
  intend to reformat because it writes changes across the repository.
- Follow the existing patterns in each module (controller → service →
  repository).

## Commit Messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(backups): add incremental backup support
fix(auth): prevent refresh token reuse after rotation
docs: update QUICK_START with GDrive setup
chore: bump dependencies
```

## Pull Requests

1. Ensure `pnpm verify` passes locally.
2. Keep PRs focused on a single concern.
3. Reference any related issue in the PR description (e.g. `Closes #42`).
4. Add tests for new business logic in services and processors.

## Reporting Issues

- Use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md) for bugs.
- Use the [feature request template](.github/ISSUE_TEMPLATE/feature_request.md)
  for new ideas.
- Search existing issues before opening a duplicate.

## Security Vulnerabilities

**Do not open public issues for security vulnerabilities.** See
[SECURITY.md](SECURITY.md) for responsible disclosure instructions.

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](LICENSE).
