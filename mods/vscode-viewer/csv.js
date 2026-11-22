// CSV/TSV for the viewer's sheet (main.js): RFC 4180 parsing and the grid's layout rules. Pure.
//   csvRows / parseCsv: fields split on `sep` (",", or "\t" for .tsv: delimiterOf); "quoted" fields keep separators,
//   line breaks and doubled "" quotes; rows end at CRLF, LF or CR; a leading BOM is dropped, a trailing line break adds
//   no row.
//   sheetOf (parsed rows): the first row is the header; columns are as many as the widest row, each as wide as its
//   longest text in the first rows (columnWidths), within a minimum and a maximum (longer text is cut with an ellipsis).
//   visibleColumns / clampX / scrollToShow / columnAt: what a scrolled viewport shows, and where.
//   rowSpans / fieldText / editCells: editing cells in the text itself, by each field's own offsets (toTsv: copying).

export const delimiterOf = (file) => (/\.tsv$/i.test(file) ? "\t" : ",");

// Rows one at a time, so a caller can parse a big file a slice per tick. Works with native calls (indexOf, split), not
// character by character: the app's script engine is slow per character. A row without a quote is one split; the next
// separator, line break and quote positions are cached. With `starts`, each row's offset in `text` is pushed there.
export function* csvRows(text, sep = ",", starts = null) {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text, n = s.length, bom = text.length - n;
  // The first `ch` at or after `from`, reusing `at` while it is still ahead (n: none left).
  const next = (ch, at, from) => (at >= from ? at : (at = s.indexOf(ch, from)) < 0 ? n : at);
  const lineEnd = (e) => e + (s[e] === "\r" && s[e + 1] === "\n" ? 2 : 1);
  let i = 0, nSep = -1, nLF = -1, nCR = -1, nQ = -1;
  while (i < n) {
    starts?.push(i + bom);
    nLF = next("\n", nLF, i); nCR = next("\r", nCR, i); nQ = next('"', nQ, i);
    const eol = Math.min(nLF, nCR);
    if (nQ >= eol) { const row = s.slice(i, eol).split(sep); i = lineEnd(eol); yield row; continue; }
    const row = [];
    for (;;) {
      let field = "";
      if (s[i] === '"') {
        for (let j = i + 1; ;) {
          const q = s.indexOf('"', j);
          if (q < 0) { field += s.slice(j); i = n; break; }
          field += s.slice(j, q);
          if (s[q + 1] === '"') { field += '"'; j = q + 2; } else { i = q + 1; break; }
        }
      }
      nSep = next(sep, nSep, i); nLF = next("\n", nLF, i); nCR = next("\r", nCR, i);
      const end = Math.min(nSep, nLF, nCR);
      field += s.slice(i, end); i = end;
      row.push(field);
      if (s[i] !== sep) { i = lineEnd(i); break; }
      if (++i === n) { row.push(""); break; }
    }
    yield row;
  }
}
export const parseCsv = (text, sep = ",") => [...csvRows(text, sep)];

