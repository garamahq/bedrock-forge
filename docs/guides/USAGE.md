# Usage Guide

This guide explains what each part of Bedrock Forge is for and how common
workflows fit together. For a concise inventory of all product areas, see the
[Feature Guide](FEATURES.md).

## Operating Model

Bedrock Forge is an operations dashboard, not a WordPress plugin. You add servers and site environments, then trigger jobs from the UI. Jobs run in the worker, connect to remote servers over SSH, and stream progress into the execution log.

### Dashboard Overview
![Dashboard Overview](../assets/dashboard.png)

Use the execution log whenever an operation looks stuck or failed. It shows the exact remote step, command label, exit code, worker message, elapsed time, and progress when the worker reports it.

The floating **Action Center** summarizes the latest 12 job records, including
queued, running, failed, and completed jobs. Open it to see live elapsed timers,
progress, errors, and execution logs without leaving the current screen. Use
**Activity** for searchable history; an old failed job can remain in the badge
after its later retry succeeds.

### Login sessions

When a protected route detects an expired access token, Forge attempts to refresh
the session and shows a loading state while it waits. It returns to the login
page only when the refresh session is missing, expired, or rejected.

## Global Search

Press **Cmd/K** or **Ctrl/K** from anywhere in the app to open global search.
Search returns pages, clients, servers, projects, environments, and common
project tabs. Environment results open the owning project and mark the matching
environment; project tab results open directly to areas such as Plugins, Backups,
Sync, Files & Config, WP Core, Security, and Activity.

Search also includes operational resources such as domains, monitors, recent
jobs, and security findings. Empty search shows recent selections so common
projects, environments, and tabs stay close to hand.

## First Setup Flow

1. **Add a server**
   - Go to **Servers -> Add Server**.
   - Enter host, port, and SSH user. Add a per-server private key, or leave the
     key blank to use the global key configured in **Settings -> SSH Key**.
   - Save and confirm SSH connectivity.

   A per-server key takes precedence over the global key. Both are encrypted at
   rest; the UI never displays the stored private key after saving.

2. **Add a client**
   - Go to **Clients -> Add Client**.
   - Add contact details and tags if useful.

3. **Add a project**
   - Go to **Projects -> Add Project**.
   - Link the client and optional hosting/support packages.

4. **Add environments**
   - Open the project and use **Environments -> Add Environment**.
   - Configure type, URL, server, root path, and backup path.
   - Forge will attempt to discover WordPress DB credentials from the remote
     site.

5. **Run baseline checks**
   - Run a backup.
   - Run plugin and theme scans.
   - Check WordPress core.
   - Add a monitor.
   - Run a security scan.

## Projects

Projects group one or more WordPress environments for the same site. Typical environment names are `production`, `staging`, and `development`, but the label is free text.

### Projects Dashboard
![Projects Page](../assets/projects.png)

Project tabs:

| Tab            | Use it for                                                                            |
| -------------- | ------------------------------------------------------------------------------------- |
| Environments   | Server/path/URL config, DB credential discovery, protected tables, tags.              |
| Backups        | Create backups and manage backup schedules.                                           |
| Plugins        | Scan, install, update, activate, deactivate, remove, and manage Composer constraints. |
| Sync           | Clone or push files/database between environments.                                    |
| Restore        | Restore backups to the originating environment.                                       |
| Tools          | Cleanup, WP logs, debug mode, cron listing, cache and operational tools.              |
| Files & Config | Remote `.env`, safe file browser, downloads, uploads archive, log tail, notes.        |
| Drift          | Compare environment config against stored baseline/committed config.                  |
| Themes         | Scan, install, update, activate, and delete themes.                                   |
| WP Core        | Check WordPress core version and run core updates.                                    |

## Plugins

Plugin management supports three source types:

| Source        | Meaning                                                             | Supported actions                                                     |
| ------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Composer      | Plugin is managed by `composer.json` as `wpackagist-plugin/<slug>`. | Add, remove, update, update all, change constraint, schedule updates. |
| Manual        | Plugin exists in WordPress files but is not Composer-managed.       | Scan, activate/deactivate, update via WP-CLI when public, remove.     |
| GitHub custom | Plugin comes from the custom plugin catalog.                        | Install, update, remove, version check.                               |

Important notes:

- Viewing `composer.json` is a queued SSH job. The viewer shows elapsed time and
  the execution log while the file is being read, then renders the JSON when the
  job completes.

