#!/usr/bin/env bash
# Install repo git hooks. Idempotent. Run after clone.
set -euo pipefail
REPO=$(git rev-parse --show-toplevel)
HOOKS="$REPO/.git/hooks"
mkdir -p "$HOOKS"

cat > "$HOOKS/pre-commit" <<'HOOK'
#!/usr/bin/env bash
# pre-commit hook — managed by scripts/install-hooks.sh
set -euo pipefail
REPO_ROOT=$(git rev-parse --show-toplevel)
if [ -x "$REPO_ROOT/scripts/check-provider-lock.sh" ]; then
  "$REPO_ROOT/scripts/check-provider-lock.sh" --staged || {
    echo "" >&2
    echo "pre-commit: blocked by provider-lock check." >&2
    echo "Escape hatch: append <!-- provider-lock:allow <reason> --> on the same line." >&2
    exit 1
  }
fi
HOOK
chmod +x "$HOOKS/pre-commit"
echo "installed: $HOOKS/pre-commit"
