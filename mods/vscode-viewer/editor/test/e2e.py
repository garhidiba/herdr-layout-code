#!/usr/bin/env python3
"""End-to-end: runs vsedit.cjs in a 100x30 pseudo-terminal, types, saves, quits, and checks colors against tokenize.cjs;
scrollbars (editor and hex viewer), the context menu, Kitty ⌘ keys, user keybindings, tsserver definition/references/rename, gofmt, the save dialog, the close request (SIGUSR2), a warm editor (--warm), auto save and hot exit;
find widget toggles, status bar items, symbol breadcrumbs, Go to Symbol and diagnostics; Expand Line Selection, Go to Bracket,
Toggle Block Comment, Save As, Join Lines and Save All; Go to File with several files, Go Back / Forward and the settings JSON;
through tsserver Show Hover (keys and mouse), Quick Fix, Expand / Shrink Selection, Format Selection and Go to Symbol in
Workspace; line comments and Cursor Undo; inline suggestions from a fake Ollama (ghost text, Tab, typing through,
accept next word, Esc, a deny-listed file).
usage: python3 -I mods/vscode-viewer/editor/test/e2e.py [scenario ...]
VSEDIT_BIN=<path to the Rust vsedit> runs the same scenarios against the Rust editor through the launcher (vsedit.sh);
each result says which editor ran, and a scenario the Rust editor didn't run alone (a fallback to JS) fails."""
import fcntl, http.server, json, os, pty, re, select, shutil, signal, struct, subprocess, sys, tempfile, termios, threading, time

HERE = os.path.dirname(os.path.abspath(__file__))
EDITOR = os.path.join(HERE, "..", "vsedit.cjs")
LAUNCHER = os.path.join(HERE, "..", "vsedit.sh")
RUST_BIN = os.environ.get("VSEDIT_BIN")
TOKENIZE = os.path.join(HERE, "..", "..", "vscode", "tokenize.cjs")

TSX = '''import React from "react";
import { createRoot } from "react-dom/client";

function App() {
  return <div className="app">hello</div>;
}

createRoot(document.getElementById("root")!).render(<App />);
'''
GO = '''package main

import "fmt"

func main() {
\tfmt.Println("hi")
}
'''


# Settings, backups and Herdr are never the real ones: main() points these at a temp folder. The keys are Linux's
# (VSEDIT_OS=linux: Ctrl keys, Ctrl+W closes) unless a scenario runs with MAC.
ISOLATED = {}
QUIT = "\x17"                       # Ctrl+W: Close Editor (Windows/Linux)
MAC = {"VSEDIT_OS": "mac"}
MAC_QUIT = "\x1b[119;9u"            # ⌘W as Kitty CSI-u
TERMS = []  # every editor started, killed after its scenario


class Term:
    def __init__(self, file, cols=100, rows=30, env=None, args=()):
        pid, fd = pty.fork()
        if pid == 0:
            e = {k: v for k, v in os.environ.items() if k != "HC_TERMINAL_ID"}
            e.update(ISOLATED)
            e.update(env or {})
            if RUST_BIN:
                e.update(VSEDIT_ENGINE="rust", VSEDIT_RUST_BIN=RUST_BIN)
                os.execvpe("sh", ["sh", LAUNCHER, file, *args], e)
            os.execvpe("node", ["node", EDITOR, file, *args], e)
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        self.pid, self.fd, self.out = pid, fd, b""
        TERMS.append(self)

    def read(self, until=None, timeout=5.0):
        end = time.time() + timeout
        if until and until.encode() in self.out:
            return True
        while time.time() < end:
            r, _, _ = select.select([self.fd], [], [], 0.05)
            if r:
                try:
                    data = os.read(self.fd, 65536)
                except OSError:
                    break
                if not data:
                    break
                self.out += data
                if until and until.encode() in self.out:
                    return True
            elif until is None and time.time() > end - timeout + 0.4:
                return True
        return until is None

    def send(self, s, wait=0.15):
        os.write(self.fd, s.encode())
        time.sleep(wait)
        self.read(timeout=wait)

    def wait_exit(self, timeout=5.0):
        end = time.time() + timeout
        while time.time() < end:
            self.read(timeout=0.1)
            pid, status = os.waitpid(self.pid, os.WNOHANG)
            if pid:
                return os.waitstatus_to_exitcode(status)
        raise AssertionError("editor did not exit")


def colored_frame(t, timeout=5.0):
    """Waits for the second frame: the first one is painted before the grammar loads, uncolored."""
    end = time.time() + timeout
    while t.out.count(b"Ln 1, Col 1") < 2 and time.time() < end:
        t.read(timeout=0.05)
    return t.out.count(b"Ln 1, Col 1") >= 2


def sgr(hexcolor):
    r, g, b = (int(hexcolor[i:i + 2], 16) for i in (1, 3, 5))
    return f"\x1b[38;2;{r};{g};{b}m"


def tokens(file):
    data = json.loads(subprocess.check_output(["node", TOKENIZE, file]))
    out = []
    for row in data["lines"]:
        for i in range(0, len(row), 3):
            out.append((row[i], data["colors"][row[i + 1]].lower()))
    return out


def painted(screen, text, color):
    """True when `text` is painted right after its foreground SGR (optionally a background SGR in between)."""
    return re.search(re.escape(sgr(color)) + r"(?:\x1b\[48;2;[\d;]+m)?" + re.escape(text), screen) is not None


def check_colors(screen, file, expected):
    toks = tokens(file)
    for text, color in expected:
        got = [c for t, c in toks if t == text]
        assert color.lower() in got, f"tokenize.cjs gives {text!r} {got}, expected {color}"
        assert painted(screen, text, color), f"{text!r} not painted with {color}"
    # Every token tokenize.cjs colors differently from the default must be painted with that exact color.
    for text, color in toks:
        if text.strip() and color != "#abb2bf" and len(text.strip()) == len(text):
            assert painted(screen, text, color), f"{text!r} not painted with {color}"


def run_tsx(tmp):
    file = os.path.join(tmp, "App.tsx")
    open(file, "w").write(TSX)
    t = Term(file)
    assert colored_frame(t), "no colored frame"
    screen = t.out.decode("utf8", "replace")
    assert "TypeScript JSX" in screen and "Spaces: 2" in screen and "UTF-8" in screen and "LF" in screen
    assert "\x1b[?1049h" in screen and "\x1b[?2004h" in screen and "\x1b[?1006h" in screen
    assert "\x1b[?1007s\x1b[?1007l" in screen, "alternate scroll (wheel as arrow keys) not turned off"
    check_colors(screen, file, [("import", "#C678DD"), ("createRoot", "#61AFEF"), ("App", "#E5C07B")])
    # Ctrl+G 5 Enter, End, type, Enter keeps indentation, Korean text, arrows, save, quit.
    t.send("\x07"); t.send("5\r"); t.send("\x1b[F")
    t.send(" ok"); t.send("\r"); t.send("한글")
    t.read("Ln 6, Col 5", timeout=2)
    assert "Ln 6, Col 5" in t.out.decode("utf8", "replace"), "cursor after 한글 should be Col 5"
    t.send("\x1b[D\x1b[D\x1b[C")  # left, left, right
    t.send("x")                     # 한x글
    t.send("\x13")
    assert t.read("Saved", timeout=2), "no Saved message"
    t.send(QUIT)
    assert t.wait_exit() == 0
    assert t.out.endswith(b"\x1b[?1049l") or b"\x1b[?1049l" in t.out[-200:], "terminal not restored"
    want = TSX.replace("hello</div>;\n", "hello</div>; ok\n  한x글\n")
    got = open(file, encoding="utf8").read()
    assert got == want, f"saved content differs:\n{got!r}\n{want!r}"
    print("tsx: ok")


def run_go(tmp):
    file = os.path.join(tmp, "main.go")
    open(file, "w").write(GO)
    t = Term(file)
    assert colored_frame(t), "no colored frame"
    screen = t.out.decode("utf8", "replace")
    assert "Go" in screen and "Tab Size: 4" in screen
    check_colors(screen, file, [("package", "#C678DD"), ("func", "#C678DD"), ("Println", "#61AFEF")])
    t.send("\x1b[B" * 5); t.send("\x1b[F"); t.send(" // 한")
    t.send("\x1f")                   # Ctrl+/ comments the line
    t.send("\x1a")                   # Ctrl+Z undoes the comment
    t.send("\x13")
    assert t.read("Saved", timeout=2)
    t.send("zz")                     # unsaved edit -> quit asks
    t.send(QUIT)
    assert t.read("Do you want to save", timeout=2), "no dirty prompt"
    t.send("d")
    assert t.wait_exit() == 0
    got = open(file, encoding="utf8").read()
    assert got == GO.replace('("hi")\n', '("hi") // 한\n'), repr(got)
    print("go: ok")


def run_crlf(tmp):
    file = os.path.join(tmp, "notes.txt")
    open(file, "wb").write(b"one\r\ntwo")
    t = Term(file)
    assert t.read("CRLF"), "CRLF not shown"
    t.send("\x1b[1;5F")              # Ctrl+End
    t.send("!"); t.send("\x13"); t.read("Saved", timeout=2); t.send(QUIT)
    assert t.wait_exit() == 0
    assert open(file, "rb").read() == b"one\r\ntwo!", open(file, "rb").read()
    print("crlf: ok")


def screen_of(t):
    return t.out.decode("utf8", "replace")


def herdr_stub(tmp, fails=0):
    """A herdr-app on PATH that logs its arguments and answers ok, after an error to the first `fails` calls (Herdr
    hasn't adopted the terminal yet): (env for Term, log path)."""
    stub = os.path.join(tmp, "stub")
    os.makedirs(stub, exist_ok=True)
    log = os.path.join(tmp, "herdr.log")
    with open(os.path.join(stub, "herdr-app"), "w") as f:
        f.write(f'#!/bin/sh\necho "$@" >> "{log}"\n'
                f'[ "$(wc -l < "{log}")" -gt {fails} ] && echo \'{{"ok": true}}\' || echo \'{{"error": "no such running terminal"}}\'\n')
    os.chmod(os.path.join(stub, "herdr-app"), 0o755)
    if os.path.exists(log):
        os.remove(log)
    return {"HC_TERMINAL_ID": "term-7", "PATH": stub + ":" + os.environ["PATH"]}, log


def run_menu_and_cmd_save(tmp):
    """Right-click (SGR button 2) opens VS Code's context menu; Herdr is told to route right-clicks; Preferences: Open Settings
    asks Herdr for the Settings dialog; Kitty ⌘S saves. Herdr doesn't know the terminal at first: routing is asked
    again until it answers ok, and once more on focus-in."""
    env, log = herdr_stub(tmp, fails=2)
    file = os.path.join(tmp, "menu.txt")
    open(file, "w").write("hello world\n")
    t = Term(file, env={**env, **MAC})
    assert t.read("Ln 1, Col 1"), "no first frame"
    assert "\x1b[>1u" in screen_of(t) and "\x1b[?1004h" in screen_of(t), "Kitty keyboard / focus reports not enabled"
    program = "do terminal.right_click --to program --terminal term-7"
    asked = lambda: open(log).read().count(program) if os.path.exists(log) else 0
    for _ in range(60):
        if asked() >= 3:
            break
        t.read(timeout=0.05)            # keeps draining the screen, or the editor blocks writing it
    assert asked() == 3, open(log).read()
    t.send("\x1b[I", wait=0.3)        # focus-in asks again
    assert asked() == 4, open(log).read()
    t.send("\x1b[<2;20;2M\x1b[<2;20;2m")
    assert t.read("Command Palette...", timeout=2), "right-click did not open the menu"
    sc = screen_of(t)
    for item in ["Go to Definition", "Peek", "Find All References", "Rename Symbol", "Change All Occurrences", "Format Document", "Cut", "Copy", "Paste"]:
        assert item in sc, item
    t.send("\x1b[27u")              # Kitty Esc closes it
    t.send("\x1bOP")                # F1: command palette
    t.send("open settings")
    assert t.read(">open settings", timeout=2), "F1 did not open the command palette"
    t.send("\r")                    # the dialog entry ranks before "Open Settings (JSON)"
    t.send("\x1b[F"); t.send("!")
    t.send("\x1b[115;9u")           # ⌘S as Kitty CSI-u
    assert t.read("Saved", timeout=2), "⌘S did not save"
    t.send("\x1b[113;9u")           # ⌘Q is not ours; ⌘W closes
    t.send(MAC_QUIT)
    assert t.wait_exit() == 0
    assert open(file).read() == "hello world!\n"
    out = screen_of(t)
    assert "\x1b[<u" in out[-300:], "Kitty keyboard mode not popped on exit"
    calls = open(log).read()
    assert "do terminal.right_click --to program --terminal term-7" in calls, calls
    assert "do terminal.right_click --to menu --terminal term-7" in calls, calls
    assert "do mod.open --name vscode-settings" in calls, calls
    print("menu + ⌘S: ok")


