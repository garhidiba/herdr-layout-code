#!/bin/sh
# Builds the Rust core (vscode-core) from the sources beside this script and installs it where the mods look for it:
#   ${HERDR_APP_HOME:-$HOME/.config/herdr-app}/vscode-core/vscode-core
# The sources ship inside the vscode-settings mod (mods/vscode-settings/native/), so a layout installed by copying
# layouts/ and mods/ can build it too: the Settings dialog's Build button runs this script. Also writes
# <herdr home>/vscode-core/install.sh, a wrapper that runs this script again. Build output goes to
# <herdr home>/vscode-core/target (never under mods/, which Herdr watches). Crates come from cargo's cache when
# they are there; only a first build on a machine without them downloads them from crates.io.
# The mods use the JavaScript core unless "core.engine" is "rust" in <herdr home>/vscode-settings.json
# (the Settings dialog switches it). When the Rust engine is chosen ("core.engine" or "editor.engine" is "rust", or
# --engine rust) it also builds the Rust editor, <herdr home>/vscode-core/vsedit (it compiles Oniguruma, so it needs a C
# compiler; when that build fails the editor stays JavaScript and the core is still installed).
# On a fresh machine it first gets what the build needs (toolchain.sh): without cargo/rustc it installs Rust with
# rustup (https://sh.rustup.rs, -y --profile minimal, into ~/.cargo and ~/.rustup; rustup with no toolchain gets
# `rustup default stable`). A C compiler is needed too (rustc links with cc): on macOS it opens the Command Line Tools
# installer (xcode-select --install) and stops until that is done; on Linux it names the package to install (no sudo).
# Each step goes to <herdr home>/vscode-core/build-status too ("running|failed|warn|done <message>"; the Settings
# dialog shows it), and its process id to build-pid (the dialog notices a build that stopped without saying so).
# Any failure leaves "core.engine" as it was, so the mods keep using JavaScript. --engine rust leaves it too when
# <herdr home>/vscode-core/build-keep-js exists at the end (the dialog writes it when JavaScript is picked meanwhile).
# This script leaves the setting alone unless asked:
#   install.sh                 build and install the binary
#   install.sh --engine rust   build, install, then set "core.engine": "rust"
#   install.sh --engine js     build nothing, set "core.engine": "js"
set -eu

here=$(cd "$(dirname "$0")" && pwd)
home=${HERDR_APP_HOME:-$HOME/.config/herdr-app}
engine=

status= # <herdr home>/vscode-core/build-status, once the build starts
say() { printf 'vscode-core: %s\n' "$1"; if [ -n "$status" ]; then printf 'running %s\n' "$1" > "$status"; fi; }
fail() { printf 'vscode-core: %s\n' "$1" >&2; if [ -n "$status" ]; then printf 'failed %s\n' "$1" > "$status"; fi; exit 1; }

while [ $# -gt 0 ]; do
  case $1 in
    --engine) [ $# -ge 2 ] || fail "--engine needs rust or js"; engine=$2; shift 2 ;;
    --engine=*) engine=${1#*=}; shift ;;
    -h|--help) sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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

out=$home/vscode-core
mkdir -p "$out"
status=$out/build-status
echo $$ > "$out/build-pid"
say "checking the build tools"
. "$here/toolchain.sh"
ensure_rust
ensure_cc
cargo=$(command -v cargo)

if ! "$cargo" fetch --locked --offline --manifest-path "$here/Cargo.toml" >/dev/null 2>&1; then
  say "downloading the crates it needs from crates.io (first build on this machine)"
  "$cargo" fetch --locked --manifest-path "$here/Cargo.toml" || fail "could not get the crates (offline?); the mods keep using the JavaScript core."
fi
say "building with $cargo"
"$cargo" build --release --locked --offline --manifest-path "$here/Cargo.toml" --target-dir "$out/target" \
  || fail "the build failed (see the Build Rust core tab); the mods keep using the JavaScript core."

# Copied beside it, then renamed over it: a mod running the old binary right now is not affected.
cp "$out/target/release/vscode-core" "$out/vscode-core.tmp.$$"
mv -f "$out/vscode-core.tmp.$$" "$out/vscode-core"
say "installed $("$out/vscode-core" --version)"

# The wrapper: builds again from these sources (quoted for sh: ' becomes '\'').
quoted=$(printf '%s' "$here/install.sh" | sed "s/'/'\\\\''/g")
printf '#!/bin/sh\n# Written by %s: builds the Rust core again from those sources.\nexec sh '\''%s'\'' "$@"\n' "$here/install.sh" "$quoted" > "$out/install.sh.tmp.$$"
mv -f "$out/install.sh.tmp.$$" "$out/install.sh"

# The Rust editor, when the Rust engine is (or is about to be) chosen.
note=
value() { sed -n -e '/^[[:space:]]*\/\//d' -e 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"\([a-z]*\)".*/\1/p' "$home/vscode-settings.json" 2>/dev/null | head -n 1; }
if [ "$engine" = rust ] || [ "$(value 'core\.engine')" = rust ] || [ "$(value 'editor\.engine')" = rust ]; then
  say "building the Rust editor (vsedit)"
  if "$cargo" build --release --locked --offline --manifest-path "$here/Cargo.toml" --target-dir "$out/target" -p vsedit; then
    cp "$out/target/release/vsedit" "$out/vsedit.tmp.$$"
    mv -f "$out/vsedit.tmp.$$" "$out/vsedit"
    say "installed $("$out/vsedit" --version)"
  else
    note="the Rust core is installed, but the Rust editor did not build (see the Build Rust core tab); files keep opening in the JavaScript editor."
    printf 'vscode-core: %s\n' "$note" >&2
  fi
fi

if [ "$engine" = rust ] && [ -e "$out/build-keep-js" ]; then
  rm -f "$out/build-keep-js"; say "JavaScript was picked during the build: \"core.engine\" stays as it is"
elif [ "$engine" = rust ]; then set_engine rust; fi
if [ -n "$note" ]; then printf 'warn %s\n' "$note" > "$status"; else printf 'done installed\n' > "$status"; fi
