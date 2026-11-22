// CSV/TSV for the viewer's sheet (main.js): RFC 4180 parsing and the grid's layout rules. Pure.
//   csvRows / parseCsv: fields split on `sep` (",", or "\t" for .tsv: delimiterOf); "quoted" fields keep separators,
//   line breaks and doubled "" quotes; rows end at CRLF, LF or CR; a leading BOM is dropped, a trailing line break adds
//   no row.
//   sheetOf (parsed rows): the first row is the header; columns are as many as the widest row, each as wide as its
//   longest text in the first rows (columnWidths), within a minimum and a maximum (longer text is cut with an ellipsis).
//   visibleColumns / clampX: which columns a sideways-scrolled viewport shows.

export const delimiterOf = (file) => (/\.tsv$/i.test(file) ? "\t" : ",");

// Rows one at a time, so a caller can parse a big file a slice per tick. Works with native calls (indexOf, split), not
// character by character: the app's script engine is slow per character. A row without a quote is one split; the next
// separator, line break and quote positions are cached.
export function* csvRows(text, sep = ",") {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text, n = s.length;
  // The first `ch` at or after `from`, reusing `at` while it is still ahead (n: none left).
  const next = (ch, at, from) => (at >= from ? at : (at = s.indexOf(ch, from)) < 0 ? n : at);
  const lineEnd = (e) => e + (s[e] === "\r" && s[e + 1] === "\n" ? 2 : 1);
  let i = 0, nSep = -1, nLF = -1, nCR = -1, nQ = -1;
  while (i < n) {
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

// A sideways scroll kept within the grid: 0 when it fits.
export const clampX = (x, total, width) => Math.max(0, Math.min(x, total - width));

export function sheetOf(rows) {
  if (!rows.length) return { header: [], body: [], cols: 0, widths: [] };
  const cols = rows.reduce((m, r) => Math.max(m, r.length), 0);
  return { header: Array.from({ length: cols }, (_, c) => rows[0][c] ?? ""), body: rows.slice(1), cols, widths: columnWidths(rows, cols) };
}
