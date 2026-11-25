#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

assert_contains() {
  local haystack="$1"
  local needle="$2"
  local message="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    echo "ASSERTION FAILED: $message (missing: $needle)" >&2
    return 1
  fi
}

assert_not_contains() {
  local haystack="$1"
  local needle="$2"
  local message="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    echo "ASSERTION FAILED: $message (unexpected: $needle)" >&2
    return 1
  fi
}

echo "=== Test 1: Prebuilt compose file stays image-only ==="
base_config="$(grep -E '^[[:space:]]*(build|image):' "$REPO_ROOT/docker-compose.yml" || true)"
assert_not_contains "$base_config" "build:" "docker-compose.yml must remain image-only for deploy.sh prebuilt images"

echo "=== Test 2: Fresh install prepares images without pre-existing images ==="
WORK_A="$TMP_DIR/clean-install"
mkdir -p "$WORK_A/bin" "$WORK_A/tools" "$WORK_A/state"
cp "$REPO_ROOT/docker-compose.yml" "$REPO_ROOT/.env.example" "$REPO_ROOT/Dockerfile" \
   "$REPO_ROOT/doctor.sh" "$REPO_ROOT/install.sh" "$REPO_ROOT/update.sh" "$WORK_A/"
cp "$REPO_ROOT"/tools/*.sh "$WORK_A/tools/" 2>/dev/null || true
[ -f "$REPO_ROOT/docker-compose.build.yml" ] && cp "$REPO_ROOT/docker-compose.build.yml" "$WORK_A/"

cat > "$WORK_A/bin/openssl" << 'EOF'
#!/usr/bin/env bash
seq_file="$TEST_STATE_DIR/openssl_seq"
n=0
[ -f "$seq_file" ] && n=$(cat "$seq_file")
n=$((n + 1))
echo "$n" > "$seq_file"
printf "%064x\n" "$n"
EOF
cat > "$WORK_A/bin/curl" << 'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat > "$WORK_A/bin/docker" << 'EOF'
#!/usr/bin/env bash
set -euo pipefail
STATE_DIR="$TEST_STATE_DIR"
echo "docker $*" >> "$STATE_DIR/calls.log"

if [[ "$1" == "info" ]]; then
  exit 0
elif [[ "$1" == "compose" ]]; then
  shift
  has_build_overlay=false
  while [[ $# -gt 0 ]]; do
    case "$1" in
      version)
        echo "Docker Compose version v2.29.0"
        exit 0
        ;;
      -f)
        if [[ "$2" == *"docker-compose.build.yml"* ]]; then
          has_build_overlay=true
        fi
        shift 2
        ;;
      build)
        if [[ "$has_build_overlay" == false ]]; then
          echo "NO-OP BUILD (no build overlay)" >> "$STATE_DIR/noop.log"
          exit 0
        fi
        echo "sha256:newforge001" > "$STATE_DIR/image_forge"
        echo "sha256:newweb001" > "$STATE_DIR/image_web"
        exit 0
        ;;
      up)
        if [[ ! -f "$STATE_DIR/image_forge" ]] || [[ ! -f "$STATE_DIR/image_web" ]]; then
          echo "pull access denied for bedrock-forge/forge" >&2
          exit 1
        fi
        cat "$STATE_DIR/image_forge" > "$STATE_DIR/running_forge"
        cat "$STATE_DIR/image_web" > "$STATE_DIR/running_web"
        exit 0
        ;;
      ps)
        if [[ "$*" == *"-q forge"* ]]; then
          echo "cid-forge"
        elif [[ "$*" == *"-q web"* ]]; then
          echo "cid-web"
        fi
        exit 0
        ;;
      exec)
        exit 0
        ;;
      *)
        shift
        ;;
    esac
  done
elif [[ "$1" == "image" && "$2" == "inspect" ]]; then
  ref="${@: -1}"
  if [[ "$ref" == *"bedrock-forge/forge:"* ]] && [[ -f "$STATE_DIR/image_forge" ]]; then
    cat "$STATE_DIR/image_forge"
    exit 0
  elif [[ "$ref" == *"bedrock-forge/web:"* ]] && [[ -f "$STATE_DIR/image_web" ]]; then
    cat "$STATE_DIR/image_web"
    exit 0
  fi
  exit 1
elif [[ "$1" == "inspect" ]]; then
  target="${@: -1}"
  if [[ "$target" == "cid-forge" ]] && [[ -f "$STATE_DIR/running_forge" ]]; then
    echo "true $(cat "$STATE_DIR/running_forge")"
    exit 0
  elif [[ "$target" == "cid-web" ]] && [[ -f "$STATE_DIR/running_web" ]]; then
    echo "true $(cat "$STATE_DIR/running_web")"
    exit 0
  fi
  exit 1
fi
exit 0
EOF
chmod +x "$WORK_A/bin/"* "$WORK_A/doctor.sh" "$WORK_A/install.sh" "$WORK_A/update.sh"

(cd "$WORK_A" && PATH="$WORK_A/bin:$PATH" TEST_STATE_DIR="$WORK_A/state" ./install.sh)

if [[ ! -f "$WORK_A/state/image_forge" ]] || [[ ! -f "$WORK_A/state/image_web" ]]; then
  echo "ASSERTION FAILED: install.sh did not build forge/web images" >&2
  exit 1
fi
if [[ -f "$WORK_A/state/noop.log" ]]; then
  echo "ASSERTION FAILED: install.sh ran a no-op docker compose build" >&2
  exit 1
fi

echo "=== Test 3: update.sh rebuilds and verifies running image matches newly built image ==="
cat > "$WORK_A/bin/git" << 'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$WORK_A/bin/git"
echo "sha256:oldforge000" > "$WORK_A/state/image_forge"
echo "sha256:oldweb000" > "$WORK_A/state/image_web"
echo "sha256:oldforge000" > "$WORK_A/state/running_forge"
echo "sha256:oldweb000" > "$WORK_A/state/running_web"

(cd "$WORK_A" && PATH="$WORK_A/bin:$PATH" TEST_STATE_DIR="$WORK_A/state" ./update.sh)

assert_contains "$(cat "$WORK_A/state/running_forge")" "sha256:newforge001" "update.sh must switch forge container to new image"
assert_contains "$(cat "$WORK_A/state/running_web")" "sha256:newweb001" "update.sh must switch web container to new image"

echo "=== Test 4: update.sh fails loudly if container still runs previous image ==="
cat > "$WORK_A/bin/docker" << 'EOF'
#!/usr/bin/env bash
set -euo pipefail
STATE_DIR="$TEST_STATE_DIR"
if [[ "$1" == "compose" ]]; then
  shift
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -f) shift 2 ;;
      build)
        echo "sha256:newforge002" > "$STATE_DIR/image_forge"
        echo "sha256:newweb002" > "$STATE_DIR/image_web"
        exit 0
        ;;
      up)
        # Intentionally leave running_forge pointing at stale old image!
        echo "sha256:oldforge000" > "$STATE_DIR/running_forge"
        echo "sha256:newweb002" > "$STATE_DIR/running_web"
        exit 0
        ;;
      ps)
        [[ "$*" == *"-q forge"* ]] && echo "cid-forge"
        [[ "$*" == *"-q web"* ]] && echo "cid-web"
        exit 0
        ;;
      *) shift ;;
    esac
  done
elif [[ "$1" == "image" && "$2" == "inspect" ]]; then
  ref="${@: -1}"
  [[ "$ref" == *"bedrock-forge/forge:"* ]] && cat "$STATE_DIR/image_forge" && exit 0
  [[ "$ref" == *"bedrock-forge/web:"* ]] && cat "$STATE_DIR/image_web" && exit 0
  exit 1
elif [[ "$1" == "inspect" ]]; then
  target="${@: -1}"
  [[ "$target" == "cid-forge" ]] && echo "true $(cat "$STATE_DIR/running_forge")" && exit 0
  [[ "$target" == "cid-web" ]] && echo "true $(cat "$STATE_DIR/running_web")" && exit 0
  exit 1
fi
exit 0
EOF
chmod +x "$WORK_A/bin/docker"

if (cd "$WORK_A" && PATH="$WORK_A/bin:$PATH" TEST_STATE_DIR="$WORK_A/state" ./update.sh); then
  echo "ASSERTION FAILED: update.sh must fail when running image ID mismatches built image ID" >&2
  exit 1
fi

echo "ALL COMPOSE SCRIPT CHECKS PASSED"
