# VS Code

Herdr's main layout turned into a VS Code–style workbench: a file explorer with Material Icon Theme icons and VS Code's git colors on the right, files opening in their own tab as an Atom One Dark editor, a right-click menu that opens the folder in VS Code or Finder, and a status bar that shows how much of the Claude and Codex usage windows is left.

![VS Code](preview.png)

## What you see

- **Left sidebar** (268px, 44–480): Herdr's own brand row (46px), spaces and agents lists (equal weights, min 90px each), footer (69px). Unchanged from Herdr's main layout.
- **Tab bar** (42px, `vscode-tabs`): Herdr's tabs, then on the right `+`, **Explorer** (folder icon) and **Changes** (branch icon) buttons; the active panel's button has the `selected` background.
- **Work area** (padding 8, gap 8): the active tab's panes (radius 10, 1px `border`, `accent` focus ring, 30px pane header).
- **Right panel** (368px, 280–900, a stack):
  - **Explorer** (`vscode-explorer`): header "Explorer" + folder name (36px, semibold 13px). A tree of the focused pane's folder, 22px rows, 12px indent per level, chevron 12px, Material Icon Theme icon 16px (file name → extension → default; folders have open/closed icons).
    - Git colors as VS Code: modified `#e2c08d`, untracked/added `#73c991`, deleted `#c74e39`, conflict `#e4676b`. Files show the color on the name plus the letter (`M U A D !`); folders show it on the name plus a 6px dot. Folders take the worst state below them; deletions don't bubble up.
    - It also finds git repos nested up to 3 levels below the folder (up to 200) and merges their status, so a folder of projects shows which project has changes.
  - **Changes**: Herdr's shipped `changes` mod (diff and commit).
- **Status bar** (28px, `vscode-status`): machine, branch and agent count on the left. On the right, one group per provider:
  - Claude (orange glyph) and Codex (blue-violet glyph without its white tile).
  - Each usage window shows: time to reset (session `3h 25m`; weekly `4d 21h`, `5h 10m` once under a day), a 40×5px bar (green `ansi2` < 70%, yellow `ansi3` 70–90%, red `ansi1` ≥ 90%), the percent.
  - Codex credit balance (e.g. `29,412`).
  - Hovering a group opens a 250px card with each window's name, `N% used`, a full-width bar and `resets 11/12 19:00 (4d 21h left)`.
