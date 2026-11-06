#!/bin/sh
# Cross-builds the remote editor bundle: the Rust editor (vsedit) and core (vscode-core, with `tokenize`) as static
# musl binaries for Linux aarch64 and x86_64, with the data the editor reads (vscode/ grammars + theme + index,
# editor/keymap.json) and the remote launcher (remote-vsedit.sh as vsedit.sh). The Explorer uploads one to a machine
# the first time a file there opens in the editor (see mods/vscode-explorer/remote.js).
# Output, per arch (never under mods/, which Herdr watches; never in git):
#   <out>/<arch>/bundle.tgz      the bundle
#   <out>/<arch>/manifest.json   {version, arch, sha256, size, files: {<name>: sha256}}; version = <vsedit version>-<first
#                                12 hex digits of the bundle's sha256>, the folder it gets on the machine
# <out> defaults to <herdr home>/vscode-core/remote; cargo's build folder is <out>/target.
# Needs (macOS or Linux): rustup with the targets aarch64-unknown-linux-musl and x86_64-unknown-linux-musl, zig and
# cargo-zigbuild (Oniguruma is C: zig is the musl cross C compiler and linker):
#   rustup target add aarch64-unknown-linux-musl x86_64-unknown-linux-musl
#   brew install zig            (or a zig from ziglang.org on PATH)
#   cargo install cargo-zigbuild --locked
# usage: sh build-remote.sh [--out <dir>]
set -eu

here=$(cd "$(dirname "$0")" && pwd)
mods=$(cd "$here/../.." && pwd)
home=${HERDR_APP_HOME:-$HOME/.config/herdr-app}
out=$home/vscode-core/remote
ARCHES="aarch64 x86_64"

fail() { printf 'build-remote: %s\n' "$1" >&2; exit 1; }
while [ $# -gt 0 ]; do
  case $1 in
    --out) [ $# -ge 2 ] || fail "--out needs a folder"; out=$2; shift 2 ;;
    -h|--help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) fail "unknown option $1 (see --help)" ;;
  esac
done

PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; export PATH
command -v cargo-zigbuild >/dev/null || fail "cargo-zigbuild not found: cargo install cargo-zigbuild --locked"
command -v zig >/dev/null || fail "zig not found: brew install zig"
installed=$(rustup target list --installed 2>/dev/null || true)
for a in $ARCHES; do
  case $installed in *"$a-unknown-linux-musl"*) ;; *) fail "rustup target $a-unknown-linux-musl missing: rustup target add $a-unknown-linux-musl" ;; esac
done

sha() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }
# The same bytes for the same files: no owners, no macOS metadata, gzip without a name or time.
pack() {
  if tar --version 2>/dev/null | grep -q bsdtar; then
    COPYFILE_DISABLE=1 tar -c --format ustar --no-mac-metadata --uid 0 --gid 0 --uname root --gname root -f - -C "$1" .
  else
    tar -c --format ustar --owner 0 --group 0 --sort name -f - -C "$1" .
  fi | gzip -9n
}

mkdir -p "$out"
targets=
for a in $ARCHES; do targets="$targets --target $a-unknown-linux-musl"; done
# shellcheck disable=SC2086
cargo zigbuild --release --locked --manifest-path "$here/Cargo.toml" --target-dir "$out/target" $targets \
  -p vsedit -p vscode-core --features vscode-core/tokenize || fail "the build failed (see above)"
version=$(sed -n 's/^version = "\(.*\)"/\1/p' "$here/vsedit/Cargo.toml" | head -n 1)

for a in $ARCHES; do
  stage=$out/.stage-$a.$$
  rm -rf "$stage"; mkdir -p "$stage/b/vscode" "$stage/b/editor"
  for bin in vsedit vscode-core; do cp "$out/target/$a-unknown-linux-musl/release/$bin" "$stage/b/$bin"; chmod 755 "$stage/b/$bin"; done
  cp -R "$mods/vscode-viewer/vscode/grammars" "$mods/vscode-viewer/vscode/index.json" "$mods/vscode-viewer/vscode/theme.json" \
    "$mods/vscode-viewer/vscode/LICENSE-vscode-textmate.md" "$stage/b/vscode/"
  cp "$mods/vscode-viewer/editor/keymap.json" "$stage/b/editor/"
  cp "$here/remote-vsedit.sh" "$stage/b/vsedit.sh"
  find "$stage/b" -exec touch -h -t 200001010000 {} + # unchanged files give the same bundle, so the same version
  pack "$stage/b" > "$stage/bundle.tgz"
  sum=$(sha "$stage/bundle.tgz")
  size=$(wc -c < "$stage/bundle.tgz" | tr -d ' ')
  ver=$version-$(printf '%s' "$sum" | cut -c1-12)
  printf '{\n  "version": "%s",\n  "arch": "%s",\n  "sha256": "%s",\n  "size": %s,\n  "files": {\n    "vsedit": "%s",\n    "vscode-core": "%s",\n    "vsedit.sh": "%s"\n  }\n}\n' \
    "$ver" "$a" "$sum" "$size" "$(sha "$stage/b/vsedit")" "$(sha "$stage/b/vscode-core")" "$(sha "$stage/b/vsedit.sh")" > "$stage/manifest.json"
  rm -rf "$stage/b" "$out/$a.old"
  # swapped in whole: a mod reading the old manifest never sees a half-written bundle
  if [ -d "$out/$a" ]; then mv "$out/$a" "$out/$a.old"; fi
  mv "$stage" "$out/$a"; rm -rf "$out/$a.old"
  printf 'build-remote: %s %s (%s bytes) -> %s\n' "$a" "$ver" "$size" "$out/$a"
done
