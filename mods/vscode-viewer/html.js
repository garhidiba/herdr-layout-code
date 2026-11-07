// HTML -> Markdown, so the viewer shows an HTML file as a readable document through its Markdown view (Herdr has no web
// view). Headings, paragraphs, line breaks, bold/italic/strikethrough/code, links, lists, blockquotes, pre blocks, simple
// tables and images (as a link `[Image: alt](src)`); <script>, <style>, <head>, <template> and comments are dropped,
// entities decoded, any other tag keeps only its text. Plain string scanning (it runs in QuickJS: no DOMParser), forgiving
// of unclosed and stray tags.

const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®", trade: "™", hellip: "…",
  mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", laquo: "«", raquo: "»", bull: "•", middot: "·",
  times: "×", divide: "÷", deg: "°", euro: "€", pound: "£", yen: "¥", cent: "¢", sect: "§", para: "¶", larr: "←", rarr: "→",
  uarr: "↑", darr: "↓" };
export const decode = (s) => s.replace(/&(#[xX][\da-fA-F]+|#\d+|[a-zA-Z]+);?/g, (m, e) => {
  if (e[0] !== "#") return NAMED[e] ?? m;
  const n = /x/i.test(e[1]) ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
  return n > 0 && n <= 0x10ffff && (n < 0xd800 || n > 0xdfff) ? String.fromCodePoint(n) : "�";
});
const esc = (s) => s.replace(/[\\`*_[\]<>#|~]/g, "\\$&");
const url = (s) => s.trim().replace(/[ ()<>]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());
const attr = (attrs, name) => {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(attrs);
  return m ? decode(m[1] ?? m[2] ?? m[3]) : "";
};
const langOf = (attrs) => /(?:^|\s)lang(?:uage)?-([\w+#.-]+)/.exec(attr(attrs, "class"))?.[1] ?? "";

const BLOCKS = new Set(["p", "div", "section", "article", "main", "header", "footer", "nav", "aside", "figure", "figcaption", "form",
  "fieldset", "legend", "address", "details", "summary", "dl", "dt", "dd", "body", "html", "center", "caption"]);
const MARKS = { strong: "**", b: "**", em: "*", i: "*", del: "~~", s: "~~", strike: "~~" };

export function htmlToMarkdown(html) {
  const src = String(html ?? "").replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(/<(script|style|head|template)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, "");
  let out = "", pending = 1, brk = false, lineStart = true, hashes = "", marker = "", markerList = null;
  let cell = null, cellGap = false, table = null, tableDepth = 0, pre = null, code = 0;
  const nest = [], links = [];   // nest: { q: true } blockquotes and { ordered, n, w } lists, outermost first
  let lineNest = [];             // the nest the last line was written in

  const prefix = (list, mark) => list.map(e => e.q ? "> " : mark && e === markerList ? marker : " ".repeat(e.w)).join("");
  const block = (n) => { if (cell !== null) cellGap = true; else pending = Math.max(pending, n); };
  const flush = () => {
    if (!pending) return;
    if (out) {
      out = out.replace(/[ \t]+$/, "") + (brk && pending === 1 ? "\\" : "") + "\n";
      let same = 0;  // a blank line keeps only the quotes and lists both lines are in
      while (same < nest.length && nest[same] === lineNest[same]) same++;
      if (pending > 1) out += prefix(nest.slice(0, same), false).trimEnd() + "\n";
    }
    lineNest = nest.slice();
    out += prefix(nest, true) + hashes;
    pending = 0; brk = false; hashes = ""; marker = ""; markerList = null; lineStart = true;
  };
  const put = (s) => {
    if (cell !== null) { if (cellGap && cell) cell += " "; cellGap = false; cell += s; return; }
    flush(); out += s; lineStart = false;
  };
  const text = (raw) => {
    if (pre) { pre.text += decode(raw); return; }
    let s = decode(raw.replace(/[ \t\r\n\f]+/g, " "));
    if (!code) s = esc(s);
    if (cell !== null ? !cell || cellGap : pending || lineStart) s = s.replace(/^ +/, "");
    if (s) put(s);
  };
  const closeTo = (q) => { for (let i = nest.length - 1; i >= 0; i--) if (!!nest[i].q === q) { nest.length = i; return true; } return false; };
  const endCell = () => { if (cell !== null && table) { if (!table.rows.length) table.rows.push([]); table.rows[table.rows.length - 1].push(cell.trim()); } cell = null; };
  const lines = (list) => { block(2); for (const l of list) { put(l); block(1); } block(2); };

  const open = (tag, attrs, selfClosing) => {
    if (pre) {
      if (tag === "br") pre.text += "\n";
      else if (tag === "code" && !pre.lang) pre.lang = langOf(attrs);
      return;
    }
    if (BLOCKS.has(tag)) return block(2);
    if (/^h[1-6]$/.test(tag)) { block(2); if (cell === null) hashes = "#".repeat(+tag[1]) + " "; return; }
    if (MARKS[tag]) return put(MARKS[tag]);
    switch (tag) {
      case "br": if (cell !== null) cellGap = true; else if (!pending && !lineStart) { pending = 1; brk = true; } return;
      case "hr": if (cell === null) lines(["---"]); return;
      case "code": code++; return put("`");
      case "pre": block(2); pre = { text: "", lang: langOf(attrs) }; return;
      case "blockquote": block(2); nest.push({ q: true }); return;
      case "ul": case "ol": block(nest.some(e => !e.q) ? 1 : 2); nest.push({ ordered: tag === "ol", n: parseInt(attr(attrs, "start"), 10) || 1, w: 2 }); return;
      case "li": {
        block(1);
        const list = [...nest].reverse().find(e => !e.q);
        if (list && cell === null) { marker = list.ordered ? `${list.n++}. ` : "- "; list.w = marker.length; markerList = list; }
        return;
      }
      case "a": {
        const href = attr(attrs, "href");
        const ok = href && !/^\s*(javascript|vbscript|data):/i.test(href) && !selfClosing;
        links.push(ok ? href : null);
        if (ok) put("[");
        return;
      }
      case "img": {
        const alt = attr(attrs, "alt").replace(/\s+/g, " ").trim(), label = esc(alt ? `Image: ${alt}` : "Image"), src = attr(attrs, "src");
        return put(src && !links.some(Boolean) ? `[${label}](${url(src)})` : label);
      }
      case "table": if (tableDepth++ === 0) { block(2); table = { rows: [] }; } return;
      case "tr": if (tableDepth === 1) { endCell(); table.rows.push([]); } return;
      case "td": case "th": if (tableDepth === 1) { endCell(); cell = ""; cellGap = false; } return;
    }
  };
  const close = (tag) => {
    if (pre) {
      if (tag !== "pre") return;
      const body = pre.text.replace(/^\r?\n/, "").replace(/\s+$/, "");
      const fence = "`".repeat(Math.max(3, ...(body.match(/`+/g) ?? []).map(r => r.length + 1)));
      const lang = pre.lang;
      pre = null;
      return lines([fence + lang, ...(body ? body.split(/\r?\n/) : []), fence]);
    }
    if (BLOCKS.has(tag) || /^h[1-6]$/.test(tag)) return block(2);
    if (MARKS[tag]) return put(MARKS[tag]);
    switch (tag) {
      case "code": if (code) { code--; put("`"); } return;
      case "blockquote": if (closeTo(true)) block(2); return;
      case "ul": case "ol": if (closeTo(false)) block(nest.some(e => !e.q) ? 1 : 2); return;
      case "li": return block(1);
      case "a": { const href = links.pop(); if (href) put(`](${url(href)})`); return; }
      case "td": case "th": case "tr": if (tableDepth === 1) endCell(); return;
      case "table": {
        if (tableDepth === 0 || --tableDepth > 0) return;
        endCell();
        const rows = table.rows.filter(r => r.length);
        table = null;
        if (!rows.length) return block(2);
        const n = Math.max(...rows.map(r => r.length));
        const row = (r) => "| " + Array.from({ length: n }, (_, i) => r[i] || " ").join(" | ") + " |";
        return lines([row(rows[0]), row(Array(n).fill("---")), ...rows.slice(1).map(row)]);
      }
    }
  };

  const TOKEN = /<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|<[!?][^>]*>|([^<]+)|</g;
  for (let m; (m = TOKEN.exec(src));) {
    if (m[2]) {
      const tag = m[2].toLowerCase(), attrs = m[3] ?? "", selfClosing = /\/\s*$/.test(attrs);
      if (m[1]) close(tag);
      else open(tag, attrs, selfClosing);
    } else if (m[4] !== undefined) text(m[4]);
    else if (m[0] === "<") text("<");
  }
  if (pre) close("pre");
  if (tableDepth) { tableDepth = 1; close("table"); }
  return out.replace(/\n{3,}/g, "\n\n").trim();
}
