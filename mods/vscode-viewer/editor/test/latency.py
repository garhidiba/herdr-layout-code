#!/usr/bin/env python3
"""First-frame time and keystroke latency of the JS editor (vsedit.cjs) and the Rust one (VSEDIT_BIN), in a 100x30
pseudo-terminal: (a) a 2,000-line TypeScript file and (b) a 20,000-line one, both cut from real .ts files under --root,
(c) a 500 KB single-line minified JS (the viewer's lib/textmate.js repeated).
first = start -> the first frame (status bar painted); colored = start -> the colored frame (the second one);
key = a typed character -> the frame showing the new column (median and p95 of 40 keys; the TS files type in the
middle line, the minified one at the start of its line, re-tokenizing it from there).
--wrap: with editor.wordWrap "on" (the minified line wraps onto ~5,700 rows and rewraps on every key).
usage: VSEDIT_BIN=<vsedit> python3 -I mods/vscode-viewer/editor/test/latency.py [--root <folder with .ts files>] [--runs 3] [--wrap]"""
import os, pty, re, select, statistics, subprocess, sys, tempfile, time, fcntl, struct, termios

HERE = os.path.dirname(os.path.abspath(__file__))
EDITOR = os.path.join(HERE, "..", "vsedit.cjs")
VSCODE = os.path.join(HERE, "..", "..", "vscode")


def ts_lines(root, n):
    files = subprocess.run(["find", root, "-name", "*.ts", "-not", "-name", "*.d.ts", "-not", "-path", "*/node_modules/*", "-not", "-path", "*/.git/*",
                            "-not", "-path", "*/templates-data/*", "-size", "+4k"], capture_output=True, text=True).stdout.split()
    out = []
    for f in sorted(files):
        try:
            out += open(f, encoding="utf8").read().split("\n")
        except (OSError, UnicodeDecodeError):
            continue
        if len(out) >= n:
            break
    return out[:n]


def spawn(cmd, file, env):
    pid, fd = pty.fork()
    if pid == 0:
        os.execvpe(cmd[0], [*cmd, file], env)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
    return pid, fd


def read_until(fd, buf, test, timeout):
    end = time.time() + timeout
    while time.time() < end:
        if test(buf[0]):
            return True
        r, _, _ = select.select([fd], [], [], 0.002)
        if r:
            try:
                buf[0] += os.read(fd, 1 << 20)
            except OSError:
                return False
    return test(buf[0])


def measure(cmd, file, env, minified):
    buf = [b""]
    t0 = time.perf_counter()
    pid, fd = spawn(cmd, file, env)
    read_until(fd, buf, lambda b: b"Ln 1, Col 1" in b, 30)
    first = time.perf_counter() - t0
    read_until(fd, buf, lambda b: b.count(b"Ln 1, Col 1") >= 2, 30)
    colored = time.perf_counter() - t0
    time.sleep(1.0)
    if minified:
        os.write(fd, b"\x1b[H")
    else:
        n = sum(1 for _ in open(file)) // 2
        os.write(fd, b"\x07"); time.sleep(0.2); os.write(fd, f"{n}\r".encode()); time.sleep(0.2); os.write(fd, b"\x1b[F")
    time.sleep(0.5)
    read_until(fd, buf, lambda b: False, 0.3)
    col = int(re.findall(rb"Ln \d+, Col (\d+)", buf[0])[-1])
    keys = []
    for _ in range(40):
        col += 1  # the status bar's column (tabs expanded) after one more character
        want = f", Col {col}".encode()
        buf[0] = b""
        t = time.perf_counter()
        os.write(fd, b"x")
        read_until(fd, buf, lambda b: want in b, 10)
        keys.append(time.perf_counter() - t)
        time.sleep(0.03)
    os.kill(pid, 9)  # unsaved, never written: the temp copy is rewritten for each run
    os.waitpid(pid, 0)
    os.close(fd)
    keys.sort()
    return first, colored, statistics.median(keys), keys[int(len(keys) * 0.95) - 1]


def main():
    root = sys.argv[sys.argv.index("--root") + 1] if "--root" in sys.argv else "/Volumes/exusb/project"
    runs = int(sys.argv[sys.argv.index("--runs") + 1]) if "--runs" in sys.argv else 3
    tmp = tempfile.mkdtemp(prefix="vsedit-latency-")
    env = {**os.environ, "VSEDIT_SETTINGS": os.path.join(tmp, "settings.json"), "VSEDIT_BACKUPS": os.path.join(tmp, "backups"),
           "VSEDIT_KEYBINDINGS": os.path.join(tmp, "kb.json")}
    if "--wrap" in sys.argv:
        open(env["VSEDIT_SETTINGS"], "w").write('{"editor.wordWrap": "on"}\n')
    env.pop("HC_TERMINAL_ID", None)
    inputs = {"(a) TS 2,000 lines": ("a.ts", "\n".join(ts_lines(root, 2000)) + "\n", False),
              "(b) TS 20,000 lines": ("b.ts", "\n".join(ts_lines(root, 20000)) + "\n", False)}
    lib = open(os.path.join(VSCODE, "lib", "textmate.js"), encoding="utf8").read().replace("\n", " ")
    inputs["(c) 500 KB one-line JS"] = ("c.min.js", (lib * (500_000 // len(lib) + 1))[:500_000] + "\n", True)
    editors = [("JS", ["node", EDITOR])]
    if os.environ.get("VSEDIT_BIN"):
        editors.append(("Rust", [os.environ["VSEDIT_BIN"], "--vscode", VSCODE]))
    print("input | editor | first frame | colored frame | key median | key p95")
    for label, (name, text, minified) in inputs.items():
        for ed, cmd in editors:
            rows = []
            for _ in range(runs):
                file = os.path.join(tmp, name)
                open(file, "w").write(text)
                rows.append(measure(cmd, file, env, minified))
            m = [statistics.median(r[i] for r in rows) for i in range(4)]
            print(f"{label} | {ed} | {m[0]*1000:.0f} ms | {m[1]*1000:.0f} ms | {m[2]*1000:.1f} ms | {m[3]*1000:.1f} ms", flush=True)


if __name__ == "__main__":
    main()
