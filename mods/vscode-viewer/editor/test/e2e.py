#!/usr/bin/env python3
"""End-to-end: runs vsedit.cjs in a 100x30 pseudo-terminal, types, saves, quits, and checks colors against tokenize.cjs;
scrollbars (editor and hex viewer), the context menu, Kitty ⌘ keys, user keybindings, tsserver definition/references/rename, gofmt, the save dialog, auto save and hot exit.
usage: python3 -I mods/vscode-viewer/editor/test/e2e.py"""
import fcntl, json, os, pty, re, select, shutil, signal, struct, subprocess, sys, tempfile, termios, time

HERE = os.path.dirname(os.path.abspath(__file__))
EDITOR = os.path.join(HERE, "..", "vsedit.cjs")
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


# Settings, backups and Herdr are never the real ones: main() points these at a temp folder.
ISOLATED = {}


class Term:
    def __init__(self, file, cols=100, rows=30, env=None, args=()):
        pid, fd = pty.fork()
        if pid == 0:
            e = {k: v for k, v in os.environ.items() if k != "HC_TERMINAL_ID"}
            e.update(ISOLATED)
            e.update(env or {})
            os.execvpe("node", ["node", EDITOR, file, *args], e)
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        self.pid, self.fd, self.out = pid, fd, b""

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
    t.send("\x11")
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
    t.send("\x11")
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
    t.send("!"); t.send("\x13"); t.read("Saved", timeout=2); t.send("\x11")
    assert t.wait_exit() == 0
    assert open(file, "rb").read() == b"one\r\ntwo!", open(file, "rb").read()
    print("crlf: ok")


def screen_of(t):
    return t.out.decode("utf8", "replace")


def herdr_stub(tmp):
    """A herdr-app on PATH that logs its arguments: (env for Term, log path)."""
    stub = os.path.join(tmp, "stub")
    os.makedirs(stub, exist_ok=True)
    log = os.path.join(tmp, "herdr.log")
    with open(os.path.join(stub, "herdr-app"), "w") as f:
        f.write(f'#!/bin/sh\necho "$@" >> "{log}"\n')
    os.chmod(os.path.join(stub, "herdr-app"), 0o755)
    if os.path.exists(log):
        os.remove(log)
    return {"HC_TERMINAL_ID": "term-7", "PATH": stub + ":" + os.environ["PATH"]}, log


def run_menu_and_cmd_save(tmp):
    """Right-click (SGR button 2) opens VS Code's context menu; Herdr is told to route right-clicks; Preferences: Open Settings
    asks Herdr for the Settings dialog; Kitty ⌘S saves."""
    env, log = herdr_stub(tmp)
    file = os.path.join(tmp, "menu.txt")
    open(file, "w").write("hello world\n")
    t = Term(file, env=env)
    assert t.read("Ln 1, Col 1"), "no first frame"
    assert "\x1b[>1u" in screen_of(t) and "\x1b[?1004h" in screen_of(t), "Kitty keyboard / focus reports not enabled"
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
    t.send("\x1b[113;9u")           # ⌘Q is not ours; Ctrl+Q quits
    t.send("\x11")
    assert t.wait_exit() == 0
    assert open(file).read() == "hello world!\n"
    out = screen_of(t)
    assert "\x1b[<u" in out[-300:], "Kitty keyboard mode not popped on exit"
    calls = open(log).read()
    assert "do terminal.right_click --to program --terminal term-7" in calls, calls
    assert "do terminal.right_click --to menu --terminal term-7" in calls, calls
    assert "do mod.open --name vscode-settings" in calls, calls
    print("menu + ⌘S: ok")


def run_keybindings(tmp):
    """vscode-keybindings.json rebinds Delete Line to ⌘⇧D (Kitty CSI-u) and removes its ⌘⇧K default; the file is read
    again while the editor runs."""
    kb = ISOLATED["VSEDIT_KEYBINDINGS"]
    os.makedirs(os.path.dirname(kb), exist_ok=True)
    open(kb, "w").write('// mine\n[{ "key": "cmd+shift+d", "command": "editor.action.deleteLines" },\n'
                        ' { "key": "cmd+shift+k", "command": "-editor.action.deleteLines" }]\n')
    file = os.path.join(tmp, "keys.txt")
    open(file, "w").write("one\ntwo\nthree\n")
    t = Term(file)
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
    t.send("\x11")
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
    t.send("\x11")
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
    t.send("\x1b[102;4u", wait=0.5)               # ⌥⇧F as Kitty CSI-u
    t.read("never", timeout=1.5)
    t.send("\x13"); assert t.read("Saved", timeout=2)
    t.send("\x11"); assert t.wait_exit() == 0
    assert open(file).read() == "package main\n\nfunc main() {\n\tx := 1\n\t_ = x\n}\n", repr(open(file).read())
    print("format (gofmt): ok")


