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
  const r = await exec("sh", ["-c", 'cd "$1" && for f in *; do [ -f "$f" ] && { stat -c "%Y %s %n" "$f" 2>/dev/null || stat -f "%m %z %N" "$f"; }; done; :', "prune", dir]);
  const files = (r.stdout ?? "").split("\n").map(l => /^(\d+) (\d+) (.+)$/.exec(l)).filter(Boolean)
    .map(([, mtime, size, name]) => ({ name, mtime: +mtime, size: +size }));
  const gone = overflow(files, cap, keep);
  if (gone.length) await exec("rm", ["-f", ...gone.map(n => `${dir}/${n}`)]);
}

// ----- the preview cache, shared by the viewer tab (main.js) and the image panel (image.js) -----

// image() only loads from the app's folder, so previews are copied to <app>/mods/vscode-viewer/.cache/<id>-<mtime>-<size>.<ext>
// (a video's still: that name + .png). `id`: pathHash of the path (with its machine for a remote file).
export const CACHE = "mods/vscode-viewer/.cache";
export const pathHash = (s) => { let h = 5381; for (const c of s) h = (h * 33 ^ c.charCodeAt(0)) >>> 0; return h.toString(36); };
// What the viewer previews as an image: extension -> format name.
export const IMAGES = { png: "PNG", jpg: "JPEG", jpeg: "JPEG", gif: "GIF", webp: "WebP", bmp: "BMP", ico: "ICO", svg: "SVG", tif: "TIFF", tiff: "TIFF" };
export const imageExt = (name) => { const e = /\.([^./]+)$/.exec(String(name).toLowerCase())?.[1]; return IMAGES[e] ? e : null; };

// { mtime (s), size } of a file here or on machine `on`, or null.
export async function statOf(exec, file, on = null) {
  const st = await exec("sh", ["-c", `stat -c '%Y %s' "$1" 2>/dev/null || stat -f '%m %z' "$1"`, "sh", file], { on }).catch(() => null);
  const [mtime, size] = (st?.stdout ?? "").trim().split(" ").map(Number);
  return st?.code === 0 && Number.isFinite(size) ? { mtime, size } : null;
}

// Puts machine `on`'s (null: this computer's) image or video `file`, `st` its statOf, into the cache folder `dir` as
// `<id>-<mtime>-<size>.<ext>` (a video: its still, that name + .png), dropping the file's other copies there. A whole
// copy already there is kept (copies land whole: written aside, then renamed), so two views of one file share it. A
// remote image or video is fetched first (fetchFile, `progress` 0-1). Resolves { name, shown, local } (`shown`: the
// file image() takes, `local`: the file on this computer) or rejects with why.
export async function cachePreview(exec, { dir, id, file, on = null, kind, ext, st, progress }) {
  const name = `${id}-${st.mtime}-${st.size}.${ext}`, shown = kind === "video" ? `${name}.png` : name;
  const remote = Boolean(on) && FETCHED.includes(kind), local = remote ? `${dir}/${name}` : file;
  const kept = await exec("sh", ["-c", 'mkdir -p "$1" || exit 2; for f in "$1/$2"-*; do [ "$f" = "$1/$3" ] || [ "$f" = "$1/$4" ] || rm -rf "$f"; done; [ -f "$1/$4" ] && [ -f "$5" ]',
    "sh", dir, id, name, shown, local]);
  if (kept.code === 0) return { name, shown, local };
  if (kept.code !== 1) throw new Error("Cannot write the preview cache");
  if (remote) await fetchFile(exec, on, file, local, st.size, progress);
  const made = kind === "video" ? await exec("sh", ["-c", POSTER, "sh", local, `${dir}/${id}-ql`, `${dir}/${shown}`])
    : remote ? { code: 0 } : await exec("sh", ["-c", 'cp "$1" "$2.part" && mv "$2.part" "$2"', "sh", file, `${dir}/${name}`]);
  if (made.code !== 0) throw new Error(`Cannot preview this ${kind}`);
  await prune(exec, dir, [name, shown]).catch(() => {});
  return { name, shown, local };
}