def run_mac_keys(tmp):
    """macOS keys (VSEDIT_OS=mac): what Herdr sends for ⌘→ / ⌘← (Ctrl+E / Ctrl+A) moves to the line end / start instead of
    selecting all, Ctrl+F / Ctrl+N move, Ctrl+K deletes to the line end, Ctrl+U (Herdr's ⌘⌫) to the line start, and the
    chord ⌘K ⌘C comments the line after the "(⌘K) was pressed" hint."""
    file = os.path.join(tmp, "mac.js")
    open(file, "w").write("let a = 1;\nlet b = 2;\n")
    t = Term(file, env=MAC)
    assert t.read("Ln 1, Col 1"), "no first frame"
    t.send("\x05"); t.send("!")                      # Ctrl+E (⌘→): line end
    t.send("\x01"); t.send("x")                      # Ctrl+A (⌘←): line start, not Select All
    t.send("\x06"); t.send("\x0b")                   # Ctrl+F right, Ctrl+K delete to the line end
    t.send("\x0e"); t.send("\x05"); t.send("\x15")   # Ctrl+N down, Ctrl+E, Ctrl+U (⌘⌫) delete to the line start
    t.send("\x10")                                  # Ctrl+P up
    t.send("\x1b[107;9u")                           # ⌘K
    assert "(⌘K) was pressed. Waiting for" in plain(t), "no chord hint"
    t.send("\x1b[99;9u")                            # ⌘C: Add Line Comment
    t.send("\x1b[115;9u")                           # ⌘S
    assert t.read("Saved", timeout=2), "⌘S did not save"
    assert open(file).read() == "// xl\n\n", repr(open(file).read())
    t.send(MAC_QUIT)
    assert t.wait_exit() == 0
    print("mac keys + ⌘K ⌘C: ok")


def run_keybindings(tmp):
    """vscode-keybindings.json rebinds Delete Line to ⌘⇧D (Kitty CSI-u) and removes its ⌘⇧K default; the file is read
    again while the editor runs."""
    kb = ISOLATED["VSEDIT_KEYBINDINGS"]
    os.makedirs(os.path.dirname(kb), exist_ok=True)
    open(kb, "w").write('// mine\n[{ "key": "cmd+shift+d", "command": "editor.action.deleteLines" },\n'
                        ' { "key": "cmd+shift+k", "command": "-editor.action.deleteLines" }]\n')
    file = os.path.join(tmp, "keys.txt")
    open(file, "w").write("one\ntwo\nthree\n")
    t = Term(file, env=MAC)
    assert t.read("Ln 1, Col 1"), "no first frame"
    t.send("\x1b[107;10u")          # ⌘⇧K: removed, does nothing
    t.send("\x1b[100;10u")          # ⌘⇧D: Delete Line
    t.send("\x1b[115;9u")           # ⌘S
    assert t.read("Saved", timeout=2), "⌘S did not save"
    assert open(file).read() == "two\nthree\n", open(file).read()
    open(kb, "w").write("[]\n")
    time.sleep(2.5)                  # the 2s re-read
    t.out = b""
    t.send("\x1b[107;10u")          # ⌘⇧K is Delete Line again
    t.send("\x1b[115;9u")
    assert t.read("Saved", timeout=2), "⌘S did not save"
    assert open(file).read() == "three\n", open(file).read()
    t.send(MAC_QUIT)
    assert t.wait_exit() == 0
    os.remove(kb)
    print("keybindings: ok")


TS_A = 'export function greet(name: string) {\n  return "hi " + name;\n}\n'
TS_B = 'import { greet } from "./a";\nconst x = greet("a");\ngreet("b");\n'


def run_typescript(tmp):
    """F12 jumps to the definition through tsserver, ⌥⇧F12 lists references, F2 renames across two files."""
    proj = os.path.join(tmp, "tsproj")
    os.makedirs(proj)
    subprocess.run(["git", "init", "-q"], cwd=proj, check=True)
    open(os.path.join(proj, "tsconfig.json"), "w").write('{"compilerOptions":{"strict":true}}')
    open(os.path.join(proj, "a.ts"), "w").write(TS_A)
    open(os.path.join(proj, "b.ts"), "w").write(TS_B)
    t = Term(os.path.join(proj, "b.ts"))
    assert t.read("Ln 1, Col 1"), "no first frame"
    t.send("\x07"); t.send("2:12\r")             # Ctrl+G 2:12 -> on `greet` in `const x = greet("a")`
    assert t.read("Ln 2, Col 12", timeout=2)
    t.out = b""
    t.send("\x1b[24~", wait=0.3)                  # F12
    assert t.read("Ln 1, Col 17", timeout=20), "F12 did not jump to greet in a.ts:\n" + screen_of(t)[-400:]
    assert "a.ts" in screen_of(t)
    t.out = b""
    t.send("\x1b[24;4~", wait=0.3)                # ⌥⇧F12 Find All References
    assert t.read("results in 2 files", timeout=20), "no references panel:\n" + screen_of(t)[-600:]
    sc = screen_of(t)
    m = re.search(r"(\d+) results in 2 files", sc)
    assert m and int(m.group(1)) >= 2, sc[-400:]
    assert "REFERENCES" in sc
    t.send("\x1b[27u")                            # Esc closes the panel
    t.out = b""
    t.send("\x1bOQ", wait=0.3)                    # F2 Rename Symbol
    assert t.read("Enter to Rename", timeout=5), "no rename box"
    t.send("hello"); t.send("\r", wait=0.3)
    assert t.read("Renamed 4 occurrences in 2 files", timeout=20), "rename failed:\n" + screen_of(t)[-400:]
    assert open(os.path.join(proj, "b.ts")).read() == TS_B.replace("greet", "hello"), "b.ts not renamed on disk"
    t.send("\x13"); assert t.read("Saved", timeout=2)
    assert open(os.path.join(proj, "a.ts")).read() == TS_A.replace("greet", "hello")
    t.send(QUIT)
    assert t.wait_exit() == 0
    print("typescript (definition, references, rename): ok")


def run_format(tmp):
    """⌥⇧F formats a Go file with gofmt (no server for Go)."""
    if not shutil.which("gofmt", path=os.environ["PATH"] + ":/opt/homebrew/bin:/usr/local/bin"):
        print("format: skipped (no gofmt)"); return
    file = os.path.join(tmp, "fmt.go")
    open(file, "w").write("package main\nfunc  main( ) {\nx:=1\n_ = x}\n")
    t = Term(file)
    assert t.read("Ln 1, Col 1")
    t.send("\x1b[105;6u", wait=0.5)               # Ctrl+Shift+I (Linux Format Document) as Kitty CSI-u
    t.read("never", timeout=1.5)
    t.send("\x13"); assert t.read("Saved", timeout=2)
    t.send(QUIT); assert t.wait_exit() == 0
    assert open(file).read() == "package main\n\nfunc main() {\n\tx := 1\n\t_ = x\n}\n", repr(open(file).read())
    print("format (gofmt): ok")


def run_save_dialog(tmp):
    """Unsaved changes: Ctrl+W asks Save / Don't Save / Cancel; Esc cancels, Enter saves and quits."""
    file = os.path.join(tmp, "dialog.txt")
    open(file, "w").write("abc\n")
    t = Term(file)
    assert t.read("Ln 1, Col 1")
    assert "\x1b]2;dialog.txt — vsedit\x07".encode() in t.out, "no terminal title"
    t.send("X")
    assert t.read("\x1b]2;● dialog.txt — vsedit\x07", timeout=2), "the title has no ● for the unsaved change"
    t.send(QUIT)
    assert t.read("Do you want to save the changes you made to dialog.txt?", timeout=2)
    sc = screen_of(t)
    assert "Your changes will be lost if you don't save them." in sc and " Save " in sc and " Don't Save " in sc and " Cancel " in sc
    t.read(timeout=0.5)
    t.out = b""
    for x, y in [(10, 5), (11, 5), (50, 15), (51, 16)]:   # the pointer moving over the dialog: nothing redrawn
        t.send(f"\x1b[<35;{x};{y}M", wait=0.1)
    assert t.out == b"", f"motion over the dialog drew {len(t.out)} bytes"
    t.send("\x1b[27u")                            # Esc = Cancel
    t.send("Y")
    t.out = b""
    t.send(QUIT)
    assert t.read("Do you want to save", timeout=2)
    t.send("\r")                                  # Enter = Save
    assert t.wait_exit() == 0
    assert open(file).read() == "XYabc\n", open(file).read()
    print("save dialog: ok")


def run_close_request(tmp):
    """SIGUSR2 (vscode-tabs closing the tab): unsaved changes ask Save / Don't Save / Cancel, the title says it asks;
    Cancel keeps the editor, Don't Save ends it without a backup; a saved editor ends at once."""
    file = os.path.join(tmp, "close.txt")
    open(file, "w").write("abc\n")
    t = Term(file)
    assert t.read("Ln 1, Col 1")
    t.send("X")
    assert t.read("\x1b]2;● close.txt — vsedit\x07", timeout=2)
    os.kill(t.pid, signal.SIGUSR2)
    assert t.read("Do you want to save the changes you made to close.txt?", timeout=2), "no dialog for the close request"
    assert t.read("\x1b]2;● close.txt — vsedit (closing)\x07", timeout=2), "the title does not say the dialog asks"
    t.out = b""
    t.send("\x1b[27u")                            # Esc = Cancel
    assert t.read("\x1b]2;● close.txt — vsedit\x07", timeout=2), "the title still says closing after Cancel"
    os.kill(t.pid, signal.SIGUSR2)
    assert t.read("Do you want to save", timeout=2)
    t.send("d")                                   # Don't Save
    assert t.wait_exit() == 0
    backups = ISOLATED["VSEDIT_BACKUPS"]
    assert open(file).read() == "abc\n" and (not os.path.isdir(backups) or os.listdir(backups) == []), "Don't Save kept something"
    t = Term(file)
    assert t.read("\x1b]2;close.txt — vsedit\x07")
    os.kill(t.pid, signal.SIGUSR2)
    assert t.wait_exit() == 0, "a saved editor should end on a close request"
    print("close request: ok")


def wait_ready(key, timeout=5.0):
    end = time.time() + timeout
    while not os.path.exists(key + ".pid") and time.time() < end:
        time.sleep(0.02)
    return os.path.exists(key + ".pid")


def run_warm(tmp):
    """--warm <key> (vscode-explorer's hidden warm tab): Ready with no file and its pid in <key>.pid once it can take
    one; handed a file and a folder through <key> and SIGUSR2, it opens that file as an editor started with it would;
    asked with no file handed over, it ends."""
    file = os.path.join(tmp, "warm.txt")
    open(file, "w").write("warm text\n")
    key = os.path.join(tmp, "warm", "tbW")
    t = Term("--warm", args=[key, "--close-on-exit"])
    assert t.read("Ready"), "no Ready screen while it waits"
    assert wait_ready(key), "no <key>.pid"
    assert open(key + ".pid").read() == str(t.pid), "<key>.pid is not the editor's pid"
    open(key, "w").write(f"{file}\n{tmp}\n")
    os.kill(t.pid, signal.SIGUSR2)
    assert t.read("\x1b]2;warm.txt — vsedit\x07", timeout=5), "the handed file did not open"
    assert t.read("Ln 1, Col 1") and b"warm text" in t.out
    assert not os.path.exists(key) and not os.path.exists(key + ".pid"), "the handoff files stay behind"
    t.send(QUIT)
    assert t.wait_exit() == 0
    t = Term("--warm", args=[key + "2", "--close-on-exit"])
    assert wait_ready(key + "2")
    os.kill(t.pid, signal.SIGUSR2)
    assert t.wait_exit() == 0, "a warm editor asked to close should end"
    print("warm: ok")


