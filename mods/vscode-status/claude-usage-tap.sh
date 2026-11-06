#!/bin/sh
# Claude Code statusLine tap: saves rate_limits from the statusLine input for the
# Herdr status bar, then hands the same input to the original statusLine command.
dir="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
payload=$(cat)
case "$payload" in
  *'"rate_limits"'*)
    printf '%s' "$payload" | python3 -c '
import sys, json, os, time
try:
    r = json.load(sys.stdin).get("rate_limits")
    if r:
        p = os.path.join(sys.argv[1], "claude-usage.json")
        open(p + ".tmp", "w").write(json.dumps({"at": int(time.time()), "rate_limits": r}))
        os.replace(p + ".tmp", p)
except Exception:
    pass
' "$dir" 2>/dev/null || :
    ;;
esac
if [ -r "$dir/claude-statusline-orig.sh" ]; then
  printf '%s' "$payload" | sh -c "$(cat "$dir/claude-statusline-orig.sh")"
fi