def run_save_dialog(tmp):
    """Unsaved changes: Ctrl+Q asks Save / Don't Save / Cancel; Esc cancels, Enter saves and quits."""
    file = os.path.join(tmp, "dialog.txt")
    open(file, "w").write("abc\n")
    t = Term(file)
    assert t.read("Ln 1, Col 1")
    t.send("X")
    t.send("\x11")
    assert t.read("Do you want to save the changes you made to dialog.txt?", timeout=2)
    sc = screen_of(t)
    assert "Your changes will be lost if you don't save them." in sc and " Save " in sc and " Don't Save " in sc and " Cancel " in sc
    t.send("\x1b[27u")                            # Esc = Cancel
    t.send("Y")
    t.out = b""
    t.send("\x11")
    assert t.read("Do you want to save", timeout=2)
    t.send("\r")                                  # Enter = Save
    assert t.wait_exit() == 0
    assert open(file).read() == "XYabc\n", open(file).read()
    print("save dialog: ok")


def run_auto_save(tmp):
    """files.autoSave afterDelay with files.autoSaveDelay in seconds saves without Ctrl+S."""
    settings = os.path.join(tmp, "auto", "vscode-settings.json")
    os.makedirs(os.path.dirname(settings))
    open(settings, "w").write('{"files.autoSave": "afterDelay", "files.autoSaveDelay": 0.3, "keep.me": 1}')
    file = os.path.join(tmp, "auto.txt")
    open(file, "w").write("one\n")
    t = Term(file, env={"VSEDIT_SETTINGS": settings})
    assert t.read("Auto Save"), "status bar has no Auto Save"
    t.send("Z")
    t.read("never", timeout=1.2)
    assert open(file).read() == "Zone\n", "not auto-saved: " + repr(open(file).read())
    t.send("\x11")
    assert t.wait_exit() == 0, "quit should not ask: the file was auto-saved"
    assert json.load(open(settings))["keep.me"] == 1
    print("auto save: ok")


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
    t.send("\x11"); assert t.wait_exit() == 0
    assert open(file).read() == "NEW base\n"
    assert os.listdir(ISOLATED["VSEDIT_BACKUPS"]) == [], "backup not removed after save"
    print("hot exit: ok")


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
    t.send("\x11")
    assert t.wait_exit() == 0
    assert b"\x1b[?1049l" in t.out[-200:] and b"\x1b[<u" in t.out[-300:], "terminal not restored"
    small = os.path.join(tmp, "nul.txt")
    open(small, "wb").write(b"ab\x00cd\n")
    t = Term(small)
    assert t.read("Open Anyway", timeout=3)
    t.send("a", wait=0.3)                         # Open Anyway: the text editor with NUL as a control picture
    assert t.read("Ln 1, Col 1", timeout=5) and "ab\u2400cd" in plain(t), plain(t)[-400:]
    t.send("\x11")
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
    t.send("\x11")
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
    t = Term(file)
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
    t.send("\x11")
    assert t.wait_exit() == 0
    print("drag auto-scroll + horizontal wheel: ok")


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
    t.send("\x11"); t.send("d")
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
    t.send("\x11")
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
    t.send("\x11")
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
    t.send("\x11")
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
    t.send("\x11")
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
    t.send("\x11")
    assert t.wait_exit() == 0
    got = open(file).read()
    assert got == 'f("a") {;}\n', repr(got)
    print("auto-closing pairs: ok")


def main():
    tmp = tempfile.mkdtemp(prefix="vsedit-e2e-")
    ISOLATED.update(VSEDIT_SETTINGS=os.path.join(tmp, "settings", "vscode-settings.json"), VSEDIT_BACKUPS=os.path.join(tmp, "backups"),
                    VSEDIT_KEYBINDINGS=os.path.join(tmp, "settings", "vscode-keybindings.json"))
    try:
        run_tsx(tmp); run_go(tmp); run_crlf(tmp); run_hex(tmp); run_error_page(tmp); run_drag_scroll(tmp); run_minified(tmp); run_scrollbars(tmp); run_decorations(tmp); run_autoclose(tmp)
        run_menu_and_cmd_save(tmp); run_save_dialog(tmp); run_auto_save(tmp); run_hot_exit(tmp); run_keybindings(tmp)
        run_format(tmp); run_typescript(tmp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print("e2e: all passed")


if __name__ == "__main__":
    main()