def run_auto_save(tmp):
    """files.autoSave afterDelay with files.autoSaveDelay in seconds saves without Ctrl+S."""
    settings = os.path.join(tmp, "auto", "vscode-settings.json")
    os.makedirs(os.path.dirname(settings))
    open(settings, "w").write('{"files.autoSave": "afterDelay", "files.autoSaveDelay": 0.3, "keep.me": 1, "editor.inlineSuggest.provider": "off"}')
    file = os.path.join(tmp, "auto.txt")
    open(file, "w").write("one\n")
    t = Term(file, env={"VSEDIT_SETTINGS": settings})
    assert t.read("Auto Save"), "status bar has no Auto Save"
    t.send("Z")
    t.read("never", timeout=1.2)
    assert open(file).read() == "Zone\n", "not auto-saved: " + repr(open(file).read())
    t.send(QUIT)
    assert t.wait_exit() == 0, "quit should not ask: the file was auto-saved"
    assert json.load(open(settings))["keep.me"] == 1
    print("auto save: ok")


def run_hidden_status_bar(tmp):
    """workbench.statusBar.visible false (vscode-memo's editor): no status bar is ever painted; the last row is text."""
    settings = os.path.join(tmp, "nostatus", "vscode-settings.json")
    os.makedirs(os.path.dirname(settings))
    open(settings, "w").write('{"workbench.statusBar.visible": false, "files.autoSave": "afterDelay", "files.autoSaveDelay": 0.3, "editor.inlineSuggest.provider": "off"}')
    file = os.path.join(tmp, "nostatus.md")
    open(file, "w").write("".join(f"row {i}\n" for i in range(60)))
    t = Term(file, env={"VSEDIT_SETTINGS": settings})
    assert t.read("row 1"), "the text did not paint"
    t.send("Z")
    t.read("never", timeout=1.2)
    assert open(file).read().startswith("Zrow 0\n"), "not auto-saved: " + repr(open(file).read()[:20])
    out = screen_of(t)
    assert "Ln 1, Col" not in out and "UTF-8" not in out and "Auto Save" not in out, "a status bar was painted"
    assert "row 28" in out, "the last row isn't text (30 rows: the breadcrumbs, then rows 0-28)"
    t.send(QUIT)
    t.wait_exit()
    print("hidden status bar: ok")


def run_cursor_style(tmp):
    """editor.cursorStyle / editor.cursorBlinking: the start sequence carries the DECSCUSR code, a live change sends the new one."""
    settings = os.path.join(tmp, "cursor", "vscode-settings.json")
    os.makedirs(os.path.dirname(settings))
    open(settings, "w").write('{"editor.cursorStyle": "block", "editor.cursorBlinking": "solid", "editor.inlineSuggest.provider": "off"}')
    file = os.path.join(tmp, "cursor.txt")
    open(file, "w").write("one\n")
    t = Term(file, env={"VSEDIT_SETTINGS": settings})
    assert t.read("\x1b[2 q"), "no steady block cursor code at start"
    open(settings, "w").write('{"editor.cursorStyle": "underline", "editor.cursorBlinking": "blink", "editor.inlineSuggest.provider": "off"}')
    assert t.read("\x1b[3 q", timeout=4.5) or (t.send("x") or t.read("\x1b[3 q", timeout=4.5)), "settings change did not reach the cursor"
    # Herdr resets the shape on focus changes: the next frame after focus-out / focus-in sends it again.
    t.out = b""
    t.send("\x1b[O"); t.send("\x1b[I")
    assert t.read("\x1b[3 q", timeout=2), "cursor shape not resent after focus-in"
    t.send(QUIT)
    t.wait_exit()
    assert b"\x1b[0 q" in t.out, "cursor not restored on leave"
    print("cursor style: ok")


def run_hot_exit(tmp):
    """SIGHUP with unsaved text writes a backup; reopening offers to restore it."""
    file = os.path.join(tmp, "hot.txt")
    open(file, "w").write("base\n")
    t = Term(file)
    assert t.read("Ln 1, Col 1")
    t.send("NEW ")
    os.kill(t.pid, signal.SIGHUP)
    t.wait_exit()
    backups = os.listdir(ISOLATED["VSEDIT_BACKUPS"])
    assert len(backups) == 1, backups
    b = json.load(open(os.path.join(ISOLATED["VSEDIT_BACKUPS"], backups[0])))
    assert b["path"] == os.path.realpath(file) or b["path"] == file
    assert b["text"] == "NEW base" and b["cursor"] == {"line": 0, "col": 4}
    assert open(file).read() == "base\n"
    t = Term(file)
    assert t.read("Restore unsaved changes from", timeout=3) and t.read(" Discard ", timeout=2), "no restore prompt"
    assert " Restore " in screen_of(t) and " Discard " in screen_of(t)
    t.send("\r")                                  # Restore
    t.send("\x13"); assert t.read("Saved", timeout=2)
    t.send(QUIT); assert t.wait_exit() == 0
    assert open(file).read() == "NEW base\n"
    assert os.listdir(ISOLATED["VSEDIT_BACKUPS"]) == [], "backup not removed after save"
    print("hot exit: ok")


def run_small_batch(tmp):
    """Windows/Linux keys: Ctrl+L selects the line and then the next, Ctrl+Shift+\\ goes to the next bracket and its partner,
    Ctrl+Shift+A block-comments the selected line, Ctrl+Shift+S saves as another file in the folder (the original
    unchanged); macOS keys: ⌃J joins lines, ⌥⌘S saves all."""
    file = os.path.join(tmp, "small.js")
    open(file, "w").write("let x = 1;\nfoo(a, [b]);\n  bar\n")
    t = Term(file)
    assert t.read("Ln 1, Col 1"), "no first frame"
    t.send("\x0c")                                 # Ctrl+L: Expand Line Selection
    assert t.read("Ln 2, Col 1 (11 selected)", timeout=2), "Ctrl+L did not select the line"
    t.send("\x0c")
    assert t.read("Ln 3, Col 1 (24 selected)", timeout=2), "Ctrl+L again did not add the next line"
    t.send("\x1b[1;5H"); t.send("\x1b[B")           # Ctrl+Home, Down
    t.send("\x1b[92;6u")                           # Ctrl+Shift+\: Go to Bracket (the next one)
    assert t.read("Ln 2, Col 4", timeout=2), "Go to Bracket did not reach the ("
    t.send("\x1b[92;6u")
    assert t.read("Ln 2, Col 11", timeout=2), "Go to Bracket did not reach the )"
    t.send("\x1b[H"); t.send("\x1b[1;2F")           # Home, Shift+End: the line selected
    t.send("\x1b[97;6u")                           # Ctrl+Shift+A: Toggle Block Comment (Linux)
    t.send("\x1b[115;6u")                          # Ctrl+Shift+S: Save As
    assert t.read("Save As: " + tmp + os.sep, timeout=2), "Save As did not prefill the folder"
    t.send("copy.js"); t.send("\r")
    assert t.read("Saved", timeout=3), "Save As did not save"
    t.send(QUIT)
    assert t.wait_exit() == 0
    got = open(os.path.join(tmp, "copy.js")).read()
    assert got == "let x = 1;\n/* foo(a, [b]); */\n  bar\n", repr(got)
    assert open(file).read() == "let x = 1;\nfoo(a, [b]);\n  bar\n", "the original changed"
    file = os.path.join(tmp, "join.txt")
    open(file, "w").write("a\n    b\nc\n")
    t = Term(file, env=MAC)
    assert t.read("Ln 1, Col 1"), "no first frame"
    t.send("\x1b[106;5u")                          # ⌃J: Join Lines
    t.send("\x1b[115;11u")                         # ⌥⌘S: Save All
    assert t.read("Saved", timeout=2), "⌥⌘S did not save"
    t.send(MAC_QUIT)
    assert t.wait_exit() == 0
    assert open(file).read() == "a b\nc\n", repr(open(file).read())
    print("line selection, brackets, block comment, save as, join lines, save all: ok")


def run_files_and_navigation(tmp):
    """Linux keys. Ctrl+P (Go to File) opens another file of the folder in the same editor, ":2" goes to a line;
    Ctrl+Alt+- / Ctrl+Shift+- go back / forward between the files; Ctrl+K S saves both; Ctrl+, (outside Herdr) opens
    the settings JSON and Ctrl+K Ctrl+S the keybindings JSON; Ctrl+W asks about the unsaved file that isn't showing, then saves it."""
    root = os.path.join(tmp, "nav")
    os.makedirs(os.path.join(root, "b"), exist_ok=True)
    a, c = os.path.join(root, "a.txt"), os.path.join(root, "b", "c.txt")
    open(a, "w").write("alpha\n")
    open(c, "w").write("gamma\ndelta\n")
    t = Term(a)
    assert t.read("Ln 1, Col 1"), "no first frame"
    t.send("\x10"); t.send("c.txt")                 # Ctrl+P: Go to File
    assert t.read("b/c.txt", timeout=2), "Go to File did not list b/c.txt"
    t.out = b""; t.send("\r")
    assert t.read("gamma", timeout=3), "Go to File did not open c.txt"
    t.send("X")
    t.out = b""; t.send("\x1b[45;7u")               # Ctrl+Alt+-: Go Back
    assert t.read("alpha", timeout=3), "Go Back did not return to a.txt"
    t.send("Y")
    t.out = b""; t.send("\x1b[45;6u")               # Ctrl+Shift+-: Go Forward
    assert t.read("Xgamma", timeout=3), "Go Forward did not return to c.txt"
    t.send("\x10"); t.send(":2"); t.send("\r")      # Go to File ":2"
    assert t.read("Ln 2, Col 1", timeout=2), "Go to File :2 did not go to line 2"
    t.send("\x0b"); t.send("s")                     # Ctrl+K S: Save All
    assert t.read("Saved", timeout=2), "Save All did not save"
    assert open(a).read() == "Yalpha\n" and open(c).read() == "Xgamma\ndelta\n", (open(a).read(), open(c).read())
    t.out = b""; t.send("\x1b[44;5u")               # Ctrl+,: the settings JSON outside Herdr
    assert t.read("files.autoSave", timeout=3), "Ctrl+, did not open the settings JSON"
    t.send("\x1b[45;7u")                            # back to c.txt, edit it, then the settings again
    t.send("W")
    t.out = b""; t.send("\x1b[44;5u")
    assert t.read("files.autoSave", timeout=3), "Ctrl+, did not open the settings JSON again"
    kb = ISOLATED["VSEDIT_KEYBINDINGS"]
    os.makedirs(os.path.dirname(kb), exist_ok=True)
    open(kb, "w").write("// my keys\n[]\n")
    t.send("\x0b"); t.send("\x13")                 # Ctrl+K Ctrl+S: the keybindings JSON outside Herdr
    assert t.read("// my keys", timeout=3), "Ctrl+K Ctrl+S did not open the keybindings JSON"
    os.remove(kb)
    t.send(QUIT)
    assert t.read("save the changes you made to c.txt", timeout=2), "quit did not ask about c.txt"
    t.send("s")
    assert t.wait_exit() == 0
    assert open(c).read() == "Xgamma\nWdelta\n", repr(open(c).read())
    print("go to file, back / forward, save all, settings JSON, quit with another unsaved file: ok")


def plain(t):
    """The screen text without colors."""
    return re.sub(r"\x1b\[[\d;]*m", "", screen_of(t))


