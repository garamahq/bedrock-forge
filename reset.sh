#!/bin/bash
# Bedrock Forge — Reset
set -euo pipefail

# Source helper routines
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/tools/setup-helpers.sh"

echo "╔════════════════════════════════════════╗"
echo "║      Bedrock Forge — Reset             ║"
echo "╚════════════════════════════════════════╝"
echo ""
echo "WARNING: This will permanently destroy ALL data (postgres + redis volumes)."
echo "         The database will be recreated and re-seeded from scratch."
echo ""

# ── Confirm ───────────────────────────────────────────────────────────────────
read -r -p "Type 'yes' to continue: " CONFIRM
if [ "$CONFIRM" != "yes" ]; then
  echo "Aborted."
  exit 0
fi

# Run Setup Doctor to validate environment prerequisites
"$SCRIPT_DIR/doctor.sh"

# ── Stop all services and remove volumes ─────────────────────────────────────
echo "Stopping services and removing volumes…"
docker compose down -v --remove-orphans

# ── Regenerate secrets (fresh install) ───────────────────────────────────────
echo "Regenerating secrets in .env…"
if [ -f .env ]; then
  rm -f .env
fi
generate_env_file
"$SCRIPT_DIR/doctor.sh"

# ── Build & start ─────────────────────────────────────────────────────────────
echo "Building image…"
docker compose build

echo "Starting services…"
docker compose up -d

# ── Wait for API to be healthy ────────────────────────────────────────────────
wait_for_api_healthy 3001 40

# ── Seed ──────────────────────────────────────────────────────────────────────
echo "Seeding database…"
bootstrap_admin_password="$(openssl rand -hex 24)"
docker compose exec -T forge sh -c 'IFS= read -r ADMIN_BOOTSTRAP_PASSWORD; export ADMIN_BOOTSTRAP_PASSWORD; exec node prisma/seed.js' <<< "$bootstrap_admin_password"

echo ""
echo "Reset complete. Fresh installation ready."
echo "   → http://localhost:3001"
echo "   Admin: admin@bedrockforge.local"
echo "   Initial password (shown once): $bootstrap_admin_password"
echo "   Change this password after your first login."
echo ""
echo "   NOTE: All previous data, sessions, and SSH keys have been wiped."
echo "         Encryption key has been rotated — re-enter any stored credentials."
