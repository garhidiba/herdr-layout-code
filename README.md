# herdr-layout-vscode

A VS Code–style layout for [Herdr](https://herdr.dev):

- **Explorer:** Material Icon Theme icons and VS Code git colors, including repos nested in the folder.
- **Source Control:** every repo under the folder, changes and commit, and a commit graph whose commits expand to their files.
- **Diff tab:** VS Code-style inline diff with VS Code's own syntax colors.
- **Editor:** code files open in a terminal tab in a VS Code-like editor colored by VS Code's own tokenizer (Atom One Dark), with VS Code's right-click menu, command palette, quick open, git change bars and folding, a find widget with Match Case / Whole Word / Regex and Replace, Save As / Save All, Expand Line Selection, Join Lines, Toggle Block Comment, Go to Bracket, Find With Selection, word wrap (VS Code's `editor.wordWrap` modes and break rules, ⌥Z or the status bar's Wrap item toggles it), clickable status bar items (go to line, indentation, line endings, language mode), symbol breadcrumbs and Go to Symbol (in the file and the workspace), error/warning underlines and overview ruler marks with F8, Quick Fix with a light bulb, hovers (keys and mouse), Expand / Shrink Selection, Format Selection, Cursor Undo, line comments as VS Code's, VS Code's default keys for macOS, Windows or Linux (whichever it runs on, two-step chords like ⌘K ⌘J included), Go to Definition / References / Rename / Format through tsserver and language servers, AI inline suggestions (gray ghost text from a local Ollama model, Tab to accept), a save dialog, hot exit and auto save; minified one-line files are colored too; binary files open in a hex viewer; a file that can't be opened shows an error page in the tab, and the tab closes with the editor; every file but an image or a video opens in it (text is told by content, as VS Code does, so `.env`, `Dockerfile` or an unknown extension open as text), Markdown too, with Open Preview in the Explorer's menu; images and videos open in a viewer tab, from a remote space too.
- **Spaces list:** each space shows the icons of the agents running in it (Claude Code, Codex, …) next to its ahead/behind commit counts.
- **Explorer menu:** VS Code's right-click menu (new, open with, reveal, cut/copy/paste, copy path, rename, delete to Trash), on remote spaces too (run on that machine; Open in VS Code through Remote-SSH).
- **Editor tab menu:** a file tab's right-click is VS Code's tab menu (close, close others / to the right / saved / all, copy path, reopen with, reveal in Finder / Explorer view, split right), with the OS's keys; on remote spaces too.
- **Pane menu:** Open in VS Code / Finder.
- **Status bar:** Claude and Codex usage meters; Codex limit resets can be redeemed from the card; a gear for Settings.
- **Settings:** a VS Code-style dialog (gear, `cmd-,`, or the editor's Preferences: Open Settings) for auto save, trim/final newline, format on save, tab size, inline suggestions, word wrap and the core and editor engines (JavaScript, or the optional Rust builds), with a **Keyboard Shortcuts** page (or the editor's Preferences: Open Keyboard Shortcuts) to change, remove and reset the editor's keys.

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

**Rust editor (optional).** The terminal editor also has a Rust build (`vsedit`, in the same workspace): the same screen and keys, Go to File with several open files, Go Back / Forward, the same language features (tsserver and LSP servers, symbols, problems, quick fixes, hover), context menu and command palette, its tokenizer and every language server request off the input thread so typing never waits, no Node start-up, and semantic colors for themes that turn `semanticHighlighting` on. The editor's engine follows the core's (Settings' **Editor: Engine** picks one for the editor alone; `"editor.engine"` in `vscode-settings.json`), and **Build Rust core** (or `install.sh`) also makes `<herdr home>/vscode-core/vsedit` when a Rust engine is chosen; it compiles Oniguruma and so needs a C compiler (`xcode-select --install`). Files open through `mods/vscode-viewer/editor/vsedit.sh`, which runs the JavaScript editor whenever the Rust one is not chosen, not built, of another launch version, or can't start. POSIX only (macOS, Linux): Windows keeps the JavaScript editor.

**Remote spaces.** A code file in a space on another machine opens in the Rust editor *on that machine*, as VS Code Remote does, so its language servers, quick open and git gutter see the project there: Linux (aarch64, x86_64) and macOS machines. Build the bundles once on this computer: `sh mods/vscode-settings/native/build-remote.sh` (into `<herdr home>/vscode-core/remote/`; needs `rustup target add aarch64-unknown-linux-musl x86_64-unknown-linux-musl aarch64-apple-darwin x86_64-apple-darwin x86_64-pc-windows-gnu aarch64-pc-windows-gnullvm`, `brew install zig`, `cargo install cargo-zigbuild --locked`). The first such file on a machine asks to install it (about 3–5 MB, into `~/.local/share/herdr-vscode/` there, through `hc`); until then, on Windows machines (the editor's terminal layer is POSIX only; their bundle has the Rust core alone) and on other systems, remote files open in the viewer.

Optional Claude meter: set Claude Code's `statusLine.command` to `sh ~/.config/herdr-app/mods/vscode-status/claude-usage-tap.sh`. If you already had a status line command, save it as `~/.config/herdr-app/claude-statusline-orig.sh`; the tap passes the input on to it.

## What it runs

- `sh`, `git`, `find` (Explorer listing and git status; Source Control repos, status, log, a commit's files, and `git add -A` + `git commit` when you commit; the diff tab's `git cat-file blob`)
- `node` (diff tab colors: `mods/vscode-diff/tokens.cjs` with the engine in `mods/vscode-viewer/vscode/`)
- `sh mods/vscode-viewer/editor/vsedit.sh` (opens the terminal editor: `<herdr home>/vscode-core/vsedit` when the editor's engine is Rust and it is built, else `node vsedit.cjs`)
- `node` (the terminal editor; must be on PATH), `pbcopy`/`pbpaste` (its clipboard), `herdr-app do terminal.right_click` (so right-clicks reach it), `git ls-files` (quick open)
- Language servers, started on first use and stopped when the editor closes: `tsserver` (TypeScript/JavaScript; the project's `node_modules/typescript` first, else the one on PATH), `rust-analyzer`, `clangd`, `sourcekit-lsp`, VS Code's JSON/CSS/HTML servers bundled in Devin.app (`node …/json-language-features/server/dist/node/jsonServerMain.js --stdio`, likewise css and html; else `vscode-json-language-server --stdio` and its css/html siblings), `yaml-language-server --stdio`, `taplo lsp stdio`, `basedpyright-langserver --stdio` (or `pyright-langserver`), `bash-language-server start`, `gopls`, `docker-langserver --stdio`, `marksman server` — each only when installed; a missing one is offered once per language in the status bar, and its install command (`npm i -g …`, `brew install …`, `cargo install …`, `go install …`, `pipx install …`) runs in a new terminal tab (`herdr-app do terminal.open`) only when you click the offer
- Without a server: `git grep` / `grep -r` (Go to Definition and references by word), `gofmt`, `rustfmt`, `prettier` (Format Document)
- `cp`, `mv`, `mkdir`, `test`, `pbcopy`, `trash` or `osascript` (Explorer menu)
- With `"core.engine": "rust"` only: `<herdr home>/vscode-core/vscode-core` (`--version`, `tree`, `repos`, `repo`, `commit-files`, `all`; it runs `git` itself), instead of the Explorer's and Source Control's `sh`/`find`/`git` reads
- `node mods/vscode-viewer/editor/keybindings.cjs --table` (Settings: the Keyboard Shortcuts table, when it opens and when `vscode-keybindings.json` changes)
- `<herdr home>/vscode-core/vscode-core --version` (Settings: Rust core status), `sh` + `mods/vscode-settings/native/install.sh` → `cargo` (Build Rust core, only when you click it)
- On a remote space's machine: `uname`, `test` (is the editor installed), the bundle's `vsedit.sh` and `vsedit` (the editor), and, after you confirm, `hc exec -i --on <machine>` from here running `mkdir`, `mktemp`, `cat`, `sha256sum`, `tar`, `chmod`, `mv`, `rm` inside `~/.local/share/herdr-vscode/` there (Windows: `powershell` with `Get-FileHash`, `tar.exe`, `Move-Item` inside `%LOCALAPPDATA%\herdr-vscode`)
- Inline suggestions: HTTP to the provider (Ollama at `http://127.0.0.1:11434` or LM Studio at `http://127.0.0.1:1234` by default, either at an address you set, or the paid Codestral or Mercury FIM APIs with your key from the macOS keychain; `node`'s `fetch`, or `curl` from the Rust editor), only after typing pauses and never for files like `.env` or keys; `editor.inlineSuggest.provider: "off"` turns it off
- `code` (Open in VS Code), `open` (Finder, Reveal in Finder, System Default)
- `stat`, `cp`, `sips`, `qlmanage` (image and video preview: copies the image, or a Quick Look still of the video, into `mods/vscode-viewer/.cache/`, kept under 1 GB); from a remote space, `hc exec --on <machine>` running `stat` and `dd` there to fetch the image or video (up to 200 MB) into that cache first; `open` (a video's Open in Player)
- `node` + `codex app-server` (Codex usage and limit resets, with your Codex login: it reads every 5 min and redeems a reset only when you click Use a reset and confirm)
- `grep` over `~/.codex/sessions` (Codex usage when the app-server is unavailable)

Only `codex app-server` reaches the network (OpenAI, as Codex itself does), and the inline suggestion provider you choose (the default, Ollama, and LM Studio are local unless you point them at another machine; Codestral and Mercury receive the code around the cursor).

## Credits

- Icons from [Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme) (MIT).
- Tab bar panel icons (`files`, `source-control`) from [VS Code Codicons](https://github.com/microsoft/vscode-codicons) (CC BY 4.0, see `mods/vscode-tabs/LICENSE-codicons.txt`).
- Colors from [Atom One Dark](https://github.com/akamud/vscode-theme-onedark) (MIT).
- File-type data and TextMate grammars from VS Code's built-in extensions (MIT); [vscode-textmate](https://github.com/microsoft/vscode-textmate) and [vscode-oniguruma](https://github.com/microsoft/vscode-oniguruma) (MIT).