// Spreadsheet column letters: 0 -> A, 25 -> Z, 26 -> AA.
export function columnLabel(i) {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

// A number the sheet aligns right: sign, digits (optionally grouped by thousands), decimals, exponent, percent.
const NUMBER = /^[-+]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?%?$/;
export const isNumber = (s) => NUMBER.test((s ?? "").trim());

// A cell on one line.
export const cellText = (s) => (s ?? "").replace(/\r\n|\r|\n/g, "↵");

// Characters drawn about twice as wide as Latin ones: CJK, Hangul, fullwidth forms.
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/g;
const ASCII = /^[\x00-\x7f]*$/;
const textWidth = (s) => s.length + (ASCII.test(s) ? 0 : s.match(WIDE)?.length ?? 0);

// Pixel widths of `cols` columns from the first rows: char px per character plus pad, clamped to [min, max]. Only as
// many rows as `cells` cells allow are measured (the app cuts off a long call), at least 3 and at most `sample`.
export function columnWidths(rows, cols, { sample = 200, cells = 1000, char = 7.5, pad = 14, min = 56, max = 320 } = {}) {
  const longest = new Array(cols).fill(0), n = Math.min(rows.length, sample, Math.max(3, Math.floor(cells / Math.max(cols, 1))));
  for (let r = 0; r < n; r++) {
    const row = rows[r];
    for (let c = 0; c < row.length && c < cols; c++) { const w = textWidth(row[c]); if (w > longest[c]) longest[c] = w; }
  }
  return longest.map(w => Math.min(max, Math.max(min, Math.ceil(w * char + pad))));
}

// The columns a viewport `width` px wide shows when scrolled `x` px sideways: [first, end), and how far the first one
// starts left of the viewport (`shift`).
export function visibleColumns(widths, x, width) {
  let first = 0, start = 0;
  while (first < widths.length - 1 && start + widths[first] <= x) start += widths[first++];
  let end = first;
  for (let right = start; end < widths.length && right < x + width;) right += widths[end++];
  return { first, end, shift: x - start };
}

// A scroll kept within the grid (either axis): 0 when it fits.
export const clampX = (x, total, width) => Math.max(0, Math.min(x, total - width));

// The scroll that brings [start, start + size) into a viewport `view` long scrolled to `at`, moving as little as it can.
export const scrollToShow = (start, size, at, view) => (start < at ? start : start + size > at + view ? Math.min(start, start + size - view) : at);

// Where each column starts, and the grid's whole width last: [0, w0, w0 + w1, ...].
export function columnStarts(widths) {
  const out = [0];
  for (const w of widths) out.push(out[out.length - 1] + w);
  return out;
}

// The column under grid position `gx` (px from the first column's left edge), held to the existing ones.
export function columnAt(widths, gx) {
  let c = 0;
  for (let left = 0; c < widths.length - 1 && left + widths[c] <= gx; c++) left += widths[c];
  return c;
}

// The parsed rows as a sheet: `starts` (csvRows') says where each row's text begins, for editCells.
export function sheetOf(rows, starts = []) {
  const cols = rows.reduce((m, r) => Math.max(m, r.length), 0);
  return { rows, starts, cols, widths: columnWidths(rows, cols) };
}

// The raw [start, end) spans of the fields of the row whose text starts at `i` in `s` (quotes included), and where the
// row ends (its line break, or the text's end), read as csvRows reads them. A row without a quote is one split. Every
// search stops at the first match (a regex from lastIndex, a slice): an indexOf for a character the file lacks would
// read to its end, per row.
const BREAK = /[\r\n]/g, FIELD_END = { ",": /[,\r\n]/g, "\t": /[\t\r\n]/g };
const firstOf = (re, s, from) => { re.lastIndex = from; const m = re.exec(s); return m ? m.index : s.length; };
export function rowSpans(s, i, sep) {
  const eol = firstOf(BREAK, s, i), line = s.slice(i, eol), spans = [];
  if (!line.includes('"')) {
    let a = i;
    for (const f of line.split(sep)) { spans.push([a, a + f.length]); a += f.length + sep.length; }
    return { spans, end: eol };
  }
  const ends = FIELD_END[sep] ?? new RegExp(`[${sep}\\r\\n]`, "g");
  for (;;) {
    const a = i;
    if (s[i] === '"') {
      for (i++; ;) {
        const at = s.indexOf('"', i);
        if (at < 0) { i = s.length; break; }
        if (s[at + 1] === '"') i = at + 2; else { i = at + 1; break; }
      }
    }
    i = firstOf(ends, s, i);
    spans.push([a, i]);
    if (s[i] !== sep) return { spans, end: i };
    i++;
  }
}

// A value as field text: quoted, its quotes doubled, when it holds the separator, a quote or a line break, or `keep`
// (the field it replaces was quoted).
export const fieldText = (v, sep, keep = false) => (keep || v.includes(sep) || /["\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

// Edits split into runs touching at most `rows` rows each, in row order (a big edit goes a run per tick).
export function rowChunks(edits, rows) {
  const sorted = [...edits].sort((a, b) => a.r - b.r || a.c - b.c), out = [];
  let chunk = [], seen = 0, last = null;
  for (const e of sorted) {
    if (e.r !== last) { if (seen === rows) { out.push(chunk); chunk = []; seen = 0; } seen++; last = e.r; }
    chunk.push(e);
  }
  if (chunk.length) out.push(chunk);
  return out;
}

// Values as TSV, for the clipboard (fields quoted as fieldText does).
export const toTsv = (rows) => rows.map(r => r.map(v => fieldText(v, "\t")).join("\t")).join("\n");

// Writes cells into a sheet's text: `edits` [{ r, c, value }] (r 0 is the header row). Returns the one text change
// { start, end, insert } that does it, or null when nothing changes. Only the edited fields' text changes, so quoting,
// line breaks, a BOM and the rest of the file stay as they were; an edited quoted field stays quoted; a cell past a
// short row's end is reached by adding separators there (empty values add nothing). `sheet` (sheetOf's) follows in
// place, without parsing again: the values, the column count and widths, and the later rows' starts.
export function editCells(text, sheet, sep, edits) {
  const byRow = new Map();
  for (const e of edits) {
    if (!(e.r >= 0 && e.r < sheet.rows.length && e.c >= 0)) continue;
    if (!byRow.has(e.r)) byRow.set(e.r, []);
    byRow.get(e.r).push(e);
  }
  const parts = [], deltas = [];
  for (const r of [...byRow.keys()].sort((a, b) => a - b)) {
    const { spans, end } = rowSpans(text, sheet.starts[r], sep), row = sheet.rows[r];
    let tail = "", n = spans.length, delta = 0;
    for (const { c, value } of byRow.get(r).sort((a, b) => a.c - b.c)) {
      if (c < spans.length) {
        const [a, b] = spans[c], insert = fieldText(value, sep, text[a] === '"');
        if (insert !== text.slice(a, b)) { parts.push({ start: a, end: b, insert }); delta += insert.length - (b - a); }
        row[c] = value;
      } else if (value !== "") {
        tail += sep.repeat(c - n + 1) + fieldText(value, sep);
        while (row.length < c) row.push("");
        row[c] = value; n = c + 1;
      }
    }
    if (tail) { parts.push({ start: end, end, insert: tail }); delta += tail.length; }
    if (delta) deltas.push({ r, delta });
    if (row.length > sheet.cols) { sheet.widths.push(...columnWidths([row.slice(sheet.cols)], row.length - sheet.cols)); sheet.cols = row.length; }
  }
  if (!parts.length) return null;
  let insert = "";
  parts.forEach((p, k) => { insert += (k ? text.slice(parts[k - 1].end, p.start) : "") + p.insert; });
  for (let k = deltas[0]?.r + 1, d = 0, j = 0; k < sheet.starts.length; k++) {
    while (j < deltas.length && deltas[j].r < k) d += deltas[j++].delta;
    sheet.starts[k] += d;
  }
  return { start: parts[0].start, end: parts[parts.length - 1].end, insert };
}
