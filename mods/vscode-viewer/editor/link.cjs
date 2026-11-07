// The desktop's end of a remote editor's inline suggestions (inline.cjs: a remote editor asks the desktop typing in it):
// the proxy (inline.cjs proxy) on a random 127.0.0.1 port, and an ssh reverse tunnel to that machine's 127.0.0.1 that
// announces it there as ~/.local/share/herdr-vscode/desktops/<desktop id>.json {port, token} (mode 600) while it lasts.
//   node link.cjs <ssh target> <desktop id>
// The vscode-explorer mod (desktop.js) runs one per remote machine with an editor open, as an hc terminal it ends when
// none is left; it ends when the tunnel does. The provider's key stays in this process: only suggestions cross.
// VSEDIT_SSH: the ssh program (tests).
const crypto = require("crypto");
const { spawn } = require("child_process");
const I = require("./inline.cjs");

// There, with the token on stdin: writes the announcement, says "ready", and removes it when the tunnel ends (stdin
// closes, or a hangup). Its arguments are checked here (a hex id, a port number). No single quotes: it goes in '…'.
const ANNOUNCE = `umask 077; d="$HOME/.local/share/herdr-vscode/desktops"; f="$d/$1.json"; mkdir -p "$d" || exit 1
trap "rm -f \\"$f\\"; exit 0" HUP INT TERM
IFS= read -r t || exit 1
printf "{\\"port\\":%s,\\"token\\":\\"%s\\"}\\n" "$2" "$t" > "$f.$$" && mv -f "$f.$$" "$f" || exit 1
echo ready
cat >/dev/null
rm -f "$f"`;

// ssh's arguments: the tunnel from the machine's 127.0.0.1:<remotePort> to here, failing (not running half) when that
// port is taken, never asking for a password (hc machine login does that), and the announcement as its command.
// `target` as hc machine ls has it: a Host alias, user@host, or user@host:port.
function sshArgs(target, remotePort, localPort, id) {
  const m = /^([^[\]]*?):(\d+)$/.exec(target);
  return ["-T", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
    "-o", "ConnectTimeout=10", "-R", `127.0.0.1:${remotePort}:127.0.0.1:${localPort}`, ...(m ? ["-p", m[2], m[1]] : [target]),
    `sh -c '${ANNOUNCE}' herdr-vscode ${id} ${remotePort}`];
}

// One tunnel: resolves "ended" after it was ready, else { code, stderr } (a taken port says "forwarding failed").
function tunnel(args, token, onReady, onSsh) {
  return new Promise((resolve) => {
    const ssh = spawn(process.env.VSEDIT_SSH || "ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
    onSsh(ssh);
    let ready = false, out = "", stderr = "";
    ssh.stdin.on("error", () => {});
    ssh.stdin.write(token + "\n"); // kept open: its end ends the announcement there
    ssh.stdout.on("data", d => { out += d; if (!ready && /^ready$/m.test(out)) { ready = true; onReady(); } });
    ssh.stderr.on("data", d => { stderr += d; });
    ssh.on("error", (e) => { stderr += e.message; });
    ssh.on("close", (code) => resolve(ready ? "ended" : { code, stderr }));
  });
}

async function main([target, id]) {
  if (!target || target.startsWith("-") || !/^[0-9a-f]{1,64}$/.test(id ?? "")) throw new Error("usage: node link.cjs <ssh target> <desktop id>");
  const token = crypto.randomBytes(24).toString("hex"), server = I.proxy({ token });
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).on("error", reject));
  let ssh = null;
  const stop = () => { ssh?.kill(); process.exit(0); };
  for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"]) process.on(sig, stop);
  for (let tries = 0; tries < 5; tries++) {
    const r = await tunnel(sshArgs(target, 20000 + crypto.randomInt(40000), server.address().port, id), token,
      () => process.stdout.write(`linked ${target}\n`), (s) => { ssh = s; });
    if (r === "ended" || !/forwarding failed/i.test(r.stderr)) { if (r !== "ended") process.stderr.write(r.stderr); break; }
  }
  server.close();
  process.exit(0);
}

module.exports = { ANNOUNCE, sshArgs };
if (require.main === module) main(process.argv.slice(2)).catch((e) => { process.stderr.write(`${e.message}\n`); process.exit(2); });
