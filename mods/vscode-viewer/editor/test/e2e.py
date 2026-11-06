#!/usr/bin/env python3
"""End-to-end: runs vsedit.cjs in a 100x30 pseudo-terminal, types, saves, quits, and checks colors against tokenize.cjs.
usage: python3 -I mods/vscode-viewer/editor/test/e2e.py"""
import fcntl, json, os, pty, re, select, shutil, struct, subprocess, sys, tempfile, termios, time

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


class Term:
    def __init__(self, file, cols=100, rows=30):
        pid, fd = pty.fork()
        if pid == 0:
            os.execvp("node", ["node", EDITOR, file])
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
    assert t.read("Ln 1, Col 1"), "no first frame"
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
    assert t.read("Ln 1, Col 1"), "no first frame"
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


def main():
    tmp = tempfile.mkdtemp(prefix="vsedit-e2e-")
    try:
        run_tsx(tmp); run_go(tmp); run_crlf(tmp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print("e2e: all passed")


if __name__ == "__main__":
    main()
