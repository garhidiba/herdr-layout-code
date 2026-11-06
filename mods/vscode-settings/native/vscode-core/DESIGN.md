# vscode-core design

`vscode-core` does the reads that vscode-explorer and vscode-scm run through many `sh`/`find`/`git`
processes, in one process, and prints the JSON the mods already build. Phase 1 (this crate) and
phase 2 (the mods use it behind the `core.engine` setting) are done. The crate lives in
`mods/vscode-settings/native/` so a gallery install, which copies only `layouts/` and `mods/`, carries it.

## Phase 1: what exists

| Command | Replaces | Output |
| --- | --- | --- |
| `repos <root>` | scm `scanRepos()` (REPOS script + `parseRepos`) | `{ top, repos: [{path,name,branch,oid,dirty,ahead,behind,upstream}] }` |
| `status <repo>` | the status half of scm `readRepo()` | `{ files: [{path,status}], limited, hasHead }` |
| `log <repo> [--upstream r] [-n 300] [--graph]` | the log half of `readRepo()` (`parseLog`, `graph`) | commit rows; with `--graph` plus `col, lines, links, width, merge` |
| `repo <repo> [--upstream r]` | scm `readRepo()` in one call (phase 2): status and log in parallel | `{ files, limited, hasHead, commits }` with the graph, exactly `readRepo()`'s shape |
| `commit-files <repo> <hash>` | `toggleCommit()`'s `git show` + `parseNameStatus` | `[{status, oldPath?, path}]` (1,000 at most) |
| `tree <dir> [--expanded a,b]` | explorer `loadFolder()` ×N + `gitMarks()` + `dirtyOf()` | `{ entries: {"": [...], "a": [...]}, limited, marks, dirty }` |
| `all <root> [--expanded …] [--repo cur]` | a whole space: tree + repos + the picked repo's `readRepo()` | `{ tree, repos, selected, repo: {files,limited,hasHead,commits} \| null, repoError? }` |
| `--version` | – | `{ version, backend: "git", git: "2.x" }`; the mods accept major version 1 |

Errors print `{ "error": "…" }` and exit 1. Parity with the mods' JS is checked by
`tests/parity.mjs` on real folders (84-repo parent, merges, far-ahead upstream, unborn branch,
nested repos, Korean locale and the C locale).

### Why spawn `git` instead of git2 or gix

The brief allowed git2 (libgit2) or gix. Both were rejected for this phase, because the output has
to be the same data the mods get from git itself, and the expensive part is `git status`, which a
library would not make faster:

- **Parity.** The log rows contain `%ar` ("3 days ago", localized by git), `%D` decorations (ref
  order, `HEAD -> `, `tag: `, decoration filters) and `--topo-order --date-order` ordering with git's
  tie-breaks. git2 and gix have none of these formatters; reimplementing them is exactly where
  byte-for-byte parity breaks. Status has the same problem (untracked-folder collapsing, submodule
  dirtiness, `.gitignore` edge cases, `status.*` config).
- **Speed.** libgit2's status has no untracked cache, no fsmonitor and no threaded index preload,
  and is slower than `git status` on large worktrees. gix's status is newer and its fidelity on
  these 84 repos would have to be proven case by case. The win measured here comes from running the
  per-repo `git status` calls in parallel and from dropping the `sh`/`find`/`sed`/`awk` pipelines,
  not from avoiding the git binary (one `git` spawn costs ~5 ms; one `status` costs 20–400 ms).
- **No writes, by construction.** Every call carries the mods' read flags
  (`--no-optional-locks -c core.fsmonitor=false -c diff.autoRefreshIndex=false`): no index refresh,
  no `index.lock`, no fsmonitor cookie. The harness checks `.git/index` mtimes and `index.lock` on
  98 repos before and after.
- **Build.** No C toolchain (git2 needs `cc` and builds libgit2/zlib), three small crates
  (`serde`, `serde_json`, `unicode-normalization`), a 0.8 MB binary, ~12 s clean release build.

If a daemon (below) ever holds repos open, gix is the candidate for the cheap reads (HEAD, refs,
ahead/behind) while status and log stay on git.

### Measured (wall time, this Mac, USB disk; `tests/parity.mjs`)