def run_hex(tmp):
    """A 1 MB binary file: the binary prompt, Enter opens hex rows, Ctrl+G goes to an offset, Ctrl+F finds planted bytes."""
    file = os.path.join(tmp, "blob.dat")
    data = bytearray(b"HXV1\x00\x01\x02\x03" + bytes(range(256)) * 4096)[:1 << 20]
    data[0x80005:0x80009] = b"\xde\xad\xbe\xef"
    open(file, "wb").write(data)
    t = Term(file)
    assert t.read("because it is binary", timeout=3), "no binary prompt:\n" + plain(t)[-400:]
    assert t.read("Open Anyway", timeout=2) and "Open in Hex Viewer" in plain(t)
    t.send("\r", wait=0.3)
    assert t.read("Decoded Text", timeout=3), "no hex view"
    sc = plain(t)
    assert "00000000  48 58 56 31 00 01 02 03  00 01 02 03 04 05 06 07  HXV1····" in sc, sc[-800:]
    assert "1.0 MB (1048576 bytes)" in sc and "Byte 0x48 72 01001000" in sc and "int8 " in sc
    t.send("\x07"); t.send("0x40000\r", wait=0.3)
    assert "Offset 0x40000 (262144)" in plain(t), plain(t)[-400:]
    assert "00040000  " in plain(t)
    t.send("\x06"); t.send("de ad be ef\r", wait=0.5)
    assert t.read("Found at 0x80005", timeout=3), "search failed:\n" + plain(t)[-400:]
    assert "00080000  f8 f9 fa fb fc de ad be  ef " in plain(t), plain(t)[-800:]
    t.send(QUIT)
    assert t.wait_exit() == 0
    assert b"\x1b[?1049l" in t.out[-200:] and b"\x1b[<u" in t.out[-300:], "terminal not restored"
    small = os.path.join(tmp, "nul.txt")
    open(small, "wb").write(b"ab\x00cd\n")
    t = Term(small)
    assert t.read("Open Anyway", timeout=3)
    t.send("a", wait=0.3)                         # Open Anyway: the text editor with NUL as a control picture
    assert t.read("Ln 1, Col 1", timeout=5) and "ab\u2400cd" in plain(t), plain(t)[-400:]
    t.send(QUIT)
    assert t.wait_exit() == 0
    print("hex viewer: ok")


def run_error_page(tmp):
    """From the Explorer (--close-on-exit): a missing file shows the error page and Try Again opens it once it exists;
    an unreadable file says Permission denied and Esc closes it, printing nothing into the shell."""
    env, log = herdr_stub(tmp)
    file = os.path.join(tmp, "later.txt")
    t = Term(file, env=env, args=["--close-on-exit"])
    assert t.read("The editor could not be opened", timeout=3), "no error page:\n" + plain(t)[-400:]
    assert t.read(" Close ", timeout=2) and "File not found" in plain(t) and "later.txt" in plain(t)
    assert " Try Again " in plain(t) and " Open in VS Code " in plain(t)
    t.out = b""
    t.send("\r", wait=0.3)                        # Try Again: still missing
    assert t.read("File not found", timeout=2)
    open(file, "w").write("now here\n")
    t.out = b""
    t.send("t", wait=0.3)                         # Try Again
    assert t.read("Ln 1, Col 1", timeout=5), "Try Again did not open the file:\n" + plain(t)[-400:]
    t.send(QUIT)
    assert t.wait_exit() == 0

    env, log = herdr_stub(tmp)
    locked = os.path.join(tmp, "locked.txt")
    open(locked, "w").write("secret\n")
    os.chmod(locked, 0)
    t = Term(locked, env=env, args=["--close-on-exit"])
    assert t.read("Permission denied", timeout=3), "no Permission denied:\n" + plain(t)[-400:]
    t.send("\x1b[27u")                            # Esc = Close
    assert t.wait_exit() == 1
    tail = plain(t)[plain(t).rfind("\x1b[?1049l"):]
    assert "vsedit" not in tail and "Permission" not in tail, "error printed into the shell: " + repr(tail)
    os.chmod(locked, 0o644)
    print("error page: ok")


def run_drag_scroll(tmp):
    """Dragging past the right edge keeps scrolling and growing the selection until release; wheel 66/67 and
    Shift+wheel scroll sideways."""
    file = os.path.join(tmp, "long.txt")
    open(file, "w").write("0123456789" * 40 + "\n")
    log = os.path.join(tmp, "input.log")
    t = Term(file, env={"VSEDIT_LOG_INPUT": log})
    assert t.read("Ln 1, Col 1")
    t.send("\x1b[<0;7;2M")                        # press on column 1 of the text
    t.send("\x1b[<32;100;2M", wait=0.6)            # drag to the last column and hold
    m = re.findall(r"Ln 1, Col (\d+) \((\d+) selected\)", plain(t))
    assert m and int(m[-1][1]) > 110, "drag did not auto-scroll: " + repr(m[-1:])
    t.send("\x1b[<0;100;2m", wait=0.3)             # release stops it
    stopped = re.findall(r"\((\d+) selected\)", plain(t))[-1]
    t.read("never", timeout=0.4)
    assert re.findall(r"\((\d+) selected\)", plain(t))[-1] == stopped, "kept scrolling after release"
    t.send("\x1b[H")                              # Home: the view follows the cursor back
    t.out = b""
    t.send("\x1b[<67;20;2M")                       # wheel right
    t.read(timeout=0.4); assert "1  6789012345" in plain(t), "wheel right did not scroll"
    t.out = b""
    t.send("\x1b[<66;20;2M")                       # wheel left
    t.read(timeout=0.4); assert "1  0123456789" in plain(t), "wheel left did not scroll"
    t.out = b""
    t.send("\x1b[<69;20;2M")                       # Shift+wheel down = right
    t.read(timeout=0.4); assert "1  6789012345" in plain(t), "Shift+wheel did not scroll sideways"
    t.send(QUIT)
    assert t.wait_exit() == 0
    assert b"\x1b[?1007r" in t.out[-300:], "alternate scroll not restored"
    assert re.search(r'^\d+ "\\u001b\[<69;20;2M"$', open(log).read(), re.M), "VSEDIT_LOG_INPUT did not log the wheel"
    print("drag auto-scroll + horizontal wheel: ok")


def run_drag_reveal(tmp):
    """Scrolled right, a drag or Down / Shift+Down ending on a short line's end scrolls the view back so the caret
    shows (VS Code)."""
    file = os.path.join(tmp, "reveal.txt")
    open(file, "w").write("0123456789" * 40 + "\nshort\n")
    t = Term(file)
    assert t.read("Ln 1, Col 1")
    t.send("\x1b[F", wait=0.3)                    # End: the view scrolls right
    assert t.read("Ln 1, Col 401")
    t.out = b""
    t.send("\x1b[<0;50;2M")                        # press on line 1
    t.send("\x1b[<32;50;3M", wait=0.3)             # drag onto line 2, right of its end
    t.send("\x1b[<0;50;3m", wait=0.3)
    assert t.read("Ln 2, Col 6"), "drag did not land at the short line's end: " + plain(t)[-200:]
    assert re.search(r"2  s?hort", plain(t)), "the view did not scroll back to the caret: " + plain(t)[-300:]   # the keys' 4-column margin
    for key, label in (("\x1b[B", "Down"), ("\x1b[1;2B", "Shift+Down")):   # the keys too: back to line 1's end, then down
        t.send("\x1b[A\x1b[F", wait=0.3)
        assert t.read("Ln 1, Col 401")
        t.out = b""
        t.send(key, wait=0.3)
        assert t.read("Ln 2, Col 6"), label + " did not land at the short line's end: " + plain(t)[-200:]
        assert re.search(r"2  s?hort", plain(t)), label + " did not scroll back to the caret: " + plain(t)[-300:]
    t.send(QUIT)
    assert t.wait_exit() == 0
    print("drag onto a short line reveals the caret: ok")


def run_shift_click(tmp):
    """XTSHIFTESCAPE on enter (ghostty/xterm report Shift+click instead of selecting) and off on exit; a Shift+press
    extends the selection from the cursor."""
    file = os.path.join(tmp, "shift.txt")
    open(file, "w").write("foo bar\nbaz qux\nend\n")
    t = Term(file)
    assert t.read("Ln 1, Col 1")
    assert "\x1b[>1s" in screen_of(t), "Shift+click not asked for (CSI > 1 s)"
    t.send("\x1b[<0;9;3M\x1b[<0;9;3m", wait=0.3)    # click line 2, column 3
    t.send("\x1b[<4;8;2M\x1b[<4;8;2m", wait=0.3)    # Shift+click line 1, column 2
    assert t.read("Ln 1, Col 2 (9 selected)"), "Shift+click did not extend: " + plain(t)[-200:]
    t.send(QUIT)
    assert t.wait_exit() == 0
    assert b"\x1b[>0s" in t.out[-300:], "Shift+click not handed back (CSI > 0 s)"
    print("shift+click: ok")


def run_minified(tmp):
    """A 300 KB one-line bundle is colored on screen (keywords #C678DD) and stays responsive to typing."""
    file = os.path.join(tmp, "bundle.min.js")
    src, i = "", 0
    while len(src) < 300000:
        src += f'function f{i}(a,b){{const c=a+b*{i};if(c>10){{return "s{i}"+c}}return null}}var v{i}=new Map;'
        i += 1
    open(file, "w").write(src + "\n")
    t = Term(file)
    assert t.read("Ln 1, Col 1", timeout=5)
    end = time.time() + 3
    while time.time() < end and not painted(screen_of(t), "function", "#C678DD"):
        t.read(timeout=0.2)
    assert painted(screen_of(t), "function", "#C678DD") and painted(screen_of(t), "return", "#C678DD"), "line 1 not colored"
    t.out = b""
    t.send("x")
    assert t.read("Ln 1, Col 2", timeout=1), "typing is stuck"
    t.send(QUIT); t.send("d")
    assert t.wait_exit() == 0
    print("minified line colors: ok")


BAR_CELL = r"(?:\x1b\[[\d;]*m)*[ ▁-█▉-▏━]"


def run_scrollbars(tmp):
    """A 500-line file has a vertical bar in the last column: dragging the thumb scrolls, a track click jumps, neither moves
    the cursor; hover reports (1003) repaint only the bar. A long line gets a horizontal bar that drags sideways. The hex
    viewer has the same vertical bar."""
    file = os.path.join(tmp, "tall.txt")
    open(file, "w").write("".join(f"row {i}\n" for i in range(500)))
    t = Term(file)
    assert colored_frame(t), "no colored frame"
    sc = screen_of(t)
    assert re.search(r"\x1b\[2;100H" + BAR_CELL, sc), "no vertical bar in the last column"
    assert "\x1b[?1003h" in sc, "hover reports not on"
    t.read(timeout=0.5)                           # the word highlight's frame, 250 ms after the cursor rests
    t.out = b""
    t.send("\x1b[<35;100;2M")                     # buttonless motion onto the thumb: the bar alone repaints
    assert b"\x1b7" in t.out and b"Ln 1, Col 1" not in t.out, "hover repainted more than the bar"
    t.out = b""
    t.send("\x1b[<0;100;2M"); t.send("\x1b[<32;100;16M", wait=0.3); t.send("\x1b[<0;100;16m", wait=0.3)
    rows = [int(n) for n in re.findall(r"row (\d+)", plain(t))]
    assert rows and max(rows) > 250, "dragging the thumb did not scroll: " + repr(rows[-3:])
    assert "Ln 1, Col 1" in plain(t) and "selected" not in plain(t), "the drag moved the cursor"
    t.out = b""
    t.send("\x1b[<0;100;29M"); t.send("\x1b[<0;100;29m", wait=0.3)   # the end of the track: jump
    assert "row 499" in plain(t) and "Ln 1, Col 1" in plain(t), "track click did not jump to the end"
    t.send(QUIT)
    assert t.wait_exit() == 0
    assert b"\x1b[?1003l" in t.out[-300:], "hover reports not turned off on exit"

    wide = os.path.join(tmp, "wide.txt")
    open(wide, "w").write("0123456789" * 40 + "\n")
    t = Term(wide)
    assert t.read("Ln 1, Col 1")
    assert re.search(r"\x1b\[29;7H" + BAR_CELL, screen_of(t)), "no horizontal bar above the status bar"
    t.out = b""
    t.send("\x1b[<0;8;29M"); t.send("\x1b[<32;50;29M", wait=0.3); t.send("\x1b[<0;50;29m", wait=0.3)
    m = re.findall(r"1  (\d{10})", plain(t))
    assert m and m[-1] != "0123456789", "dragging the horizontal thumb did not scroll: " + repr(m[-1:])
    assert "Ln 1, Col 1" in plain(t), "the drag moved the cursor"
    t.send(QUIT)
    assert t.wait_exit() == 0

    blob = os.path.join(tmp, "rows.bin")
    open(blob, "wb").write(bytes(16 * 1000))
    t = Term(blob)
    assert t.read("Decoded Text", timeout=3) and t.read("\x1b[?1003h", timeout=2), "no hex view with hover reports"
    assert re.search(r"\x1b\[3;100H" + BAR_CELL, screen_of(t)), "no bar in the hex viewer"
    t.out = b""
    t.send("\x1b[<0;100;3M"); t.send("\x1b[<32;100;20M", wait=0.3); t.send("\x1b[<0;100;20m", wait=0.3)
    offs = [int(o, 16) for o in re.findall(r"([0-9a-f]{8})  00", plain(t))]
    assert offs and max(offs) > 0x1000, "dragging the hex bar did not scroll"
    assert "Offset 0x0 (0)" in plain(t), "the drag moved the hex cursor"
    t.send(QUIT)
    assert t.wait_exit() == 0
    print("scrollbars: ok")


