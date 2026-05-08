#!/usr/bin/env bash
# scripts/check-no-consumer-leak.sh
#
# CI guard: cloudy (an onlytool) must never depend on or be aware of vykean (a
# consumer). This script greps source for any reference to vykean and fails
# the build if any are found.
#
# Architectural rule: onlytools must not be aware of consumers; vykean depends
# on onlytools, not the other way around.
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

# Search source for vykean references. Excludes tests, fixtures, docs, and
# build artefacts. Docs cleanup is owned by a separate branch this session.
hits="$(grep -REn 'vykean|VYKEAN' \
  --exclude='check-no-consumer-leak.sh' \
  --exclude='*.md' \
  --exclude='CHANGELOG.md' \
  --exclude='fixtures.py' \
  --exclude-dir=tests \
  --exclude-dir=__tests__ \
  --exclude-dir=test \
  --exclude-dir=node_modules \
  --exclude-dir=venv \
  --exclude-dir=__pycache__ \
  --exclude-dir=dist \
  --exclude-dir=build \
  --exclude-dir=.git \
  . 2>/dev/null || true)"

if [[ -n "$hits" ]]; then
  echo "scripts/check-no-consumer-leak.sh: FAIL"
  echo ""
  echo "Found vykean references in cloudy source — onlytools must not be aware of consumers."
  echo "Architectural rule: vykean depends on cloudy; cloudy must not depend on vykean."
  echo ""
  echo "$hits"
  exit 1
fi

echo "scripts/check-no-consumer-leak.sh: ok (no consumer leak detected)"
