#!/bin/bash
# deploy.sh — Build locally, ship images to server, deploy Bedrock Forge.
#
# Usage:
#   ./deploy.sh                # incremental deploy (build + push + restart)
#   ./deploy.sh --install      # force first-time setup even if .env exists
#   ./deploy.sh --cleanup-only # only run safe Docker disk cleanup on server
#   ./deploy.sh --build-only   # build images locally without deploying
#   ./deploy.sh --no-cache     # force a clean Docker build (ignore layer cache)
#   ./deploy.sh --skip-backup  # skip pre-deploy DB snapshot (use on first install)
#
# Deployment config is read from .env.deploy (copy from .env.deploy.example).
#
# HOW IT WORKS
# ────────────────────────────────────────────────────────────────────────────
#  1. Build `forge` and `web` Docker images on THIS machine (uses local CPU).
#  2. Stream each image to the server via:  docker save | gzip | ssh | docker load
#     No registry required; images travel directly over the existing SSH tunnel.
#  3. Server only runs `docker compose up` — zero build work on the VPS.
# Prevent concurrent deploy.sh runs from colliding
LOCK_FILE="/tmp/bedrock_forge_deploy.lock"
exec 200>"$LOCK_FILE"
if ! flock -n 200; then
  LOCK_PID=$(fuser "$LOCK_FILE" 2>/dev/null | tr -d ' ' || echo "unknown")
  echo -e "\033[0;31m✖  Another deployment (PID ${LOCK_PID}) is already running on this machine.\033[0m" >&2
  echo -e "\033[0;33mℹ  If this is an orphaned process, you can kill it with: kill -9 ${LOCK_PID}\033[0m" >&2
  exit 1
fi

# ── Load deployment config ────────────────────────────────────────────────────
if [[ ! -f .env.deploy ]]; then
  echo "ERROR: .env.deploy not found. Copy .env.deploy.example and fill in your values."
  exit 1
fi
# shellcheck source=.env.deploy.example
source .env.deploy

# Validate required vars
: "${SERVER_USER:?SERVER_USER must be set in .env.deploy}"
: "${SERVER_HOST:?SERVER_HOST must be set in .env.deploy}"
: "${SERVER_PATH:?SERVER_PATH must be set in .env.deploy}"
: "${DOMAIN:?DOMAIN must be set in .env.deploy}"

CORS_ORIGIN="$DOMAIN"
REMOTE_CORS_ORIGIN=$(printf '%q' "$CORS_ORIGIN")

# Build customization
INSTALL_CHROMIUM="${INSTALL_CHROMIUM:-true}"

# ── Image tag (defaults to git short-sha for reproducibility) ─────────────────
# If the working tree is dirty, include a timestamp suffix so an uncommitted
# hotfix never reuses an already-loaded remote image tag.
if [[ -z "${IMAGE_TAG:-}" ]]; then
  BASE_IMAGE_TAG="$(git rev-parse --short HEAD 2>/dev/null || echo "latest")"
  if [[ -n "$(git status --porcelain=v1 2>/dev/null)" ]]; then
    IMAGE_TAG="${BASE_IMAGE_TAG}-dirty-$(date -u +%Y%m%d%H%M%S)"
  else
    IMAGE_TAG="${BASE_IMAGE_TAG}"
  fi
fi
FORGE_IMAGE="bedrock-forge/forge:${IMAGE_TAG}"
WEB_IMAGE="bedrock-forge/web:${IMAGE_TAG}"

# ── Colour helpers ────────────────────────────────────────────────────────────
ok()    { echo -e "\033[0;32m✔  $*\033[0m"; }
info()  { echo -e "\033[0;36mℹ  $*\033[0m"; }
warn()  { echo -e "\033[0;33m⚠  $*\033[0m"; }
err()   { echo -e "\033[0;31m✖  $*\033[0m" >&2; exit 1; }
step()  { echo -e "\033[1;35m▶  $*\033[0m"; }

# ── Argument parsing ──────────────────────────────────────────────────────────
FORCE_INSTALL=false
CLEANUP_ONLY=false
BUILD_ONLY=false
NO_CACHE=""
SKIP_BACKUP=false
AUTO_YES=false
for arg in "$@"; do
  case "$arg" in
    --install)      FORCE_INSTALL=true ;;
    --cleanup-only) CLEANUP_ONLY=true ;;
    --build-only)   BUILD_ONLY=true ;;
    --no-cache)     NO_CACHE="--no-cache" ;;
    --skip-backup)  SKIP_BACKUP=true ;;
    -y|--yes)       AUTO_YES=true ;;
    *) err "Unknown argument: $arg" ;;
  esac