def bg(hexcolor):
    return sgr(hexcolor).replace("[38;", "[48;")


def run_decorations(tmp):
    """Indent guides in the theme's editorIndentGuide colors (the cursor's block in activeBackground); the bracket pair at
    the cursor on editorBracketMatch.background; the word at the cursor's occurrences after 250 ms."""
    file = os.path.join(tmp, "deco.go")
    open(file, "w").write("package main\n\nfunc main() {\n\tif true {\n\t\tprintln(1)\n\t}\n}\n")
    t = Term(file)
    assert colored_frame(t), "no colored frame"
    t.send("\x07"); t.send("5:3\r")              # into the if block
    assert t.read("Ln 5, Col 9", timeout=2)
    sc = screen_of(t)
    assert sgr("#3c4049") + "│" in sc, "no indent guide in editorIndentGuide.background #abb2bf26"
    assert sgr("#626772") + "│" in sc, "no active guide in editorIndentGuide.activeBackground #626772"
    assert "5  │   │   println(1)" in plain(t), "guides not at each indent step"
    t.out = b""
    t.send("\x1b[C" * 8)                          # after the ( of println(
    assert t.read("Ln 5, Col 17", timeout=2)
    sc = screen_of(t)
    assert re.search(re.escape(bg("#515a6b")) + r"\((?:\x1b\[[\d;]*m)*1(?:\x1b\[[\d;]*m)*" + re.escape(bg("#515a6b")) + r"\)", sc), "brackets not highlighted"
    t.send("\x07")
    t.out = b""
    t.send("3:7\r")                              # on `main` of func main
    t.read(timeout=0.5)
    assert screen_of(t).count(bg("#474d59") + "main") >= 2, "occurrences of main not on wordHighlightBackground"
    t.send(QUIT)
    assert t.wait_exit() == 0
    print("decorations: ok")


def run_autoclose(tmp):
    """Typing in a TypeScript file: ( and " insert their pairs, typing the closers steps over them, Backspace in an empty
    pair deletes both, an opener wraps the selection; a quick chunk of keys is handled key by key."""
    file = os.path.join(tmp, "pairs.ts")
    open(file, "w").write("\n")
    t = Term(file)
    assert colored_frame(t), "no colored frame"
    for ch in 'f("a':
        t.send(ch, wait=0.05)
    t.send('")')                                   # one chunk: over the quote, over the paren
    t.send(" [", wait=0.05); t.send("\x7f")         # [] then Backspace: both gone
    t.send(";")
    t.send("\x1b[1;2D")                            # Shift+Left selects the ;
    t.send("{")                                    # wraps it
    t.send("\x13")
    assert t.read("Saved", timeout=2)
    t.send(QUIT)
    assert t.wait_exit() == 0
    got = open(file).read()
    assert got == 'f("a") {;}\n', repr(got)
    print("auto-closing pairs: ok")


def status_col(t, text):
    """1-based column of `text` in the last painted status bar (row 30)."""
    row = plain(t).split("\x1b[30;1H")[-1]
    assert text in row, "not in the status bar: " + repr(row[:120])
    return row.index(text) + 1


def run_find_and_status(tmp):
    """The find widget (Linux keys): Alt+C / Alt+W narrow the matches (N of M in the widget), Ctrl+Alt+Enter replaces all. Status bar clicks:
    Ln/Col opens Go to Line, LF picks CRLF and the save writes it."""
    file = os.path.join(tmp, "words.txt")
    open(file, "w").write("Foo foo food\nbar foo\n")
    t = Term(file)
    assert t.read("Ln 1, Col 1")
    t.send("\x06"); t.send("foo", wait=0.3)               # Ctrl+F foo
    assert "1 of 4" in plain(t) and "Aa ab .*" in plain(t), "no count in the widget:\n" + plain(t)[-300:]
    t.send("\x1bc", wait=0.3)                             # Alt+C Match Case
    assert t.read("1 of 3", timeout=2), "Match Case did not narrow:\n" + plain(t)[-300:]
    t.send("\x1bw", wait=0.3)                             # Alt+W Match Whole Word
    assert t.read("1 of 2", timeout=2), "Whole Word did not narrow"
    t.send("\x08", wait=0.2)                              # Ctrl+H: the Replace row
    t.send("baz"); t.send("\x1b[13;7u", wait=0.3)         # Ctrl+Alt+Enter Replace All
    assert t.read("No results", timeout=2) and "baz food" in plain(t), "no Replace All:\n" + plain(t)[-300:]
    t.send("\x1b[27u"); t.send("\x13")
    assert t.read("Saved", timeout=2)
    assert open(file).read() == "Foo baz food\nbar baz\n"
    x = status_col(t, "Ln ")
    t.send(f"\x1b[<0;{x + 1};30M\x1b[<0;{x + 1};30m", wait=0.3)
    assert t.read("Go to line", timeout=2), "Ln/Col did not open Go to Line"
    t.send("\x1b[27u", wait=0.2)
    x = status_col(t, "   LF   ") + 3
    t.send(f"\x1b[<0;{x};30M\x1b[<0;{x};30m", wait=0.3)
    assert t.read("Select End of Line Sequence", timeout=2), "LF did not open the picker"
    t.send("\x1b[B"); t.send("\r", wait=0.3); t.send("\x13")
    assert t.read("CRLF", timeout=2) and t.read("Saved", timeout=2)
    assert open(file, "rb").read() == b"Foo baz food\r\nbar baz\r\n", open(file, "rb").read()
    t.send(QUIT)
    assert t.wait_exit() == 0
    print("find toggles + status bar items: ok")


SHOP = 'export class Shop {\n  buy(n: number) {\n    return n;\n  }\n}\nconst s: string = 1;\n'


def run_symbols_and_problems(tmp):
    """Through tsserver: right after opening (no edit) the type error has a red underline (SGR 4 + 58), a red ● in the
    gutter and a full red cell beside its row on the overview ruler, which shows although the file fits; the
    breadcrumbs follow the cursor into Shop › buy, F8 goes to the error (its message in the status bar), Ctrl+Shift+O
    lists the symbols from the TypeScript server and jumps."""
    proj = os.path.join(tmp, "shopproj")
    os.makedirs(proj)
    subprocess.run(["git", "init", "-q"], cwd=proj, check=True)
    open(os.path.join(proj, "tsconfig.json"), "w").write('{"compilerOptions":{"strict":true}}')
    file = os.path.join(proj, "shop.ts")
    open(file, "w").write(SHOP)
    t = Term(file)
    assert t.read("Ln 1, Col 1")
    assert t.read("\x1b[4m\x1b[58:2::241:76:76m", timeout=20), "no red underline after opening"
    t.read(timeout=0.5)
    screen = screen_of(t)
    assert "\x1b[4:3m" not in screen, "a curly underline, which showed nothing in Herdr's terminal"
    ruler_red = "#%02x%02x%02x" % tuple(round(a * 0.702 + b * 0.298) for a, b in ((255, 40), (18, 44), (18, 52)))
    assert re.search(r"\x1b\[7;100H(?:\x1b\[[\d;]*m)*" + re.escape(sgr(ruler_red)) + r"(?:\x1b\[[\d;]*m)*█", screen), "no full red ruler cell beside line 6"
    assert re.search(r"\x1b\[7;1H(?:\x1b\[[\d;]*m)*" + re.escape(sgr("#f14c4c")) + "●", screen), "no red ● in the gutter of line 6"
    t.send("\x07"); t.send("3:5\r")
    assert t.read("shop.ts › Shop › buy", timeout=20), "no symbol breadcrumbs:\n" + plain(t)[-300:]
    t.out = b""
    t.send("\x1b[19~", wait=0.3)                          # F8
    assert t.read("Ln 6, Col 7", timeout=5) and t.read("not assignable", timeout=2), "F8 did not reach the error:\n" + plain(t)[-300:]
    t.send("\x1b[111;6u", wait=0.5)                       # Ctrl+Shift+O
    assert t.read("from TypeScript server", timeout=10), "no symbol picker:\n" + plain(t)[-300:]
    assert "Shop" in plain(t) and "method" in plain(t)
    t.send("buy"); t.send("\r", wait=0.3)
    assert t.read("Ln 2, Col 3", timeout=2), "the picker did not jump to buy"
    t.send(QUIT)
    assert t.wait_exit() == 0
    print("symbols + diagnostics (tsserver): ok")


def fake_server(folder, name):
    """A fake language server (fake-lsp.cjs) installed as `name` in `folder`."""
    f = os.path.join(folder, name)
    with open(f, "w") as out:
        out.write(f'#!/bin/sh\nexec "{shutil.which("node")}" "{os.path.join(HERE, "fake-lsp.cjs")}" "{name}" "$@"\n')
    os.chmod(f, 0o755)


def run_install_prompt(tmp):
    """A YAML file without its server: with extensions.ignoreRecommendations nothing is offered; else the status bar offers
    "Install YAML language server (npm i -g yaml-language-server)?" (a stub npm is the tool here), a click asks Herdr for a
    new terminal tab running it (the stub herdr-app logs terminal.open with the command), and once the server turns up
    (a fake one put on PATH) the editor starts it within seconds: its error gets the red underline."""
    env, log = herdr_stub(tmp)
    stub = env["PATH"].split(":")[0]
    extra = [stub, *os.environ["PATH"].split(":"), "/opt/homebrew/bin", "/usr/local/bin", os.path.expanduser("~/.local/bin"), os.path.expanduser("~/.cargo/bin")]
    if shutil.which("yaml-language-server", path=":".join(extra)):
        print("install prompt: skipped (yaml-language-server is installed)")
        return
    with open(os.path.join(stub, "npm"), "w") as f:
        f.write("#!/bin/sh\nexit 0\n")
    os.chmod(os.path.join(stub, "npm"), 0o755)
    proj = os.path.join(tmp, "yamlproj")
    os.makedirs(proj)
    file = os.path.join(proj, "a.yaml")
    open(file, "w").write("key: [\n")
    offer = "Install YAML language server (npm i -g yaml-language-server)?"
    settings = ISOLATED["VSEDIT_SETTINGS"]
    os.makedirs(os.path.dirname(settings), exist_ok=True)
    before = open(settings).read() if os.path.exists(settings) else None
    raw = json.loads(before) if before else {}
    open(settings, "w").write(json.dumps({**raw, "extensions.ignoreRecommendations": True}) + "\n")
    try:
        t = Term(file, cols=140, env=env)
        assert t.read("Ln 1, Col 1")
        assert not t.read(offer, timeout=2), "offered although extensions.ignoreRecommendations is on"
        t.send(QUIT)
        assert t.wait_exit() == 0
    finally:
        if before is None:
            os.remove(settings)
        else:
            open(settings, "w").write(before)
    t = Term(file, cols=140, env=env)  # wide enough for the whole offer beside the status bar's items
    assert t.read(offer, timeout=10), "no install offer:\n" + plain(t)[-300:]
    t.send("\x1b[<0;5;30M\x1b[<0;5;30m", wait=0.5)
    assert t.read("Installing YAML language server in a new terminal tab", timeout=3), "the click did not start the install"
    calls = open(log).read()
    assert "do terminal.open --place tab --name Install YAML language server --folder " + proj in calls, calls
    assert '--argv ["sh","-c",' in calls and '"sh","npm i -g yaml-language-server"]' in calls, calls
    fake_server(stub, "yaml-language-server")
    assert t.read("YAML language server is installed", timeout=8), "the installed server was not noticed:\n" + plain(t)[-300:]
    assert t.read("\x1b[4m\x1b[58:2::241:76:76m", timeout=10), "the new server's problem has no red underline"
    assert t.read("fake yaml-language-server --stdio", timeout=5), "the problem is not the server's"
    t.send(QUIT)
    assert t.wait_exit() == 0
    print("install prompt: ok")


