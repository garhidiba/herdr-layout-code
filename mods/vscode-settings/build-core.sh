#!/bin/sh
# Builds the Rust core: runs the install script of the sources shipped in this mod (native/install.sh, so the binary
# matches these mods), else <herdr home>/vscode-core/install.sh (the wrapper an earlier build left). It builds a
# release and copies the binary to <herdr home>/vscode-core/vscode-core. Clones nothing.
# Usage: sh build-core.sh [<herdr home>]
here=$(cd "$(dirname "$0")" && pwd)
home="${1:-${HERDR_APP_HOME:-$HOME/.config/herdr-app}}"
for script in "$here/native/install.sh" "$home/vscode-core/install.sh"; do
  if [ -f "$script" ]; then HERDR_APP_HOME="$home" exec sh "$script"; fi
done
echo "No Rust core sources: neither $here/native/install.sh nor $home/vscode-core/install.sh exists."
echo "Install the layout's mods/vscode-settings folder again (it carries native/), then press Build again."
exit 1
