# `vsedit --serve` protocol

The native editor mod (`mods/vscode-editor-native`) draws; `vsedit --serve` is the editor. The server owns the
buffer, undo, selection, commands (`keymap.json`), find/replace, folds, git gutter, problems and inline suggestions,
the same code as the terminal editor without its painting (`serve.rs`, `frame.rs`).

## Connecting

`vsedit --serve [--vscode <dir>]` prints one line, `{"port":N}` (or `{"error":"…"}` and exit 1), then detaches.
Connect to `127.0.0.1:N` within 20 s. One client per server. The server exits when the client disconnects or sends
`close`; unsaved text goes to the hot-exit backup then, and opening the file again offers it.

Messages are JSON, one per line, both ways.

## Units

- `line`: 0-based line index.
- `col`: **UTF-8 byte offset in the line**, the Rust core's unit (not UTF-16, not display cells). Columns the client
  sends are snapped back to a character boundary. Text comes as strings (`runs[].text`), so widths, tabs and wide
  characters are the client's to measure.
- `status.col` is VS Code's "Col": characters before the caret plus one, tabs to their stop.

## Requests (client → server)

| op | fields | does |
| --- | --- | --- |
| `open` | `path` | Opens the file (a missing one is new). The first starts the editor; later ones open beside it. Reply `opened` or `error`. |
| `view` (or `scroll`) | `first`, `last`, `cols` | The lines the client shows (`last - first + 1` rows from line `first`) and the text columns. Page Up/Down and reveal use them. |
| `command` | `id`, `args?` | A `keymap.json` command id. `editor.action.clipboardPasteAction` takes `args.text` (the client's clipboard). |
| `key` | `key` | A key in `keymap.json` chord syntax (`"enter"`, `"shift+tab"`, `"cmd+k cmd+c"` is two `key`s): resolved through the user's keybindings, chords, the find widget and inline suggestions. Enter, Tab and Escape come this way. |
| `insert` | `text` | Typed or IME-committed text (auto-closing pairs apply; in the find widget it goes to the field). |
| `click` | `line`, `col`, `mods?`, `count?`, `on?` | A press. `mods`: any of `"shift"`, `"cmd"` (⌘-click is Go to Definition). `count`: 2 selects the word, 3 the line. `on`: `"gutter"` (line numbers: Shift extends by lines), `"fold"` (the chevron: toggles the fold). |
| `drag` | `line`, `col` | Moves the selection's head while the button is down. |
| `save` | | Save (format on save, trim, changed-on-disk check as the editor does). |
| `close` | | Ends the session. Reply `closed`. |

## Replies and pushes (server → client)

- `opened`: `{path, language, lines, palette}`. `palette`: the theme colors to draw with (`bg`, `fg`, `selection`,
  `currentLine`, `cursor`, `lineNumber`, `lineNumberActive`, `findMatch`, `findOther`, `findRange`, `bracket`,
  `word`, `wordWrite`, `selectionMatch`, `git*`, `fold*`, `ghost`, `guide`, `guideActive`, `lightBulb`, `error`,
  `warning`, `info`, `statusBar`, `statusBarFg`).
- `error`: `{for, message}`.
- `clipboard`: `{text}` after Copy / Cut: put it on the system clipboard.
- `closed`: the session ended (`close`, or the Quit command).
- `frame`: pushed after every request that changed something, and whenever something changes by itself (tokens
  arriving, git gutter, problems, messages expiring, word highlight). **Only what changed since the last frame**:

| key | value |
| --- | --- |
| `seq` | 1, 2, … |
| `rows` | The lines to show, top to bottom (folded lines left out). Sent when it changes. |
| `lines` | `[{l, runs, decos, gutter, ghost?}]` for each line of `rows` that is new or changed. Lines of `rows` not in `lines` are unchanged; the client keeps lines by `l` and may drop those not in `rows`. |
| `top` | The first line shown. The server moves it to reveal the caret (find, go to line, typing past the edge): scroll to it. |
| `caret` | `{line, col}` |
| `selections` | `[{anchor, head}]` (one for now) |
| `status` | `{ln, col, dirty, language, wrap, left, leftColor, offer, items: [{text, act}]}`: `left` is the message, problem or find count; `items` the right side (`act`: what a click would run, `Goto`, `Indent`, `Eol`, `Wrap`, `Language`, `Inline`, `Install` or null). |
| `find` | null, or `{query, replace, replaceShown, field, case, word, regex, inSelection, count, current, error}` while the find widget is open. |
| `popup` | null, or `"dialog"`, `"input"`, `"picker"`, `"menu"` (overlays the client can't draw yet). |
| `ruler` | The overview ruler: `{git: [[from, to, kind]], find: [line], word: [line], problems: [[line, severity]]}`. |

A line: `runs: [{text, fg, style}]` covers the line's text in order (`fg` `#rrggbb`; `style` bits 1 italic,
2 bold, 4 underline, 8 strikethrough); a line not tokenized yet is one run in the default color and comes again when
its tokens do. `decos: [{from, to, kind}]`, `kind` one of `find`, `findCurrent`, `findScope`, `bracket`, `word`,
`wordWrite`, `selectionMatch`, `error`, `warning`, `info`, `hint` (the last four are squiggles). `gutter:
{git: "added"|"modified"|"deletedAbove"|"deletedBelow"|null, fold: "expanded"|"collapsed"|null, diag: severity|null,
bulb: bool}`. `ghost: {col, lines}`: an inline suggestion shown at `col`.

Not in the frame yet: word-wrapped rows (lines are logical), indent guides, CodeLens rows, breadcrumbs, and the
overlays' contents (`popup` only says one is open).
