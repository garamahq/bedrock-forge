#!/bin/bash
# Bedrock Forge — First-Time Setup
set -euo pipefail

# Source helper routines
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/tools/setup-helpers.sh"

# Run Setup Doctor to validate environment prerequisites
"$SCRIPT_DIR/doctor.sh"

echo "╔════════════════════════════════════════╗"
echo "║    Bedrock Forge — First-Time Setup    ║"
echo "╚════════════════════════════════════════╝"

# Generate environment configuration file (.env) with secure tokens
generate_env_file

# Validate the generated or existing configuration before building services.
"$SCRIPT_DIR/doctor.sh"

# ── Build & start services ────────────────────────────────────────────────────
echo "Building Docker images…"
docker compose build

echo "Starting all Docker containers…"
docker compose up -d

# ── Wait for backend API to become ready ──────────────────────────────────────
wait_for_api_healthy 3001 30

# ── Run database seed ─────────────────────────────────────────────────────────
echo "Seeding database with default configuration and admin user…"
bootstrap_admin_password="$(openssl rand -hex 24)"
seed_output="$(docker compose exec -T forge sh -c 'IFS= read -r ADMIN_BOOTSTRAP_PASSWORD; export ADMIN_BOOTSTRAP_PASSWORD; exec node prisma/seed.js' <<< "$bootstrap_admin_password")"
printf '%s\n' "$seed_output"

echo ""
echo "Setup complete!"
echo "   → http://localhost:3002"
if grep -q 'Admin users created:[[:space:]]*1' <<< "$seed_output"; then
  echo "   Admin: admin@bedrockforge.local"
  echo "   Initial password (shown once): $bootstrap_admin_password"
  echo "   Change this password after your first login."
else
  echo "   Existing admin account was kept unchanged."
fi
echo ""
echo "   Logs:    docker compose logs -f forge"
echo "   Update:  ./update.sh"
echo "   Reset:   ./reset.sh"
echo "   Stop:    docker compose down"