done

echo ""
echo "╔════════════════════════════════════════════╗"
echo "║    Bedrock Forge — Production Deploy        ║"
echo "╚════════════════════════════════════════════╝"
echo ""
info "Target    : ${SERVER_USER}@${SERVER_HOST}:${SERVER_PATH}"
info "Domain    : ${DOMAIN}"
info "Image tag : ${IMAGE_TAG}"
echo ""

# ── Local git state check ─────────────────────────────────────────────────────
if [[ "$BUILD_ONLY" == "false" && "$CLEANUP_ONLY" == "false" ]]; then
  if ! git diff-index --quiet HEAD --; then
    warn "You have uncommitted changes in your git repository. Deploying tag: ${IMAGE_TAG}"
    if [[ "$AUTO_YES" == "true" ]]; then
      info "Auto-confirming deployment (-y / --yes flag provided)."
    elif [ -t 0 ]; then
      read -t 30 -p "Do you want to continue? (y/N) " -n 1 -r || REPLY="n"
      echo ""
      if [[ ! ${REPLY:-} =~ ^[Yy]$ ]]; then
        err "Deployment aborted by user (or timed out)."
      fi
    else
      warn "Stdin is not a TTY. Proceeding anyway..."
    fi
  fi
fi

# ── Local prerequisites ───────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || err "docker is not installed locally."
command -v rsync  >/dev/null 2>&1 || err "rsync is not installed locally."
command -v ssh    >/dev/null 2>&1 || err "ssh is not installed locally."

STRICT_HOST_KEY_CHECKING="${STRICT_HOST_KEY_CHECKING:-accept-new}"
SSH_OPTS=(-o ConnectTimeout=10 -o BatchMode=yes -o StrictHostKeyChecking="${STRICT_HOST_KEY_CHECKING}" -o ServerAliveInterval=30 -o ServerAliveCountMax=6)

# ── Remote Docker cleanup helper ─────────────────────────────────────────────
run_remote_cleanup() {
  local skip_cleanup="${DEPLOY_SKIP_DOCKER_CLEANUP:-false}"
  local builder_until="${DEPLOY_DOCKER_BUILDER_PRUNE_UNTIL:-168h}"
  local keep_image_versions="${DEPLOY_KEEP_IMAGE_VERSIONS:-3}"
  # shellcheck disable=SC2029
  ssh "${SSH_OPTS[@]}" "${SERVER_USER}@${SERVER_HOST}" bash <<ENDCLEAN
set -euo pipefail
cd "${SERVER_PATH}"
SKIP_CLEANUP=${skip_cleanup@Q}
BUILDER_UNTIL=${builder_until@Q}
KEEP_IMAGE_VERSIONS=${keep_image_versions@Q}

if [[ "\$SKIP_CLEANUP" == "true" ]]; then
  echo "Docker cleanup skipped (DEPLOY_SKIP_DOCKER_CLEANUP=true)."
  exit 0
fi

command -v docker >/dev/null 2>&1 || { echo "ERROR: Docker not installed on server."; exit 1; }

echo "Docker disk usage before cleanup:"
docker system df || true
echo ""
if [[ ! "\$KEEP_IMAGE_VERSIONS" =~ ^[1-9][0-9]*\$ ]]; then
  echo "ERROR: DEPLOY_KEEP_IMAGE_VERSIONS must be a positive integer." >&2
  exit 1
fi
echo "Retaining the newest \$KEEP_IMAGE_VERSIONS image versions per Forge repository..."
for repository in bedrock-forge/forge bedrock-forge/web; do
  docker image ls --filter "reference=\${repository}:*" --format '{{.ID}}' \
    | awk -v keep="\$KEEP_IMAGE_VERSIONS" '!seen[\$0]++ && ++count > keep { print }' \
    | xargs -r docker image rm || true
done
docker image prune -f || true
echo ""
echo "Removing builder cache older than \$BUILDER_UNTIL..."
docker builder prune -f --filter "until=\$BUILDER_UNTIL" || true
echo ""
echo "Docker disk usage after cleanup:"
docker system df || true
ENDCLEAN
}

# ── Cleanup-only mode ─────────────────────────────────────────────────────────
if [[ "$CLEANUP_ONLY" == "true" ]]; then
  info "Testing SSH connection…"
  ssh "${SSH_OPTS[@]}" "${SERVER_USER}@${SERVER_HOST}" "echo connected" \
    >/dev/null 2>&1 || err "Cannot connect to ${SERVER_USER}@${SERVER_HOST}."
  ok "SSH OK"
  info "Running safe Docker cleanup only…"
  run_remote_cleanup
  ok "Docker cleanup finished"
  exit 0