Baseline from the preload task: 12 single-repo spaces ≈ 0.75 s per panel; the 84-repo parent ≈ 2.6 s.

| Work | mods' JS/shell | vscode-core | |
| --- | ---: | ---: | ---: |
| `repos` on /Volumes/exusb/project (84 repos) | 2.3–3.3 s | 0.56–0.80 s | ×4 |
| `tree` on /Volumes/exusb/project (marks of 84 repos) | 2.4–3.3 s | 0.62–0.78 s | ×4 |
| `all` on /Volumes/exusb/project (tree + repos + changes + graph) | 6.5 s | 0.9 s (0.66 s warm) | ×7 |
| `all` on 12 project folders, one after another | 9.1–11.8 s | 2.2–2.5 s | ×4.5 |
| one repo's status + log (two calls) | 8–370 ms | same | ×1 |
| `repo` (status + log in one call) | 7–354 ms | 10–341 ms | ×1–1.5 |
| Mods' background preload of 12 project folders, Explorer (phase 2, `node` harness) | 2.6–2.8 s, 47 spawns | 0.77–0.85 s, 12 spawns | ×3.4 |
| Same, Source Control | 2.8–3.0 s, 34 spawns | 0.81–0.98 s, 12 spawns | ×3.3 |

A single small repo gains nothing (both are one or two git spawns); the gain is on folders with many
repos and on loading a whole space in one call.

### Intentional differences from the JS path

- In `all`, each nested repo's status is read once (`--porcelain=v2 -z --branch --no-renames`) and
  serves both the repo list and the Explorer's marks; the JS runs a v1 and a v2 status per repo. The
  values are the same (v2 `XY` with `.` → space is v1's `XY`).
- All git calls use the full read flags; the Explorer's own status omitted `diff.autoRefreshIndex=false`
  (no effect on `status`). `--no-renames` was added to the repo-list status (no effect on `dirty`).
- An expanded folder that cannot be listed is left out of `entries` (as the JS preload does; the
  foreground JS refresh shows an error instead). The 5,000-entry total is counted in the order the
  folders are given; the JS steady-state refresh counts the other folders' previous listings.
- With `status.showStash=true` and an upstream, the JS `head -n 5` can cut the first entry and miss
  a dirty repo; vscode-core reports it dirty. Repo paths containing `@@` break the JS marks parser,
  not vscode-core.
- Sorting: the repo list and the listing cut use `strcoll` in the caller's locale, as `sort` and the
  shell globs do. Folder entries sort as QuickJS's `localeCompare` (NFC, then code point), which is
  what Herdr's engine does (assumed from QuickJS's source; Node's ICU collation differs, so the
  harness emulates QuickJS).
- `--expanded` splits on commas: a folder name containing a comma cannot be passed, so the Explorer
  takes the JS path when an expanded folder's path has one.
- `repo` takes `hasHead` from its own status (`branch.oid`), `readRepo()` from the repo row it was
  given; they differ only when `readRepo()` gets no row (it then assumes a HEAD; the log fails on an
  unborn branch either way, so `commits` is `[]` in both).

## Phase 2: engine selection (done)

`<herdr home>/vscode-settings.json` (shared with the editor; JSONC with `//` comment lines) has
`"core.engine": "js" | "rust"`. **Absent means `js`.** The Settings dialog mod writes it; so does
`install.sh --engine rust|js`.

- `js` (or absent, invalid, or the file unreadable): the mods never run the binary. Today's code path, unchanged.
- `rust`: `core.js` (the same file in vscode-explorer and vscode-scm, since a mod can't import
  another mod's files; a test checks the copies match) runs `${appHome()}/vscode-core/vscode-core`
  with `exec` for **local** spaces only (`on` set → JS; a remote machine has no binary).
  - Failures are split in two. A call the binary answers with `{error}` (exit 1: a folder git can't
    read, a bad hash) takes JS for that call only; the JS path then shows its own message. A core
    that is unusable — `exec` rejecting (missing), a `--version` whose major is not `CORE_API` (1),
    output that isn't JSON — takes JS and shows one warning toast: *"Rust core not built — using
    JavaScript"* / *"Build it in Settings."* (or *"Rust core is out of date — using JavaScript"* /
    *"Rebuild it in Settings."*), whose action is `mod.open vscode-settings`. The two panels share
    the toast through the shared value `vscode-core.toast` (a toast within 10 s is not repeated).
  - After that the mod stays on JS until the settings file's text changes or a minute passes; the
    minute is what picks up a build from Settings, which doesn't change the file. No second toast
    until the file changes.
