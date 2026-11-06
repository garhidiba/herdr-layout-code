#!/bin/sh
# Builds the Rust core (vscode-core) and installs it where the mods look for it:
#   ${HERDR_APP_HOME:-$HOME/.config/herdr-app}/vscode-core/vscode-core
# The mods use the JavaScript core unless "core.engine" is "rust" in <herdr home>/vscode-settings.json
# (the Settings dialog switches it). This script leaves that setting alone unless asked:
#   native/install.sh                 build and install the binary
#   native/install.sh --engine rust   build, install, then set "core.engine": "rust"
#   native/install.sh --engine js     build nothing, set "core.engine": "js"
set -eu

here=$(cd "$(dirname "$0")" && pwd)
home=${HERDR_APP_HOME:-$HOME/.config/herdr-app}
engine=

fail() { printf 'vscode-core: %s\n' "$1" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case $1 in
    --engine) [ $# -ge 2 ] || fail "--engine needs rust or js"; engine=$2; shift 2 ;;
    --engine=*) engine=${1#*=}; shift ;;
    -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) fail "unknown option $1 (see --help)" ;;
  esac
done
case $engine in ''|rust|js) ;; *) fail "--engine must be rust or js, not '$engine'" ;; esac

# Sets "core.engine" in vscode-settings.json, keeping every other key (and comments) as they are.
set_engine() {
  file=$home/vscode-settings.json tmp=$home/vscode-settings.json.tmp.$$
  mkdir -p "$home"
  if [ ! -s "$file" ] || [ "$(sed 's#^[[:space:]]*//.*##' "$file" | tr -d ' \t\r\n')" = "{}" ]; then
    printf '{\n  "core.engine": "%s"\n}\n' "$1" > "$tmp"
  elif grep -q '"core\.engine"' "$file"; then
    sed -E 's/("core\.engine"[[:space:]]*:[[:space:]]*)"[^"]*"/\1"'"$1"'"/' "$file" > "$tmp"
  else
    # After the object's opening brace (the first one outside a // comment line).
    awk -v v="$1" '
      !done && !/^[[:space:]]*\/\// && (i = index($0, "{")) {
        print substr($0, 1, i); print "  \"core.engine\": \"" v "\","
        rest = substr($0, i + 1); if (rest ~ /[^[:space:]]/) print rest
        done = 1; next
      }
      { print }' "$file" > "$tmp"
  fi
  mv -f "$tmp" "$file"
  printf 'vscode-core: "core.engine" is now "%s" in %s\n' "$1" "$file"
}

if [ "$engine" = js ]; then set_engine js; exit 0; fi

cargo=$(command -v cargo 2>/dev/null) || cargo=$HOME/.cargo/bin/cargo
[ -x "$cargo" ] || fail "cargo not found. Install Rust (https://rustup.rs) and run this again; the mods keep using the JavaScript core."

printf 'vscode-core: building with %s\n' "$cargo"
"$cargo" build --release --manifest-path "$here/Cargo.toml" --target-dir "$here/target" \
  || fail "the build failed (see above); the mods keep using the JavaScript core."

mkdir -p "$home/vscode-core"
# Copied beside it, then renamed over it: a mod running the old binary right now is not affected.
cp "$here/target/release/vscode-core" "$home/vscode-core/vscode-core.tmp.$$"
mv -f "$home/vscode-core/vscode-core.tmp.$$" "$home/vscode-core/vscode-core"
printf 'vscode-core: installed %s\n' "$("$home/vscode-core/vscode-core" --version)"

if [ "$engine" = rust ]; then set_engine rust; fi
