// Saving a file on another machine (a space's `on`): Herdr's writeTextFile writes only here, so the buffer goes into a
// local file first (byte for byte, its line endings as they are) and from there on `hc exec -i --on`'s stdin to a
// small writer there (vscode-explorer's remote.js uploads its bundle the same way): one round trip whatever the size,
// binary-safe, nothing on a command line but the path. The writer takes the whole text before touching the file and
// checks its byte count, so a cut-off transfer leaves the file as it was; it then writes into the same file (keeping
// its permissions and owner). A Windows path (C:\…, C:/…, \\server\…) gets a PowerShell writer (-EncodedCommand, the
// path validated and single-quoted), any other path a sh one (the path as "$1", never in the script's text).
// No Herdr imports, so node tests load it; exec and writeTextFile are passed in.

// Here: sends file $2 to machine $1 and runs the rest there, the file on its stdin. Herdr's PATH may leave hc out.
export const SEND = 'PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; '
  + 'm=$1 f=$2; shift 2; exec hc exec -i --on "$m" --timeout 120 -- "$@" < "$f"';
// There (Unix): stdin = the text, $1 the file, $2 its size in bytes.
export const SAVE_UNIX = `tmp=$(mktemp "\${TMPDIR:-/tmp}/herdr-save.XXXXXX") || exit 3
trap 'rm -f "$tmp"' EXIT
cat > "$tmp" || exit 3
n=$(wc -c < "$tmp" | tr -d ' ')
[ "$n" = "$2" ] || { echo "only $n of $2 bytes arrived" >&2; exit 4; }
cat "$tmp" > "$1"`;
const POWERSHELL = ["-NoProfile", "-NonInteractive", "-EncodedCommand"];

export const isWindowsPath = (p) => /^([A-Za-z]:[\\/]|\\\\|\/\/)/.test(p);
// A PowerShell single-quoted literal (curly single quotes count as quotes there too): vscode-explorer's remote.js psQuote.
export const psQuote = (s) => `'${String(s).replace(/['‘’‚‛]/g, "$&$&")}'`;
// -EncodedCommand's text: the script as UTF-16LE, base64 (vscode-explorer's remote.js encodeCommand).
export function encodeCommand(script) {
  const bytes = [];
  for (let i = 0; i < script.length; i++) { const c = script.charCodeAt(i); bytes.push(c & 0xff, c >> 8); }
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b = 0, c = 0] = bytes.slice(i, i + 3), n = (a << 16) | (b << 8) | c;
    out += abc[n >> 18] + abc[(n >> 12) & 63] + (i + 1 < bytes.length ? abc[(n >> 6) & 63] : "=") + (i + 2 < bytes.length ? abc[n & 63] : "=");
  }
  return out;
}

// There (Windows): stdin = the text, all of it read before the file is opened.
export function windowsSave(path, size) {
  if (!isWindowsPath(path) || /[\x00-\x1f]/.test(path) || !Number.isInteger(size) || size < 0) throw new Error(`Cannot save ${path}`);
  return `$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'
try {
  $buf = New-Object IO.MemoryStream; [Console]::OpenStandardInput().CopyTo($buf)
  if ($buf.Length -ne ${size}) { [Console]::Error.WriteLine("only $($buf.Length) of ${size} bytes arrived"); exit 4 }
  [IO.File]::WriteAllBytes(${psQuote(path)}, $buf.ToArray())
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 5 }`;
}

// The writer for `path` (`size` bytes coming on stdin), as [program, ...args].
export const saveArgv = (path, size) => isWindowsPath(path)
  ? ["powershell", ...POWERSHELL, encodeCommand(windowsSave(path, size))]
  : ["sh", "-c", SAVE_UNIX, "herdr-save", path, String(size)];

// Bytes `text` takes as UTF-8 (a lone surrogate: 3, as U+FFFD).
export function utf8Length(text) {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c < 0xdc00 && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

// stderr without PowerShell's CLIXML blocks ("#< CLIXML <Objs …>…</Objs>", written when it isn't a console, progress
// records among it): each block gives way to its error texts, decoded (vscode-explorer's remote.js plainStderr).
export function plainStderr(text) {
  const unescape = (t) => t.replace(/_x([0-9A-Fa-f]{4})_/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&(lt|gt|quot|apos|amp|#x[0-9A-Fa-f]+|#\d+);/g, (m, e) => ({ lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" })[e] ?? String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : +e.slice(1)));
  return String(text ?? "").replace(/#< CLIXML\s*(<Objs[\s\S]*?(<\/Objs>|$))?/g, (block) =>
    [...block.matchAll(/<S S="Error">([^<]*)<\/S>/g)].map((m) => unescape(m[1])).join(""));
}

// Writes `text` to machine `on`'s file `path` through the local file `tmp` (removed after). Rejects with why.
export async function saveRemote(exec, writeTextFile, { on, path, text, tmp }) {
  await exec("rm", ["-f", tmp]);
  try {
    await writeTextFile(tmp, text, null);
    const r = await exec("sh", ["-c", SEND, "herdr-save", on, tmp, ...saveArgv(path, utf8Length(text))], { timeout: 150000 })
      .catch(e => ({ code: -1, stderr: String(e?.message ?? e) }));
    const why = plainStderr(r.stderr).trim().split(/\r?\n/).pop();
    if (r.code !== 0) throw new Error(`Cannot save to ${on}${why ? `: ${why}` : ""}`);
  } finally { await exec("rm", ["-f", tmp]).catch(() => {}); }
}
