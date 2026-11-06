// External programs: a PATH that includes the usual tool folders, lookup, git root, running with a timeout.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const EXTRA = ["/opt/homebrew/bin", "/usr/local/bin", path.join(os.homedir(), ".local/bin"), path.join(os.homedir(), ".cargo/bin")];
// The caller's PATH first, then the usual tool folders it lacks.
const env = () => { const own = (process.env.PATH ?? "/usr/bin:/bin").split(":"); return { ...process.env, PATH: [...own, ...EXTRA.filter(d => !own.includes(d))].join(":") }; };

// Absolute path of an executable on that PATH (or `dirs` first), else null.
function which(name, dirs = []) {
  for (const d of [...dirs, ...env().PATH.split(":")]) {
    const f = path.join(d, name);
    try { fs.accessSync(f, fs.constants.X_OK); if (fs.statSync(f).isFile()) return f; } catch {}
  }
  return null;
}

// The folder holding .git above `file`, else the file's folder.
function gitRoot(file) {
  for (let d = path.dirname(file); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, ".git"))) return d;
    if (path.dirname(d) === d) return path.dirname(file);
  }
}

// Runs a program to completion: { code, stdout, stderr }. Never throws.
function run(cmd, args, { cwd, input, timeout = 10000 } = {}) {
  const r = spawnSync(cmd, args, { cwd, input, timeout, encoding: "utf8", env: env(), maxBuffer: 64 * 1024 * 1024 });
  return { code: r.error ? -1 : r.status, stdout: r.stdout ?? "", stderr: r.error ? r.error.message : r.stderr ?? "" };
}

// Same, without blocking the editor.
function runAsync(cmd, args, { cwd, input, timeout = 10000 } = {}) {
  return new Promise((resolve) => {
    let out = "", err = "", done = false;
    const finish = (code) => { if (!done) { done = true; clearTimeout(t); resolve({ code, stdout: out, stderr: err }); } };
    let p;
    try { p = spawn(cmd, args, { cwd, env: env(), stdio: ["pipe", "pipe", "pipe"] }); } catch (e) { return resolve({ code: -1, stdout: "", stderr: e.message }); }
    const t = setTimeout(() => { try { p.kill(); } catch {} err += "timed out"; finish(-1); }, timeout);
    p.stdout.setEncoding("utf8").on("data", d => { out += d; });
    p.stderr.setEncoding("utf8").on("data", d => { err += d; });
    p.on("error", e => { err += e.message; finish(-1); });
    p.on("close", code => finish(code));
    p.stdin.on("error", () => {});
    p.stdin.end(input ?? "");
  });
}

module.exports = { env, which, gitRoot, run, runAsync, EXTRA };
