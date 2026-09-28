# Quick Start

Get Bedrock Forge running and connect your first WordPress site.

---

## Prerequisites

- Docker Engine 24+ and Docker Compose v2+
- `curl` installed (used by the health check in `install.sh`)
- A Linux server you can SSH into
- 2 GB RAM minimum on the machine running Bedrock Forge

---

## Step 1 — Install

```bash
git clone https://github.com/garamahq/bedrock-forge.git
cd bedrock-forge
./install.sh
```

`install.sh` does the following automatically:

1. Generates random secrets (`ENCRYPTION_KEY`, `JWT_SECRET`,
   `JWT_REFRESH_SECRET`, `POSTGRES_PASSWORD`, `REDIS_PASSWORD`) and writes them
   to `.env`
2. Runs `docker compose build`
3. Starts all services (`docker compose up -d`)
4. Waits for the API health check to pass (`/health`)
5. Seeds the database with roles, a randomly generated initial admin password, tags, and starter packages

**Duration:** ~2–4 minutes on first run (Docker build + image pull).

---

## Step 2 — Open the Dashboard

Navigate to **http://localhost:3002** in your browser.

### Login Screen
![Login Page](../assets/login.png)

Log in with the initial admin credentials printed once by `./install.sh`:

| Field    | Value                      |
| -------- | -------------------------- |
| Email    | `admin@bedrockforge.local` |
| Password | Generated randomly during setup |

Save the password when the installer prints it; it cannot be retrieved from the
database. Existing admin accounts are not reset when setup is run again.

Once authenticated, you will arrive at the main system dashboard, which displays a high-level summary of your servers, projects, monitoring alerts, and recent job activities.

### Dashboard Overview
![Dashboard Page](../assets/dashboard.png)

---

## Step 3 — Add Your First Server

1. Click **Servers** in the left sidebar
2. Click **Add Server**
3. Fill in:
   - **Name** — friendly label (e.g. `production-server`)
   - **IP address** — your server's public IP
   - **SSH port** — default `22`
   - **SSH user** — e.g. `root` or `deploy`
   - **SSH private key** — paste your private key (stored encrypted at rest)
   - **Passphrase** — if your key is passphrase-protected
4. Click **Save**

Bedrock Forge tests the SSH connection immediately. If it fails, check the IP, port, and key.

### Servers Page
![Servers Page](../assets/servers.png)

---

## Step 4 — Add Your First Project & Environment

1. Click **Projects** → **Add Project**
2. Fill in the project name and optionally link a client
3. Open the new project → **Environments** tab → **Add Environment**
4. Fill in:
   - **Type** — `production` (or whatever label makes sense)
   - **Server** — select the server you added in Step 3
   - **URL** — the WordPress site URL (e.g. `https://example.com`)
   - **Root path** — absolute path to the WordPress root on the server (e.g.
     `/home/example.com/public_html`)
   - **Backup path** — where backup archives are stored on the server (e.g.
     `/home/example.com/backups`)
5. Click **Save**

Bedrock Forge will attempt to read WordPress DB credentials from `wp-config.php` or Bedrock `.env` in the root path.

### Projects Page
![Projects Page](../assets/projects.png)

---

## Step 5 — Run Your First Backup

1. Open the project → **Backups** tab
2. Click **Create Backup**
3. Select backup type:
   - **Full** — database + files
   - **Database only** — mysqldump only
   - **Files only** — WordPress files, excluding database
4. Click **Start Backup**

Watch real-time progress in the execution log panel. The backup archive is saved
on the server at the configured backup path. If Google Drive is configured in
Settings, it is also uploaded automatically.

---

## Step 6 — Scan Plugins and Themes

1. Open the project -> **Plugins** tab
2. Click **Scan Plugins**

A minimal PHP script is pushed to the server and executed. Results appear within
seconds showing all installed plugins with name, version, and active/inactive
status.

Then open **Themes** and run a theme scan. Theme actions use WP-CLI on the
remote environment.

---

## Step 7 — Set Up Uptime Monitoring

1. Click **Monitors** in the left sidebar -> **Add Monitor**
2. Select the environment you want to monitor
3. Set the **interval** (default: 10 minutes)
4. Click **Enable**

The monitor will start checking immediately. You can view response time history and uptime percentage on the Monitor detail page.

### Uptime Monitors Page
![Monitors Page](../assets/monitors.png)

---

## What's Next

- Configure **backup schedules** from the project backup workflow.
- Add **Google Drive** credentials in **Settings -> Integrations** for off-site
  backup uploads.
- Add **Slack notifications** in **Settings -> Integrations** to get alerted on
  failures and outages.
- Configure **Settings -> Billing** if you need EUR, LYD, GBP, or another
  display currency.
- Use **Settings -> Plugins** for the custom GitHub plugin catalog and
  cross-environment installed plugin inventory.
- Run **Security** scans and schedules for servers and WordPress environments.
- Run **Lighthouse** audits to track performance scores.
- Add more servers, projects, and clients
- Invite team members via **Users & Roles** (admin only)

---

See [INSTALLATION.md](INSTALLATION.md) for setup details and
[../guides/USAGE.md](../guides/USAGE.md) for the full operator guide.
