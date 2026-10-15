# Bedrock Forge Feature Guide

This guide maps the features available in Bedrock Forge and their main
operational boundaries. For step-by-step workflows, see the
[Usage Guide](USAGE.md). Bedrock Forge is a self-hosted operator dashboard for
one trusted team managing WordPress and Bedrock environments over SSH.

## Inventory and team operations

| Feature | What it covers |
| --- | --- |
| Servers | SSH server inventory, connectivity checks, health details, linked environments, and optional CyberPanel helpers. A per-server private key takes precedence; a global key configured in **Settings → SSH Key** is the fallback. |
| Clients and projects | Organize client records and the projects and environments they own. Projects can carry tags and hosting/support package assignments. |
| Environments | Track a site's URL, server, environment type, root and backup paths, database discovery, protected sync data, and optional Google Drive destination. |
| Domains and tags | Track domain ownership/expiry data and label clients or environments for filtering. |
| Packages and invoices | Define hosting/support packages and generate invoices for status tracking. Billing does not collect payments. |
| Users and roles | Manage team accounts with admin, manager, maintainer, and client roles. API access is role-checked; audit logs record administrative changes. |

## WordPress operations

| Feature | What it covers |
| --- | --- |
| Backups and restore | Create full, database-only, files-only, or incremental backups; configure schedules and retention; upload to Google Drive; restore a backup to its originating environment. |
| Sync and clone | Move database and/or files between environments with safety backups, URL replacement, protected-data rules, and restoration of selected target-specific WordPress settings after database import. |
| Plugins | Scan Composer, manual, and custom GitHub plugins; install, update, activate, deactivate, remove, and manage Composer constraints. Configure catalog entries and update schedules in Settings. |
| Themes and WordPress core | Scan and manage themes; check and update the WordPress core version through remote WP-CLI workflows. |
| Tools and maintenance | Run cleanup, maintenance mode, debug toggles, cron inspection, cache fixes, log retrieval, and other supported WP-CLI actions. |
| Files and configuration | Edit environment values with validation and backup-before-write, compare variables, browse approved remote roots, edit small text files, tail logs, and create upload/download archives. |
| Drift | Compare a saved environment configuration baseline with current values and review differences. |

Google Drive accepts a default folder and a per-environment folder override.
For easier recovery, organize Drive folders by project, then environment, then
site, and assign each environment the ID of its site folder. See
[Backups and Restore](USAGE.md#backups-and-restore) and
[Google Drive setup](../getting-started/INSTALLATION.md#google-drive-configuration).

## Monitoring, security, and performance

| Feature | What it covers |
| --- | --- |
| Uptime monitors | HTTP status and response time history, SSL expiry, DNS resolution, keyword checks, incident history, and configured notifications. A failed first probe is retried after five seconds; recovery from a down state requires a second successful probe before an up transition is recorded. |
| Security | Server and environment scans, scheduled checks, findings, reports, alert settings, and operator-reviewed hardening actions. |
| Lighthouse | Queue local Chromium-based mobile/desktop audits and review score history. PageSpeed API use is optional and quota-bound. |
| Problems | Cross-project attention feed for conditions such as down monitors, expiring domains, outdated plugins, and configuration drift. |

Two sequential probes reduce transient monitor alerts but do not provide
independent, multi-region verification. For response steps, see the
[degraded-health runbook](../runbooks/degraded-health.md).

## Platform operations

- **Activity and Action Center:** Review queued and recent job states, progress,
  errors, and execution logs. The Action Center summarizes the latest 12 job
  records; use Activity for searchable job history.
- **Notifications:** Configure supported Slack, Google Chat, and generic
  webhook delivery, review in-app notifications, and inspect delivery logs.
- **Reports:** Configure, generate, and review report history and PDFs.
- **Integrations:** Configure Google Drive, Cloudflare, GitHub, and notification
  providers supported by the installation.
- **System backups:** Schedule PostgreSQL dumps of the Forge platform database
  and upload them to Google Drive; these are separate from managed-site
  backups.
- **Global search:** Use **Cmd/K** or **Ctrl/K** to find pages, clients,
  projects, environments, servers, domains, monitors, jobs, and security
  findings.
- **Audit logs:** Review recorded user actions and administrative changes.

## Job and session behavior

Long-running operations run as BullMQ jobs. The API validates and queues the
request, the worker performs the remote operation, and the UI receives progress
and final status. Inspect Activity before retrying a failed job so you do not
repeat an operation that already changed a remote site.

When an access token expires, protected route guards attempt a refresh using the
refresh-token session. The app shows a loading state while refresh is in flight
and returns to the login page only if the refresh cannot complete.

## Further reading

- [Usage Guide](USAGE.md) — day-to-day setup and operation.
- [Quick Start](../getting-started/QUICK_START.md) — connect a first server and
  environment.
- [Installation](../getting-started/INSTALLATION.md) — deployment and
  configuration.
- [Architecture](../reference/ARCHITECTURE.md) — system and security model.
- [Current Scope and Boundaries](../reference/LIMITATIONS.md) — supported
  workflows and intentional limits.
