# Deployment Guide

---

## Server Requirements

Bedrock Forge runs on any VPS or dedicated server meeting the following
requirements:

| Resource       | Minimum                    | Recommended  |
| -------------- | -------------------------- | ------------ |
| CPU            | 1 vCPU                     | 2 vCPU       |
| RAM            | 2 GB                       | 4 GB         |
| Disk           | 10 GB                      | 40 GB SSD    |
| OS             | Ubuntu 22.04+ / Debian 12+ | Ubuntu 24.04 |
| Docker         | 24+                        | latest       |
| Docker Compose | v2+                        | v2.20+       |

**Additional disk space** is needed for backup archives on the Bedrock Forge
server itself (if using local staging before Google Drive upload). Estimate 2–3×
the total size of all managed WordPress sites for comfortable headroom.

---

## First-Time Remote Deployment

Use `deploy.sh` to push the project to a remote server and run the install:

```bash
# Copy deployment target settings and edit the values
cp .env.deploy.example .env.deploy
${EDITOR:-vi} .env.deploy

# First deployment
./deploy.sh --install
```

`deploy.sh` reads the target from `.env.deploy`, builds the `forge` and `web`
images on the local machine, and streams them to the server over SSH. The
server does not build the application and no container registry is required.
It syncs only Compose, nginx, and runtime config files; application source code
is included in the built images. On first install it creates `.env`, generates
the encryption/JWT/database/Redis secrets, and starts the Compose stack.
Use `--install` only for a genuinely new installation: it regenerates secrets
and must not be run against an existing database.

Prerequisites on the local machine:

- Docker Engine, `rsync`, and `ssh`
- SSH key authentication to the deployment target
- At least 3 GiB of free disk space on the target after safe image cleanup

The target needs Docker Engine and Compose v2. The script checks SSH and disk
capacity before sending images. After deployment it waits for the API health
endpoint, reports the image tag, and safely prunes old images and builder cache.

---

## Installing Docker on the Target Server

```bash
# Ubuntu/Debian
curl -fsSL https://get.docker.com | sh
systemctl enable --now docker

# Verify
docker --version
docker compose version
```

---

## Incremental Updates

After the initial install, use the same script to build and deploy an update:

```bash
./deploy.sh
```

An incremental deploy:

1. Builds and streams the two tagged images from the local machine.
2. Creates a PostgreSQL pre-deploy snapshot under
   `backups/pre-deploy/` before the migration unless `--skip-backup` is passed.
3. Updates the image tag and recreates `forge` and `web`; PostgreSQL and Redis
   stay on their existing volumes.
4. Waits up to three minutes for `/health`. If the new API does not become
   healthy, the script restores the previous image tag and attempts a rollback.
5. Cleans unused images and old builder cache after health succeeds.

The deployment database snapshot is stored on the target host. Copy it to
separate storage for disaster recovery; image cleanup does not delete backup
files or Docker volumes. Avoid `--skip-backup` for routine updates.

Useful modes:

```bash
./deploy.sh --build-only  # Build images without SSH or deployment
./deploy.sh --no-cache    # Rebuild without Docker layer cache
./deploy.sh --cleanup-only # Safe remote image/cache cleanup only
```

Cleanup controls:

```bash
DEPLOY_SKIP_DOCKER_CLEANUP=true ./deploy.sh
DEPLOY_DOCKER_BUILDER_PRUNE_UNTIL=72h ./deploy.sh
./deploy.sh --cleanup-only
```

Cleanup never prunes Docker volumes. Do not run `docker volume prune` unless you
have separately backed up PostgreSQL and Redis volumes.

---

## Manual Deployment

If you prefer full control:

```bash
# On the target server:
git clone https://github.com/garamahq/bedrock-forge.git /home/forge
cd /home/forge
./install.sh
```

For subsequent updates:

```bash
cd /home/forge
git pull
./update.sh
```

---

## Setting Up a Custom Domain with SSL

1. Point your domain's DNS `A` record to the server IP
2. Install Certbot:
   ```bash
   apt install certbot python3-certbot-nginx
   ```
3. Obtain a certificate:
   ```bash
   certbot certonly --standalone -d forge.example.com
   ```
