# herdr-layout-vscode

A VS Code–style layout for [Herdr](https://herdr.dev):

- **Explorer:** Material Icon Theme icons and VS Code git colors, including repos nested in the folder.
- **Source Control:** every repo under the folder, changes and commit, and a commit graph whose commits expand to their files.
- **Diff tab:** VS Code-style inline diff with VS Code's own syntax colors.
- **Editor:** files open in their own tab as an Atom One Dark editor; images open as a preview, markdown opens rendered with an Edit toggle.
- **Pane menu:** Open in VS Code / Finder.
- **Status bar:** Claude and Codex usage meters.

See [RECIPE.md](RECIPE.md) for exactly what it does and how it is built.

## Install

Ask your agent in Herdr: *"add the layout from github.com/garhidiba/herdr-layout-vscode"*. It follows Herdr's own install steps.

To install by hand:

1. Copy `layouts/vscode.json` into `~/.config/herdr-app/layouts/` and the `mods/*` folders into `~/.config/herdr-app/mods/`.
2. Merge `keys.json` into yours.
3. Run `herdr-app check` on each mod.
4. Switch with `ctrl-shift-l`, or run `herdr-app do layout.switch --name vscode`.

Optional Claude meter: set Claude Code's `statusLine.command` to `sh ~/.config/herdr-app/mods/vscode-status/claude-usage-tap.sh`. If you already had a status line command, save it as `~/.config/herdr-app/claude-statusline-orig.sh`; the tap passes the input on to it.

## What it runs

- `sh`, `git`, `find` (Explorer listing and git status; Source Control repos, status, log, a commit's files, and `git add -A` + `git commit` when you commit; the diff tab's `git cat-file blob`)
- `node` (diff tab colors: `mods/vscode-diff/tokens.cjs` with the engine in `mods/vscode-viewer/vscode/`)
- `code` (Open in VS Code), `open` (Finder)
- `stat`, `cp`, `sips` (image preview: copies the image into `mods/vscode-viewer/.cache/`)
- `grep` over `~/.codex/sessions` (Codex usage)

Nothing reaches the network.

## Credits

- Icons from [Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme) (MIT).
- Colors from [Atom One Dark](https://github.com/akamud/vscode-theme-onedark) (MIT).
- File-type data from VS Code's built-in extensions (MIT).
