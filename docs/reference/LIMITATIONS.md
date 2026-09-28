# Current Scope and Boundaries

These are current product boundaries, not bugs. Bedrock Forge is built as a
self-hosted operator tool for one trusted team managing WordPress sites over
SSH.

## Workspace Model

- No multi-tenant workspace isolation.
- One Forge install is intended for one internal team.
- It is not currently designed as a hosted SaaS platform for multiple unrelated
  customer workspaces.

## Billing

- No payment processing.
- Billing tracks invoices only; it does not charge cards or integrate with
  Stripe, PayPal, or accounting systems.
- No tax engine.

## Authentication and Access

- No SSO.
- No self-service password recovery. The installer does not reset an existing
  administrator, so retain the generated password and create a second
  administrator for account recovery.
- MFA exists for user sessions where implemented in the app, but full enterprise
  identity-provider integration is not part of the current scope.
- Role-based access exists, but organization/workspace isolation is not a
  current tenancy boundary.

## Notifications

- Slack and in-app notifications are available, alongside Google Chat and
  configurable generic webhook delivery.
- Email, Discord, and Telegram delivery are not currently supported.

## Backups and Restore

- Incremental backups include a database dump and use remote rsync hard-link
  snapshots for files. They require `rsync` on the managed server and extra
  remote disk space for the cache directory beside the WordPress document root.
- No cross-server restore from an existing backup record. Restores target the
  originating environment.
- Google Drive is the only remote backup target wired into the backup UI.
- S3, Backblaze B2, Wasabi, SFTP, and other rclone targets are not exposed as
  first-class UI workflows yet.

## Remote Files

- The remote file browser is intentionally limited to safe roots such as site
  root, uploads, logs, downloads, and backup paths.
- It does not expose arbitrary server paths such as `/etc`, `/root`, or SSH key
  directories.
- Direct file download is intended for small files; large uploads are packaged
  into a remote Downloads archive.

## Hosting Panels

- CyberPanel automation is CyberPanel-specific.
- cPanel, Plesk, DirectAdmin, CloudPanel, and RunCloud are not integrated.

## WordPress Compatibility

- Bedrock projects are the primary target.
- Standard WordPress layouts are supported for many operations.
- WordPress Multisite is not documented or tested as a supported workflow.

## Security Model

- SSH host key trust/known-host verification is fully enforced in SshPoolManager using fingerprints.
- External vulnerability-feed sync such as WPScan/CVE ingestion is not wired as
  a production feed.
- Treat hardening actions as operator-assisted workflows. Review each action
  before running it on production.

## Performance Audits

- Lighthouse runs locally with Chromium in the Docker image by default.
- Google PageSpeed API fallback is optional and quota-bound.
