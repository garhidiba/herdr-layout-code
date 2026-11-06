// A child process speaking Content-Length framed JSON on stdout (LSP, and tsserver's responses).
const { spawn } = require("child_process");
const { env } = require("./proc.cjs");

// Feeds stdout chunks; calls onMessage(obj) per complete frame. Lengths are in bytes.
function frameReader(onMessage) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const head = buf.indexOf("\r\n\r\n");
      if (head === -1) return;
      const m = /Content-Length: *(\d+)/i.exec(buf.slice(0, head).toString("latin1"));
      if (!m) { buf = buf.slice(head + 4); continue; }
      const len = Number(m[1]), start = head + 4;
      if (buf.length < start + len) return;
      const body = buf.slice(start, start + len).toString("utf8");
      buf = buf.slice(start + len);
      let msg = null;
      try { msg = JSON.parse(body.trim()); } catch {}
      if (msg) onMessage(msg);
    }
  };
}

const frame = (obj) => { const s = JSON.stringify(obj); return `Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`; };

// Owns the process; pending requests are rejected when it dies. Subclasses send/route messages.
class Child {
  constructor(cmd, args, cwd, onMessage) {
    this.pending = new Map(); this.dead = null;
    this.proc = spawn(cmd, args, { cwd, env: env(), stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stdout.on("data", frameReader(onMessage));
    this.proc.stderr.on("data", () => {});
    this.proc.stdin.on("error", () => {});
    const die = (why) => { if (this.dead) return; this.dead = why; for (const p of this.pending.values()) p.reject(new Error(why)); this.pending.clear(); };
    this.proc.on("error", e => die(`${cmd}: ${e.message}`));
    this.proc.on("exit", code => die(`${cmd} exited (${code})`));
  }
  write(text) { if (!this.dead) this.proc.stdin.write(text); }
  // Registers a pending reply under `id`; rejects after `timeout` ms.
  wait(id, timeout) {
    if (this.dead) return Promise.reject(new Error(this.dead));
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error("The language server did not answer in time")); }, timeout);
      this.pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
    });
  }
  settle(id, error, value) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    error ? p.reject(error) : p.resolve(value);
  }
  kill() { try { this.proc.kill(); } catch {} }
}

module.exports = { frameReader, frame, Child };
