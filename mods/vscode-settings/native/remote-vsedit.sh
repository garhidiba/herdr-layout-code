#!/bin/sh
# The remote bundle's launcher (build-remote.sh ships it as <root>/<version>/vsedit.sh; root is
# ~/.local/share/herdr-vscode). The Explorer opens a remote file with it in a tab on that machine:
#   sh vsedit.sh <file> [--close-on-exit] [--os mac|win|linux] [--settings <json>] [--keybindings <json>]
# --os: the keys of the computer the keyboard is on (Herdr's), not this machine's. --settings / --keybindings: the
# local vscode-settings.json / vscode-keybindings.json, written to <root>/ before the editor starts (the local files
# win: a change made here from the editor's palette lasts until the next launch). Backups (hot exit) stay in
# <root>/backups. Everything it writes is under <root>. There is no JavaScript editor here to fall back to: when the
# Rust editor can't start, it says why and waits for Enter.
here=$(cd "$(dirname "$0")" && pwd)
root=$(dirname "$here")
HERDR_APP_HOME=$root VSEDIT_SETTINGS=$root/vscode-settings.json VSEDIT_KEYBINDINGS=$root/vscode-keybindings.json VSEDIT_BACKUPS=$root/backups
export HERDR_APP_HOME VSEDIT_SETTINGS VSEDIT_KEYBINDINGS VSEDIT_BACKUPS
# language servers and formatters the user installed (hc's and Herdr's shells may leave these out)
PATH="$PATH:$HOME/.local/bin:$HOME/.cargo/bin"; export PATH

# written only when it changed (compared without trailing newlines), through a temp file and a rename
put() { new=$(printf '%s' "$1"); if [ "$(cat "$2" 2>/dev/null)" != "$new" ]; then printf '%s\n' "$new" > "$2.tmp.$$" && mv -f "$2.tmp.$$" "$2"; fi; }

n=$#
while [ "$n" -gt 0 ]; do
  case $1 in
    --os|--settings|--keybindings)
      if [ "$n" -lt 2 ]; then shift; n=$((n - 1)); continue; fi # a flag without its value is dropped
      case $1 in --os) VSEDIT_OS=$2; export VSEDIT_OS ;; --settings) put "$2" "$VSEDIT_SETTINGS" ;; *) put "$2" "$VSEDIT_KEYBINDINGS" ;; esac
      shift 2; n=$((n - 2)) ;;
    *) set -- "$@" "$1"; shift; n=$((n - 1)) ;;
  esac
done

"$here/vsedit" --vscode "$here/vscode" "$@"
code=$?
if [ "$code" = 86 ]; then
  printf 'The editor could not start on this machine (run %s/vsedit with VSEDIT_DEBUG=1 to see why).\nPress Enter to close.\n' "$here"
  read -r _
fi
exit "$code"
