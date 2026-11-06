# herdr-layout-vscode

A VS Code–style layout for [Herdr](https://herdr.dev):

- **Explorer:** Material Icon Theme icons and VS Code git colors, including repos nested in the folder.
- **Source Control:** every repo under the folder, changes and commit, and a commit graph whose commits expand to their files.
- **Diff tab:** VS Code-style inline diff with VS Code's own syntax colors.
- **Editor:** code files open in a terminal tab in a VS Code-like editor colored by VS Code's own tokenizer (Atom One Dark), with VS Code's right-click menu, command palette, quick open, git change bars and folding, a find widget with Match Case / Whole Word / Regex and Replace, Save As / Save All, Expand Line Selection, Join Lines, Toggle Block Comment, Go to Bracket, Find With Selection, clickable status bar items (go to line, indentation, line endings, language mode), symbol breadcrumbs and Go to Symbol, error/warning squiggles with F8, VS Code's default keys for macOS, Windows or Linux (whichever it runs on, two-step chords like ⌘K ⌘J included), Go to Definition / References / Rename / Format through tsserver and language servers, a save dialog, hot exit and auto save; minified one-line files are colored too; binary files open in a hex viewer; a file that can't be opened shows an error page in the tab, and the tab closes with the editor; images and markdown open in a viewer tab.
- **Explorer menu:** VS Code's right-click menu (new, open with, reveal, cut/copy/paste, copy path, rename, delete to Trash).
- **Pane menu:** Open in VS Code / Finder.
- **Status bar:** Claude and Codex usage meters; Codex limit resets can be redeemed from the card; a gear for Settings.
- **Settings:** a VS Code-style dialog (gear, `cmd-,`, or the editor's Preferences: Open Settings) for auto save, trim/final newline, format on save, tab size and the core engine (JavaScript or the optional Rust core), with a **Keyboard Shortcuts** page (or the editor's Preferences: Open Keyboard Shortcuts) to change, remove and reset the editor's keys.

See [RECIPE.md](RECIPE.md) for exactly what it does and how it is built.

## Install

Ask your agent in Herdr: *"add the layout from github.com/garhidiba/herdr-layout-vscode"*. It follows Herdr's own install steps.

To install by hand:

1. Copy `layouts/vscode.json` into `~/.config/herdr-app/layouts/` and the `mods/*` folders into `~/.config/herdr-app/mods/`.
2. Merge `keys.json` into yours (it is macOS's: it passes ⌘ keys to the editor; ⌘K chords also need `cmd-k` and their second keys passed, see RECIPE.md). Copy `vscode-settings.json` to `~/.config/herdr-app/` only if you don't have one (the editor creates it with the defaults otherwise). `vscode-keybindings.json` is the editor's user keybindings file, empty (`[]`, no custom keys); copy it only if you don't have one. It takes VS Code's format for your OS, `[{ "key": "cmd+shift+d", "command": "editor.action.deleteLines" }]` (`ctrl+…` on Windows/Linux, chords like `"ctrl+k ctrl+c"` too), and `"command": "-editor.action.deleteLines"` removes a default; the Keyboard Shortcuts page writes it for you.
3. Run `herdr-app check` on each mod.
4. Switch with `ctrl-shift-l`, or run `herdr-app do layout.switch --name vscode`.

### Core engine: JavaScript (default) or Rust (optional)

The Explorer and Source Control read folders and git with a **JavaScript core** that works out of the box: nothing to build.

The optional **Rust core** (`vscode-core`) does the same reads in one parallel process, about 3–4× faster (12 project folders preloaded in the background: 2.7 s → 0.8 s per panel; an 84-repo folder: 6.5 s → 0.9 s). Its sources ship inside the Settings mod (`mods/vscode-settings/native/`), so a layout installed by copying `layouts/` and `mods/` can build it. It needs Rust (`cargo`, from [rustup.rs](https://rustup.rs); `~/.cargo/bin` is found even when it isn't on Herdr's PATH) and runs on this machine only (remote spaces keep the JavaScript core). Cargo's cache is used when it has the crates; otherwise the first build downloads them from crates.io. To use it, either:

- open the layout's Settings (gear, `cmd-,`), pick **Rust** as the core engine and press **Build Rust core** (a terminal tab shows the build), or
- run `sh ~/.config/herdr-app/mods/vscode-settings/native/install.sh --engine rust` (or the same script in this repo): it builds into `~/.config/herdr-app/vscode-core/` (binary, `target/` build folder, and an `install.sh` wrapper to build again) and sets `"core.engine": "rust"` in `vscode-settings.json`.

`install.sh` alone only builds and installs the binary; `--engine js` switches back without building. If Rust is chosen but the binary is missing, out of date or broken, the Explorer and Source Control use JavaScript and say so once (the toast opens Settings); they try the binary again when `vscode-settings.json` changes or a minute later.

**Rust editor (preview, opt-in).** The terminal editor also has a Rust build (`vsedit`, in the same workspace): the same screen and keys, its tokenizer on a worker thread so typing never waits for coloring, no Node start-up. Language features (TypeScript/LSP, symbols, problems), the context menu, the command palette and Go to File still need the JavaScript editor; their keys say "Not yet in the Rust editor". To try it, add `"editor.engine": "rust"` to `vscode-settings.json` and build the Rust core (Settings' **Build Rust core**, or `install.sh`): with the Rust engine chosen the build also makes `<herdr home>/vscode-core/vsedit`, which compiles Oniguruma and so needs a C compiler (`xcode-select --install`). Files open through `mods/vscode-viewer/editor/vsedit.sh`, which runs the JavaScript editor whenever the Rust one is not chosen, not built, of another launch version, or can't start. `"core.engine": "rust"` alone does not switch the editor yet.

Optional Claude meter: set Claude Code's `statusLine.command` to `sh ~/.config/herdr-app/mods/vscode-status/claude-usage-tap.sh`. If you already had a status line command, save it as `~/.config/herdr-app/claude-statusline-orig.sh`; the tap passes the input on to it.

## What it runs

- `sh`, `git`, `find` (Explorer listing and git status; Source Control repos, status, log, a commit's files, and `git add -A` + `git commit` when you commit; the diff tab's `git cat-file blob`)
- `node` (diff tab colors: `mods/vscode-diff/tokens.cjs` with the engine in `mods/vscode-viewer/vscode/`)
- `sh mods/vscode-viewer/editor/vsedit.sh` (opens the terminal editor: `<herdr home>/vscode-core/vsedit` with `"editor.engine": "rust"` when built, else `node vsedit.cjs`)
- `node` (the terminal editor; must be on PATH), `pbcopy`/`pbpaste` (its clipboard), `herdr-app do terminal.right_click` (so right-clicks reach it), `git ls-files` (quick open)
- Language servers, started on first use and stopped when the editor closes: `tsserver` (TypeScript/JavaScript; the project's `node_modules/typescript` first, else the one on PATH), `rust-analyzer`, `clangd`, `sourcekit-lsp`, and VS Code's JSON/CSS/HTML servers bundled in Devin.app (`node …/json-language-features/server/dist/node/jsonServerMain.js --stdio`, likewise css and html)
- Without a server: `git grep` / `grep -r` (Go to Definition and references by word), `gofmt`, `rustfmt`, `prettier` (Format Document)
- `cp`, `mv`, `mkdir`, `test`, `pbcopy`, `trash` or `osascript` (Explorer menu)
- With `"core.engine": "rust"` only: `<herdr home>/vscode-core/vscode-core` (`--version`, `tree`, `repos`, `repo`, `commit-files`, `all`; it runs `git` itself), instead of the Explorer's and Source Control's `sh`/`find`/`git` reads
- `node mods/vscode-viewer/editor/keybindings.cjs --table` (Settings: the Keyboard Shortcuts table, when it opens and when `vscode-keybindings.json` changes)
- `<herdr home>/vscode-core/vscode-core --version` (Settings: Rust core status), `sh` + `mods/vscode-settings/native/install.sh` → `cargo` (Build Rust core, only when you click it)
- `code` (Open in VS Code), `open` (Finder, Reveal in Finder, System Default)
- `stat`, `cp`, `sips` (image preview: copies the image into `mods/vscode-viewer/.cache/`)
- `node` + `codex app-server` (Codex usage and limit resets, with your Codex login: it reads every 5 min and redeems a reset only when you click Use a reset and confirm)
- `grep` over `~/.codex/sessions` (Codex usage when the app-server is unavailable)

Only `codex app-server` reaches the network (OpenAI, as Codex itself does).

## Credits

- Icons from [Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme) (MIT).
- Colors from [Atom One Dark](https://github.com/akamud/vscode-theme-onedark) (MIT).
- File-type data and TextMate grammars from VS Code's built-in extensions (MIT); [vscode-textmate](https://github.com/microsoft/vscode-textmate) and [vscode-oniguruma](https://github.com/microsoft/vscode-oniguruma) (MIT).