def run_git_gutter(tmp):
    """A file in a temp git repo: a typed line gets the modified bar, a new line the added bar (editorGutter colors), ⌥F5 /
    ⇧⌥F5 go to the next / previous change; after a commit the bars go."""
    repo = os.path.join(tmp, "repo")
    os.makedirs(repo)
    git = lambda *a: subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", *a], cwd=repo, check=True, capture_output=True)
    git("init", "-q")
    file = os.path.join(repo, "g.txt")
    open(file, "w").write("".join(f"line {i}\n" for i in range(10)))
    git("add", "g.txt"); git("commit", "-q", "-m", "first")
    t = Term(file)
    assert colored_frame(t), "no colored frame"
    t.send("X", wait=0.6)                               # line 1 modified, diffed 300 ms later
    assert sgr("#948b60") + "▎" in screen_of(t), "no modified bar in editorGutter.modifiedBackground"
    t.send("\x07"); t.send("8\r"); t.send("\x1b[F"); t.send("\r"); t.send("new", wait=0.6)
    assert sgr("#109868") + "▎" in screen_of(t), "no added bar in editorGutter.addedBackground"
    assert "Ln 9, Col 4" in plain(t)
    t.send("\x1b[15;3~")                                 # ⌥F5: past the last change, back to the first
    assert t.read("Ln 1, Col 1", timeout=2), "Go to Next Change did not wrap to line 1"
    t.send("\x1b[15;4~")                                 # ⇧⌥F5: from the first, the last
    assert t.read("Ln 9, Col 1", timeout=2), "Go to Previous Change did not go to the added line"
    t.send("\x13")
    assert t.read("Saved", timeout=2)
    git("commit", "-q", "-am", "second")
    t.out = b""
    time.sleep(3.5); t.read()                            # the 3 s poll sees the new HEAD and repaints
    last = plain(t).split("\x1b[1;1H")[-1]               # the last frame
    assert "Ln 9" in last and "▎" not in last, "bars still there after the commit"
    t.send(QUIT)
    assert t.wait_exit() == 0
    print("git gutter: ok")


def no_lenses(tmp):
    """Settings with CodeLens off, for scenarios that click rows of TypeScript (the lens rows would move them)."""
    file = os.path.join(tmp, "settings", "no-lenses.json")
    os.makedirs(os.path.dirname(file), exist_ok=True)
    shared = json.load(open(ISOLATED["VSEDIT_SETTINGS"])) if os.path.exists(ISOLATED["VSEDIT_SETTINGS"]) else {}
    open(file, "w").write(json.dumps({**shared, "editor.codeLens": False}))  # the shared settings (provider off) kept
    return {"VSEDIT_SETTINGS": file}


def run_folding(tmp):
    """Linux keys. Kitty Ctrl+Shift+[ folds the block at the cursor (⋯ after the header, its lines gone, ↓ skips them),
    Ctrl+Shift+] unfolds it; chevrons show with the pointer on the gutter and a click on one folds; Unfold All from the
    palette; the two-step chords Ctrl+K Ctrl+0 / Ctrl+L / Ctrl+J with the status hint after Ctrl+K."""
    file = os.path.join(tmp, "fold.ts")
    open(file, "w").write("function a() {\n  if (x) {\n    one();\n    two();\n  }\n}\nconst z = 1;\n")
    t = Term(file, env=no_lenses(tmp))
    assert colored_frame(t), "no colored frame"
    last = lambda: plain(t).split("\x1b[1;1H")[-1]
    t.send("\x07"); t.send("3\r")
    t.send("\x1b[91;6u", wait=0.3)                      # ⌃⇧[ (Kitty: [ with ctrl+shift)
    assert "⋯" in last() and "one();" not in last() and "Ln 2, Col" in last(), "Fold did not fold the if block:\n" + last()[-600:]
    t.send("\x1b[B")
    assert t.read("Ln 5, Col", timeout=2), "↓ did not skip the folded lines"
    t.send("\x1b[A"); t.send("\x1b[93;6u", wait=0.3)    # ⌃⇧]
    assert "one();" in last() and "⋯" not in last(), "Unfold did not unfold"
    t.send("\x1b[<35;2;3M", wait=0.3)                   # the pointer onto the gutter
    assert "⌄" in last(), "no chevrons with the pointer on the gutter"
    t.send("\x1b[<0;6;2M"); t.send("\x1b[<0;6;2m", wait=0.3)  # click line 1's chevron
    assert "›function a() { ⋯" in last() and "const z" in last() and "if (x)" not in last(), "the chevron click did not fold:\n" + last()[-600:]
    if RUST_BIN:  # no command palette until phase 3: its key (Ctrl+K Ctrl+J) instead
        t.send("\x1b[107;5u\x1b[106;5u", wait=0.3)
    else:
        t.send("\x1bOP"); t.send("Unfold All", wait=0.3); t.send("\r", wait=0.3)
    assert "one();" in last(), "Unfold All from the palette"
    t.send("\x1b[107;5u")                               # Ctrl+K: the chord's first key
    assert "(Ctrl+K) was pressed. Waiting for" in last(), "no chord hint: " + repr(last()[-500:])
    t.send("\x1b[48;5u", wait=0.3)                      # Ctrl+0: Fold All
    assert "›function a() { ⋯" in last() and "if (x)" not in last(), "Ctrl+K Ctrl+0 Fold All"
    t.send("\x0b\x0c", wait=0.3)                         # legacy Ctrl+K Ctrl+L: Toggle Fold (the cursor's fold opens)
    assert "x) { ⋯" in last() and "5  │ }" in last(), "Ctrl+K Ctrl+L Toggle Fold: the outer fold opens, the inner stays"
    t.send("\x1b[107;5u\x1b[106;5u", wait=0.3)          # Ctrl+K Ctrl+J: Unfold All
    assert "one();" in last(), "Ctrl+K Ctrl+J Unfold All"
    t.send(QUIT)
    assert t.wait_exit() == 0
    print("folding: ok")


def run_word_wrap(tmp):
    """editor.wordWrap "on" (Linux keys): a long line paints on 3 rows (the number on the first only), ↓ moves within it, a
    click on its third row lands there; Alt+Z turns wrapping off (one row, "No Wrap" in the status bar) and a click on that
    item turns it on again; narrowing the window rewraps onto more rows (5 at 52 columns) and the cursor keeps its line and column."""
    file = os.path.join(tmp, "wrap.txt")
    words = " ".join(f"word{i:02d}" for i in range(30))   # 209 characters: 3 rows at 92 columns
    open(file, "w").write(f"short\n{words}\nend\n")
    settings = os.path.join(tmp, "settings", "wrap.json")
    open(settings, "w").write(json.dumps({**json.load(open(ISOLATED["VSEDIT_SETTINGS"])), "editor.wordWrap": "on"}))
    t = Term(file, env={"VSEDIT_SETTINGS": settings})
    assert t.read("Ln 1, Col 1")
    t.read(timeout=0.4)
    assert row_text(t, 3).startswith("   2  word00") and row_text(t, 4).startswith("      word") and "   3  end" in row_text(t, 6), \
        "not wrapped onto 3 rows:\n" + "\n".join(row_text(t, r) for r in range(2, 7))
    t.send("\x1b[B"); t.send("\x1b[B", wait=0.3)           # line 2's first row, then its second
    second = int(re.findall(r"Ln 2, Col (\d+)", plain(t))[-1])
    assert second > 80, f"↓ left the wrapped line: Col {second}"
    t.send(f"\x1b[<0;10;5M\x1b[<0;10;5m", wait=0.3)        # x 3 on the third row
    third = int(re.findall(r"Ln 2, Col (\d+)", plain(t))[-1])
    assert third > second + 80, f"the click did not land on the third row: Col {third}"
    t.send("\x1bz", wait=0.3)                               # Alt+Z: Toggle Word Wrap
    assert row_text(t, 4).startswith("   3 ") and "No Wrap" in plain(t).split("\x1b[30;1H")[-1], "Alt+Z did not turn wrapping off"
    x = status_col(t, "No Wrap") + 1
    t.send(f"\x1b[<0;{x};30M\x1b[<0;{x};30m", wait=0.3)
    assert "   3  end" in row_text(t, 6) and "No Wrap" not in plain(t).split("\x1b[30;1H")[-1], "the status bar item did not turn wrapping on"
    fcntl.ioctl(t.fd, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 60, 0, 0))
    os.kill(t.pid, signal.SIGWINCH)
    t.read(timeout=0.5)
    assert f"Ln 2, Col {third}" in plain(t).split("\x1b[30;1H")[-1], "the resize moved the cursor"
    assert "   3  end" in row_text(t, 8), "not rewrapped onto 5 rows at 60 columns: " + " / ".join(row_text(t, r) for r in range(2, 9))
    t.send(QUIT)
    assert t.wait_exit() == 0
    print("word wrap: ok")


MED = ('export function greet(name: string) {\n  return "hi " + name;\n}\nconst n = greet("a").length;\nconst m = gret("b");\n'
       'const msg = "hi there";\nconst   y  =  1 ;\nconst   z  =  2 ;\n')
OTHER = "export function farewell() {\n  return 1;\n}\n"


def run_picker_scroll(tmp):
    """Select Language Mode (Ctrl+K M) lists more languages than its 12 rows: End shows YAML at the bottom, Home goes
    back to Plain Text, the wheel over the list scrolls it (the selection stays), and a click after the wheel picks the
    row under the pointer."""
    file = os.path.join(tmp, "s.lua")
    open(file, "w").write("print(1)\n")
    t = Term(file)
    assert t.read("Ln 1, Col 1")
    t.send("\x0b"); t.send("m", wait=0.4)                # Ctrl+K M
    assert t.read("Select Language Mode", timeout=3) or "Lua" in plain(t), "no language picker"
    t.out = b""
    t.send("\x1b[F", wait=0.4)                           # End
    assert "YAML" in plain(t), "End did not scroll to the last language:\n" + plain(t)[-600:]
    t.out = b""
    t.send("\x1b[H", wait=0.4)                           # Home
    assert "Plain Text" in plain(t), "Home did not scroll back to the first language"
    t.out = b""
    t.send("\x1b[<65;50;5M", wait=0.2); t.send("\x1b[<65;50;5M", wait=0.4)   # two wheel notches down over the list
    sc = plain(t)
    at = sc.rfind("\x1b[4;12H")                         # the first list row (box at x 11, y 2: the list from row 4)
    row = re.split(r"\x1b", sc[at + 8:], maxsplit=1)[0].strip() if at >= 0 else ""
    assert row and not row.startswith("Plain Text"), "the wheel did not scroll the list: " + repr(row)
    assert "\x1b[4;89H" in sc, "no scrollbar in the list's last column"
    t.send("\x1b[<0;50;4M\x1b[<0;50;4m", wait=0.5)       # click that row
    name = row.split("(")[0].strip()
    assert t.read(name, timeout=3) and status_col(t, name) > 0, f"the click did not pick {name}:\n" + plain(t)[-400:]
    t.send(QUIT)
    assert t.wait_exit() == 0
    print(f"picker scroll (End / Home / wheel / click {name}): ok")


