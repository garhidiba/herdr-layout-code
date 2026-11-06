#!/bin/sh
# Cross-builds the remote bundles: what the Explorer uploads to a remote space's machine (mods/vscode-explorer/remote.js).
#   platform         Rust target(s)                                   builder              in the bundle
#   linux-aarch64    aarch64-unknown-linux-musl (static)              cargo zigbuild       editor + core
#   linux-x86_64     x86_64-unknown-linux-musl (static)               cargo zigbuild       editor + core
#   macos            aarch64-apple-darwin + x86_64-apple-darwin, lipo cargo (macOS only)   editor + core
#   windows-x86_64   x86_64-pc-windows-gnu                            cargo zigbuild       core only
#   windows-aarch64  aarch64-pc-windows-gnullvm                       cargo zigbuild       core only
# editor = vsedit, the data it reads (vscode/ grammars + theme + index, editor/keymap.json) and the launcher
# (remote-vsedit.sh as vsedit.sh); core = vscode-core with `tokenize` (vscode-core.exe on Windows, whose terminal
# layer the editor doesn't have yet). Oniguruma is C: zig is the cross C compiler and linker (mingw-w64 for Windows).
# Output, per platform (never under mods/, which Herdr watches; never in git):
#   <out>/<platform>/bundle.tgz      the bundle (ustar + gzip; Windows 10+ unpacks it with its tar.exe)
#   <out>/<platform>/manifest.json   {version, platform, sha256, size, files: {<name>: sha256}}; version = <vsedit
#                                    version>-<first 12 hex digits of the bundle's sha256>, its folder on the machine
# <out> defaults to <herdr home>/vscode-core/remote; cargo's build folder is <out>/target.
# Needs: rustup targets (rustup target add aarch64-unknown-linux-musl x86_64-unknown-linux-musl aarch64-apple-darwin
# x86_64-apple-darwin x86_64-pc-windows-gnu aarch64-pc-windows-gnullvm), zig (brew install zig) and cargo-zigbuild
# (cargo install cargo-zigbuild --locked). On Linux the macos bundle is skipped.
# usage: sh build-remote.sh [--out <dir>]
set -eu

here=$(cd "$(dirname "$0")" && pwd)
mods=$(cd "$here/../.." && pwd)
home=${HERDR_APP_HOME:-$HOME/.config/herdr-app}
out=$home/vscode-core/remote

fail() { printf 'build-remote: %s\n' "$1" >&2; exit 1; }
while [ $# -gt 0 ]; do
  case $1 in
    --out) [ $# -ge 2 ] || fail "--out needs a folder"; out=$2; shift 2 ;;
    -h|--help) sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) fail "unknown option $1 (see --help)" ;;
  esac
done

ZIG_TARGETS="aarch64-unknown-linux-musl x86_64-unknown-linux-musl x86_64-pc-windows-gnu aarch64-pc-windows-gnullvm"
MAC_TARGETS="aarch64-apple-darwin x86_64-apple-darwin"
PLATFORMS="linux-aarch64 linux-x86_64 windows-x86_64 windows-aarch64"
if [ "$(uname -s)" = Darwin ]; then PLATFORMS="$PLATFORMS macos"; else MAC_TARGETS=; printf 'build-remote: not on macOS, skipping the macos bundle\n'; fi

PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; export PATH
command -v cargo-zigbuild >/dev/null || fail "cargo-zigbuild not found: cargo install cargo-zigbuild --locked"
command -v zig >/dev/null || fail "zig not found: brew install zig"
installed=$(rustup target list --installed 2>/dev/null || true)
for t in $ZIG_TARGETS $MAC_TARGETS; do
  case $installed in *"$t"*) ;; *) fail "rustup target $t missing: rustup target add $t" ;; esac
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
targets() { for t in "$@"; do printf ' --target %s' "$t"; done; }