fi

# ── Step 1: Build images LOCALLY ─────────────────────────────────────────────
step "Building images locally (your CPU, not the server's)…"
echo ""

# Build forge (runtime) target
info "Building forge image → ${FORGE_IMAGE}"
# shellcheck disable=SC2086
docker build \
  ${NO_CACHE} \
  --build-arg INSTALL_CHROMIUM="${INSTALL_CHROMIUM}" \
  --target runtime \
  --tag "${FORGE_IMAGE}" \
  --tag "bedrock-forge/forge:latest" \
  --label "git.sha=${IMAGE_TAG}" \
  --label "built.at=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  .
ok "forge image built"

# Build web (nginx) target — reuses the cached builder layer from above
info "Building web image   → ${WEB_IMAGE}"
# shellcheck disable=SC2086
docker build \
  ${NO_CACHE} \
  --target web \
  --tag "${WEB_IMAGE}" \
  --tag "bedrock-forge/web:latest" \
  --label "git.sha=${IMAGE_TAG}" \
  --label "built.at=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  .
ok "web image built"

echo ""
info "Local image sizes:"
docker image ls --format "  {{.Repository}}:{{.Tag}}  {{.Size}}" \
  | grep "bedrock-forge/" || true
echo ""

# Exit here if --build-only
if [[ "$BUILD_ONLY" == "true" ]]; then
  ok "Build-only mode — skipping deploy"
  exit 0
fi

# ── Step 2: Test SSH connectivity ─────────────────────────────────────────────
step "Connecting to server…"
ssh "${SSH_OPTS[@]}" "${SERVER_USER}@${SERVER_HOST}" "echo connected" \
  >/dev/null 2>&1 || err "Cannot connect to ${SERVER_USER}@${SERVER_HOST}. Check SSH keys / firewall."
ok "SSH connection OK"

# Free old commit-tagged images before uploading another multi-GB runtime image.
# Running cleanup only after health succeeds can deadlock deployment when Redis
# loses write access because the root filesystem is already full.
step "Pre-deploy disk cleanup and capacity check…"
run_remote_cleanup
REMOTE_FREE_KB=$(ssh "${SSH_OPTS[@]}" "${SERVER_USER}@${SERVER_HOST}" "df -Pk '${SERVER_PATH}' | awk 'NR==2 {print \$4}'")
MIN_FREE_KB=$((3 * 1024 * 1024))
if [[ ! "$REMOTE_FREE_KB" =~ ^[0-9]+$ ]] || (( REMOTE_FREE_KB < MIN_FREE_KB )); then
  err "Server has less than 3 GiB free after cleanup; refusing to upload deployment images."
fi
ok "Remote disk has sufficient free space"

# ── Step 3: Sync config / compose files (NOT source code) ────────────────────
step "Syncing compose files and config to server…"
rsync -az --delete \
  --include='docker-compose.yml' \
  --include='nginx/' \
  --include='nginx/**' \
  --include='.env.example' \
  --include='entrypoint.sh' \
  --exclude='*' \
  -e "ssh -o StrictHostKeyChecking=${STRICT_HOST_KEY_CHECKING}" \
  ./ "${SERVER_USER}@${SERVER_HOST}:${SERVER_PATH}/"
ok "Config synced"

# ── Step 4: Stream images to server via SSH pipe ──────────────────────────────
# docker save | pigz/gzip | ssh | docker load
# Gzip reduces ~40-60% of image data over the wire. No registry needed.
# pigz uses all CPU cores; pv shows transfer progress so the step never looks frozen.
# We skip the upload entirely when the image tag already exists on the server.
step "Shipping images to server (streaming via SSH)…"
echo ""

# Pick the fastest available compressor (pigz >> gzip)
if command -v pigz &>/dev/null; then
  COMPRESS_CMD="pigz -1"
  DECOMPRESS_CMD="pigz -d"
else
  COMPRESS_CMD="gzip -1"
  DECOMPRESS_CMD="gzip -d"
fi

# Pick a progress tool if available
if command -v pv &>/dev/null; then
  PROGRESS_PIPE="pv -pterb"
else
  PROGRESS_PIPE="cat"
fi

