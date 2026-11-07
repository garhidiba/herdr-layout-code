// Previews that need the file on this computer (image() and Quick Look read local files): a file on another machine (a
// space's `on`) is fetched into the viewer's cache first, in pieces through `hc exec` (binary-safe, but it keeps only the
// first 8 MiB of output, and Herdr's exec ends after 30 s). Each exec is passed in, so the tests run it here.
// Paths only ever go in as arguments ("$1"), never into a script's text.

// The kinds a remote file is fetched for; another kind previews remotely once it is listed here.
export const FETCHED = ["image", "video"];
export const REMOTE_MAX = 200e6;   // bytes; larger remote files are not fetched
export const CACHE_MAX = 1e9;      // bytes the cache keeps, oldest dropped first
const BLOCK = 1e6, PIECE = 4;      // one exec fetches PIECE blocks: 4 MB, in 30 s from ~140 KB/s up
// Here: appends blocks $3 .. $3+$4 of machine $1's ("" this one) file $2 to $5. Herdr's PATH may leave hc out.
export const FETCH = `PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"; m=$1
on() { if [ -n "$m" ]; then hc exec --on "$m" -- "$@"; else hc exec -- "$@"; fi; }
on sh -c 'exec dd if="$1" bs=${BLOCK} skip="$2" count="$3" 2>/dev/null' fetch "$2" "$3" "$4" >> "$5"`;
// Here: a Quick Look still of video $1 as $3 (PNG), made in folder $2.
export const POSTER = 'mkdir -p "$2" && qlmanage -t -s 1600 -o "$2" "$1" >/dev/null 2>&1 && mv "$2"/*.png "$3"; s=$?; rm -rf "$2"; exit $s';

// The first block of each piece a file of `size` bytes is fetched in.
export const pieces = (size) => Array.from({ length: Math.ceil(size / (BLOCK * PIECE)) }, (_, i) => i * PIECE);

// Copies machine `on`'s file `path` (`size` bytes) to `out`, telling progress (0-1) after each piece. Only a complete
// copy lands at `out`; a failed or short one (the file changed meanwhile) is removed and rejects.
export async function fetchFile(exec, on, path, out, size, progress = () => {}) {
  if (size > REMOTE_MAX) throw new Error(`Larger than ${REMOTE_MAX / 1e6} MB · too big to preview from ${on}`);
  const part = `${out}.part`, fail = async (why) => { await exec("rm", ["-f", part]); throw new Error(why); };
  if ((await exec("sh", ["-c", ': > "$1"', "fetch", part])).code !== 0) return fail("Cannot write the preview cache");
  for (const skip of pieces(size)) {
    const r = await exec("sh", ["-c", FETCH, "fetch", on ?? "", path, String(skip), String(PIECE), part]).catch(e => ({ code: 1, stderr: String(e?.message ?? e) }));
    if (r.code !== 0) return fail(`Cannot fetch this file from ${on}${r.stderr?.trim() ? `: ${r.stderr.trim().split("\n").pop()}` : ""}`);
    progress(Math.min(1, (skip + PIECE) * BLOCK / size));
  }
  const done = await exec("sh", ["-c", '[ "$(wc -c < "$1" | tr -d " ")" = "$2" ] && mv "$1" "$3"', "fetch", part, String(size), out]);
  if (done.code !== 0) return fail(`The file changed on ${on} while fetching`);
}

// Cache files ({ name, mtime, size }) to delete, oldest first, until the rest fit in `cap`; never those named in `keep`
// or still being fetched (.part).
export function overflow(files, cap = CACHE_MAX, keep = []) {
  let total = files.reduce((n, f) => n + f.size, 0);
  const out = [];
  for (const f of [...files].sort((a, b) => a.mtime - b.mtime)) {
    if (total <= cap) break;
    if (keep.includes(f.name) || f.name.endsWith(".part")) continue;
    out.push(f.name); total -= f.size;
  }
  return out;
}

// Trims the cache folder `dir` to `cap` (overflow), keeping `keep`.
export async function prune(exec, dir, keep, cap = CACHE_MAX) {
  const r = await exec("sh", ["-c", 'cd "$1" && for f in *; do [ -f "$f" ] && { stat -f "%m %z %N" "$f" 2>/dev/null || stat -c "%Y %s %n" "$f"; }; done; :', "prune", dir]);
  const files = (r.stdout ?? "").split("\n").map(l => /^(\d+) (\d+) (.+)$/.exec(l)).filter(Boolean)
    .map(([, mtime, size, name]) => ({ name, mtime: +mtime, size: +size }));
  const gone = overflow(files, cap, keep);
  if (gone.length) await exec("rm", ["-f", ...gone.map(n => `${dir}/${n}`)]);
}
