#!/bin/sh
# Opens a file in the terminal editor: the Rust editor (<herdr home>/vscode-core/vsedit, built by the Settings dialog's
# "Build Rust core" with the Rust engine chosen) when vscode-settings.json chooses it, else vsedit.cjs. The JS editor
# also runs whenever the binary is missing or answers another launch API; the binary itself execs vsedit.cjs
# (--fallback) before touching the terminal when it can't take the file (no grammars, or a keymap.json command it has
# never heard of: a newer table than the binary).
# usage: sh vsedit.sh <file> [--close-on-exit]
# Which editor: "editor.engine" ("js" | "rust") in vscode-settings.json; without it "core.engine" (while RUST_READY is
# 1; the Settings dialog's editorEngine() reads it the same way). VSEDIT_ENGINE overrides both (tests);
# VSEDIT_ENGINE_LOG=<file> gets a line per launch: rust, js, or js (fallback).
RUST_READY=0 # 1 once the Rust editor has the phase-3 language features: then "core.engine": "rust" chooses it too (0: only "editor.engine")
API=1        # the launch contract: `vsedit --api` must print this

here=$(cd "$(dirname "$0")" && pwd)
home=${HERDR_APP_HOME:-$HOME/.config/herdr-app}
settings=${VSEDIT_SETTINGS:-$home/vscode-settings.json}
bin=${VSEDIT_RUST_BIN:-$home/vscode-core/vsedit}

# A string setting's value ("" when absent), skipping // comment lines.
value() { sed -n -e '/^[[:space:]]*\/\//d' -e 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"\([a-z]*\)".*/\1/p' "$settings" 2>/dev/null | head -n 1; }

engine=${VSEDIT_ENGINE:-$(value 'editor\.engine')}
if [ -z "$engine" ] && [ "$RUST_READY" = 1 ]; then engine=$(value 'core\.engine'); fi
log() { if [ -n "${VSEDIT_ENGINE_LOG:-}" ]; then echo "$1" >> "$VSEDIT_ENGINE_LOG"; fi; }

# Herdr starts programs with PATH=/usr/bin:/bin; node usually lives in Homebrew or ~/.local. The Explorer starts this
# script straight from `sh -c` (launch.js), so no login shell runs unless node is nowhere else (nvm): then, as
# launch.js does, the login shell finds it. The caller's PATH stays first (as lang/proc.cjs env() keeps it), so what
# it puts there (the tests' herdr-app stub) wins over the tool folders.
PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin"; export PATH
if [ "$engine" = rust ] && [ -x "$bin" ] && [ "$("$bin" --api 2>/dev/null)" = "$API" ]; then
  log rust
  exec "$bin" --vscode "$here/../vscode" --fallback "$here/vsedit.cjs" "$@"
fi
log js
command -v node >/dev/null && exec node "$here/vsedit.cjs" "$@"
exec "${SHELL:-/bin/sh}" -lic 'exec "$0" "$@"' node "$here/vsedit.cjs" "$@"
