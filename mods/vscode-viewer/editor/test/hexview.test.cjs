// node --test mods/vscode-viewer/editor/test
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const HV = require("../hexview.cjs");
const F = require("../file.cjs");

const tmpFile = (bytes) => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hexview-")), "data.bin");
  fs.writeFileSync(f, bytes);
  return f;
};
const readerOf = (bytes, chunk) => { const f = tmpFile(bytes), fd = fs.openSync(f, "r"); return new HV.Reader(fd, bytes.length, chunk); };

test("a row shows the offset, 16 bytes as hex in two groups of 8, and printable ASCII with · for the rest", () => {
  const bytes = Buffer.from([0x48, 0x69, 0x00, 0x7f, 0x20, 0xff, 1, 2, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x0a]);
  assert.equal(HV.formatRow(0x10, bytes), "00000010  48 69 00 7f 20 ff 01 02  41 42 43 44 45 46 47 0a  Hi·· ···ABCDEFG·");
});

test("a short last row pads the hex columns so the ASCII pane stays aligned", () => {
  const row = HV.formatRow(0x20, Buffer.from("abc"));
  assert.equal(row.indexOf("abc", 10), HV.ASCII_COL);
  assert.equal(row.slice(HV.hexCol(0), HV.hexCol(3)), "61 62 63 ");
});

test("the column header lines up with the byte columns", () => {
  assert.equal(HV.HEADER.slice(HV.hexCol(0), HV.hexCol(0) + 2), "00");
  assert.equal(HV.HEADER.slice(HV.hexCol(8), HV.hexCol(8) + 2), "08");
  assert.equal(HV.HEADER.slice(HV.hexCol(15), HV.hexCol(15) + 2), "0F");
});

test("the data inspector decodes signed/unsigned, both byte orders and float32 at the cursor", () => {
  const v = Object.fromEntries(HV.inspect(Buffer.from([0xff, 0xfe, 0x80, 0x3f])));
  assert.equal(v.int8, "-1");
  assert.equal(v.uint8, "255");
  assert.equal(v["int16 LE"], "-257"); // 0xfeff
  assert.equal(v["int16 BE"], "-2"); // 0xfffe
  assert.equal(v["int32 BE"], String(Buffer.from([0xff, 0xfe, 0x80, 0x3f]).readInt32BE(0)));
  assert.equal(Object.fromEntries(HV.inspect(Buffer.from([0, 0, 0x80, 0x3f])))["float32 LE"], "1");
});

test("near the end of the file the inspector shows only the values that fit", () => {
  assert.deepEqual(HV.inspect(Buffer.from([7])).map(([k]) => k), ["int8", "uint8"]);
  assert.deepEqual(HV.inspect(Buffer.alloc(0)), []);
});

test("offsets: 0x and h suffixes or a-f digits are hex, plain digits decimal, anything else invalid", () => {
  assert.equal(HV.parseOffset("0x1F"), 31);
  assert.equal(HV.parseOffset("1fh"), 31);
  assert.equal(HV.parseOffset("ff"), 255);
  assert.equal(HV.parseOffset(" 31 "), 31);
  assert.equal(HV.parseOffset("zz"), null);
});

test("find text: spaced byte pairs are hex, quoted or other text is UTF-8", () => {
  assert.deepEqual(HV.parseNeedle("de ad be ef"), Buffer.from([0xde, 0xad, 0xbe, 0xef]));
  assert.deepEqual(HV.parseNeedle("0a"), Buffer.from([0x0a]));
  assert.deepEqual(HV.parseNeedle("cafe"), Buffer.from("cafe"));
  assert.deepEqual(HV.parseNeedle('"de ad"'), Buffer.from("de ad"));
  assert.equal(HV.parseNeedle(""), null);
});

test("chunked reads join chunks, stop at the end of the file and return nothing past it", () => {
  const bytes = Buffer.from(Array.from({ length: 100 }, (_, i) => i));
  const r = readerOf(bytes, 16);
  assert.deepEqual(r.read(10, 12), bytes.subarray(10, 22)); // straddles the 16-byte chunk boundary
  assert.deepEqual(r.read(0, 100), bytes);
  assert.deepEqual(r.read(90, 50), bytes.subarray(90));
  assert.equal(r.read(100, 4).length, 0);
  assert.ok(r.cache.size <= 64);
});

