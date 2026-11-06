#!/bin/sh
# Builds the Rust core by running the layout's install script (it builds a release and copies the binary to
# <herdr home>/vscode-core/vscode-core). Clones or updates nothing. Usage: sh build-core.sh [<herdr home>]
home="${1:-${HERDR_APP_HOME:-$HOME/.config/herdr-app}}"
script="$home/vscode-core/install.sh"
if [ -f "$script" ]; then
  exec sh "$script"
fi
echo "No install script at $script."
echo "Get it from the herdr-layout-vscode repo: run  sh <repo>/native/install.sh"
echo "(or copy the repo's native/ folder's install.sh to $home/vscode-core/ and open Settings again)."
exit 1
