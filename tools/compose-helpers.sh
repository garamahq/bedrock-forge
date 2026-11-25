#!/usr/bin/env bash
# Shared Docker Compose local build and running-image verification helpers.

resolve_env_value() {
  local key="$1"
  local default_val="${2:-}"
  local env_val=""

  if [ -n "${!key:-}" ]; then
    printf '%s\n' "${!key}"
    return 0
  fi

  if [ -f .env ]; then
    env_val="$(
      awk -F= -v k="$key" '$1 == k { sub(/^[^=]*=/, ""); print; exit }' .env |
        sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
    )"
  fi

  if [ -n "$env_val" ]; then
    printf '%s\n' "$env_val"
  else
    printf '%s\n' "$default_val"
  fi
}

inspect_image_id() {
  local ref="$1"
  local id
  id="$(docker image inspect --format '{{.Id}}' "$ref" 2>/dev/null || true)"
  if [ -z "$id" ]; then
    echo "ERROR: Expected Docker image '$ref' was not found." >&2
    return 1
  fi
  printf '%s\n' "$id"
}

build_compose_images() {
  local image_tag forge_image web_image
  image_tag="$(resolve_env_value IMAGE_TAG latest)"
  forge_image="bedrock-forge/forge:${image_tag}"
  web_image="bedrock-forge/web:${image_tag}"

  docker compose -f docker-compose.yml -f docker-compose.build.yml build "$@"

  inspect_image_id "$forge_image" >/dev/null
  inspect_image_id "$web_image" >/dev/null
}

verify_running_compose_image() {
  local service="$1"
  local expected_image="$2"
  local expected_id cid state_and_id running_state running_id

  expected_id="$(inspect_image_id "$expected_image")"
  cid="$(docker compose ps -q "$service" | head -n1)"
  if [ -z "$cid" ]; then
    echo "ERROR: Service '$service' has no running container." >&2
    return 1
  fi

  state_and_id="$(docker inspect --format '{{.State.Running}} {{.Image}}' "$cid" 2>/dev/null || true)"
  running_state="${state_and_id%% *}"
  running_id="${state_and_id#* }"

  if [ "$running_state" != "true" ]; then
    echo "ERROR: Container for '$service' ($cid) is not running (state: ${running_state:-unknown})." >&2
    return 1
  fi
  if [ "$running_id" != "$expected_id" ]; then
    echo "ERROR: Service '$service' is running image '$running_id', expected '$expected_id' ($expected_image)." >&2
    return 1
  fi
}

verify_all_app_images() {
  local image_tag
  image_tag="$(resolve_env_value IMAGE_TAG latest)"
  verify_running_compose_image forge "bedrock-forge/forge:${image_tag}"
  verify_running_compose_image web "bedrock-forge/web:${image_tag}"
}
