#!/usr/bin/env bash
# check-provider-lock.sh — enforce BIBLE §17.2 (provider-agnostic).
#
# Greps for hardcoded LLM-provider names in active code, docs, and task JSON.
# Exits 1 with file:line for every match so it blocks a pre-commit / CI run.
#
# Scope by design:
#   - ACTIVE docs + ACTIVE task JSON + source code we author
#   - Frozen post-facto records (SESSION_NOTES, HANDOFF, CHANGELOG) are exempt
#   - Ingested research corpus (knowy/ai/*) is data, not architecture
#   - Vendored / generated artefacts (.yalc, dist, build, node_modules) exempt
#   - Account control plane docs (sweech/, omnai/) have to name engines — exempt
#
# Usage:
#   ./scripts/check-provider-lock.sh                 # scan the whole repo
#   ./scripts/check-provider-lock.sh --staged        # scan staged files only (pre-commit)
#   ./scripts/check-provider-lock.sh path1 path2     # scan specific paths
#   ./scripts/check-provider-lock.sh --strict        # also flag 'claude-pole' / 'claude-code' literals
#
# Inline escape hatch:
#   Any line that contains "provider-lock:allow" is skipped.
#   Use it only for intentional architectural mentions (engine-family
#   comparisons, stat citations) and include a one-word reason:
#     line of text  <!-- provider-lock:allow arch-comparison -->
#
# Exit codes:
#   0 — clean
#   1 — violations found (printed with file:line)
#   2 — usage error

set -uo pipefail

PATTERN='(this Claude|Claude session|Claude API|@anthropic-ai|using Claude|use Claude|Claude must|Claude should|Claude will|Claude as |ChatGPT|GPT-[0-9]|GPT4|GPT5)'
STRICT_PATTERN='(claude-pole|claude-code)'

# Files that are never architectural contamination even if they match.
# Includes proof/ directories (frozen execution records) and historical
# statusHistory entries in completed task JSON.
EXEMPT_PATH_PATTERN='(^|/)(\.git/|node_modules/|\.yalc/|vendor/|venv/|\.venv/|build/|dist/|target/|DerivedData/|Pods/|__pycache__/|ELPA/|SESSION_NOTES|HANDOFF(\.md|_)|CHANGELOG\.md|package-lock\.json|package\.json$|bun\.lockb|\.playwright-mcp/|loopy/proof/|loopy/runs/|loopy/checkpoints/|loopy/state\.json|\.loopy/state\.json|proof/T-|views/roadmap|views/tasks|views/progress|knowy/ai/|coverage/|inventory\.json|/tests?/fixtures/)|\.test\.(ts|tsx|js|swift|py)$'

# Sweep-meta files that document the pattern AS data (self-referential).
# These are the trackers themselves; they must contain the pattern to describe it.
EXEMPT_META_PATTERN='(^|/)(PROVIDER_LOCK_SWEEP\.md|keel/tasks/T-VHQ-09[0-5]\.json|scripts/check-provider-lock\.sh)$'

# Repos whose entire job is to name engines — legitimate mentions.
EXEMPT_REPO_PATTERN='(^|/)(sweech|omnai)/'

MODE=scan
STRICT=0
PATHS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --staged) MODE=staged; shift ;;
    --strict) STRICT=1; shift ;;
    -h|--help)
      sed -n '2,25p' "$0"
      exit 0
      ;;
    --) shift; PATHS+=("$@"); break ;;
    -*)
      echo "unknown flag: $1" >&2
      exit 2
      ;;
    *) PATHS+=("$1"); shift ;;
  esac
done

gather_files() {
  if [ "$MODE" = staged ]; then
    git diff --cached --name-only --diff-filter=ACMR 2>/dev/null
  elif [ ${#PATHS[@]} -gt 0 ]; then
    for p in "${PATHS[@]}"; do
      if [ -d "$p" ]; then
        find "$p" -type f \( -name '*.md' -o -name '*.json' -o -name '*.yaml' -o -name '*.yml' -o -name '*.ts' -o -name '*.tsx' -o -name '*.swift' -o -name '*.py' -o -name '*.go' \) 2>/dev/null
      elif [ -f "$p" ]; then
        echo "$p"
      fi
    done
  else
    # Whole repo, author-owned types only
    find . -type f \( -name '*.md' -o -name '*.json' -o -name '*.yaml' -o -name '*.yml' -o -name '*.ts' -o -name '*.tsx' -o -name '*.swift' -o -name '*.py' -o -name '*.go' \) 2>/dev/null | sed 's|^\./||'
  fi
}

files=$(gather_files \
  | grep -vE "$EXEMPT_PATH_PATTERN" \
  | grep -vE "$EXEMPT_REPO_PATTERN" \
  | grep -vE "$EXEMPT_META_PATTERN" \
  || true)

if [ -z "$files" ]; then
  echo "check-provider-lock: no files in scope."
  exit 0
fi

violations=$(mktemp)
trap 'rm -f "$violations"' EXIT

# Drop any line containing the inline escape hatch, or an npm-package
# identifier for a vendor SDK (same semantic as package.json manifests being
# exempt — an import statement naming a published package is describing a
# dependency, not hardcoding routing).
filter_allowed() { grep -vE 'provider-lock:allow|@anthropic-ai/[a-z0-9-]+-sdk' || true; }

while IFS= read -r f; do
  [ -f "$f" ] || continue
  grep -nE "$PATTERN" "$f" 2>/dev/null | filter_allowed | sed "s|^|$f:|" >> "$violations"
  if [ "$STRICT" = 1 ]; then
    grep -nE "$STRICT_PATTERN" "$f" 2>/dev/null | filter_allowed | sed "s|^|$f:[strict] |" >> "$violations"
  fi
done <<< "$files"

if [ -s "$violations" ]; then
  count=$(wc -l < "$violations" | tr -d ' ')
  echo "check-provider-lock: $count violation(s) — BIBLE §17.2" >&2
  echo "---" >&2
  cat "$violations" >&2
  echo "---" >&2
  echo "Fix: engine selection must route through sweech profiles + omnai.select()." >&2
  echo "See https://github.com/vykeai/onlytools-docs/blob/main/PROVIDER_LOCK.md for context and fix tasks." >&2
  exit 1
fi

echo "check-provider-lock: clean."
exit 0
