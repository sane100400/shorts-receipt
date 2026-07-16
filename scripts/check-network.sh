#!/usr/bin/env bash

set -u

failures=0

check_url() {
  local label="$1"
  local url="$2"
  local code

  code="$(curl \
    --silent \
    --show-error \
    --location \
    --max-redirs 8 \
    --connect-timeout 5 \
    --max-time 20 \
    --output /dev/null \
    --write-out '%{http_code}' \
    "$url" 2>/dev/null || true)"

  if [[ "$code" =~ ^[23][0-9][0-9]$ ]]; then
    printf '  [OK] %-22s HTTP %s\n' "$label" "$code"
  else
    printf '  [FAIL] %-20s HTTP %s\n' "$label" "${code:-000}"
    failures=$((failures + 1))
  fi
}

echo "Hackathon network preflight"
check_url "Google Cloud Console" "https://console.cloud.google.com/"
check_url "Cloud Shell" "https://shell.cloud.google.com/"
check_url "Google AI Studio" "https://aistudio.google.com/"
check_url "Antigravity" "https://antigravity.google/"
check_url "GitHub" "https://github.com/"
check_url "npm registry" "https://registry.npmjs.org/"

echo
if (( failures > 0 )); then
  printf 'Result: %d endpoint(s) unreachable\n' "$failures"
  exit 1
fi

echo "Result: all required endpoints are reachable"
