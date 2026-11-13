# Sourced by install.sh and build-remote.sh (sh, not run on its own): what building these sources needs on a fresh
# machine. The caller defines say <message> and fail <message> (prints, exits).
#   ensure_rust   cargo and rustc; when missing, installs them with rustup (no questions, minimal profile)
#   ensure_cc     a C compiler and linker (rustc links with cc; Oniguruma is C), else fails with how to get one
# Herdr starts programs with PATH=/usr/bin:/bin; rustup puts cargo and rustc in ~/.cargo/bin.
PATH="${CARGO_HOME:-$HOME/.cargo}/bin:$PATH"; export PATH

ensure_rust() {
  if rustc --version >/dev/null 2>&1 && cargo --version >/dev/null 2>&1; then return 0; fi
  if command -v rustup >/dev/null 2>&1; then
    say "rustup has no Rust toolchain yet: installing stable (first time)"
    rustup default stable || fail "rustup could not install the stable toolchain (offline?); then build again (Settings: Build Rust core)."
  else
    if command -v curl >/dev/null 2>&1; then get="curl --proto =https --tlsv1.2 -sSf"
    elif command -v wget >/dev/null 2>&1; then get="wget -qO-"
    else fail "Rust is not installed and there is no curl or wget to get it: install Rust from https://rustup.rs, then build again (Settings: Build Rust core)."
    fi
    say "installing Rust with rustup (first time; it goes in ~/.cargo and ~/.rustup)"
    # shellcheck disable=SC2086
    $get https://sh.rustup.rs | sh -s -- -y --profile minimal
  fi
  rustc --version >/dev/null 2>&1 && cargo --version >/dev/null 2>&1 \
    || fail "Rust did not install (see above; offline?): install it from https://rustup.rs, then build again (Settings: Build Rust core)."
  say "Rust installed: $(rustc --version)"
}

ensure_cc() {
  if [ "$(uname -s)" = Darwin ]; then
    # /usr/bin/cc is only a stub until the Command Line Tools are installed; their installer is a dialog.
    xcode-select -p >/dev/null 2>&1 && return 0
    xcode-select --install >/dev/null 2>&1 || true
    fail "a C compiler is needed: install the Command Line Tools from the dialog that opened (or run xcode-select --install), then build again (Settings: Build Rust core)."
  fi
  command -v cc >/dev/null 2>&1 && return 0
  if command -v apt-get >/dev/null 2>&1; then how="sudo apt-get install -y build-essential"
  elif command -v dnf >/dev/null 2>&1; then how="sudo dnf install -y gcc"
  elif command -v yum >/dev/null 2>&1; then how="sudo yum install -y gcc"
  elif command -v pacman >/dev/null 2>&1; then how="sudo pacman -S --needed base-devel"
  elif command -v zypper >/dev/null 2>&1; then how="sudo zypper install -y gcc"
  elif command -v apk >/dev/null 2>&1; then how="sudo apk add build-base"
  else how="install gcc or clang with the system's package manager"
  fi
  fail "a C compiler (cc) is needed: $how, then build again (Settings: Build Rust core)."
}