- Version handshake: `--version` once per settings-file version (and after each retry), shared by
  concurrent calls. The crate became 1.0.0 with `repo`; a 0.x binary is "out of date".
- The setting is re-read at most every 2 s on the next call (one small file read), like the editor,
  so a switch applies on the next refresh without restarting.
- The Settings dialog shows *"Rust core: built (v1.0.0)"*, *"Rust core: v0.1.0 is out of date
  (rebuild it)"*, or *"not built"* when `exec` rejects; **Build Rust core** shows while Rust is chosen
  and the binary isn't a current one.

### Swap points (the JS is already factored for this)

| Mod | JS function | With `rust` |
| --- | --- | --- |
| Explorer | `loadFolder(path, context, tree)` ×N and `gitMarks(cwd)` in `refresh()` | one `tree <cwd> --expanded <folders>`; `entries` (only folders still expanded), `limited`, `marks` from it; `dirtyOf()` stays in JS |
| Explorer | `loadFolder` from `toggle()` (one folder) | JS (a single `sh` listing) |
| SCM | `scanRepos(cwd, on)` | `repos <cwd>` (same `{top, repos}`) |
| SCM | `readRepo(repo, root, on)` from `loadRepo()` | `repo <root> [--upstream r]` (upstream when the row has `ahead`, as `readRepo()`) |
| SCM | `toggleCommit()` | `commit-files <root> <hash>` |
| Explorer | `preload()` of other spaces | `tree <cwd> --expanded <saved folders>` (its half only: `all` would also read the picked repo's log) |
| SCM | `preload()` of other spaces | `all <cwd> [--repo <chosen>]`: repos plus the picked repo's changes and graph in one call; the repo data is used only when the mod's own `pickRepo()` picks the same repo and its cache isn't fresh |

`cache.js` (localStorage, `freshRoot`) is unchanged: it stores the same shapes. The graph rows are
stored without lanes and `graph()` reruns on restore, as today.

Limits to respect: `exec` has a 30 s limit and 8 MiB of output. `all` on the 84-repo parent prints
83 KB, `tree` 43 KB; the caps (5,000 entries, 1,000 files, 300 commits, 200 repos) bound it.

### One-shot exec (what phase 2 uses) vs a daemon (later, if needed)

One-shot `exec` is a drop-in: same call sites, no lifecycle, and it already removes most of the
cost. A daemon is worth it only if the 10 s refresh and the folder watch still cost too much.

Daemon sketch, if pursued:

- `vscode-core serve --port 0 --detach` binds 127.0.0.1, double-forks with `setsid` (an `exec`'d
  child must return within 30 s), writes `{port, token, pid, version}` to
  `<herdr home>/vscode-core/port` (mode 0600), and exits after 30 min without clients.
- Discovery: a mod reads the port file and calls `GET /health` with the token; on failure it runs
  `vscode-core serve --detach` once and retries, else falls back to one-shot exec, then JS.
- API: `GET /tree`, `/repos`, `/repo`, `/commit-files` (same JSON as the commands, parameters in the
  query or a JSON body, so folder names with commas work), and a WebSocket `/watch?root=` that pushes
  `{kind: "tree" | "repos" | "repo", root, data}` after file changes.
- Watching with `notify` (FSEvents/inotify), debounced ~300 ms; inside `.git` only `HEAD`, `refs/`,
  `packed-refs` and `index` changes count. Results are cached in memory per root and recomputed per
  changed repo, so a save in one of 84 repos re-reads one repo, not 84. No on-disk cache: the mods
  already persist theirs.
- `mod.json`: the WebSocket/fetch typings say requests are gated by the mod's `capabilities.network`
  policy (AGENTS.md calls network access unrestricted for mods); declare loopback only, e.g.
  `"capabilities": { "network": ["http://127.0.0.1", "ws://127.0.0.1"] }`, and confirm the exact
  schema with `herdr-app check` when implementing. The token keeps other local processes out.
- Costs: process lifecycle (stale port files, several Herdr windows, upgrading a running binary),
  a second watcher next to Herdr's own `watchFolder`, and more code to keep in parity.

## Distribution for gallery users

The JavaScript core needs nothing, so the gallery listing stays install-and-go: *"Works out of the
box. Optional: a Rust core makes folders with many repos ~4× faster; build it from Settings (needs
Rust)."*

| | Build from source (`install.sh`) | Prebuilt per-platform binaries |
| --- | --- | --- |
| Needs | Rust toolchain (rustup), ~15 s first build | nothing |
| Platforms | anything Rust builds for | only what CI builds (macOS arm64/x86_64, Linux x86_64/arm64) |
| Trust | the user builds what they can read | a downloaded executable: checksums, macOS signing/notarization (browser downloads get quarantined) |
| Upkeep | none | release CI per version; binary/mod version skew to handle |

Decision (phase 2): build from source, with the sources inside the Settings mod. `native/` moved
to `mods/vscode-settings/native/`, so copying `mods/` (all a gallery install does) carries the
Cargo workspace, `Cargo.lock` and `install.sh`. No clone, no network for the sources.

- **Build button** → `mods/vscode-settings/build-core.sh <herdr home>` in a terminal tab → the mod's
  own `native/install.sh` (so the binary matches the installed mods), else the
  `<herdr home>/vscode-core/install.sh` wrapper an earlier build wrote.
- **`install.sh`** puts `~/.cargo/bin` in front of PATH (Herdr starts programs with
  `/usr/bin:/bin`), runs `cargo fetch --locked --offline` and only when that fails a plain
  `cargo fetch --locked` (the one network use: the 17 crates, first build on a machine without
  them in cargo's cache), then `cargo build --release --locked --offline` with
  `--target-dir <herdr home>/vscode-core/target` — never under `mods/`, which Herdr watches and
  hot-reloads. It copies the binary to `<herdr home>/vscode-core/vscode-core` (copy then rename) and
  writes `<herdr home>/vscode-core/install.sh`, a two-line wrapper (`exec sh '<that install.sh>' "$@"`)
  for rebuilding from a shell. Tested with `HERDR_APP_HOME=<temp>` holding only `layouts/` + `mods/`
  and `PATH=/usr/bin:/bin`: ~9 s release build, nothing written under `mods/`.
- Vendoring the crates (`cargo vendor`, ~4 MB incl. `syn`) into the mod was rejected: it would ship
  in every install and Herdr watches the folder.

Prebuilt binaries can come later as `install.sh --prebuilt` (download the release asset for
`uname -sm`, verify its SHA-256, same install path), with the `--version` handshake guarding skew.

## Editor on Rust: phase 1 (tokenizer)

Goal: a Rust tokenizer that gives exactly the tokens and colors of the viewer/editor's JS path
(vscode-textmate 9.3.2 + vscode-oniguruma 1.7.0 + the bundled grammars + One Dark), and a number
for whether moving the editor to Rust pays off.

### What exists

- Crate `vscode-textmate` (library, beside `vscode-core`): `Registry::new(theme, loader)`,
  `load_grammar(scope)`, `Grammar::tokenize_line2(line, prev, time_limit)` → UTF-16 token offsets
  with the same encoded metadata, `StateStack::equals`, `color_map()`. Modules follow the JS files:
  `onig.rs` (vscode-oniguruma's scanner), `raw.rs` (JSON/plist grammars, JSONC theme), `rule.rs`,
  `grammar.rs` (rule factory, scope/state stacks, `_tokenizeString`), `registry.rs` (dependency
  closure), `theme.rs`, `matcher.rs`, `file.rs` (tokenize.cjs).
- `vscode-core tokenize <file> [maxLines] [--vscode <dir>] [--stack]` (only with the cargo feature
  `tokenize`, off by default; without it the command prints `{"error": "vscode-core was built
  without tokenize …"}` and exits 1) prints tokenize.cjs's JSON
  (`{scope, total, eol, indent, colors, lines, theme}`); `--stack` adds the final rule stack.
  `--vscode` defaults to `<herdr home>/mods/vscode-viewer/vscode` next to the installed binary.
- `tests/parity.mjs` (vs the unchanged tokenize.cjs; a preload hook records the JS rule stack),
  `tests/bench.mjs` and `examples/bench.rs`.

### How it stays identical

- **Same regex engine and options.** `onig_sys = "=69.8.1"` bundles Oniguruma 6.9.8, the release
  vscode-oniguruma 1.7.0 pins (`deps/oniguruma` at "setup 6.9.8"); 69.9.x bundles 6.9.10, hence the
  pin. Patterns are compiled with `ONIG_OPTION_CAPTURE_GROUP`, UTF-8, `ONIG_SYNTAX_DEFAULT`. The
  scanner is `onig.cc` line for line: a RegSet (position lead) for strings under 1,000 bytes, else
  regex by regex with the per-regex result cache keyed by string id, skipped for patterns with `\G`.
- **Offsets.** The engine works in UTF-8 bytes; vscode-textmate in UTF-16 units. Every match lands
  on a character boundary, so the tokenizer runs on byte offsets and converts token starts to UTF-16
  once per line (`tokenize_line2` returns what the JS returns). Unmatched groups stay -1 (the JS
  maps them to 0 on non-ASCII lines; both have length 0 and are skipped the same way).
- **Same rule ids.** vscode-textmate stores compiled ids on the raw rule objects and deep-clones a
  grammar per use (`initGrammar`); the port keeps both (`Rc` rules with an id cell, a fresh tree per
  grammar, `$base` shared by identity) and walks capture/injection keys in JavaScript `for…in` order,
  so the rule stacks match id for id, not just token for token.
- **Same grammar closure.** `ScopeDependencyProcessor` is ported as is (captures' patterns are not
  walked, as in the JS), so the same includes resolve or stay unresolved.
- **Theme.** Same sort (stable, UTF-16 comparison), trie, parent-scope matching and color-id order,
  so the metadata's color indexes match `getColorMap()`.
- Left out because the viewer does not use them: injection grammars contributed through
  `getInjections` (the viewer passes none; a grammar's own `injections` work), embedded-language
  ids, token-type overrides, balanced brackets, fonts (`LineFonts`). `Registry::load_grammar`
  returns a new `Grammar` per call where the JS caches one; tokens are the same.

### Parity (`tests/parity.mjs`)

Every language with an extension in index.json: real files from /Volumes/exusb/project (plus
/opt/homebrew, /usr/share, /usr/local for languages the projects lack), up to 20 per language (the
first found, the 3 largest, 3 minified bundles for JS; skipping node_modules/.git/build/dist/target),
and 10 synthetic cases per language: empty, newlines only, CRLF and lone CR, tabs + Hangul/emoji/
astral/ZWJ, RTL (token merging off), unterminated strings/comments/heredocs across lines, lines of
1,000+ bytes (the per-regex path), 3,999- and 5,000-unit lines (the 4,000 cut), BOM + invalid UTF-8.
Compared: every line's runs (text, color, font style), scope/total/eol/indent/colors/theme, and the
end rule stack (rule ids, end patterns, content scopes and their attributes — what `equals` uses).

Result: **1,655/1,655 files identical (965 real, 690 synthetic) in 69 languages, 100% in each.**
Languages with no real file on this machine, so covered by the synthetic set only: Clojure,
CoffeeScript (only under node_modules), HLSL, Julia, Raku, R, RELAX NG, ShaderLab, BibTeX, Razor,
Handlebars, Pug, code-search, WebAssembly text, code-snippets. A sabotaged binary (one font style
changed) is reported as a mismatch with the line and both rows.

### Measured (this Mac, USB disk; `tests/bench.mjs`, median of 5 for a–c)

cold = a whole process (start, grammar load, regex compile, tokenize, JSON out): `node tokenize.cjs`
vs `vscode-core tokenize`; for (c), which both CLIs skip (lines over 4,000 units), the bench programs
in the editor's 1,000-unit `LongLine` chunks. warm = tokenizing the same lines again in process, with
the grammar loaded and its regexes compiled.

| Input | cold JS | cold Rust | × | warm JS | warm Rust | × |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| (a) TS, 2,000 lines | 420 ms | 247 ms | 1.7 | 72 ms | 54 ms | 1.3 |
| (b) TS, 20,000 lines | 2.70 s | 2.18 s | 1.2 | 2.27 s | 1.80 s | 1.3 |
| (c) 500 KB one-line minified JS, chunked | 7.4 s | 5.7 s | 1.3 | 7.0 s | 5.3 s | 1.3 |
| (d) all 965 real parity files (≤ 8,000 lines each), one process each | 207 s | 92 s | 2.2 | 80 s | 56 s | 1.4 |

- First pass (includes compiling the regexes on first use): (a) JS 343 ms / Rust 235 ms,
  (b) 2.9 s / 2.0 s, (d) 110 s / 75 s. Grammar load itself is 3–8 ms on both sides.
- (c) in one `tokenizeLine2` call (no chunking) Rust takes 9.5 s — slower than chunked, so the
  editor's chunking stays useful on either side.
- (d)'s cold gap (~120 ms per file) is Node start-up + WASM instantiation, not tokenizing.

Where the time goes (macOS `sample` on the 20,000-line run): ~95% inside Oniguruma
(`forward_search`, `match_at`, `mbc_enc_len`, `onig_regset_search`, region clearing); the Rust side
(scope stacks, theme lookups, token output) is ~5%. Both paths run the same engine on the same
patterns, so the Rust tokenizer is native Oniguruma vs Oniguruma in WASM under V8's JIT, which is
only a little slower.

| Tried | Result | Kept? |
| --- | --- | --- |
| Per-regex search with the cache for every string (no RegSet) | warm 20k lines 1.87 s → 2.4 s | no |
| RegSet threshold 300 / 4,000 bytes instead of 1,000 | within noise (±3%) | no (kept the JS's 1,000) |

Also found: one Node process that loads ~1,000 grammars without `registry.dispose()` crashes inside
vscode-oniguruma ("memory access out of bounds") once the WASM heap passes 2 GB, because its
scanner and string pointers are 32-bit `int`s. tokenize.cjs is one grammar per process; the bench
disposes each registry.

### Build

The tokenizer is opt-in so the Rust engine the mods use today keeps its old build: `vscode-textmate`
is an optional dependency of vscode-core behind the feature `tokenize`, and the workspace's
`default-members` is vscode-core alone, so a plain `cargo build` / `install.sh` neither compiles the
tokenizer nor needs a C compiler.

| Build | Command (in `mods/vscode-settings/native`) | Release build | Binary |
| --- | --- | ---: | ---: |
| Default (`install.sh`) | `cargo build --release` | 8.4 s | 0.77 MB |
| With the tokenizer | `cargo build --release --features tokenize` | 27 s | 1.6 MB |

Measured with `install.sh`, crates cached, `PATH=/usr/bin:/bin`, `HERDR_APP_HOME=<temp>`, empty
target dir: offline fetch succeeds and Oniguruma is not compiled. The tokenize build adds five
crates (`onig_sys`, `cc`, `find-msvc-tools`, `pkg-config`, `shlex`; ~0.8 MB to download) and needs a
C compiler (Xcode Command Line Tools' `cc` on macOS). They are in `Cargo.lock`, so a first
`cargo fetch --locked` downloads them even for the default build; they are just not compiled.
`onig_sys` builds its bundled copy unless `RUSTONIG_SYSTEM_LIBONIG`/`RUSTONIG_DYNAMIC_LIBONIG` is
set, so a Homebrew oniguruma does not leak in.

Tests: `cargo test` (vscode-core), `cargo test --workspace --features vscode-core/tokenize`
(everything); the parity and bench scripts need `cargo build --release --features tokenize` (and
`cargo build --release -p vscode-textmate --examples` for the bench).

### Recommendation for phase 2 (editor core in Rust)

The tokenizer alone does not justify the move: it is bound by Oniguruma, which both sides run, and
Rust is only **1.3× faster warm** and 1.2–2.2× per file cold (the larger figure is mostly Node start-up). A 20,000-line file still takes ~2 s
to color in Rust; a 500 KB minified line ~5 s. What a Rust editor core would actually gain:

1. **Start-up.** ~120 ms per process (Node + WASM + JIT warm-up) disappears — visible when a file
   opens, not while typing.
2. **Off the input thread.** In Node the tokenizer shares the event loop with keystrokes; the editor
   copes with deadlines, chunks and `ensure(last, deadline)`. A Rust core can tokenize on a worker
   thread (each `Grammar` is single-threaded `Rc`, so one grammar per thread) and never block input —
   a bigger felt win than the 1.3×.
3. **No WASM heap ceiling.** vscode-oniguruma fails past a 2 GB heap; the editor keeps one grammar
   per open file (`vsedit.cjs` `loadState` → `H.loadGrammar`, never disposed), so a long session that
   opens very many files can reach it. Native Oniguruma frees with the grammar.

Recommendation: do **not** start phase 2 for speed. If it is done, do it for (2) and (1): first ship
`vscode-core tokenize` (turning the feature on by default, or building it on demand) as an optional engine behind `core.engine` for the viewer (drop-in: same JSON,
1.2–2.2× per file), then move the editor's `Highlighter` (per-line stacks, incremental retokenize,
`LongLine` chunks) to a Rust worker that streams tokens, and only then the buffer/paint core if
profiling of the editor itself (not the tokenizer) shows it is the bottleneck. Real tokenizer speed-ups
would need changes the JS does not make (e.g. caching scanner results across lines), which would
have to be re-proven against this parity harness.

## Editor on Rust: phase 2 (editor body)

### What exists

A separate crate and binary, `vsedit` (`mods/vscode-settings/native/vsedit/`), not a `vscode-core edit`
subcommand: the core stays a small C-free build that the Explorer and Source Control spawn on every refresh,
while the editor needs the tokenizer (Oniguruma's C sources), `libc` for the terminal and its own launch
contract. One module per JS file: `buffer`, `keys`, `width`, `paint`, `file`, `settings`, `commands`
(commands.cjs + keybindings.cjs), `highlight`, `decorations`, `autoclose`, `find`, `folding`, `gitgutter`,
`scrollbar`, `backup`, `overlays` (dialog, input, quick pick), `editor` + `view` (vsedit.cjs's Editor),
`hexview`, `errorpage`, `term` / `app` (terminal.cjs). Same output conventions (SGR order, ENTER/LEAVE modes,
`?1007s/l/r`, Kitty keyboard, SGR mouse, 1003 only while a bar shows), same settings/keybindings files and
2 s live reload, same backup format and folder.

- **Positions** are byte offsets in each line's UTF-8; UTF-16 is used only where the JS shows or stores it
  (`(N selected)`, the backup's cursor), and the status bar's `Col` counts characters as the JS does.
- **Tokenizer on a worker thread.** vscode-textmate's grammars are `Rc` (single-threaded), so the worker owns
  the registry and grammars and mirrors the lines. The editor sends each batch of edits as one composed line
  change with a sequence number; the worker keeps the rule stack after every line, re-tokenizes from the edit
  until a line past it ends in the same state (highlight.cjs's rule), tokenizes the rest of the file in the
  background, and sends batches every ~12 ms. Results for lines edited since they were computed are dropped;
  others are mapped through the edits that followed. Lines over 4,000 UTF-16 units go in ~1,000-unit pieces
  (cut after `;`/`}`), partial tokens shown as they come; typing in such a line keeps the pieces before it.
  The first frame is painted before any grammar loads; the second waits up to 1 s for the visible lines.
  Typing a quote waits up to 20 ms for the line's tokens (the string/comment check), as the JS tokenizes it inline.
- **Find** uses Oniguruma (exported from vscode-textmate) in place of JavaScript's RegExp: `(?i)` for Match Case
  off, `(?<![\p{L}\p{N}_$])…(?![\p{L}\p{N}_$])` for whole words; `$n`, `$&`, `$<name>`, `\n`, `\t` replacements.
- **Semantic layer (phase 3 hook):** `highlight::SemanticLayer`, spans (line, start, end → fg, font style) painted
  over the TextMate colors; spans move with edits below them and are dropped on edited lines. Empty in phase 2.
- **Keys:** ids, titles and default keys per OS come from the shared table `mods/vscode-viewer/editor/keymap.json`
  (`{ id, title, keys: { mac, win, linux } }`, read at start next to `--vscode`; an id the binary has no action for
  sends the file to the JS editor). The OS is `VSEDIT_OS`, else the platform, as in commands.cjs. Two-step chords as
  keybindings.cjs: the first key shows `(⌘K) was pressed. Waiting for second key of chord...`, the second runs the
  command or says `The key combination (…, …) is not a command.`, and a typed character counts as the second key.
  Movement and deletion (cursorHome, cursorLineStart, deleteAllLeft, macOS ⌃A/⌃E/⌃K/⌃U, …) are commands of the
  table; only Enter, Tab and Escape are the editor's own. The user's `vscode-keybindings.json` applies on top.
- Phase 3 (JS only for now): language features (tsserver/LSP: definition, references, rename, hover, format,
  diagnostics, document symbols and symbol breadcrumbs), the context menu, the command palette — their keys show
  `Not yet in the Rust editor`. Also still JS-only: Go to File (quick open) with its multi-file switching,
  Open Settings/Keyboard Shortcuts (JSON), Go Back/Forward.

### Launch and engine switch

Every opener (`openArgs` in the Explorer, the Settings dialog's JSON files) asks for
`["exec", "sh", "<herdr home>/mods/vscode-viewer/editor/vsedit.sh", <file>, "--close-on-exit"?]`; `launch.js` starts it
straight from `sh -c` without the login shell (`exec` dropped), `tab.new` when that fails. The launcher execs
`<herdr home>/vscode-core/vsedit --vscode … --fallback …/vsedit.cjs` when `"editor.engine": "rust"` and
`vsedit --api` prints `1`; otherwise `node vsedit.cjs`. The binary execs `node vsedit.cjs` itself (before touching
the terminal) when it can't start. **`"core.engine": "rust"` does not route to the Rust editor yet** (`RUST_READY=0`
in the launcher): Go to File and the multi-file switching are missing. `install.sh` (the dialog's Build Rust core)
builds `vsedit` too when `core.engine` or `editor.engine` is `rust` (or `--engine rust`); a failed editor build
(no C compiler) leaves the editor on JS and still installs the core. The dialog does not show the editor's status.

### Tests

- `cargo test -p vsedit` (62 tests: buffer/undo, key parsing, the shared key table, per-OS defaults and chords, find,
  folding, autoclose, decorations, git diff, scrollbars, settings, hex viewer, …).
- `VSEDIT_BIN=<target>/release/vsedit python3 -I mods/vscode-viewer/editor/test/e2e.py`: the JS editor's e2e
  scenarios through the launcher with the Rust engine forced; the four phase-3 scenarios are skipped, and the
  table says which editor ran. All 17 phase-2 scenarios pass in Rust (and all 21 still pass in JS).

### Measured (this Mac, USB disk; `mods/vscode-viewer/editor/test/latency.py --runs 3`, medians)

first = start → first frame; colored = start → colored frame; key = typed character → the frame with the new
column (40 keys; TS files at the end of the middle line, the minified file at the start of its line). The binary
run directly; through the launcher add one `sh` and one `vsedit --api` (a few ms).

| Input | first JS | first Rust | colored JS | colored Rust | key median JS / Rust | key p95 JS / Rust |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| (a) TS, 2,000 lines | 77 ms | 32 ms | 205 ms | 120 ms | 1.8 / 1.7 ms | 3.5 / 8.5 ms |
| (b) TS, 20,000 lines | 72 ms | 17 ms | 205 ms | 109 ms | 1.1 / 1.6 ms | 28.8 / 7.1 ms |
| (c) 500 KB one-line JS | 66 ms | 21 ms | 242 ms | 142 ms | 31.9 / 0.3 ms | 37.3 / 3.7 ms |

Start-up is 2–4× faster (no Node, no WASM), and the minified line no longer blocks typing (the JS spends its
25 ms slice per keystroke re-tokenizing it; the worker does that off the input thread). Typing in ordinary files
was already ~2 ms in JS.