- Composer add/update/remove runs on Bedrock layouts.
- Manual public plugin update uses WP-CLI.
- Custom GitHub plugins must be added to **Settings -> Plugins -> Custom
  Catalog** before they can be installed on an environment.
- **Settings -> Plugins -> Installed Plugins** is a cross-environment inventory
  based on the latest plugin scans.

## Backups and Restore

Backup types:

- **Full**: database and files.
- **Database only**: mysqldump output only.
- **Files only**: site files only.

Schedules can run daily, weekly, or monthly. Retention can prune old backup
records by count or age depending on schedule settings.

Google Drive upload uses the configured rclone integration. Set a default
folder in **Settings -> Integrations**, then optionally set a folder ID on each
environment to direct its archives to a more specific destination. A practical
Drive layout is `Project / Backups / Environment / Site`; set the environment's
folder ID to the final site folder. This makes it easier to review and restore
backups without mixing sites.

For a site with a large media library, choose the smallest backup type that
meets the recovery need: **Files only** for site files without the database,
**Database only** for the database, or **Full** for both. **Incremental** stores
a database dump and rsync hard-link file snapshots; it needs rsync and extra
space on the managed server. Large Google Drive uploads can take longer than
archive creation, so wait for the job to show **Completed** and verify the file
in its destination folder before treating the upload as finished.

Restore and backup-target boundaries are tracked in
[Current Scope and Boundaries](../reference/LIMITATIONS.md).

## Sync

Sync is for moving data between project environments.

Supported scopes:

- **Database only**: Generates a database dump on the source server, transfers it to the target, imports it, runs protection steps, and performs URL replacement.
- **Files only**: Syncs site files (excluding configurations like `.env`, `wp-config.php`, `.htaccess`) using `rsync` (or a tar-relay fallback).
- **Database + files**: Performs the database sync first, followed by the file sync.

Forge creates a safety backup of the target before a database import unless the
operator explicitly skips it. It also preserves selected target-specific state
across the import: WordPress search visibility (`blog_public`), the active
plugin list, and Secure Guard options other than its lock-state value. If the
target contains database tables but Forge cannot read its WordPress options
table, the sync stops instead of importing over unknown target state. Review
the execution log for each capture, restore, and cleanup step.

### Data Protection & Sanitization

When syncing databases between environments (such as cloning from `production` to `staging` or pushing from `staging` to `production`), it is critical to prevent overwriting environment-specific data or leaking sensitive user information. Forge provides three levels of database protection, all configured per target environment.

> **Which should I use?**
> | Goal | Use |
> |---|---|
> | Keep an entire plugin's table intact on target | **Protected Tables** |
> | Delete/sanitize data after import (e.g. wipe orders on staging) | **SQL Protection Queries** |
> | Keep target post type content untouched during sync | **Protected Custom Post Types** |

#### 1. Protected Tables

Protected tables are specific database tables on the target environment that are **completely skipped** during the database import.

- **How it works**: The source `mysqldump` is generated without those tables. The target's existing table data is never touched or overwritten. They are also excluded from URL search-replace.
- **When to use**: Plugin-owned tables that are environment-specific and should never be overwritten — e.g. local SMTP settings, Wordfence scan logs, or WP Super Cache config.
- **Configuration**: Enter the exact table names (e.g. `wp_smtp_settings, wp_wflogs`) in the **Protected Tables** field of the Environment settings modal.

#### 2. SQL Protection Queries

SQL Protection Queries are custom SQL commands executed on the **target** database **immediately after** the dump is imported but **before** URL search-replace runs.

- **How it works**: Forge pushes the queries to the target server, auto-detects the WordPress table prefix (via `information_schema`), substitutes `{prefix}` / `%prefix%` with the real prefix (e.g. `wp_` or `mysite_`), and runs all queries in sequence.
- **When to use**: Sanitizing production data when pushing to staging or dev — delete orders, anonymize emails, clear API keys, etc.
- **Configuration**: Enter one SQL query per line in the **SQL Protection Queries** text area of the Environment settings modal.

##### Use case: Delete a custom post type on import (e.g. wipe 'project' from staging)

Use this when you do **not** want a post type to exist on the target after sync. The queries must be entered in dependency order (children before parents):