mkdir -p "$out"
build="--release --locked --manifest-path $here/Cargo.toml --target-dir $out/target --features vscode-core/tokenize"
# shellcheck disable=SC2046,SC2086
cargo zigbuild $build $(targets aarch64-unknown-linux-musl x86_64-unknown-linux-musl) -p vsedit -p vscode-core || fail "the Linux build failed (see above)"
# shellcheck disable=SC2046,SC2086
cargo zigbuild $build $(targets x86_64-pc-windows-gnu aarch64-pc-windows-gnullvm) -p vscode-core || fail "the Windows build failed (see above)"
if [ -n "$MAC_TARGETS" ]; then
  # shellcheck disable=SC2046,SC2086
  cargo build $build $(targets $MAC_TARGETS) -p vsedit -p vscode-core || fail "the macOS build failed (see above)"
fi
version=$(sed -n 's/^version = "\(.*\)"/\1/p' "$here/vsedit/Cargo.toml" | head -n 1)
rel() { printf '%s/target/%s/release/%s' "$out" "$1" "$2"; }

for p in $PLATFORMS; do
  stage=$out/.stage-$p.$$
  rm -rf "$stage"; mkdir -p "$stage/b"
  case $p in
    linux-*) t=${p#linux-}-unknown-linux-musl; for bin in vsedit vscode-core; do cp "$(rel "$t" "$bin")" "$stage/b/$bin"; done ;;
    macos) for bin in vsedit vscode-core; do lipo -create -output "$stage/b/$bin" "$(rel aarch64-apple-darwin "$bin")" "$(rel x86_64-apple-darwin "$bin")"; done ;;
    windows-x86_64) cp "$(rel x86_64-pc-windows-gnu vscode-core.exe)" "$stage/b/" ;;
    windows-aarch64) cp "$(rel aarch64-pc-windows-gnullvm vscode-core.exe)" "$stage/b/" ;;
  esac
  case $p in
    windows-*) files="vscode-core.exe" ;;
    *)
      chmod 755 "$stage/b/vsedit" "$stage/b/vscode-core"
      mkdir -p "$stage/b/vscode" "$stage/b/editor"
      cp -R "$mods/vscode-viewer/vscode/grammars" "$mods/vscode-viewer/vscode/index.json" "$mods/vscode-viewer/vscode/theme.json" \
        "$mods/vscode-viewer/vscode/LICENSE-vscode-textmate.md" "$stage/b/vscode/"
      cp "$mods/vscode-viewer/editor/keymap.json" "$stage/b/editor/"
      cp "$here/remote-vsedit.sh" "$stage/b/vsedit.sh"
      files="vsedit vscode-core vsedit.sh" ;;
  esac
  find "$stage/b" -exec touch -h -t 200001010000 {} + # unchanged files give the same bundle, so the same version
  pack "$stage/b" > "$stage/bundle.tgz"
  sum=$(sha "$stage/bundle.tgz")
  size=$(wc -c < "$stage/bundle.tgz" | tr -d ' ')
  ver=$version-$(printf '%s' "$sum" | cut -c1-12)
  list=
  for f in $files; do list="$list${list:+,}
    \"$f\": \"$(sha "$stage/b/$f")\""; done
  printf '{\n  "version": "%s",\n  "platform": "%s",\n  "sha256": "%s",\n  "size": %s,\n  "files": {%s\n  }\n}\n' \
    "$ver" "$p" "$sum" "$size" "$list" > "$stage/manifest.json"
  rm -rf "$stage/b" "$out/$p.old"
  # swapped in whole: a mod reading the old manifest never sees a half-written bundle
  if [ -d "$out/$p" ]; then mv "$out/$p" "$out/$p.old"; fi
  mv "$stage" "$out/$p"; rm -rf "$out/$p.old"
  printf 'build-remote: %s %s (%s bytes) -> %s\n' "$p" "$ver" "$size" "$out/$p"
done