def run_medium_language(tmp):
    """Through tsserver, on Windows/Linux keys: Ctrl+K Ctrl+I shows greet's signature, the mouse resting on `n` shows its
    type, Ctrl+. offers "Change spelling to 'greet'" and applies it, Shift+Alt+→ / ← grow and shrink the selection in a
    string, Ctrl+K Ctrl+F formats only the selected line, Ctrl+T finds `farewell` in the other file and opens it."""
    proj = os.path.join(tmp, "medproj")
    os.makedirs(proj)
    subprocess.run(["git", "init", "-q"], cwd=proj, check=True)
    open(os.path.join(proj, "tsconfig.json"), "w").write('{"compilerOptions":{"strict":true}}')
    file = os.path.join(proj, "m.ts")
    open(file, "w").write(MED)
    open(os.path.join(proj, "other.ts"), "w").write(OTHER)
    t = Term(file, cols=120, env=no_lenses(tmp))       # room for the whole problem message beside the status items
    assert t.read("Ln 1, Col 1")
    t.send("\x07"); t.send("1:18\r")                     # on greet
    t.send("\x0b"); t.send("\x1b[105;5u", wait=0.3)      # Ctrl+K Ctrl+I (Kitty: Ctrl+I is Tab in legacy bytes)
    assert t.read("function greet(name: string): string", timeout=20), "no hover:\n" + plain(t)[-400:]
    t.send("\x1b[27u")                                   # Esc closes it
    t.out = b""
    t.send("\x1b[<35;13;5M", wait=0.6)                   # the pointer rests on `n` (line 4, column 7)
    assert t.read("const n: number", timeout=20), "no mouse hover:\n" + plain(t)[-400:]
    t.send("\x1b[<35;60;12M")                            # off the text: it closes
    t.send("\x07"); t.send("5:12\r")                     # on gret
    assert t.read("Did you mean 'greet'", timeout=20), "no diagnostic for gret"
    t.out = b""
    t.send("\x1b[46;5u", wait=0.5)                       # Ctrl+.
    assert t.read("Change spelling to 'greet'", timeout=20), "no quick fix menu:\n" + plain(t)[-400:]
    t.send("\r", wait=0.5)
    t.send("\x07"); t.send("6:18\r")                     # in "there"
    t.out = b""
    t.send("\x1b[1;4C", wait=0.5)                        # Shift+Alt+→: the word
    assert t.read("(5 selected)", timeout=20), "Expand Selection did not select the word:\n" + plain(t)[-300:]
    t.send("\x1b[1;4C", wait=0.3)                        # the string's contents
    assert t.read("(8 selected)", timeout=5), "Expand Selection did not select the string's contents"
    t.out = b""
    t.send("\x1b[1;4D", wait=0.3)                        # Shift+Alt+←: back to the word
    assert t.read("(5 selected)", timeout=5), "Shrink Selection did not go back"
    t.send("\x07"); t.send("7:1\r")
    t.send("\x1b[1;2B")                                  # Shift+Down: line 7 selected
    t.send("\x0b"); t.send("\x1b[102;5u", wait=1.0)      # Ctrl+K Ctrl+F
    t.send("\x13")
    assert t.read("Saved", timeout=5)
    got = open(file).read()
    assert 'const m = greet("b");' in got, "the quick fix was not applied:\n" + got
    assert "\nconst y = 1;\nconst   z  =  2 ;\n" in got, "Format Selection:\n" + got
    t.out = b""
    t.send("\x14"); t.send("farewell", wait=0.5)         # Ctrl+T
    assert t.read("other.ts", timeout=20), "no workspace symbol:\n" + plain(t)[-400:]
    t.out = b""
    t.send("\r", wait=0.5)                               # tsserver's span starts at the declaration, as in VS Code
    assert t.read("other.ts › farewell", timeout=10) and "Ln 1, Col 1" in plain(t), "did not open other.ts at farewell:\n" + plain(t)[-600:]
    t.send(QUIT)
    assert t.wait_exit() == 0
    print("hover, quick fix, smart select, format selection, workspace symbols (tsserver): ok")


REF_A = 'export function greet(name: string) {\n  return "hi " + name;\n}\nlet count = 0;\ncount = count + 1;\ngreet("c");\n'
REF_B = 'import { greet } from "./a";\ngreet("a");\ngreet("b");\n'


def row_text(t, r):
    """The text last painted on screen row r (from its cursor move to the next escape)."""
    sc = plain(t)
    at = sc.rfind(f"\x1b[{r};1H")
    assert at >= 0, f"row {r} never painted"
    return re.split(r"\x1b", sc[at + len(f"\x1b[{r};1H"):], maxsplit=1)[0]


def palette():
    return json.loads(subprocess.check_output(["node", "-e", f"console.log(JSON.stringify(require({json.dumps(os.path.join(HERE, '..', 'paint.cjs'))}).themePalette()))"]))


def run_references_and_lenses(tmp):
    """Through tsserver: an "N references" CodeLens row above greet (a click peeks them), Shift+F12 peeks several
    references, resting on `count` paints its write and its reads in their own colors (documentHighlight), Ctrl+F seeds
    the word at the cursor (typing replaces it), Alt+L keeps the search to the selection, Ctrl+click goes to the definition."""
    proj = os.path.join(tmp, "refproj")
    os.makedirs(proj)
    subprocess.run(["git", "init", "-q"], cwd=proj, check=True)
    open(os.path.join(proj, "tsconfig.json"), "w").write('{"compilerOptions":{"strict":true}}')
    open(os.path.join(proj, "a.ts"), "w").write(REF_A)
    open(os.path.join(proj, "b.ts"), "w").write(REF_B)
    colors = palette()
    t = Term(os.path.join(proj, "a.ts"))
    assert t.read("Ln 1, Col 1")
    assert t.read(" reference", timeout=30), "no CodeLens:\n" + plain(t)[-600:]
    t.read(timeout=0.3)
    lens, line1 = row_text(t, 2), row_text(t, 3)
    m = re.search(r"(\d+) references?", lens)
    assert m and int(m.group(1)) >= 2, "the lens row: " + repr(lens)
    assert "export function greet" in line1, "the declaration is not below its lens: " + repr(line1)
    assert sgr(colors["codeLens"]) in screen_of(t), "the lens is not in editorCodeLens.foreground"
    t.out = b""
    t.send("\x1b[<0;8;2M\x1b[<0;8;2m", wait=0.5)        # a click on the lens
    assert t.read("— References", timeout=20), "the lens click did not peek:\n" + plain(t)[-600:]
    assert "Ln 1, Col 17" in plain(t)
    t.send("\x1b[27u")
    t.out = b""
    t.send("\x1b[24;2~", wait=0.5)                        # Shift+F12 Go to References: several -> peek
    assert t.read("— References", timeout=20) and re.search(r"1 of \d", plain(t)), "Shift+F12 did not peek:\n" + plain(t)[-600:]
    t.send("\x1b[27u")
    t.out = b""
    t.send("\x07"); t.send("5:1\r")                       # on the written `count`
    t.read(timeout=1.5)
    sc = screen_of(t)
    assert bg(colors["wordHighlightStrong"]) + "count" in sc, "no write highlight (wordHighlightStrongBackground):\n" + sc[-600:]
    assert bg(colors["wordHighlight"]) + "count" in sc, "no read highlight (wordHighlightBackground)"
    t.out = b""
    t.send("\x06", wait=0.3)                             # Ctrl+F: the word at the cursor
    assert t.read("of 3", timeout=2) and "count" in plain(t), "Ctrl+F did not seed `count`:\n" + plain(t)[-400:]
    t.send("greet", wait=0.3)                             # typing replaces the seed
    assert t.read("2 of 2", timeout=2), "typing did not replace the seed:\n" + plain(t)[-400:]
    t.send("\x1b[27u")
    t.send("\x07"); t.send("5:1\r")
    t.send("\x1b[1;2B"); t.send("\x1b[1;2B")              # Shift+Down x2: lines 5-6
    t.send("\x06"); t.send("greet", wait=0.3)
    assert t.read("of 2", timeout=2)
    t.out = b""
    t.send("\x1bl", wait=0.3)                            # Alt+L Find in Selection
    assert t.read("1 of 1", timeout=2), "Alt+L did not keep to the selection:\n" + plain(t)[-400:]
    t.send("\x1b[27u")
    t.send("\x07"); t.send("4:1\r")
    t.out = b""
    t.send("\x1b[<16;8;8M\x1b[<16;8;8m", wait=0.5)      # Ctrl+click on greet("c") (row 8: the lens row comes first)
    assert t.read("Ln 1, Col 17", timeout=20), "Ctrl+click did not go to the definition:\n" + plain(t)[-400:]
    t.send(QUIT)
    assert t.wait_exit() == 0
    print("references, CodeLens, reference highlights, find seeding (tsserver): ok")


def run_medium_editing(tmp):
    """Line comments on Windows/Linux keys (Ctrl+/ toggles, Ctrl+K Ctrl+C adds, Ctrl+K Ctrl+U removes; CSS gets a block
    comment) and Cursor Undo (Ctrl+U); on macOS keys ⌘U undoes the cursor while ⌃U (Herdr's ⌘⌫) still deletes to the line start."""
    file = os.path.join(tmp, "cm.js")
    open(file, "w").write("a();\n// b();\nc();\n")
    t = Term(file)
    assert t.read("Ln 1, Col 1")
    t.send("\x1b[1;6F")                                  # Ctrl+Shift+End: all selected
    t.send("\x1b[47;5u")                                 # Ctrl+/: not all commented -> comments every line
    t.send("\x0b"); t.send("\x1b[117;5u")                # Ctrl+K Ctrl+U: removes one level
    t.send("\x0b"); t.send("\x1b[117;5u")                # again: b's own comment goes
    t.send("\x1b[1;5H")                                  # Ctrl+Home
    t.send("\x0b"); t.send("\x1b[99;5u")                 # Ctrl+K Ctrl+C on line 1
    t.send("\x07"); t.send("3:3\r")
    assert t.read("Ln 3, Col 3", timeout=2)
    t.out = b""
    t.send("\x15")                                       # Ctrl+U: Cursor Undo
    assert t.read("Ln 1, Col 4", timeout=2), "Ctrl+U did not bring the cursor back:\n" + plain(t)[-300:]
    t.send("\x13"); assert t.read("Saved", timeout=2)
    assert open(file).read() == "// a();\nb();\nc();\n", repr(open(file).read())
    t.send(QUIT)
    assert t.wait_exit() == 0
    css = os.path.join(tmp, "s.css")
    open(css, "w").write("a { color: red; }\n")
    t = Term(css)
    assert t.read("Ln 1, Col 1")
    t.send("\x1b[47;5u")                                 # Ctrl+/ in CSS: a block comment around the line
    t.send("\x13"); assert t.read("Saved", timeout=2)
    assert open(css).read() == "/* a { color: red; } */\n", repr(open(css).read())
    t.send(QUIT)
    assert t.wait_exit() == 0
    file = os.path.join(tmp, "mu.txt")
    open(file, "w").write("one two\nthree\n")
    t = Term(file, env=MAC)
    assert t.read("Ln 1, Col 1")
    t.send("\x1b[B"); t.send("\x05")                     # ↓, ⌃E (⌘→): Ln 2, Col 6
    assert t.read("Ln 2, Col 6", timeout=2)
    t.out = b""
    t.send("\x1b[117;9u")                                # ⌘U
    assert t.read("Ln 2, Col 1", timeout=2), "⌘U did not undo the cursor"
    t.out = b""
    t.send("\x1b[117;9u")
    assert t.read("Ln 1, Col 1", timeout=2), "the second ⌘U did not go back to the start"
    t.send("\x05"); t.send("\x15")                       # ⌃E, ⌃U: deletes to the line start
    t.send("\x1b[115;9u"); assert t.read("Saved", timeout=2)
    assert open(file).read() == "\nthree\n", repr(open(file).read())
    t.send(MAC_QUIT)
    assert t.wait_exit() == 0
    print("line comments, cursor undo: ok")


