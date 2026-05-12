#!/usr/bin/env bash
# scripts/check-no-consumer-leak.sh
#
# CI guard: this onlytool must never depend on or be aware of vykean (a
# consumer). This script greps source code (file-type whitelist) for any
# reference to vykean and fails the build if any are found.
#
# Architectural rule: onlytools must not be aware of consumers; vykean depends
# on onlytools, not the other way around.
#
# Scope: source code file types only (.py .ts .tsx .js .swift .kt .sh
# .yaml .yml .toml). Metadata (keel/*.json, *.jsonl, *.md, proof/*) is
# OUT of scope — those describe historical state, not code dependencies.
#
# To re-enable a temporary local override during a refactor, set
# ALLOW_CONSUMER_LEAK=1 in your environment. CI must NEVER set this.

set -euo pipefail

if [[ "${ALLOW_CONSUMER_LEAK:-}" == "1" ]]; then
  echo "scripts/check-no-consumer-leak.sh: skipped (ALLOW_CONSUMER_LEAK=1)"
  exit 0
fi

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

# Scan source code only (file-type whitelist). Excludes tests + build artefacts.
hits="$(grep -REn 'vykean|VYKEAN' \
  --include='*.py' \
  --include='*.ts' \
  --include='*.tsx' \
  --include='*.js' \
  --include='*.swift' \
  --include='*.kt' \
  --include='*.sh' \
  --include='*.yaml' \
  --include='*.yml' \
  --include='*.toml' \
  --exclude='check-no-consumer-leak.sh' \
  --exclude='check-provider-lock.sh' \
  --exclude-dir=tests \
  --exclude-dir=__tests__ \
  --exclude-dir=test \
  --exclude-dir=fixtures \
  --exclude-dir=node_modules \
  --exclude-dir=venv \
  --exclude-dir=__pycache__ \
  --exclude-dir=dist \
  --exclude-dir=build \
  --exclude-dir=.git \
  --exclude-dir=.worktrees \
  . 2>/dev/null || true)"

if [[ -n "$hits" ]]; then
  repo_name="$(basename "$repo_root")"
  echo "scripts/check-no-consumer-leak.sh: FAIL"
  echo ""
  echo "Found vykean references in $repo_name source code — onlytools must not be aware of consumers."
  echo "Architectural rule: vykean depends on $repo_name; $repo_name must not depend on vykean."
  echo ""
  echo "$hits"
  exit 1
fi

echo "scripts/check-no-consumer-leak.sh: ok (no consumer leak detected)"
