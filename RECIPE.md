# VS Code

Herdr's main layout turned into a VS Code–style workbench: a file explorer with Material Icon Theme icons, VS Code's git colors and VS Code's right-click menu, and a Source Control panel (repositories, changes, commit graph) on the right; code files opening in their own terminal tab in a VS Code-like editor painted by VS Code's own tokenizer with Atom One Dark, images and markdown in a viewer tab, and changes as a VS Code-style diff tab; a pane menu that opens the folder in VS Code or Finder; and a status bar that shows how much of the Claude and Codex usage windows is left, with Codex limit resets.

![VS Code](preview.png)

## What you see

- **Left sidebar** (268px, 44–480): Herdr's own brand row (46px), spaces and agents lists (equal weights, min 90px each), footer (69px). Unchanged from Herdr's main layout.
- **Tab bar** (42px, `vscode-tabs`): Herdr's tabs, then on the right `+`, **Explorer** (folder icon) and **Source Control** (Herdr's changes icon) buttons; the active panel's button has the `selected` background.
- **Work area** (padding 8, gap 8): the active tab's panes (radius 10, 1px `border`, `accent` focus ring, 30px pane header).
- **Right panel** (368px, 280–900, a stack):
  - **Explorer** (`vscode-explorer`): header "Explorer" + folder name (36px, semibold 13px). A tree of the project you work in: the focused terminal's folder, 22px rows, 12px indent per level, chevron 12px, Material Icon Theme icon 16px (file name → extension → default; folders have open/closed icons).
    - Git colors as VS Code: modified `#e2c08d`, untracked/added `#73c991`, deleted `#c74e39`, conflict `#e4676b`. Files show the color on the name plus the letter (`M U A D !`); folders show it on the name plus a 6px dot. Folders take the worst state below them; deletions don't bubble up.
    - It also finds git repos nested up to 3 levels below the folder (up to 200) and merges their status, so a folder of projects shows which project has changes.
  - **Source Control** (`vscode-scm`): header "Source Control" (36px, semibold 13px), then three collapsible sections. Each section header is 22px: chevron 14px, uppercase 11px bold title, details on the right, 1px `border` line above. Rows are 22px.
    - **Repositories** (count badge): every git repo under the project you work in — the focused terminal's folder; editor and diff tabs keep the space's last one, and a fresh space starts at its first terminal's folder: the folder's own repo plus repos nested up to 3 levels (200 at most), up to 5 rows visible then scrolling. A row: 6px `accent` dot when selected (row on `selected`), repo folder name, branch icon 12px, branch (short hash when detached) with `*` when dirty, and `↑n ↓m` when the branch has an upstream.
    - **Changes** (repo name and file-count badge): a 28px commit message input (`surface`, `accent` border while typing, placeholder "Message (Enter to commit)"), a 28px full-width **✓ Commit on <branch>** button (`solid` when there is a message, else `raised`), then the changed files, up to 8 rows visible: file name in its git color (deleted ones struck through), the folder dimmed, the letter on the right. Colors and letters as the Explorer: `M` `#e2c08d`, untracked `U` / added `A` `#73c991`, `D` `#c74e39`, conflict `!` `#e4676b`. A clicked file opens a diff tab (`HEAD` ↔ working tree).
    - **Graph** (`<branch> · <upstream>` on the right): takes the remaining height. One 22px row per commit (newest 300): a lane column (12px per lane, at most 12 lanes drawn) with 2px lines, horizontal links where branches join or split, and an 8px dot (a ring for merge commits), lane colors `#ffb000 #dc267f #994f00 #40b0a6 #b66dff` (VS Code's scmGraph colors) by lane; then the subject (semibold on the HEAD commit), up to 2 ref chips (16px, radius 8, 10px: branches with the lane color border and 20% fill, tags on `raised`; `+n` for more), and the author dimmed. An expanded commit (row on `selected`) lists its changed files below it, 22px rows: the lanes that continue below the commit drawn at full height, a 10px indent, the Material icon 16px (file name → extension → default, the Explorer's table), the name in its git color (struck through when deleted), the folder dimmed, the letter on the right (`M` `#e2c08d`, `A` `#73c991`, `D` `#c74e39`, renamed `R` `#73c991`; copies show `A`, type changes `M`). "Loading…" or "No changed files" while there are none.
