#!/bin/bash
# Bedrock Forge Setup Helpers
# Centralized script functions sourced by other setup/maintenance scripts.

# Set or update a value in a key=value file (defaulting to .env)
set_env_value() {
  local key="$1"
  local value="$2"
  local file="${3:-.env}"
  local escaped
  escaped=$(printf '%s' "$value" | sed -e 's/[\/&|\\]/\\&/g')
  if grep -q "^${key}=" "$file"; then
    sed -i "s|^${key}=.*|${key}=${escaped}|" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

# Verify a command prerequisite exists, otherwise error out
verify_prereq() {
  local cmd="$1"
  local msg="$2"
  command -v "$cmd" >/dev/null 2>&1 || { echo "ERROR: $msg"; exit 1; }
}

# Generate .env with randomized secrets, replacing template values as needed.
generate_env_file() {
  if [ ! -f .env ]; then
    echo "Generating .env from .env.example…"
    if [ ! -f .env.example ]; then
      echo "ERROR: .env.example not found."
      exit 1
    fi
    cp .env.example .env

  else
    echo ".env already exists — preserving configured values and replacing template secrets."
  fi

  # Replace only known template values; preserve operator-provided credentials.
  if grep -q '^ENCRYPTION_KEY=change_me' .env; then
    set_env_value ENCRYPTION_KEY "$(openssl rand -hex 32)"
  fi
  if grep -q '^JWT_SECRET=change_me' .env; then
    set_env_value JWT_SECRET "$(openssl rand -hex 32)"
  fi
  if grep -q '^JWT_REFRESH_SECRET=change_me' .env || grep -q '^JWT_REFRESH_SECRET=$' .env; then
    set_env_value JWT_REFRESH_SECRET "$(openssl rand -hex 32)"
  fi
  if grep -q '^POSTGRES_PASSWORD=\(change_me\|forge_password\)' .env; then
    POSTGRES_PASSWORD="$(openssl rand -hex 16)"
    set_env_value POSTGRES_PASSWORD "$POSTGRES_PASSWORD"
    set_env_value DATABASE_URL "postgresql://forge:${POSTGRES_PASSWORD}@postgres:5432/bedrock_forge"
  fi
  if grep -q '^REDIS_PASSWORD=\(change_me\|forge_password\)' .env; then
    REDIS_PASSWORD="$(openssl rand -hex 16)"
    set_env_value REDIS_PASSWORD "$REDIS_PASSWORD"
    set_env_value REDIS_URL "redis://:${REDIS_PASSWORD}@redis:6379"
  fi

  chmod 600 .env
  echo "Environment configuration is ready."
}

# Poll the API health endpoint until it responds with success
wait_for_api_healthy() {
  local port="${1:-3001}"
  local retries="${2:-40}"
  echo "Waiting for Forge API to be ready on port $port…"
  until curl -sf "http://localhost:$port/health" > /dev/null 2>&1; do
    retries=$((retries - 1))
    if [ "$retries" -le 0 ]; then
      echo "ERROR: Forge API did not become healthy in time."
      echo "Check logs: docker compose logs forge"
      exit 1
    fi
    sleep 3
  done
  echo "Forge API is healthy."
}