test("the chunk cache keeps only the most recently used chunks", () => {
  const r = readerOf(Buffer.alloc(64), 8);
  r.keep = 2;
  r.read(0, 1); r.read(8, 1); r.read(0, 1); r.read(16, 1);
  assert.deepEqual([...r.cache.keys()], [0, 2]);
});

test("find locates hex and text across 1 MB block boundaries, wraps around, and searches backwards", () => {
  const bytes = Buffer.alloc((1 << 20) + 100);
  const at = (1 << 20) - 2; // the needle straddles the first block's end
  Buffer.from([0xde, 0xad, 0xbe, 0xef]).copy(bytes, at);
  Buffer.from("hello").copy(bytes, 10);
  const r = readerOf(bytes);
  assert.equal(r.find(HV.parseNeedle("de ad be ef"), 0), at);
  assert.equal(r.find(HV.parseNeedle("hello"), 11), 10, "wraps to the start");
  assert.equal(r.find(HV.parseNeedle("hello"), at, true), 10, "backwards");
  assert.equal(r.find(HV.parseNeedle("de ad be ef"), 5, true), at, "backwards wraps to the end");
  assert.equal(r.find(HV.parseNeedle("ca fe"), 0), -1);
});

test("the viewer moves by bytes and rows, extends a selection with Shift and copies it as hex", () => {
  const bytes = Buffer.from(Array.from({ length: 64 }, (_, i) => i));
  let copied = null;
  const v = new HV.HexView(readerOf(bytes), { file: "x", crumbs: ["x"], colors: require("../paint.cjs").paletteOf({}), clipboard: (t) => { copied = t; } });
  v.rows = 10;
  v.handle({ type: "key", name: "down", ctrl: false, shift: false, alt: false, cmd: false });
  v.handle({ type: "key", name: "right", ctrl: false, shift: true, alt: false, cmd: false });
  v.handle({ type: "key", name: "right", ctrl: false, shift: true, alt: false, cmd: false });
  assert.equal(v.cursor, 18);
  assert.deepEqual(v.range(), [16, 19]);
  v.handle({ type: "key", name: "c", ctrl: true, shift: false, alt: false, cmd: false });
  assert.equal(copied, "10 11 12");
  v.handle({ type: "key", name: "end", ctrl: false, shift: false, alt: false, cmd: false });
  assert.equal(v.cursor, 63);
  assert.equal(v.offsetAt(HV.ASCII_COL + 1 + 2, 3), 2, "a click in the ASCII pane maps to its byte");
});

test("the viewer's scrollbar shows when rows don't fit, and dragging it scrolls without moving the cursor", () => {
  const mouse = (y, more) => ({ type: "mouse", button: 0, x: 80, y, motion: false, release: false, ...more });
  const v = new HV.HexView(readerOf(Buffer.alloc(16 * 100)), { file: "x", crumbs: ["x"], colors: require("../paint.cjs").paletteOf({}) });
  assert.ok(v.render(14, 80).includes("\x1b[3;80H") && v.vbar.shown, "the bar in the last column from the first row");
  v.handle(mouse(3)); v.handle(mouse(12, { motion: true })); v.handle(mouse(12, { release: true }));
  assert.equal(v.top, 90, "dragged to the end: the last page");
  assert.equal(v.cursor, 0);
  const small = new HV.HexView(readerOf(Buffer.alloc(32)), { file: "x", crumbs: ["x"], colors: require("../paint.cjs").paletteOf({}) });
  small.render(14, 80);
  assert.equal(small.vbar.shown, false, "everything fits: no bar");
});

test("NUL bytes mark a file binary; Open Anyway decodes it as text", () => {
  const f = tmpFile(Buffer.from("a\0b\n"));
  assert.equal(F.load(f).binary, true);
  assert.deepEqual(F.load(f, { lossy: true }).lines, ["a\0b"]);
});

test("names that are clearly binary skip the prompt", () => {
  for (const f of ["/x/.DS_Store", "a.png", "b.zip", "c.wasm", "d.woff2", "e.pdf", "f.sqlite", "g.exe"]) assert.ok(HV.binaryName(f), f);
  for (const f of ["a.ts", "README.md", "logo.svg", "notes.txt"]) assert.ok(!HV.binaryName(f), f);
});
