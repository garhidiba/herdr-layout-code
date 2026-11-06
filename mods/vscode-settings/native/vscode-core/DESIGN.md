# vscode-core design

`vscode-core` does the reads that vscode-explorer and vscode-scm run through many `sh`/`find`/`git`
processes, in one process, and prints the JSON the mods already build. Phase 1 (this crate) is done;
phase 2 is wiring it into the mods behind the `core.engine` setting.

## Phase 1: what exists

| Command | Replaces | Output |
| --- | --- | --- |
| `repos <root>` | scm `scanRepos()` (REPOS script + `parseRepos`) | `{ top, repos: [{path,name,branch,oid,dirty,ahead,behind,upstream}] }` |
| `status <repo>` | the status half of scm `readRepo()` | `{ files: [{path,status}], limited, hasHead }` |
| `log <repo> [--upstream r] [-n 300] [--graph]` | the log half of `readRepo()` (`parseLog`, `graph`) | commit rows; with `--graph` plus `col, lines, links, width, merge` |
| `commit-files <repo> <hash>` | `toggleCommit()`'s `git show` + `parseNameStatus` | `[{status, oldPath?, path}]` (1,000 at most) |
| `tree <dir> [--expanded a,b]` | explorer `loadFolder()` ×N + `gitMarks()` + `dirtyOf()` | `{ entries: {"": [...], "a": [...]}, limited, marks, dirty }` |
| `all <root> [--expanded …] [--repo cur]` | a whole space: tree + repos + the picked repo's `readRepo()` | `{ tree, repos, selected, repo: {files,limited,hasHead,commits} \| null, repoError? }` |
| `--version` | – | `{ version, backend: "git", git: "2.x" }` |

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
- `--expanded` splits on commas: a folder name containing a comma cannot be passed (phase 2 should
  pass those through the JS path or a daemon request body).

## Phase 2: engine selection

`<herdr home>/vscode-settings.json` (shared with the editor; JSONC with `//` comment lines) gets
`"core.engine": "js" | "rust"`. **Absent means `js`.** The Settings dialog mod writes it; so does
`native/install.sh --engine rust|js`.

- `js`: the mods never run the binary. Today's code path, unchanged.
- `rust`: the mods run `${appHome()}/vscode-core/vscode-core` with `exec` for **local** spaces only
  (`on` set → JS; a remote machine has no binary). Any failure of a call — `exec` rejecting (binary
  missing), a non-zero exit, unparsable JSON, a `{error}` — runs the JS path for that call, and the
  first such failure per session shows one toast: *"Rust core not built — using JS"* with the hint
  *"Build it from Settings"* (`notify({ …, action })` can open the Settings dialog). Missing binary
  is remembered for the session so later calls skip straight to JS.
- Version handshake: the mods ask `vscode-core --version` once per session and accept the binary
  when its major version matches the mods' expected `CORE_API` (start at 0 → 1 when wired); a
  mismatch is treated as "not built" (toast says "rebuild").
- Switching later: the Settings dialog (engine picker + **Build Rust core** button, which runs
  `native/install.sh` in a terminal tab), or `native/install.sh --engine rust|js`, or editing the
  setting by hand. Mods re-read the setting on their 10 s refresh timer (one small file read), so a
  switch applies without restarting.
- The Settings dialog shows *"Rust core: built (v0.1.0, git 2.54)"* from `--version`, or *"not
  built"* when `exec` rejects.

### Swap points (the JS is already factored for this)

| Mod | JS function | With `rust` |
| --- | --- | --- |
| Explorer | `loadFolder(path, context, tree)` ×N and `gitMarks(cwd)` in `refresh()`/`preload()` | one `tree <cwd> --expanded <folders>`; fill `tree.entries`, `tree.limited`, `marks` from it. `dirtyOf()` can take `dirty` from the output or stay in JS (cheap). |
| Explorer | `loadFolder` from `toggle()` (one folder) | keep JS (a single `sh` listing) or `tree <cwd> --expanded <path>` and take one key |
| SCM | `scanRepos(cwd, on)` | `repos <cwd>` (same `{top, repos}`) |
| SCM | `readRepo(repo, root, on)` | `status <root>` + `log <root> --graph [--upstream]`; better a small `repo <root> [--upstream r]` command returning `readRepo()`'s exact `{files, limited, hasHead, commits}` in one exec (add in phase 2) |
| SCM | `toggleCommit()` | `commit-files <root> <hash>` |
| both | `preload()` of other spaces | `all <cwd> [--expanded …] [--repo <chosen>]` once per space; each mod keeps its half (or one mod preloads and shares through `setShared`, keyed by root) |

`cache.js` (localStorage, `freshRoot`) is unchanged: it stores the same shapes. The graph rows are
stored without lanes and `graph()` reruns on restore, as today.

Limits to respect: `exec` has a 30 s limit and 8 MiB of output. `all` on the 84-repo parent prints
83 KB, `tree` 43 KB; the caps (5,000 entries, 1,000 files, 300 commits, 200 repos) bound it.

### One-shot exec (recommended for phase 2) vs a daemon (later, if needed)

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

Recommendation: build from source now (Settings button → `native/install.sh` in a terminal tab).
Gallery installs copy only `mods/*`, so the Settings mod must be able to reach the source: ship
`native/` inside the Settings mod's folder (copied with the mods), or have the button run
`git clone --depth 1 <repo> && native/install.sh` into a temp folder. Prebuilt binaries can come
later as `install.sh --prebuilt` (download the release asset for `uname -sm`, verify its SHA-256,
same install path), with the `--version` handshake guarding skew either way.
