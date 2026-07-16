#!/usr/bin/env bash

set -euo pipefail

echo "Repository validation"

bash -n scripts/*.sh
echo "  [OK] shell syntax"

for script in scripts/*.mjs; do
  node --check "$script"
done
while IFS= read -r script; do
  node --check "$script"
done < <(find extension server -type f \( -name '*.js' -o -name '*.mjs' \) -print 2>/dev/null | sort)
echo "  [OK] JavaScript syntax"

node -e "JSON.parse(require('node:fs').readFileSync('package.json', 'utf8'))"
npm ls --all >/dev/null
echo "  [OK] package manifest and dependency tree"

for ignored_path in .env .env.local service-account-key.json demo.mp4; do
  if ! git check-ignore --quiet "$ignored_path"; then
    echo "  [FAIL] $ignored_path is not protected by .gitignore" >&2
    exit 1
  fi
done
echo "  [OK] local secrets and large demo files are ignored"

tracked_secrets="$(git ls-files '.env' '.env.*' 'service-account*.json' '*-credentials.json' | grep -vFx '.env.example' || true)"
if [[ -n "$tracked_secrets" ]]; then
  echo "  [FAIL] credential-like files are tracked:" >&2
  printf '%s\n' "$tracked_secrets" >&2
  exit 1
fi
echo "  [OK] no credential-like files are tracked"

if git ls-files | grep -q '^\[External\]'; then
  echo "  [FAIL] organizer reference documents must remain local-only" >&2
  exit 1
fi
echo "  [OK] organizer documents are excluded from the public repository"

if rg --hidden \
  --glob '!node_modules/**' \
  --glob '!.git/**' \
  --glob '![External]*' \
  --glob '!package-lock.json' \
  'AIza[0-9A-Za-z_-]{35}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----' .; then
  echo "  [FAIL] a credential-like secret pattern was found" >&2
  exit 1
fi
echo "  [OK] secret pattern scan"

npm audit --omit=dev --audit-level=high >/dev/null
echo "  [OK] production dependency audit"

echo "Result: repository checks passed"