4. Configure nginx as the HTTPS frontend (see
   [Installation — Running Behind a Reverse Proxy](../getting-started/INSTALLATION.md#running-behind-a-reverse-proxy))
5. Set `CORS_ORIGIN=https://forge.example.com` in `/home/forge/.env`
6. Restart the forge container:
   ```bash
   cd /home/forge
   docker compose restart forge
   ```

### Auto-renew SSL

Certbot installs a systemd timer automatically. Verify:

```bash
systemctl list-timers | grep certbot
```

---

## Production Environment Variables

On first-time setup via `deploy.sh --install`, secrets are auto-generated. For
manual configuration, the critical production values to set in `.env`:

```env
NODE_ENV=production
CORS_ORIGIN=https://forge.example.com
API_PORT=3000
LIGHTHOUSE_PROVIDER=auto
LIGHTHOUSE_CHROME_PATH=/usr/bin/chromium-browser
```

All secrets (encryption key, JWT secrets, database password, redis password) are
generated by `install.sh`. Do not regenerate `ENCRYPTION_KEY` after any sites
have been added — all stored credentials will become unreadable.

`LIGHTHOUSE_PROVIDER=auto` runs local Chromium-based Lighthouse first and only
uses Google PageSpeed when local Lighthouse is unavailable and `PAGESPEED_API_KEY`
is configured. Use `LIGHTHOUSE_PROVIDER=local` to avoid PageSpeed daily quota
entirely.

---

## Monitoring the Deployment

```bash
# Tail all service logs on the server
cd /home/forge
docker compose logs -f

# Tail only the API/worker
docker compose logs -f forge

# Check service health
docker compose ps

# Check API health endpoint
curl http://localhost:3001/health
```

The API exposes a health endpoint at `GET /health` which returns
`{ status: "ok" }` when all services (database, redis) are connected. Docker
Compose health checks use this endpoint.

---

## Backup Strategy for the Platform Itself

The Bedrock Forge database contains all managed site credentials, backup
records, and configuration. Back it up regularly:

```bash
# Dump the postgres database
docker compose exec postgres pg_dump -U forge forge > forge-db-backup-$(date +%Y%m%d).sql

# Copy the dump off the server
scp root@your-server:/home/forge/forge-db-backup-*.sql ./
```

Also back up the `.env` file — it contains the `ENCRYPTION_KEY` which is
required to decrypt all stored credentials.

```bash
# Secure copy of .env (never commit this to git)
scp root@your-server:/home/forge/.env ./forge.env.backup
```

---

## Scaling Considerations

The default Docker Compose file is a single-machine deployment. For higher
capacity:

- **Backup storage:** Mount an NFS volume or S3-compatible filesystem at
  `BACKUP_STORAGE_PATH` to avoid filling the local disk
- **PostgreSQL:** For larger installations, migrate to a managed database
  (managed PostgreSQL) by updating `DATABASE_URL`
- **Redis:** Use a managed Redis (Upstash, Redis Cloud) by updating `REDIS_URL`
- **Worker concurrency:** Adjust concurrency settings per queue in
  `apps/worker/src/worker.module.ts` based on available RAM and managed server
  count
- **SSH pool:** Default max connections per server is 15 — tunable in
  `packages/remote-executor/src/ssh-pool.manager.ts`

---

## Rollback

If health verification fails, `deploy.sh` attempts to restore the previous
image tag automatically. For a manual rollback, inspect the retained image tags
and the previous environment file on the server, then restore the previous
`IMAGE_TAG` before recreating the app services:

```bash
cd /home/forge

# Find available tagged images
docker image ls 'bedrock-forge/forge'
docker image ls 'bedrock-forge/web'

# Restore the previous IMAGE_TAG in .env, then recreate both app services.
# The deployment script keeps the preceding environment file as .env.bak.
cp .env.bak .env
docker compose up -d --force-recreate forge web
curl -fsS http://localhost:3001/health

# If the migration needs reverting, restore from database backup
```

> Prisma migrations are forward-only by default. Routine `deploy.sh` updates
> create a pre-deploy PostgreSQL dump automatically. Preserve that dump before
> attempting a database rollback.

---

## Firewall Configuration

Only expose what is needed:

```bash
# Allow SSH, HTTP, HTTPS
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp

# The forge containers (postgres:5432, redis:6379, node:3000/3002) must NOT be
# exposed publicly — they bind to localhost inside Docker's bridge network

ufw enable
```

If using a cloud provider, configure the firewall at the provider level as well.
