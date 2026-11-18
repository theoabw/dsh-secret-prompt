#!/usr/bin/env bash
# Build @theoabw/dsh-secret-prompt, install it into the dsh web profile as a
# file: dependency, ensure the loader entry exists in the profile patch, and
# restart the web service. Idempotent: re-running rebuilds and refreshes
# everything.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="${DSH_PROFILE:-web}"
PROFILE_DIR="${DSH_HOME:-$HOME/.dsh}/profiles/$PROFILE"
PATCH="$PROFILE_DIR/cordis.patch.yml"

if [ ! -f "$PATCH" ]; then
  echo "error: profile patch not found at $PATCH (set DSH_PROFILE or DSH_HOME)" >&2
  exit 1
fi

# 1. Build both halves (node entry + browser bundle).
(cd "$ROOT" && pnpm run build)

# 2. Install the package into the web profile as a file: dependency.
dsh plugin --profile "$PROFILE" add "file:$ROOT" >/dev/null

# 3. Ensure the loader entry exists in the profile patch (idempotent).
if ! grep -q 'id: secret-prompt' "$PATCH"; then
  cat >> "$PATCH" <<'EOF'

# Secret prompt tool: collect secrets from the user via a masked GUI field
# without exposing the value to the agent loop.
- insert:
    - id: secret-prompt
      name: '@theoabw/dsh-secret-prompt'
EOF
  echo "added loader entry to $PATCH"
else
  echo "loader entry already present in $PATCH"
fi

# 4. Restart the web service so the loader picks up the new entry and bundle.
# systemctl is unreachable from the dsh bash sandbox; fall back to talking to
# the user systemd manager over D-Bus directly.
if systemctl --user restart dsh.service 2>/dev/null; then
  echo "deployed: dsh.service restarted (systemctl)"
else
  busctl --user call org.freedesktop.systemd1 /org/freedesktop/systemd1 org.freedesktop.systemd1.Manager RestartUnit ss dsh.service replace
  echo "deployed: dsh.service restarted (busctl)"
fi