class FakeOllama(http.server.ThreadingHTTPServer):
    """/api/generate on 127.0.0.1: the reply depends on how the text before the cursor (in the raw FIM prompt) ends;
    every request but the warm-up and /api/show is kept."""
    REPLIES = {"return": " a + b;", "c": "onsole.log(a + b);",
               "p": "Here's a breakdown of each service:",            # prose: never shown
               "q": "```js\nuit();\n```",                              # a fenced reply: shown without its fences
               "i": "f (a) {\n    go();\n  }\n  stop();\n  stop();"}  # a block: cut after its closing brace

    def __init__(self):
        self.requests, self.warmups = [], 0
        server = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                if self.path == "/api/show":
                    reply = {"template": "{{ .Prompt }}"}
                elif body.get("prompt") == "" and body.get("options", {}).get("num_predict") == 1:
                    server.warmups += 1
                    reply = {"response": "", "done": True}
                else:
                    server.requests.append(body)
                    p = body["prompt"].split("<|fim_suffix|>")[0]
                    reply = {"response": next((v for k, v in FakeOllama.REPLIES.items() if p.endswith(k)), ""), "done": True}
                data = json.dumps(reply).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        super().__init__(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.serve_forever, daemon=True).start()


def run_inline_suggest(tmp):
    """Ghost text from a fake Ollama after typing pauses (one request for a burst), Tab accepts, typing its own
    characters keeps the rest without asking again, Ctrl+→ takes a word, Esc hides it; a prose reply never shows, a
    fenced one shows without its fences, a block is cut after its closing brace and Tab takes all of it; a .env file
    sends nothing."""
    stub = FakeOllama()
    settings = os.path.join(tmp, "inline", "vscode-settings.json")
    os.makedirs(os.path.dirname(settings))
    json.dump({"editor.inlineSuggest.provider": "ollama", "editor.inlineSuggest.endpoint": f"http://127.0.0.1:{stub.server_port}",
               "editor.inlineSuggest.debounce": 80}, open(settings, "w"))
    env = {"VSEDIT_SETTINGS": settings}
    file = os.path.join(tmp, "add.js")
    open(file, "w").write("function add(a, b) {\n  \n}\n")
    t = Term(file, env=env)
    assert colored_frame(t), "no colored frame"
    t.send("\x07"); t.send("2:3\r")
    t.out = b""
    t.send("return", wait=0.02)
    assert t.read(" a + b;", timeout=3), "no ghost text:\n" + plain(t)[-400:]
    assert sgr("#717378") + " a + b;" in screen_of(t), "the ghost text isn't in editorGhostText's color"
    assert len(stub.requests) == 1, f"{len(stub.requests)} requests for one burst of typing"
    first = stub.requests[0]
    assert first["raw"] and first["prompt"].endswith("<|fim_suffix|>\n}<|fim_middle|>") and "\n" not in first["options"]["stop"], repr(first["prompt"][-40:])
    t.send("\t")                                         # Tab accepts
    t.send("\r"); t.read(timeout=0.4)                    # a new line (its empty reply shows nothing)
    asked = len(stub.requests)
    t.out = b""
    t.send("c")
    assert t.read("onsole.log(a + b);", timeout=3), "no ghost text after c"
    t.out = b""
    t.send("ons", wait=0.05)
    assert t.read("ole.log(a + b);", timeout=2), "the rest of the suggestion doesn't show after typing through"
    t.read(timeout=0.4)
    assert len(stub.requests) == asked + 1, "typing through the suggestion asked again"
    t.send("\x1b[1;5C")                                  # Ctrl+→: accept next word ("ole")
    t.send("\x1b", wait=0.3)                             # Esc hides the rest
    t.send("\x13"); assert t.read("Saved", timeout=2)
    assert open(file).read() == "function add(a, b) {\n  return a + b;\n  console\n}\n", repr(open(file).read())
    t.send("\x1b[1;5F"); t.send("\x1b[A"); t.send("\x1b[F"); t.send("\r")  # a new line under "console"
    asked = len(stub.requests)
    t.out = b""
    t.send("p"); t.read(timeout=0.8)                     # prose: asked, not shown
    assert len(stub.requests) == asked + 1 and "breakdown" not in plain(t), "a prose reply showed"
    t.send("\x7f"); t.out = b""
    t.send("q")
    assert t.read("uit();", timeout=3), "no ghost text from the fenced reply"
    assert "```" not in plain(t), "the fence showed"
    t.send("\x1b", wait=0.2); t.send("\x7f"); t.out = b""
    t.send("i")
    assert t.read("go();", timeout=3), "no block ghost text"
    t.read(timeout=0.5)
    assert "stop();" not in plain(t), "the block wasn't cut after its closing brace"
    t.send("\t")                                        # Tab takes the whole block
    t.send("\x13"); assert t.read("Saved", timeout=2)
    assert open(file).read() == "function add(a, b) {\n  return a + b;\n  console\n  if (a) {\n    go();\n  }\n}\n", repr(open(file).read())
    t.send(QUIT)
    assert t.wait_exit() == 0
    assert stub.warmups == 1, f"{stub.warmups} warm-ups"
    secret = os.path.join(tmp, ".env")
    open(secret, "w").write("TOKEN=\n")
    asked = len(stub.requests)
    t = Term(secret, cols=120, env=env)                  # room for the whole message beside the status items
    assert t.read("Ln 1, Col 1")
    t.send("\x1b[1;5F"); t.send("x"); t.read(timeout=0.5)
    t.send("\x1b\\")                                    # Alt+\ (Trigger Inline Suggestion) says why not
    assert t.read("No inline suggestions for this file", timeout=2)
    assert len(stub.requests) == asked, "a deny-listed file was sent"
    t.send(QUIT); t.send("d")
    t.wait_exit()
    stub.shutdown()
    print("inline suggestions: ok")


class FakeHosted(http.server.ThreadingHTTPServer):
    """A hosted FIM API (Codestral / Mercury) on 127.0.0.1: SSE events in the provider's shape (Mistral's
    chat-like delta, the others' text), the reply chosen as FakeOllama's by how the prompt ends; 401 for a wrong key."""
    def __init__(self, provider):
        self.requests, self.auth = [], []
        server = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                server.requests.append(body)
                server.auth.append(self.headers.get("Authorization"))
                if self.headers.get("Authorization") != "Bearer sk-e2e":
                    self.send_response(401); self.send_header("Content-Length", "2"); self.end_headers(); self.wfile.write(b"{}")
                    return
                text = next((v for k, v in FakeOllama.REPLIES.items() if body["prompt"].endswith(k)), "")
                events = ""
                for piece in re.findall(r"[^\n]*\n?", text):
                    if piece:
                        choice = {"delta": {"content": piece}} if provider == "codestral" else {"text": piece}
                        events += f"data: {json.dumps({'choices': [choice]})}\n\n"
                data = (events + "data: [DONE]\n\n").encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        super().__init__(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.serve_forever, daemon=True).start()


def run_inline_hosted(tmp):
    """Codestral and Mercury through fake APIs: the key (from the environment here; the keychain is a stub
    that has none) goes as a Bearer header, a block is cut after its closing brace, a fenced reply shows without its
    fences, prose never shows; with no key the status bar says so."""
    for provider, env_var in [("codestral", "MISTRAL_API_KEY"), ("mercury", "INCEPTION_API_KEY")]:
        stub = FakeHosted(provider)
        settings = os.path.join(tmp, "hosted-" + provider, "vscode-settings.json")
        os.makedirs(os.path.dirname(settings))
        json.dump({"editor.inlineSuggest.provider": provider, "editor.inlineSuggest.endpoint": f"http://127.0.0.1:{stub.server_port}/v1/fim/completions",
                   "editor.inlineSuggest.debounce": 80}, open(settings, "w"))
        env = {"VSEDIT_SETTINGS": settings, "VSEDIT_SECURITY": "/usr/bin/false", "VSEDIT_SECRETS": os.path.join(tmp, "no-secrets.json"), env_var: "sk-e2e"}
        file = os.path.join(tmp, f"hosted-{provider}.js")
        open(file, "w").write("function f() {\n  \n}\n")
        t = Term(file, env=env)
        assert colored_frame(t), "no colored frame"
        t.send("\x07"); t.send("2:3\r")
        t.out = b""
        t.send("i")
        assert t.read("go();", timeout=3), f"{provider}: no block ghost text:\n" + plain(t)[-300:]
        t.read(timeout=0.5)
        assert "stop();" not in plain(t), f"{provider}: the block wasn't cut"
        t.send("\x1b", wait=0.2); t.send("\x7f"); t.out = b""
        t.send("q")
        assert t.read("uit();", timeout=3) and "```" not in plain(t), f"{provider}: the fenced reply"
        t.send("\x1b", wait=0.2); t.send("\x7f"); t.out = b""
        t.send("p"); t.read(timeout=0.8)
        assert "breakdown" not in plain(t), f"{provider}: prose showed"
        assert stub.auth and set(stub.auth) == {"Bearer sk-e2e"}, stub.auth
        assert all(r["stream"] and "suffix" in r for r in stub.requests), stub.requests[0]
        t.send(QUIT); t.send("d")
        t.wait_exit()
        stub.shutdown()
    del env[env_var]
    t = Term(file, env=env)
    assert t.read("Mercury: no API key", timeout=5), "no 'no API key' in the status bar"
    t.send(QUIT)
    t.wait_exit()
    print("hosted inline suggestions: ok")


def main():
    tmp = tempfile.mkdtemp(prefix="vsedit-e2e-")
    ISOLATED.update(VSEDIT_SETTINGS=os.path.join(tmp, "settings", "vscode-settings.json"), VSEDIT_BACKUPS=os.path.join(tmp, "backups"),
                    VSEDIT_KEYBINDINGS=os.path.join(tmp, "settings", "vscode-keybindings.json"), VSEDIT_OS="linux")
    # No scenario but run_inline_suggest asks a model (Ollama may run on this machine): the provider is off.
    os.makedirs(os.path.join(tmp, "settings"))
    open(ISOLATED["VSEDIT_SETTINGS"], "w").write('{"files.autoSave": "off", "files.autoSaveDelay": 1, "editor.inlineSuggest.provider": "off"}\n')
    engines = os.path.join(tmp, "engines.log")
    ISOLATED.update(VSEDIT_ENGINE_LOG=engines, VSEDIT_INLINE_USAGE=os.path.join(tmp, "inline-usage.json"))
    scenarios = [run_tsx, run_go, run_crlf, run_hex, run_error_page, run_drag_scroll, run_drag_reveal, run_shift_click, run_minified, run_scrollbars, run_decorations,
                 run_autoclose, run_git_gutter, run_folding, run_word_wrap, run_menu_and_cmd_save, run_save_dialog, run_close_request, run_warm, run_auto_save, run_hidden_status_bar, run_cursor_style, run_hot_exit,
                 run_keybindings, run_mac_keys, run_format, run_typescript, run_find_and_status, run_symbols_and_problems, run_install_prompt, run_small_batch,
                 run_files_and_navigation, run_picker_scroll, run_medium_language, run_medium_editing, run_inline_suggest, run_references_and_lenses, run_inline_hosted]
    only = set(sys.argv[1:])
    results = []
    try:
        for run in scenarios:
            name = run.__name__
            if only and name not in only and name[4:] not in only:
                continue
            open(engines, "w").close()
            try:
                run(tmp); status = "pass"
            except Exception as e:  # noqa: BLE001 - every failure is reported in the table
                status = f"FAIL: {str(e).splitlines()[0][:100] if str(e) else type(e).__name__}"
            for t in TERMS:
                try:
                    os.kill(t.pid, signal.SIGKILL); os.waitpid(t.pid, 0)
                except OSError:
                    pass
                os.close(t.fd)
            TERMS.clear()
            used = sorted(set(open(engines).read().split("\n")) - {""}) if RUST_BIN else ["js"]
            if RUST_BIN and status == "pass" and used != ["rust"]:
                status = "FAIL: not run by the Rust editor alone"
            results.append((name, status, ", ".join(used)))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print("\nscenario | result | editor")
    for name, status, used in results:
        print(f"{name[4:]} | {status} | {used}")
    if any(s.startswith("FAIL") for _, s, _ in results):
        sys.exit(1)
    print("e2e: all passed")


if __name__ == "__main__":
    main()
