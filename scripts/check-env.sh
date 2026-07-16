#!/usr/bin/env bash

set -u

strict=false
if [[ "${1:-}" == "--event-day" ]]; then
  strict=true
elif [[ -n "${1:-}" ]]; then
  echo "Usage: $0 [--event-day]" >&2
  exit 2
fi

errors=0
warnings=0

ok() {
  printf '  [OK] %s\n' "$1"
}

warn() {
  printf '  [WARN] %s\n' "$1"
  warnings=$((warnings + 1))
}

fail() {
  printf '  [FAIL] %s\n' "$1"
  errors=$((errors + 1))
}

require_command() {
  local command_name="$1"
  local label="$2"
  if command -v "$command_name" >/dev/null 2>&1; then
    ok "$label"
  else
    fail "$label is not installed"
  fi
}

optional_command() {
  local command_name="$1"
  local label="$2"
  if command -v "$command_name" >/dev/null 2>&1; then
    ok "$label"
  else
    warn "$label is not installed (optional)"
  fi
}

env_value() {
  local key="$1"
  sed -nE "s/^${key}=(.*)$/\1/p" .env 2>/dev/null | tail -n 1 | tr -d '\r'
}

echo "Hackathon environment check"
echo
echo "Required local tools"
require_command git "Git"
require_command node "Node.js"
require_command npm "npm"
require_command gcloud "Google Cloud CLI"
require_command curl "curl"

if command -v node >/dev/null 2>&1; then
  node_major="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
  if [[ "$node_major" =~ ^[0-9]+$ ]] && (( node_major >= 20 )); then
    ok "Node.js $(node --version) satisfies >=20"
  else
    fail "Node.js 20 or newer is required"
  fi
fi

echo
echo "Recommended tools"
optional_command gemini "Gemini CLI"
optional_command gh "GitHub CLI"
optional_command docker "Docker"
optional_command python3 "Python 3"
optional_command ffmpeg "ffmpeg (demo recording conversion)"

if command -v gh >/dev/null 2>&1; then
  if gh auth status >/dev/null 2>&1; then
    ok "GitHub CLI authentication"
  else
    warn "GitHub CLI is installed but not authenticated"
  fi
fi

if command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then
    ok "Docker daemon"
  else
    warn "Docker is installed but its daemon is unavailable"
  fi
fi

echo
echo "Event credentials"
active_account=""
active_project=""
if command -v gcloud >/dev/null 2>&1; then
  active_account="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | head -n 1)"
  active_project="$(gcloud config get-value project 2>/dev/null || true)"
fi

if [[ "$active_account" == *@gcplab.me ]]; then
  ok "Active event account: $active_account"
elif $strict; then
  fail "No @gcplab.me event account is active"
else
  warn "Event account is not active yet; this is expected before credentials are distributed"
fi

if [[ -n "$active_project" && "$active_project" != "(unset)" ]]; then
  if [[ "$active_account" == *@gcplab.me ]]; then
    ok "Assigned GCP project: $active_project"
  else
    warn "Current GCP project belongs to the pre-existing local configuration"
  fi
elif $strict; then
  fail "No GCP project is selected"
else
  warn "Assigned GCP project is not selected yet"
fi

echo
echo "Gemini SDK configuration"
if [[ ! -f .env ]]; then
  if $strict; then
    fail ".env is missing; copy .env.example and add the event API key"
  else
    warn ".env is not created yet; this is expected before the event API key is issued"
  fi
else
  api_key="$(env_value GEMINI_API_KEY)"
  vertex_mode="$(env_value GOOGLE_GENAI_USE_VERTEXAI)"
  env_project="$(env_value GOOGLE_CLOUD_PROJECT)"

  if [[ -n "$api_key" ]]; then
    ok "GEMINI_API_KEY is set (value hidden)"
  elif [[ "$vertex_mode" == "true" && -n "$env_project" ]]; then
    ok "Vertex AI mode is configured for project $env_project"
  elif $strict; then
    fail "Set GEMINI_API_KEY, or configure Vertex AI mode and GOOGLE_CLOUD_PROJECT"
  else
    warn "Gemini credentials are not configured yet"
  fi
fi

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  tracked_secrets="$(git ls-files '.env' '.env.*' 'service-account*.json' '*-credentials.json' | grep -vFx '.env.example' || true)"
  if [[ -z "$tracked_secrets" ]]; then
    ok "No known local credential files are tracked by Git"
  else
    fail "Credential-like files are tracked by Git: $tracked_secrets"
  fi
else
  warn "Git repository has not been initialized"
fi

echo
if (( errors > 0 )); then
  printf 'Result: %d failure(s), %d warning(s)\n' "$errors" "$warnings"
  exit 1
fi

printf 'Result: ready (%d warning(s))\n' "$warnings"