- **Status bar** (28px, `vscode-status`): machine, branch and agent count on the left. On the right, one group per provider:
  - Claude (orange glyph) and Codex (blue-violet glyph without its white tile).
  - Each usage window shows: time to reset (session `3h 25m`; weekly `4d 21h`, `5h 10m` once under a day), a 40×5px bar (green `ansi2` < 70%, yellow `ansi3` 70–90%, red `ansi1` ≥ 90%), the percent.
  - Codex credit balance (e.g. `29,412`).
  - Hovering a group opens a 250px card with each window's name, `N% used`, a full-width bar and `resets 11/12 19:00 (4d 21h left)`.
  - The Claude card ends with a **Reset limits ↗** button that opens `https://claude.ai/settings/usage` (Claude Code has no API for limit resets).
  - The Codex card ends with a **Limit resets** row (`N available`), one dimmed 11px line per available credit (`expires 12/1 04:22`, or `no expiry`), and a full-width 26px **Use a reset** button (dimmed and inert at 0 or while redeeming, when it reads **Redeeming…**). Without the `codex` CLI it shows **Reset limits ↗** to `https://chatgpt.com/codex/settings/usage` instead.
- **Diff tab** (`vscode-diff`, opened from Source Control), named `<file> (<parent short hash>) ↔ <file> (<short hash>)` (the old name on the left for renames; `∅` for a root commit's parent), or `<file> (HEAD) ↔ <file> (Working Tree)` from Changes:
  - Header (30px): breadcrumbs of the last 3 folders `›` the file with its Material icon, then `<old short> ↔ <new short>` (11.5px, `dim`), then ghost buttons **Open File** and **Open in VS Code** (local only).
  - One inline column on `#282c34`, editor font 13px, 20px rows: old and new line numbers (two 44px gutters, `#636d83`), the sign (`-`/`+`), then the text. Removed lines on `#e06c7520`, added on `#98c37920`, removed before added in each change. Tabs show as 4 spaces. Long lines scroll sideways.
  - Unchanged runs keep 3 lines of context around each change; 3 or more hidden lines fold into one `⋯ N unchanged lines` row (`#2c313c`, text `#7f848e`).
  - Text colors are VS Code's own (vscode-textmate + oniguruma, its TextMate grammars and Atom One Dark, from `vscode-viewer/vscode/`), with italic, bold and underline; plain `#abb2bf` without node or the engine, or for remote repos.
  - Messages instead of the diff: `Loading diff…`, `Binary file · no text diff`, `File too large to diff`, `Empty file`.
- **Editor tab** (`vscode-viewer`, opened from the Explorer or a diff tab's Open File):
  - **Right-click menu** (270px popup, 26px rows, separators like VS Code, shortcut hints as labels only):
    - Folder: **New File…**, **New Folder…** | **Reveal in Finder** `⌥⌘R`, **Open in Integrated Terminal** | **Cut** `⌘X`, **Copy** `⌘C`, **Paste** `⌘V` (only after Cut/Copy) | **Copy Path** `⌥⌘C`, **Copy Relative Path** `⇧⌥⌘C` | **Rename…** `↵`, **Delete** `⌘⌫`.
    - File: **Open Preview**, **Open With…** (VS Code Editor (terminal), Herdr Editor (viewer), Open in VS Code, System Default) in place of New File/Folder; the rest as for a folder.
    - Right-clicking empty space in the tree opens the folder menu for the root. Remote folders show only Open Preview and the two Copy Path items.
    - Rename/New open a 440px dialog with a name field (Rename selects the name without its extension); Delete asks "Are you sure you want to delete '<name>'?" with **Move to Trash**.
- **Terminal editor** (`vscode-viewer/editor/vsedit.cjs`, a terminal tab opened from the Explorer for code/text files):
  - Top line: breadcrumbs `folder › folder › file` relative to the enclosing git repo (else the home folder), `●` in `#e5c07b` when dirty.
  - Text on `#282c34`, default `#abb2bf`, every visible line colored by vscode-textmate with the akamud Atom One Dark 2.3.0 theme (24-bit SGR, italic/bold/underline/strikethrough from the theme). Gutter numbers `#636d83`, active `#abb2bf`; current line `#2c313c` (when nothing is selected); selection `#3e4451`; current find match `#42557b`, other matches `#324365` (`editor.findMatchHighlightBackground` over the background). Opaque `colors` from `theme.json` override these. Bar cursor in `#528bff`.
  - No word wrap; tabs shown to the file's indent size; CJK, Hangul and emoji are 2 columns wide; control characters show as control pictures (`␉`-style).
  - Bottom status bar (`#21252b`/`#9da5b4`): messages on the left (Saved, Find: 3 of 12, errors); on the right `Ln X, Col Y (N selected)`, `Spaces: N` or `Tab Size: N`, `UTF-8` (`UTF-8 with BOM`), `LF`/`CRLF`, VS Code's language name (Plain Text when there is no grammar).
  - Find widget (48 columns, top right) with Find and, for replace, Replace fields; Go to line prompt on the first text row; Save/Quit/disk-change choices on the row above the status bar.
- **Viewer tab** (`vscode-viewer`, opened from the Explorer for images, markdown and remote files, or with Open With → Herdr Editor):
  - Header (30px): breadcrumbs of the last 3 folders `›` the file with its Material icon, then ghost buttons **Wrap**, **Revert** (only when edited), **Open in VS Code**, **Save ⌘S** / **Saved**.
  - Herdr's built-in editor on `#282c34` with text `#abb2bf`, 13px, line numbers.
  - Status strip (22px): language name (VS Code's name for the file type), line count, `Spaces: N`/`Tabs`, `UTF-8`, `LF`/`CRLF`.
  - **Images** (`png jpg jpeg gif webp bmp ico svg tif tiff`): the image centered on `#282c34` with a `#323842` 8px checkerboard, 16px padding, shrunk to fit and never enlarged. Header keeps breadcrumbs and **Open in VS Code** (no Wrap/Save). Status strip: format (`PNG`, `JPEG`, `SVG`, …), `W × H` pixels (from `sips`), size (`B`/`KB`/`MB`, one decimal).
  - **Markdown** (`md markdown mdx mkd`): opens rendered (`TextView.markdown`, 14px, padding 28/16, scrollable, selectable) with an **Edit** button; in the editor the button reads **Preview**. Wrap shows only in the editor.

## How it behaves

- **Explorer button / Source Control button** toggle the right panel and pick its page; the choice is remembered per space. `cmd-e` toggles the panel.
- **Explorer clicks:** folder = expand/collapse; code/text file = a new terminal tab named after the file running `node <herdr home>/mods/vscode-viewer/editor/vsedit.cjs <file>`, started in the Explorer's root; images (`png jpg jpeg gif webp bmp ico svg tif tiff`), markdown (`md markdown mdx mkd`) and files on a remote machine = a `vscode-viewer` tab; `cmd`+click = `code <file>`.
  - The tree follows the focused terminal's folder. While an editor, viewer or diff tab is focused it keeps the space's last project (the terminal editor tab starts in the Explorer's root, so it doesn't move the tree either); a new space starts at its first terminal's folder, else the space folder. Each project keeps its last tree and git state, so switching back shows it at once and refreshes behind it. It refreshes on file changes, every 10s and after a menu file operation, and lists at most 500 entries per folder and 5,000 in total.
- **Explorer right-click menu:**
  - Open Preview opens the file as a click does. Open With: VS Code Editor = the terminal editor, Herdr Editor = `vscode-viewer`, Open in VS Code = `code`, System Default = `open`.
  - Reveal in Finder = `open -R`. Open in Integrated Terminal = `terminal.open {folder, place: "tab"}` in the folder (a file's parent folder).
  - Cut/Copy remember the path (shared value `vscode-explorer.clipboard`); Paste goes into the right-clicked folder (a file's parent): copy = `cp -R -n`, cut = `mv -n`, then the clipboard clears. An existing name gets Finder's `name copy.ext`, `name copy 2.ext`…; nothing is overwritten, and a folder can't go into itself.
  - Copy Path / Copy Relative Path (relative to the Explorer root) go through `pbcopy`.
  - Rename/New File/New Folder refuse empty names, slashes, `.`/`..` and names that exist. New File creates it empty and opens it in the editor. Delete moves to the Trash with `trash` (macOS 15+), else Finder via `osascript`; never `rm`.
  - ↑/↓ move, Enter runs, Esc closes. Failures show in a small dialog.
- **Terminal editor** (VS Code's Linux keys, since the terminal can't receive ⌘):
  - Move: arrows, Home (first non-blank, then column 0), End, PageUp/PageDown, Ctrl+Home/End, Ctrl+←/→ or Alt+←/→ by word, Ctrl+↑/↓ scroll. Shift with any move selects. Ctrl+A selects all. Esc clears the selection.
  - Edit: typing and committed IME text (Korean included) insert at the cursor; typing groups into one undo step until the cursor moves. Backspace in leading spaces goes back to the previous tab stop; Alt+Backspace / Alt+Delete delete a word. Enter keeps the line's indentation and adds one level after `{ [ (` (splitting `{}` onto three lines). Tab inserts spaces to the next tab stop (or a tab in tab-indented files); with a multi-line selection Tab/Shift+Tab indent/outdent the lines.
  - Ctrl+/ toggles the language's line comment at the smallest indent (`//`, `#`, `--`, `;`, `%`, `@REM`, `'`), or wraps lines in `/* */`, `<!-- -->`, `{{!-- --}}` for CSS, HTML/XML/Markdown, Handlebars.
  - Ctrl+C / Ctrl+X copy/cut the selection, or the whole line when nothing is selected; the text goes to `pbcopy` and OSC 52. Ctrl+V pastes `pbpaste` (a whole copied line goes above the current line, like VS Code); the terminal's own paste arrives as bracketed paste. Ctrl+Z undo, Ctrl+Y / Ctrl+Shift+Z redo.
  - Ctrl+F find (case-insensitive, incremental from where it opened, selected text prefills): Enter/↓/F3 next, Shift+Enter/↑ previous, Esc closes and keeps the match selected. Ctrl+H adds Replace: Tab switches fields, Enter in Replace replaces and moves on, Alt+Enter replaces all (one undo step). Counts up to 20,000 matches.
  - Ctrl+G go to line (`120` or `120:5`). Ctrl+S save. Ctrl+Q quit; when dirty it asks `[S] Save [D] Don't Save [C] Cancel`.
  - Mouse: click places the cursor, drag selects, Shift+click extends, double-click selects a word, wheel scrolls 3 lines.
  - Save keeps the file's EOL (LF/CRLF), trailing newline, BOM and mode, writing a temp file next to it and renaming it over (symlinks are followed). If the file's mtime or size changed since it was loaded or saved, Ctrl+S asks `[O] Overwrite [R] Reload [C] Cancel`; Reload is one undo step.
  - A missing file opens empty and is created on save. Files over 50 MB, or with NUL bytes, print a message and exit.
  - The real terminal cursor sits at the editor cursor (or in the active prompt field), so the IME's pre-edit shows in place. The terminal is restored (main screen, cursor, mouse and paste modes off) on quit, crash and SIGTERM/SIGHUP.
  - Tokenizing is lazy (up to the bottom of the screen) and incremental: after an edit it restarts at the edited line and stops at the first later line whose rule stack equals the old one. The first screen waits up to 1s for colors; later frames spend at most 60ms and paint the rest in the default color until the next slice. Lines over 4,000 characters are not tokenized.
- **Viewer tab:**
- **Source Control:**
  - Clicking a section header collapses or expands it (remembered). Clicking a repo selects it for Changes and Graph; the choice is kept per folder while the panel lives. The default is that folder's own repo, else the first dirty repo, else the first.
  - Clicking a file in Changes opens a diff tab of `HEAD` ↔ the working tree (untracked and new files show as all added, deleted ones as all removed).
  - Clicking a commit in the Graph expands it to its changed files (against its first parent for merges); clicking it again collapses it. The expanded commits are kept across refreshes until the repo changes. Clicking a file there opens a diff tab of the parent ↔ that commit. Every click opens a new tab.
  - **Enter** in the message or the Commit button runs `git add -A` then `git commit -m <message>` in the selected repo, as Herdr's `changes` mod; errors show in `ansi1` under the button. Esc leaves the input.
  - It refreshes when files change under the folder (at most every 2s) and every 10s, and keeps its folder while an editor or diff tab is focused, so opening a file or diff tab (a mod pane with no folder) does not reload it; it follows the focused pane only in a space without a folder.
- **Editor:**
  - Typing marks the file dirty (8px `#e5c07b` dot). `cmd-s` (or Save) writes only if the file on disk is still what was loaded.
  - If the disk changed while editing, a banner offers **Reload (discard my edits)** or **Overwrite**. Untouched buffers follow the disk every 3s.
  - **Wrap** toggles soft wrap. Remote (SSH) files open read-only.
  - **Markdown:** Preview renders the editor's current text, unsaved edits included; Save and the dirty dot work in both modes.
  - **Images:** checked every 3s (`stat` mtime + size); when either changes the file is copied again and the strip updates. Remote images show "Image preview is local only".
- **Pane right-click** (`vscode-menu`): Herdr's pane menu plus **Open in VS Code** and **Open in Finder** for the pane's folder (local panes only).
- **Diff tab:** read-only. Clicking a `⋯ N unchanged lines` row shows those lines. A commit diff is read once; a working-tree diff reads the file again every 3s and redraws when it changed. **Open File** opens `<repo>/<path>` in a `vscode-viewer` tab; **Open in VS Code** runs `code <repo>/<path>`.
- **Status bar:** Codex rollout log re-read every 60s, Codex app-server every 5 min (and at start and after a reset), Claude every 10s from the statusLine file and every 5 min from Claude's usage API (`/api/oauth/usage` with the Claude Code token from the Keychain, read inside `sh` and never kept); a reply under 10 min old wins because the statusLine value lags behind claude.ai, and a refused call pauses the API for 15 min. The bars and credit balance use the app-server's numbers when its last read worked, else the log.
- **Use a reset** opens the shipped `confirm` mod as a dialog (420×180): "Use a Codex limit reset?" / "Restores the 5-hour and weekly limits now. N left after this; it cannot be undone." Confirm (or Enter) runs `vscode-status.consume-reset`; Cancel or Esc does nothing.
  - It redeems the available credit that expires first (none listed: Codex picks), with a new UUID idempotency key. A failed attempt keeps its key, so the next try retries the same attempt instead of spending a second credit. One redemption runs at a time.
  - The outcome becomes a toast: `reset` → success "Codex limits reset", `nothingToReset` → info "Nothing to reset", `noCredit` → warning "No limit resets left", `alreadyRedeemed` → success "Reset already used", an error → error "Codex limit reset failed" with the message.

## Built from

- **Layout** `layouts/vscode.json`: Herdr's main tree with `terminal_menu: "vscode-menu"`, `tabs` → `vscode-tabs`, `status` → `vscode-status`, and `panel-body` children `explorer` (`vscode-explorer`) and `changes` (`vscode-scm`). Shipped mods used as is: `workspace-chrome`, `spaces`, `agents`, `pane`. Keys: `keys.json` section `layout:vscode` (`cmd-e` → `layout.toggle:panel`, `cmd-s` → `vscode-viewer.save`).
- **`vscode-tabs`:** the shipped tabs mod plus an `explorer` panel button; the `changes` button reads "Source Control" (icon `mods/changes/changes.svg`).
  - It treats an empty `workspace.panels` as unset (an old uninstalled layout can leave `[]`, which otherwise hides every panel button).
  - It never shows a `files` button.
- **`vscode-explorer`:**
  - Runs `sh` (folder listing; `find … -maxdepth 3 -name .git` for nested repos), `git status --porcelain=v1 -z` per repo, and `code` on cmd+click. Uses `watchFolder`.
  - `icons.json` maps names/extensions/folder names to icon files, generated from Material Icon Theme 5.40.0's `material-icons.json`. `icons/` holds its 1,256 SVGs (MIT, see `LICENSE-material-icon-theme.txt`).
  - Opens code/text files with `run("tab.new", {name, folder: <Explorer root>, argv: ["node", "<appHome()>/mods/vscode-viewer/editor/vsedit.cjs", file]})`, the rest with `run("tab.new", {name, mod: "vscode-viewer", props: {file, on}})` (`paths.js`, shared with the menu).
  - The right-click menu and its dialogs (`menu.js`) are overlays of `vscode-explorer` itself (`openOverlay({mod: "vscode-explorer", kind: "popup" | "dialog", props: {menu} | {dialog}})`), because a mod can't import another mod's files. They run `open`, `cp`, `mv`, `mkdir`, `test`, `pbcopy`, `trash`/`osascript`, `code` and `writeTextFile`, and ask the tree to reload through the shared value `vscode-explorer.refresh`. Tests: `node --test mods/vscode-explorer/test/paths.test.mjs`.
- **`vscode-scm`:**
  - Repos: one `sh` script runs `git rev-parse --show-toplevel`, `find "$1" -maxdepth 3 -name .git -prune | head -200`, then for each repo `git status --porcelain=v2 --branch --untracked-files=normal | head -n 5` (branch, upstream, ahead/behind; one entry line means dirty).
  - Selected repo: `git status --porcelain=v1 -z --no-renames --untracked-files=all` (first 1,000 files), `git log --topo-order --date-order -n 300` with `%H %P %D %s %an %ar` split by NUL and `0x1e`, over `HEAD` plus the upstream when `branch.ab` shows it exists. Commit logic is copied from the shipped `changes` mod.
  - An expanded commit: `git show --name-status -z --format= -M -m --first-parent <hash>` (first 1,000 files), parsed with renames/copies carrying the old path. Icons: `<herdr home>/mods/vscode-explorer/icons.json` and `mods/vscode-explorer/icons/<icon>.svg`.
  - Files open with `run("tab.new", {name, mod: "vscode-diff", props: {repo, commit, parent, path, oldPath?, on}})` (`commit: null, parent: "HEAD"` for the working tree).
  - Lanes are computed in JS: each lane waits for the commit it leads to; per row it records which lanes have a top half and a bottom half line and which lanes link to the node. Lines, links and dots are absolutely placed `div`s.
  - `v_virtual_list` + `Scrollbar.vertical` for the graph, its clicks through `on_item_click` with keys `c:<hash>` and `f:<hash>:<path>`; `InputState`/`Input` for the message; `watchFolder` on the repo top (or the folder); `localStorage` for collapsed sections. Icons: `branch.svg` (Lucide git-branch), `chevron-down.svg`, `chevron-right.svg`.
- **`vscode-viewer`:**
  - `EditorState`/`Editor` from `gpui-base`, `readTextFile`/`writeTextFile(path, text, expected)` for conflict-safe saves, and `nextCommand()` for `save`. Runs `code` from the Open in VS Code button.
  - `langs.json`: file type → the closest grammar the built-in editor has, from the language contributions of VS Code's built-in extensions.
  - `vscode/`: VS Code's tokenizer, vendored. `lib/textmate.js` (vscode-textmate), `lib/oniguruma.js` + `lib/onig.wasm` (vscode-oniguruma), 103 TextMate grammars in `grammars/` from VS Code's built-in extensions, `theme.json` (akamud Atom One Dark 2.3.0), `index.json` (file name → scope: exact name, name prefix, longest extension), `tokenize.cjs` (reference CLI: file → colored tokens as JSON). Licenses: `LICENSE-vscode-textmate.md`, `LICENSE-vscode-oniguruma.txt`.
  - `palettes.json`: per-extension role colors (see Watch out). It reads `../vscode-explorer/icons.json` for the breadcrumb icon.
  - Markdown: `TextView.markdown(id, text)` from `gpui-base`. Images: `image()`, `Background.checkerboard` painted with `window.paint_path`; runs `sh` (`stat`, `mkdir`/`rm`/`cp` into `<herdr home>/mods/vscode-viewer/.cache/<path hash>-<mtime>-<size>.<ext>`, older copies of the same file removed) and `sips` for pixel size.
- **`vscode-diff`:**
  - Sides: `git cat-file blob <parent>:<old path>` and `<commit>:<path>` (a failing read is an empty side), the working tree with `readTextFile`.
  - `diff.js`: Myers' line diff (common prefix/suffix trimmed first; past 2,000 edits the middle shows as removed then added) and the fold rows. Up to 20,000 lines per side and 8 MiB output.
  - `tokens.cjs`: the `tokenize.cjs` engine code as a helper, `node tokens.cjs <engine dir> <file name> [file] [maxLines]` (text on stdin without a file) printing `{colors, lines: [[text, colorIndex, fontStyle, …]]}`. Run as `git cat-file blob <rev> | node …` through `sh`, or with the working-tree file, engine `<herdr home>/mods/vscode-viewer/vscode`.
  - `v_virtual_list` inside an `overflow_x_scrollbar` box with `Scrollbar.vertical`; fold clicks through `on_item_click` (`fold:<index>`). Runs `code` from Open in VS Code.
- **`vscode-viewer/editor/`** (the terminal editor, Node.js, no dependencies): `vsedit.cjs` (terminal, input, drawing, commands), `keys.cjs` (xterm/CSI-u/modifyOtherKeys keys, SGR 1006 mouse, bracketed paste), `buffer.cjs` (lines, edits, undo/redo), `highlight.cjs` (vscode-textmate registry, theme color map, per-line rule stacks), `width.cjs` (East Asian Wide/Fullwidth + emoji widths, tabs), `language.cjs` (scope lookup, VS Code language names, comment tokens), `file.cjs` (decode/encode, indent guess, atomic save, disk-change check). Colors come from `tokenizeLine2` metadata: foreground `(meta & 0x00ff8000) >>> 15`, font style `(meta & 0x00007800) >>> 11`.
  - Tests: `node --test mods/vscode-viewer/editor/test/unit.test.cjs`; end-to-end in a 100×30 pseudo-terminal (types ASCII and `한글`, saves, quits, compares painted SGR colors with `tokenize.cjs`): `python3 -I mods/vscode-viewer/editor/test/e2e.py`.
- **`vscode-status`:**
  - Codex usage comes from `codex-limits.mjs` (run with `node`), which starts `codex app-server` (or `$CODEX_BIN`) and speaks its JSON-RPC over stdio: `initialize` (clientInfo `herdr-vscode-status` 0.1.0), `initialized`, then one request. It kills the child after the answer or 20s.
    - `node codex-limits.mjs read` → `account/rateLimits/read`, printed as `{rate_limits: {primary, secondary: {used_percent, window_minutes, resets_at}, credits: {balance, has_credits, unlimited}}, ordinaryUsageAllowed, resets: {availableCount, credits: [{id, description, expiresAt, status}] | null}}` (the rollout-log shape, so both parse the same).
    - `node codex-limits.mjs consume <creditId> <idempotencyKey>` → `account/rateLimitResetCredit/consume {creditId, idempotencyKey}` (`""` sends `creditId: null`), printed as `{outcome}`: `reset`, `nothingToReset`, `noCredit` or `alreadyRedeemed`.
    - Exit codes: 0 ok, 1 usage, 2 error or timeout, 3 `codex` not found (message on stderr).
  - Fallback for the bars: the newest `~/.codex/sessions/**/rollout-*.jsonl` that has a `rate_limits` event (`sh` + `grep`). Claude usage comes from `<herdr home>/claude-usage.json`, written by `claude-usage-tap.sh`.
  - `nextCommand()` loop for `consume-reset`; `openOverlay` with the shipped `confirm` mod; `notify` for the outcome.
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
- **Assumptions.** The VS Code `code` CLI (Shell Command: Install 'code' in PATH) and macOS `open` are assumed. The Claude meter needs the statusLine tap and shows `–` until Claude Code has refreshed its status line once. Codex needs `node` and the `codex` CLI signed in (else only local session logs, and no Use a reset).
- **PATH.** Herdr starts with `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, so every launch of `node`, `code`, `codex` and `trash` goes through `sh` with `/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin` in front. Tools elsewhere (e.g. nvm without a link in those folders) aren't found from the panels; the terminal editor tab runs in your own shell and isn't affected.
- **Limit resets spend real credits.** `consume` cannot be undone; it runs only after Confirm in the dialog. The app-server list of credits may be capped or missing (`credits: null`), so the row count can be less than `N available`.
- **Source Control.** Git reads use `--no-optional-locks -c core.fsmonitor=false` so polling writes no lock files (otherwise the folder watch refreshes itself forever). It never pushes, fetches or switches branches; ahead/behind is as of the last fetch. Graph links are straight horizontal lines, not VS Code's curves; lanes past 12 are not drawn. Limits: 200 repos, 300 commits, 1,000 files (per commit too). Remote (SSH) folders refresh on the 10s timer only.
- **Terminal editor.** Node.js must be on PATH in your login shell (the tab runs `node`). The terminal can't receive ⌘, so its shortcuts are Ctrl (Ctrl+S, Ctrl+F, …), like VS Code on Linux. Ctrl+Shift+Z needs a terminal that reports it (CSI-u or modifyOtherKeys); Ctrl+Y always works. Shift+Enter in Find needs the same, else use ↑. Emoji joined with ZWJ are measured per code point, so some terminals draw them narrower than the editor expects. Jumping to the end of a large file colors it over a few frames (about 4s for 21,000 lines of TypeScript), the text is editable meanwhile.
- **Explorer menu.** File operations are local only. Delete needs `trash` or Finder automation permission for `osascript`. The shortcut hints are labels; the keys aren't bound.
- **Viewer limits.** It opens files up to 1 MiB. With `line_numbers: false` the editor scrolls 4 columns left; keep line numbers on.
- **Changing the mods.** Herdr replaces shipped mods and layouts on every start (edits move to `<name>-edited`). That is why everything here is a separately named mod; don't edit the shipped ones.

## Done when

- `herdr-app check` passes for each of the seven mods, and `layout.switch {name: "vscode"}` shows no errors in `herdr-app status`.
- The tab bar shows Explorer and Source Control. Explorer lists the focused folder with Material icons, and a modified file in a git repo is `#e2c08d` with `M`.
- Source Control on a folder holding several repos lists them all with branch and `*` on the dirty ones; selecting one shows its changed files and a graph whose HEAD commit carries its branch chip. Typing a message and pressing Enter commits, and the file list empties.
- Clicking a commit in the Graph lists its files with icons and letters under it, the lanes running through; clicking a modified `.js` file there opens `main.js (<parent>) ↔ main.js (<hash>)` with red and green lines in VS Code colors and `⋯ N unchanged lines` rows that expand on click. Clicking a file in Changes opens `<file> (HEAD) ↔ <file> (Working Tree)`.
- Clicking a `.png` shows it centered on the checkerboard with `PNG`, `W × H` and its size in the strip. Clicking `README.md` shows it rendered; Edit opens the editor, and an unsaved edit appears after Preview.
- Clicking a `.ts` file opens a terminal tab whose status bar says `TypeScript` and whose `import` is `#c678dd`. Typing `한글` puts the cursor 4 columns further; Ctrl+S shows Saved and writes the file with its line endings; Ctrl+Q closes the tab.
- Clicking a `.md` or `.png` file opens a `vscode-viewer` tab, and the Explorer root doesn't change.
- Right-clicking a file shows the menu above; Copy then Paste on its folder makes `name copy.ext`; Delete moves it to the Trash.
- With a Codex session log present, the status bar shows the Codex glyph with two bars and a credit number; hovering shows the card with reset times.
- `node mods/vscode-status/codex-limits.mjs read` prints `resets.availableCount`; the Codex card shows `N available`, an expiry line per credit and **Use a reset**, which opens the confirm dialog (test `consume` only against a fake `CODEX_BIN`).
- Right-clicking a pane shows Open in VS Code and Open in Finder; Finder opens the pane's folder.