- **Editor tab** (`vscode-viewer`, opened from the Explorer):
  - Header (30px): breadcrumbs of the last 3 folders `›` the file with its Material icon, then ghost buttons **Wrap**, **Revert** (only when edited), **Open in VS Code**, **Save ⌘S** / **Saved**.
  - Herdr's built-in editor on `#282c34` with text `#abb2bf`, 13px, line numbers.
  - Status strip (22px): language name (VS Code's name for the file type), line count, `Spaces: N`/`Tabs`, `UTF-8`, `LF`/`CRLF`.
  - **Images** (`png jpg jpeg gif webp bmp ico svg tif tiff`): the image centered on `#282c34` with a `#323842` 8px checkerboard, 16px padding, shrunk to fit and never enlarged. Header keeps breadcrumbs and **Open in VS Code** (no Wrap/Save). Status strip: format (`PNG`, `JPEG`, `SVG`, …), `W × H` pixels (from `sips`), size (`B`/`KB`/`MB`, one decimal).
  - **Markdown** (`md markdown mdx mkd`): opens rendered (`TextView.markdown`, 14px, padding 28/16, scrollable, selectable) with an **Edit** button; in the editor the button reads **Preview**. Wrap shows only in the editor.

## How it behaves

- **Explorer button / Changes button** toggle the right panel and pick its page; the choice is remembered per space. `cmd-e` toggles the panel.
- **Explorer clicks:** folder = expand/collapse; file = opens a new tab named after the file with `vscode-viewer`; `cmd`+click = `code <file>`.
  - The tree follows the focused pane's folder, refreshes on file changes and every 10s, and lists at most 500 entries per folder and 5,000 in total.
- **Editor:**
  - Typing marks the file dirty (8px `#e5c07b` dot). `cmd-s` (or Save) writes only if the file on disk is still what was loaded.
  - If the disk changed while editing, a banner offers **Reload (discard my edits)** or **Overwrite**. Untouched buffers follow the disk every 3s.
  - **Wrap** toggles soft wrap. Remote (SSH) files open read-only.
  - **Markdown:** Preview renders the editor's current text, unsaved edits included; Save and the dirty dot work in both modes.
  - **Images:** checked every 3s (`stat` mtime + size); when either changes the file is copied again and the strip updates. Remote images show "Image preview is local only".
- **Pane right-click** (`vscode-menu`): Herdr's pane menu plus **Open in VS Code** and **Open in Finder** for the pane's folder (local panes only).
- **Status bar:** Codex usage re-read every 60s, Claude every 10s.

## Built from

- **Layout** `layouts/vscode.json`: Herdr's main tree with `terminal_menu: "vscode-menu"`, `tabs` → `vscode-tabs`, `status` → `vscode-status`, and `panel-body` children `explorer` (`vscode-explorer`) and `changes` (shipped `changes`). Shipped mods used as is: `workspace-chrome`, `spaces`, `agents`, `pane`, `changes`. Keys: `keys.json` section `layout:vscode` (`cmd-e` → `layout.toggle:panel`, `cmd-s` → `vscode-viewer.save`).
- **`vscode-tabs`:** the shipped tabs mod plus an `explorer` panel button.
  - It treats an empty `workspace.panels` as unset (an old uninstalled layout can leave `[]`, which otherwise hides every panel button).
  - It never shows a `files` button.
- **`vscode-explorer`:**
  - Runs `sh` (folder listing; `find … -maxdepth 3 -name .git` for nested repos), `git status --porcelain=v1 -z` per repo, and `code` on cmd+click. Uses `watchFolder`.
  - `icons.json` maps names/extensions/folder names to icon files, generated from Material Icon Theme 5.40.0's `material-icons.json`. `icons/` holds its 1,256 SVGs (MIT, see `LICENSE-material-icon-theme.txt`).
  - Opens files with `run("tab.new", {name, mod: "vscode-viewer", props: {file, on}})`.
- **`vscode-viewer`:**
  - `EditorState`/`Editor` from `gpui-base`, `readTextFile`/`writeTextFile(path, text, expected)` for conflict-safe saves, and `nextCommand()` for `save`. Runs `code` from the Open in VS Code button.
  - `langs.json`: file type → the closest grammar the built-in editor has, from the language contributions of VS Code's built-in extensions.
  - `vscode/index.json`: file type → VS Code TextMate scope, used for the language name.
  - `palettes.json`: per-extension role colors (see Watch out). It reads `../vscode-explorer/icons.json` for the breadcrumb icon.
  - Markdown: `TextView.markdown(id, text)` from `gpui-base`. Images: `image()`, `Background.checkerboard` painted with `window.paint_path`; runs `sh` (`stat`, `mkdir`/`rm`/`cp` into `<herdr home>/mods/vscode-viewer/.cache/<path hash>-<mtime>-<size>.<ext>`, older copies of the same file removed) and `sips` for pixel size.
- **`vscode-status`:**
  - Codex usage comes from the newest `~/.codex/sessions/**/rollout-*.jsonl` that has a `rate_limits` event (`sh` + `grep`, no network). Claude usage comes from `<herdr home>/claude-usage.json`, written by `claude-usage-tap.sh`.
  - Wire the tap in as Claude Code's `statusLine.command` (`sh <herdr home>/mods/vscode-status/claude-usage-tap.sh`). It saves `rate_limits` from the statusLine input and then runs `<herdr home>/claude-statusline-orig.sh` with the same input, if present.
  - Uses `HoverCard` from `gpui-base`. Icons: `claude.svg`, `codex.svg`.
- **`vscode-menu`:** the shipped menu plus two pane items that call `exec("code", [cwd])` and `exec("open", [cwd])`.

## Watch out

- **Editor colors.** Herdr's editor colors only 10 syntax roles (keyword, string, comment, function, type, number, constant, variable, operator, punctuation). `boolean`, `string.escape` and every finer key are ignored, so it cannot reproduce Atom One Dark exactly.
  - `palettes.json` was calibrated per extension: real files were tokenized with VS Code's engine and the akamud Atom One Dark theme, Herdr's editor was rendered with a unique color per role, and each role took the VS Code color most of its characters have.
  - A role changes only when that color has ≥ 45% share and leads the base color by 20 points. Comments always stay `#5c6370`.
  - Character match vs VS Code went from 59.0% to 68.1% overall (Python 56→85%, Shell 60→85%, C 67→88%, CSS 38→75%). TSX stays ~62%: function calls, JSX tags and globals share one role.
  - For exact colors use Open in VS Code.
- **Image preview.** `image()` only loads paths inside the Herdr app folder, so each image is copied into the hidden `.cache/` folder (hidden files don't trigger a mod reload; `.cache/` is git-ignored). The last copy per file stays after its tab closes. Pixel size needs macOS `sips`; elsewhere it is left out.
- **No HTML preview.** Herdr has no webview; `TextView` renders markdown (and simple HTML) without CSS or scripts, so `.html` files open in the editor only.
- **Editor limits.** It opens files up to 1 MiB. With `line_numbers: false` the editor scrolls 4 columns left; keep line numbers on.
- **Assumptions.** The VS Code `code` CLI (Shell Command: Install 'code' in PATH) and macOS `open` are assumed. The Claude meter needs the statusLine tap and shows `–` until Claude Code has refreshed its status line once. Codex needs local session logs.
- **Changing the mods.** Herdr replaces shipped mods and layouts on every start (edits move to `<name>-edited`). That is why everything here is a separately named mod; don't edit the shipped ones.

## Done when

- `herdr-app check` passes for each of the five mods, and `layout.switch {name: "vscode"}` shows no errors in `herdr-app status`.
- The tab bar shows Explorer and Changes. Explorer lists the focused folder with Material icons, and a modified file in a git repo is `#e2c08d` with `M`.
- Clicking a `.ts` file opens a tab whose status strip says `TypeScript`. Editing shows the dot. `cmd-s` writes the file and the button returns to Saved.
- Clicking a `.png` shows it centered on the checkerboard with `PNG`, `W × H` and its size in the strip. Clicking `README.md` shows it rendered; Edit opens the editor, and an unsaved edit appears after Preview.
- With a Codex session log present, the status bar shows the Codex glyph with two bars and a credit number; hovering shows the card with reset times.
- Right-clicking a pane shows Open in VS Code and Open in Finder; Finder opens the pane's folder.