# Helper: upload one image. By default this overwrites the remote tag with the
# local build unless DEPLOY_SKIP_EXISTING_IMAGE_UPLOAD is true.
ship_image() {
  local image="$1"
  local label="$2"

  if [[ "${DEPLOY_SKIP_EXISTING_IMAGE_UPLOAD:-true}" == "true" ]]; then
    if ssh "${SSH_OPTS[@]}" "${SERVER_USER}@${SERVER_HOST}" \
         "docker image inspect '${image}' > /dev/null 2>&1"; then
      ok "${label} already exists on server — skipping upload"
      return 0
    fi
  fi

  info "Uploading ${label} (${image}) via ${COMPRESS_CMD} over SSH…"
  docker save "${image}" \
    | ${COMPRESS_CMD} \
    | ${PROGRESS_PIPE} \
    | ssh "${SSH_OPTS[@]}" "${SERVER_USER}@${SERVER_HOST}" \
        "${DECOMPRESS_CMD} | docker load"
  ok "${label} loaded on server"
}

# Upload sequentially so progress display renders cleanly and network upload is dedicated
ship_image "${WEB_IMAGE}"   "web image"
ship_image "${FORGE_IMAGE}" "forge image"
echo ""

# ── Step 5: Remote deploy (compose up only — no build) ───────────────────────
step "Running remote deployment steps…"
# shellcheck disable=SC2029
ssh "${SSH_OPTS[@]}" "${SERVER_USER}@${SERVER_HOST}" bash <<ENDSSH
set -euo pipefail
cd "${SERVER_PATH}"
CORS_ORIGIN=${REMOTE_CORS_ORIGIN}
IMAGE_TAG=${IMAGE_TAG@Q}

set_env_value() {
  local key="\$1"
  local value="\$2"
  local file="\${3:-.env}"
  local temp_file="\${file}.tmp"

  local found=false
  if [[ -f "\$file" ]]; then
    while IFS= read -r line || [[ -n "\$line" ]]; do
      if [[ "\$line" == "\${key}"=* ]]; then
        printf '%s\n' "\${key}=\${value}"
        found=true
      else
        printf '%s\n' "\$line"
      fi
    done < "\$file" > "\$temp_file"
    mv "\$temp_file" "\$file"
  fi

  if [[ "\$found" = false ]]; then
    printf '%s\n' "\${key}=\${value}" >> "\$file"
  fi
}

# ── Verify Docker is available on the server ──────────────────────────────────
command -v docker >/dev/null 2>&1 || { echo "ERROR: Docker not installed on server."; exit 1; }

# ── First-time install vs incremental update ──────────────────────────────────
if [[ ! -f .env ]] || [[ "${FORCE_INSTALL}" == "true" ]]; then
  echo ">>> First-time install (or --install flag set)"
  if [[ ! -f .env.example ]]; then
    echo "ERROR: .env.example not found in ${SERVER_PATH}"
    exit 1
  fi
  cp .env.example .env

  # Generate secrets
  ENCRYPTION_KEY=\$(openssl rand -hex 32)
  JWT_SECRET=\$(openssl rand -hex 32)
  JWT_REFRESH_SECRET=\$(openssl rand -hex 32)
  POSTGRES_PASSWORD=\$(openssl rand -hex 16)
  REDIS_PASSWORD=\$(openssl rand -hex 16)

  set_env_value ENCRYPTION_KEY "\$ENCRYPTION_KEY"
  set_env_value JWT_SECRET "\$JWT_SECRET"
  set_env_value JWT_REFRESH_SECRET "\$JWT_REFRESH_SECRET"
  set_env_value POSTGRES_PASSWORD "\$POSTGRES_PASSWORD"
  set_env_value REDIS_PASSWORD "\$REDIS_PASSWORD"
  set_env_value CORS_ORIGIN "\$CORS_ORIGIN"
  set_env_value IMAGE_TAG "\$IMAGE_TAG"
  set_env_value NODE_ENV production

  echo "Secrets generated and written to .env"

  # Pull infrastructure images, bring everything up.
  # forge/web images are already loaded — compose uses the image: field.
  docker compose pull postgres redis || true
  if ! docker compose up -d --remove-orphans; then
    echo "ERROR: docker compose up failed. Forge logs:"
    docker compose logs --tail=100 forge
    exit 1
  fi

