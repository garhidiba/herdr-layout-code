#!/bin/sh
# Builds the Rust core: runs the install script of the sources shipped in this mod (native/install.sh, so the binary
# matches these mods), else <herdr home>/vscode-core/install.sh (the wrapper an earlier build left). It builds a
# release and copies the binary to <herdr home>/vscode-core/vscode-core. Clones nothing. On a fresh machine install.sh
# first installs Rust (rustup) and asks for a C compiler. Options after the home go to install.sh (--engine rust: the
# Settings dialog switching to Rust; the setting changes only when the build works).
# Usage: sh build-core.sh [<herdr home> [install.sh options]]
here=$(cd "$(dirname "$0")" && pwd)
home="${1:-${HERDR_APP_HOME:-$HOME/.config/herdr-app}}"
[ $# -gt 0 ] && shift
for script in "$here/native/install.sh" "$home/vscode-core/install.sh"; do
  if [ -f "$script" ]; then HERDR_APP_HOME="$home" exec sh "$script" "$@"; fi
done
msg="No Rust core sources: neither $here/native/install.sh nor $home/vscode-core/install.sh exists."
echo "$msg"
echo "Install the layout's mods/vscode-settings folder again (it carries native/), then press Build again."
mkdir -p "$home/vscode-core" && printf 'failed %s\n' "$msg" > "$home/vscode-core/build-status"
exit 1
