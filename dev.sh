#!/bin/bash
# Bedrock Forge — Local Dev Launcher
set -euo pipefail

# Source helper routines
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/tools/setup-helpers.sh"

# Run Setup Doctor to validate environment prerequisites
"$SCRIPT_DIR/doctor.sh" development

echo "╔══════════════════════════════════════════╗"
echo "║   Bedrock Forge — Local Dev Launcher     ║"
echo "╚══════════════════════════════════════════╝"

# Generate environment configuration file (.env) with secure tokens if needed
generate_env_file

echo "Starting dev stack (Postgres + Redis + API + Worker + Web)…"
docker compose -f docker-compose.dev.yml up --build