else
  echo ">>> Incremental update"

  # Back up existing config
  cp .env .env.bak

  PREV_TAG=""
  if [[ -f .env ]]; then
    PREV_TAG=$(grep "^IMAGE_TAG=" .env | cut -d= -f2 || echo "")
  fi

  # Auto backup database before migration
  if docker compose ps postgres 2>/dev/null | grep -q "Up"; then
    if [[ "${SKIP_BACKUP}" == "true" ]]; then
      echo ">>> Pre-deployment database snapshot SKIPPED (--skip-backup)."
    else
      echo ">>> Creating pre-deployment database snapshot..."
      mkdir -p backups/pre-deploy
      BACKUP_FILE="backups/pre-deploy/db_pre_deploy_\${IMAGE_TAG}_\$(date +%Y%m%d_%H%M%S).sql"

      # Read the actual configured user and database — never assume defaults.
      _PG_USER=\$(grep "^POSTGRES_USER=" .env | cut -d= -f2- | tr -d '"' || echo "forge")
      _PG_DB=\$(grep  "^POSTGRES_DB="   .env | cut -d= -f2- | tr -d '"' || echo "bedrock_forge")

      if docker compose exec -T postgres pg_dump -U "\${_PG_USER:-forge}" "\${_PG_DB:-bedrock_forge}" > "\$BACKUP_FILE" 2>/dev/null; then
        echo "Pre-deployment database snapshot written to \$BACKUP_FILE"
      else
        # Non-zero exit on backup failure. If you intentionally want to skip the
        # backup (e.g. first deploy to an empty DB), pass --skip-backup.
        echo "ERROR: Pre-deployment database snapshot failed. Use --skip-backup to bypass." >&2
        rm -f "\$BACKUP_FILE"
        exit 1
      fi
    fi
  fi

  # Update dynamic env vars
  set_env_value CORS_ORIGIN "\$CORS_ORIGIN"
  set_env_value IMAGE_TAG "\$IMAGE_TAG"

  # Ensure infra services are running (no-op if already healthy)
  docker compose up -d postgres redis

  # Restart forge with the new image (no build — image is already loaded)
  if ! docker compose up -d --force-recreate --no-deps forge; then
    echo "ERROR: forge failed to start. Logs:"
    docker compose logs --tail=100 forge
    echo "Restoring previous configuration..."
    mv .env.bak .env
    exit 1
  fi
  if ! docker compose up -d --remove-orphans; then
    echo "ERROR: docker compose up (all services) failed. Forge logs:"
    docker compose logs --tail=100 forge
    echo "Restoring previous configuration..."
    mv .env.bak .env
    exit 1
  fi
fi

# ── Wait for the API to report healthy ────────────────────────────────────────
echo "Waiting for Forge API to become healthy (up to 3 min)…"
RETRIES=60
HEALTHY=false
until curl -sf http://localhost:3001/health > /dev/null 2>&1; do
  RETRIES=\$((RETRIES - 1))
  if [ "\${RETRIES}" -le 0 ]; then
    break
  fi
  sleep 3
done

if curl -sf http://localhost:3001/health > /dev/null 2>&1; then
  HEALTHY=true
fi

if [ "\$HEALTHY" = false ]; then
  echo "ERROR: Forge API did not become healthy in time."
  echo "=== forge container logs (last 80 lines) ==="
  docker compose logs --tail=80 forge
  echo "=== forge container status ==="
  docker compose ps forge

  if [[ -f .env.bak && -n "\${PREV_TAG:-}" && "\$PREV_TAG" != "\$IMAGE_TAG" ]]; then
    echo ">>> ROLLING BACK to last known healthy tag: \$PREV_TAG"
    mv .env.bak .env
    docker compose up -d --force-recreate --no-deps forge
    docker compose up -d --remove-orphans
    echo "Rollback complete. Verifying health of rolled-back container..."
    RETRIES=60
    until curl -sf http://localhost:3001/health > /dev/null 2>&1; do
      RETRIES=\$((RETRIES - 1))
      if [ "\${RETRIES}" -le 0 ]; then
        echo "CRITICAL ERROR: Rolled back container also failed health checks!"
        exit 1
      fi
      sleep 3
    done
    echo "Rollback successful. System is healthy under tag: \$PREV_TAG."
  fi
  exit 1
fi

echo ""
echo "Deployment complete."
echo "   API  → http://localhost:3001  (proxied via nginx as ${DOMAIN}/api)"
echo "   Web  → http://localhost:3002  (proxied via nginx as ${DOMAIN})"
echo ""
echo "   Live logs : docker compose logs -f forge"
ENDSSH

# ── Step 6: Remote cleanup (dangling images from prior deploys) ───────────────
info "Running safe Docker cleanup on server…"
run_remote_cleanup

ok "Deployment finished"
echo ""
echo "   Production URL → ${DOMAIN}"
echo "   Image tag      → ${IMAGE_TAG}"
echo ""
