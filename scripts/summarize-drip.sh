#!/bin/sh
# Daily summary drip (LaunchAgent com.session-atlas.summarize-drip).
#
# At most CAP (default 150) tier-1 summaries per run through headless Claude
# (Haiku 4.5), md's own sessions first, then agent-started ones, newest first.
# The usage gate stops issuing calls at the threshold and resumes after reset;
# launchd never starts a second copy while one is still waiting.
#
# The canonical config stays provider-free: the claude-cli provider exists
# only in a per-run copy that is removed on exit.
set -eu
umask 077

CAP="${1:-150}"
THRESHOLD="${ATLAS_DRIP_THRESHOLD:-0.8}"
CONFIG="${ATLAS_DRIP_CONFIG:-$HOME/.config/session-atlas/config.toml}"
BUN="${ATLAS_BUN:-$HOME/.bun/bin/bun}"
MODEL="claude-haiku-4-5-20251001"

case "$CAP" in ''|*[!0-9]*) echo "summarize-drip: cap must be a whole number" >&2; exit 2 ;; esac
cd "$(dirname "$0")/.."

RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/atlas-drip.XXXXXX")"
trap 'rm -rf "$RUN_DIR"' EXIT
trap 'exit 143' INT TERM
cat "$CONFIG" > "$RUN_DIR/config.toml"
printf '\n[[providers]]\nname = "haiku-cli"\nkind = "claude-cli"\nmodel = "%s"\n' "$MODEL" >> "$RUN_DIR/config.toml"

echo "summarize-drip · $(date '+%Y-%m-%d %H:%M') · cap $CAP · threshold $THRESHOLD"
left="$CAP"
for origin in human agent; do
  [ "$left" -gt 0 ] || break
  "$BUN" run src/cli.ts summarize --backfill --origin "$origin" --limit "$left" \
    --concurrency 1 --threshold "$THRESHOLD" --config "$RUN_DIR/config.toml" > "$RUN_DIR/out" 2>&1 || status=$?
  cat "$RUN_DIR/out"
  [ "${status:-0}" -eq 0 ] || exit "$status"
  # Summarized and pending both spent a call; skips never reach the model.
  spent="$(sed -n 's/.*· \([0-9][0-9]*\) summarized · \([0-9][0-9]*\) pending ·.*/\1 \2/p' "$RUN_DIR/out" | tail -1)"
  set -- $spent
  left=$((left - ${1:-0} - ${2:-0}))
done
echo "summarize-drip · done · $(date '+%Y-%m-%d %H:%M')"
