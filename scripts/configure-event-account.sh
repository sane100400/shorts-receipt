#!/usr/bin/env bash

set -euo pipefail

project_id="${1:-}"
account="${2:-}"
configuration="studyjam-hackathon"

if [[ -z "$project_id" || -z "$account" ]]; then
  cat >&2 <<'USAGE'
Usage: npm run gcp:configure -- PROJECT_ID USERNAME@gcplab.me

Run this only after the event credentials and assigned project ID are issued.
It creates a separate gcloud configuration so your personal project stays intact.
USAGE
  exit 2
fi

if [[ ! "$project_id" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]]; then
  echo "Invalid Google Cloud project ID: $project_id" >&2
  exit 2
fi

if [[ ! "$account" =~ @gcplab\.me$ ]]; then
  echo "The event account must end in @gcplab.me: $account" >&2
  exit 2
fi

if gcloud config configurations describe "$configuration" >/dev/null 2>&1; then
  gcloud config configurations activate "$configuration"
else
  gcloud config configurations create "$configuration"
fi

if ! gcloud auth list --filter="account=$account" --format='value(account)' | grep -Fxq "$account"; then
  echo "Opening Google authentication for $account ..."
  gcloud auth login "$account"
fi

gcloud config set account "$account"
gcloud config set project "$project_id"

cat <<EOF

Event gcloud configuration is active.
  account: $account
  project: $project_id

Next:
  1. Open https://aistudio.google.com/apikey with the same account.
  2. Import the assigned project if needed and copy its provisioned API key.
  3. Run: cp .env.example .env
  4. Put the key in GEMINI_API_KEY inside .env.
  5. Run: npm run doctor:event && npm run smoke:gemini

To return to your previous default configuration later:
  gcloud config configurations activate default
EOF