```sql
-- 1. Delete comment metadata for project post comments
DELETE cm FROM {prefix}commentmeta cm
  INNER JOIN {prefix}comments c ON cm.comment_id = c.comment_ID
  INNER JOIN {prefix}posts p ON c.comment_post_ID = p.ID
  WHERE p.post_type = 'project';

-- 2. Delete comments on project posts
DELETE c FROM {prefix}comments c
  INNER JOIN {prefix}posts p ON c.comment_post_ID = p.ID
  WHERE p.post_type = 'project';

-- 3. Delete postmeta for project revisions
DELETE pm FROM {prefix}postmeta pm
  INNER JOIN {prefix}posts r ON pm.post_id = r.ID
  INNER JOIN {prefix}posts p ON r.post_parent = p.ID
  WHERE r.post_type = 'revision' AND p.post_type = 'project';

-- 4. Delete project revisions
DELETE r FROM {prefix}posts r
  INNER JOIN {prefix}posts p ON r.post_parent = p.ID
  WHERE r.post_type = 'revision' AND p.post_type = 'project';

-- 5. Delete term relationships (category/tag links) for projects
DELETE tr FROM {prefix}term_relationships tr
  INNER JOIN {prefix}posts p ON tr.object_id = p.ID
  WHERE p.post_type = 'project';

-- 6. Delete custom fields / ACF metadata for projects
DELETE pm FROM {prefix}postmeta pm
  INNER JOIN {prefix}posts p ON pm.post_id = p.ID
  WHERE p.post_type = 'project';

-- 7. Finally delete the project posts themselves
DELETE FROM {prefix}posts WHERE post_type = 'project';
```

##### Use case: Sanitize WooCommerce orders & customer data on staging

```sql
-- Remove WooCommerce orders & shop logs
DELETE FROM {prefix}posts WHERE post_type IN ('shop_order', 'shop_order_refund', 'wc_user_membership', 'wc_membership_plan');
DELETE pm FROM {prefix}postmeta pm LEFT JOIN {prefix}posts p ON pm.post_id = p.ID WHERE p.ID IS NULL;

-- Anonymize user email addresses and clear session tokens
UPDATE {prefix}users SET user_email = CONCAT(user_login, '@staging.local'), user_pass = '$P$B7yO3s4Z2iA5hS7gX9wQ1R0tU6vY2o.' WHERE ID > 1;
DELETE FROM {prefix}usermeta WHERE meta_key = 'session_tokens';
```

#### 3. Protected Custom Post Types

Use this when you want to **keep** the target's existing content for a custom post type untouched — so that whatever is in production doesn't overwrite staging/dev data for that post type.

- **When to use**: You have staging-specific projects, courses, lessons, or test content that you never want wiped out by a production sync.
- **How it works** (full lifecycle):
  1. **Pre-import backup**: Before the dump is imported, Forge connects to the target DB, auto-detects the table prefix, and copies all rows for the protected post types from `posts`, `postmeta`, `term_relationships`, `term_taxonomy`, `terms`, `comments`, and `commentmeta` — including their revisions and directly attached media — into temporary `_forge_backup_*` tables.
  2. **Safe import**: Forge skips the `DROP DATABASE` step so the backup tables survive the incoming dump.
  3. **Post-import restore**: After import, Forge deletes all rows for the protected post types that arrived from the source (posts, revisions, directly attached media, taxonomy links, comments, and metadata), then re-inserts the original target rows from the backup tables, and finally drops the backup tables.
  4. **File sync protection**: During database+files sync, Forge excludes upload files referenced by the protected post type's directly attached media from rsync/tar overwrite and deletion.
- **Configuration**: Enter a comma-separated list of custom post type slugs in the **Protected Custom Post Types** field of the Environment settings modal.

```
project, course, lesson
```

> **Important**: This preserves post type **content** on the target. The post type **registration** (code / plugin) must still exist on both environments. Media protection is based on WordPress attachment rows directly attached to the protected posts; arbitrary URLs embedded in builder content are not guaranteed unless they resolve to those attachments.

> **Note**: Protected Custom Post Types and SQL Protection Queries are not mutually exclusive. You could protect `course` posts on staging while also running sanitization queries for WooCommerce orders in the same sync.

## Files & Config

Use **Project -> Files & Config** to reduce routine SSH usage.

Available workflows:

- Edit remote `.env` with secret masking, checksum conflict checks, required
  variable validation, and backup-before-write.
- Compare `.env` variables between staging and production.
- Browse safe remote roots: site root, uploads, logs, downloads, and backups.
- Quick-edit small text files and tail selected log files.
- Download small files directly from safe roots.
- Create a remote uploads archive under the Downloads folder.
- Keep persistent project notes.

The file browser is intentionally scoped. It does not expose arbitrary server
paths such as `/etc`, `/root`, or SSH key directories.

## Security

The Security page keeps the main operational security views:

