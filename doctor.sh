#!/bin/bash
# Bedrock Forge — Setup Doctor
# Validates system prerequisites (Docker, Node, ports, env) before running the application.

set -euo pipefail

echo "========================================="
echo "   Bedrock Forge — Setup Doctor"
echo "========================================="

errors=0
warnings=0
mode="${1:-production}"

check_node_version() {
  if command -v node >/dev/null 2>&1; then
    local version
    version=$(node -v | cut -d'v' -f2)
    local major
    major=$(echo "$version" | cut -d'.' -f1)
    if [ "$major" -lt 22 ]; then
      echo "⚠ Node.js v$version is below 22; host Node.js is only needed for local package commands."
      warnings=$((warnings + 1))
    else
      echo "✓ Node.js v$version detected (>= 22)"
    fi
  else
    echo "ℹ Node.js is not installed on the host; Docker builds provide Node.js."
  fi
}

check_pnpm_version() {
  if ! command -v pnpm >/dev/null 2>&1; then
    echo "ℹ pnpm is not installed on the host; it is only needed for local package commands."
    return
  fi
  local version major
  version=$(pnpm --version)
  major=${version%%.*}
  if ! [[ "$major" =~ ^[0-9]+$ ]] || [ "$major" -lt 9 ]; then
    echo "⚠ pnpm $version is below 9; use pnpm 9+ for package commands."
    warnings=$((warnings + 1))
  else
    echo "✓ pnpm $version detected (>= 9)"
  fi
}

check_openssl() {
  if command -v openssl >/dev/null 2>&1; then
    echo "✓ openssl is installed"
  else
    echo "✗ ERROR: openssl is required for generating security credentials but is not installed."
    errors=$((errors + 1))
  fi
}

check_docker_daemon() {
  if command -v docker >/dev/null 2>&1; then
    if ! docker info >/dev/null 2>&1; then
      echo "✗ ERROR: Docker CLI is installed, but the Docker daemon is not running."
      errors=$((errors + 1))
    else
      echo "✓ Docker daemon is running"
    fi
  else
    echo "✗ ERROR: Docker is not installed."
    errors=$((errors + 1))
  fi
}

check_compose() {
  if ! command -v docker >/dev/null 2>&1; then
    return
  fi
  if docker compose version >/dev/null 2>&1; then
    echo "✓ Docker Compose v2 is available"
  else
    echo "✗ ERROR: Docker Compose v2 is required (run 'docker compose version')."
    errors=$((errors + 1))
  fi
}

check_env_file() {
  if [ ! -f .env ]; then
    echo "ℹ .env does not exist yet; run the setup script to generate it."
    return
  fi

  local failed=0
  local database_url redis_url jwt_secret jwt_refresh_secret encryption_key
  env_value() {
    awk -F= -v key="$1" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' .env |
      sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
  }
  database_url=$(env_value DATABASE_URL)
  redis_url=$(env_value REDIS_URL)
  jwt_secret=$(env_value JWT_SECRET)
  jwt_refresh_secret=$(env_value JWT_REFRESH_SECRET)
  encryption_key=$(env_value ENCRYPTION_KEY)

  for key in DATABASE_URL REDIS_URL POSTGRES_PASSWORD REDIS_PASSWORD JWT_SECRET JWT_REFRESH_SECRET ENCRYPTION_KEY CORS_ORIGIN; do
    value="$(env_value "$key")"
    if [ -z "$value" ]; then
      echo "✗ ERROR: $key is missing or empty in .env."
      failed=1
    elif [[ "$value" =~ change_me|forge_password|dev-|test- ]]; then
      echo "✗ ERROR: $key still contains a template or development value."
      failed=1
    fi
  done
  if ! [[ "$encryption_key" =~ ^[a-fA-F0-9]{64}$ ]]; then
    echo "✗ ERROR: ENCRYPTION_KEY must be exactly 64 hexadecimal characters."
    failed=1
  fi
  if [ "${#jwt_secret}" -lt 32 ] || [ "${#jwt_refresh_secret}" -lt 32 ]; then
    echo "✗ ERROR: JWT_SECRET and JWT_REFRESH_SECRET must each be at least 32 characters."
    failed=1
  fi
  if [ -n "$jwt_secret" ] && [ "$jwt_secret" = "$jwt_refresh_secret" ]; then
    echo "✗ ERROR: JWT_SECRET and JWT_REFRESH_SECRET must be different."
    failed=1
  fi
  case "$database_url" in postgresql://*|postgres://*) ;; *) echo "✗ ERROR: DATABASE_URL must be a PostgreSQL URL."; failed=1 ;; esac
  case "$redis_url" in redis://*|rediss://*) ;; *) echo "✗ ERROR: REDIS_URL must be a Redis URL."; failed=1 ;; esac

  if [ "$failed" -eq 0 ]; then
    echo "✓ .env required values and secret formats are valid"
  else
    errors=$((errors + 1))
  fi
}

check_port() {
  local port="$1"
  local service_name="$2"
  if command -v node >/dev/null 2>&1; then
    if ! node -e "require('net').createServer().listen($port, '127.0.0.1', () => process.exit(0)).on('error', () => process.exit(1))" >/dev/null 2>&1; then
      echo "✗ WARNING: Port $port ($service_name) is already in use by another process."
      warnings=$((warnings + 1))
      return 1
    fi
  else
    # Fallback to python3
    if command -v python3 >/dev/null 2>&1; then
      if ! python3 -c "import socket; s = socket.socket(); s.bind(('127.0.0.1', $port))" >/dev/null 2>&1; then
        echo "✗ WARNING: Port $port ($service_name) is already in use by another process."
        warnings=$((warnings + 1))
        return 1
      fi
    else
      # Fallback to ss
      if command -v ss >/dev/null 2>&1; then
        if ss -tln | grep -qE ":$port\b"; then
          echo "✗ WARNING: Port $port ($service_name) is already in use by another process."
          warnings=$((warnings + 1))
          return 1
        fi
      fi
    fi
  fi
  echo "✓ Port $port ($service_name) is available"
  return 0
}

# 1. Check tool dependencies
echo ""
echo "--- Checking Dependencies ---"
check_node_version || true
check_pnpm_version || true
check_openssl || true
check_docker_daemon || true
check_compose || true

# 2. Validate .env without sourcing or executing it as shell code.
echo ""
echo "--- Checking Configuration ---"
check_env_file || true

# 3. Check the host ports published by the selected Compose profile.
echo ""
echo "--- Checking Port Conflicts ---"
if [ "$mode" = "development" ]; then
  check_port 5432 "PostgreSQL Database" || true
  check_port 6379 "Redis Queue" || true
  check_port 3000 "Forge API" || true
  check_port 5173 "Vite Web Client" || true
elif [ "$mode" = "production" ]; then
  check_port 3001 "Forge API" || true
  check_port 3002 "Forge Web Client" || true
else
  echo "✗ ERROR: Usage: doctor.sh [production|development]"
  errors=$((errors + 1))
fi

# 4. Summary
echo ""
echo "========================================="
if [ "$errors" -gt 0 ]; then
  echo "   Doctor found $errors error(s) and $warnings warning(s)."
  echo "   Please fix the errors above before running Bedrock Forge."
  echo "========================================="
  exit 1
elif [ "$warnings" -gt 0 ]; then
  echo "   Doctor found 0 errors and $warnings warning(s)."
  echo "   System meets all core requirements, but review warnings above."
  echo "========================================="
  exit 0
else
  echo "   Doctor found no issues! System is ready."
  echo "========================================="
  exit 0
fi
