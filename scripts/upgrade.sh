#!/usr/bin/env bash
# duckling upgrade — one-shot script for the maintainer after a code change:
#   1. type-check & build TypeScript (CLI + daemon + Worker)
#   2. push the Worker to Cloudflare
#   3. restart the local user daemon so it picks up new code
#   4. re-merge hook entries into ~/.claude/settings.json
#
# Pre-reqs:
#   - $CLOUDFLARE_API_TOKEN exported in your shell
#   - `npm link` already done (so `duckling` resolves in PATH)
#
# Safe to re-run; every step is idempotent.

set -euo pipefail
cd "$(dirname "$0")/.."

step() { printf '\n\033[1;36m== %s\033[0m\n' "$1"; }
done_msg() { printf '\n\033[1;32m%s\033[0m\n' "$1"; }

step "1/4 build"
npm run build

step "2/4 deploy Worker"
if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "  CLOUDFLARE_API_TOKEN not set — skipping deploy."
  echo "  Run 'export CLOUDFLARE_API_TOKEN=...' then 'npx wrangler deploy' yourself."
else
  npx wrangler deploy
fi

step "3/4 stop daemon (so it doesn't keep running stale code)"
# `upgrade` only updates code — it does NOT restart the daemon for you.
# Run `duckling start` yourself when you want sessions reachable from TG.
if command -v duckling >/dev/null 2>&1; then
  duckling stop || true
else
  echo "  duckling not in PATH — skip."
fi

step "4/4 uninstall legacy hooks"
# duckling no longer uses Claude Code hooks. This sweeps any leftover
# hook entries out of ~/.claude/settings.json. Safe to re-run.
if command -v duckling >/dev/null 2>&1; then
  duckling uninstall-hooks
else
  node -e "require('./dist/cli/uninstall-hooks.js').runUninstallHooks()"
fi

echo
echo "Next: \`duckling start\` to bring the daemon up; drive Claude from Telegram."

done_msg "✓ duckling upgrade done"