| View      | Use it for                                                      |
| --------- | --------------------------------------------------------------- |
| Overview  | High-level scan status and security score.                      |
| Servers   | Server hardening and SSH/security scan results.                 |
| Projects  | WordPress environment security scans.                           |
| Findings  | Flat list of current findings with acknowledgement workflow.    |
| Schedules | Automated server/environment scan schedules and alert settings. |

### Security Overview Dashboard
![Security Page](../assets/security.png)

Security scans can check server posture, SSH activity, WordPress configuration,
file patterns, suspicious scripts, and related hardening items. Some hardening
actions can be applied from the UI, but review each action before running it on
production.

Environment hardening selects only low-risk protections by default. Destructive
or compatibility-sensitive actions, such as deleting PHP files in uploads,
forcing a WordPress core reinstall, or updating every plugin, are visible but
must be selected explicitly and confirmed before Forge queues the job.

The hardening UI groups actions by intent and provides presets:

- **Safe hardening**: non-destructive server and WordPress protections.
- **Bedrock app shield**: focused file-access rules for exposed Bedrock app
  paths.
- **Incident response**: cleanup or repair actions that require review before
  use.

Finding cards show the recommended remediation, a preview of what Forge will
change, and a post-run scan prompt so operators can verify that the issue is
closed instead of guessing from the job result alone.

For Bedrock installs, the environment scan also probes direct `/app` access for
logs, `.env`, package metadata, and unexpected extensionless files. The **Block
sensitive file access** action writes a web-server app-path guard that denies
unsafe direct files while preserving normal static assets.

Security boundaries are tracked in
[Current Scope and Boundaries](../reference/LIMITATIONS.md).

## Monitoring and Lighthouse

Monitoring supports:

- HTTP availability.
- Response time history.
- SSL expiry checks.
- DNS resolution checks.
- Keyword/content checks.
- Incident logs and notifications.

Monitor state changes are confirmed to reduce one-off false alerts. A failed
first HTTP probe is retried after five seconds; if the monitor was up, a
successful retry prevents a down transition. When a monitor was down, the first
successful recovery probe is followed by another probe after five seconds. A
failed confirmation keeps it down and does not send an up alert. The monitor
still uses the configured worker's network path, so this is not independent
multi-region verification.

### Uptime Monitoring Dashboard
![Monitors Page](../assets/monitors.png)

Lighthouse audits are separate from uptime monitors. Use **Lighthouse** to run
performance audits for environments and review historical mobile/desktop scores
and trends.

Forge runs local Chromium-based Lighthouse by default to avoid Google PageSpeed
daily query quotas. PageSpeed API is optional fallback/configurable behavior.
If a PageSpeed quota error appears, set `LIGHTHOUSE_PROVIDER=local` or wait for
the Google quota reset.

## Billing and Packages

Packages define recurring hosting/support prices for projects. Invoices are
generated from project package assignments and can be tracked through draft,
sent, paid, overdue, and cancelled statuses.

Settings:

- Use **Settings -> Billing** to configure currency code and locale.
- Currency affects display formatting in packages and invoices.

Billing boundaries are tracked in
[Current Scope and Boundaries](../reference/LIMITATIONS.md).

## Settings

Key settings areas:

| Tab          | Use it for                                                             |
| ------------ | ---------------------------------------------------------------------- |
| Account      | Your profile and password.                                             |
| SSH Key      | Configure the encrypted global private key used when a server has no key.       |
| Integrations | Slack, Google Chat, generic webhooks, Google Drive/rclone, Cloudflare, and GitHub. |
| Automation   | Scheduled/platform automation settings.                                |
| Plugins      | Custom plugin catalog and installed plugin inventory.                  |
| Billing      | Currency and locale for billing display.                               |
| Backup       | Forge system backup settings.                                          |
| Advanced     | Low-level app settings.                                                |

### Settings Panel
![Settings Page](../assets/settings.png)

Only admins can change global settings.

## Activity, Problems, and Audit Logs

- **Activity** shows background job history and failures.
- **Problems** aggregates attention items such as down monitors, expiring
  domains, outdated plugins, drift, and other issues.
- **Audit Logs** show user actions and operational changes.

### Job Activity Log
![Activity Page](../assets/activity.png)

Use these pages for triage before rerunning failed operations.

## Current Product Boundaries

The canonical list of current product boundaries is maintained in
[Current Scope and Boundaries](../reference/LIMITATIONS.md). Treat Forge as an
operator tool for a trusted internal team, not a hosted SaaS platform for
multiple unrelated customer workspaces.
