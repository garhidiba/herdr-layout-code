// node --test mods/vscode-viewer/test/csv.test.mjs
// CSV/TSV parsing (RFC 4180) and the sheet's layout rules (csv.js).
import test from "node:test";
import assert from "node:assert/strict";
import { parseCsv, csvRows, delimiterOf, columnLabel, isNumber, cellText, columnWidths, sheetOf, visibleColumns, clampX,
  rowSpans, fieldText, editCells, rowChunks, toTsv, scrollToShow, columnStarts, columnAt, thumbOf, scrollAtTrack } from "../csv.js";

test("plain rows split on commas; a trailing newline adds no empty row", () => {
  assert.deepEqual(parseCsv("a,b,c\n1,2,3\n"), [["a", "b", "c"], ["1", "2", "3"]]);
  assert.deepEqual(parseCsv("a,b\n1,2"), [["a", "b"], ["1", "2"]]);
});

test("CRLF and lone CR end rows too; a BOM is dropped", () => {
  assert.deepEqual(parseCsv("﻿a,b\r\n1,2\r\n"), [["a", "b"], ["1", "2"]]);
  assert.deepEqual(parseCsv("a\r1\r"), [["a"], ["1"]]);
});

test("quoted fields keep commas, newlines and doubled quotes", () => {
  assert.deepEqual(parseCsv('name,note\n"Doe, J","say ""hi""\nbye"\n'), [["name", "note"], ["Doe, J", 'say "hi"\nbye']]);
  assert.deepEqual(parseCsv('"a\r\nb",c'), [["a\r\nb", "c"]]);
});

test("empty fields, empty quoted fields and blank lines are kept", () => {
  assert.deepEqual(parseCsv('a,,""\n\nb'), [["a", "", ""], [""], ["b"]]);
  assert.deepEqual(parseCsv(""), []);
  assert.deepEqual(parseCsv("a,\nb,"), [["a", ""], ["b", ""]], "a trailing separator ends with an empty field");
});

test("a quote inside an unquoted field is text; an unclosed quote runs to the end", () => {
  assert.deepEqual(parseCsv('5" pipe,x'), [['5" pipe', "x"]]);
  assert.deepEqual(parseCsv('"open,\nrest'), [["open,\nrest"]]);
  assert.deepEqual(parseCsv('"a"b,c'), [["ab", "c"]], "text after a closing quote is kept");
});

test(".tsv splits on tabs, everything else on commas", () => {
  assert.equal(delimiterOf("/p/data.TSV"), "\t");
  assert.equal(delimiterOf("/p/data.csv"), ",");
  assert.deepEqual(parseCsv("a\tb,c\n1\t2", "\t"), [["a", "b,c"], ["1", "2"]]);
});

test("columns are lettered like a spreadsheet: A..Z, AA, AB.., ZZ, AAA", () => {
  assert.deepEqual([0, 1, 25, 26, 27, 701, 702].map(columnLabel), ["A", "B", "Z", "AA", "AB", "ZZ", "AAA"]);
});

test("numbers (signs, decimals, thousands, exponents, percents) align right; text and blanks don't", () => {
  for (const s of ["0", "-12", "+3.5", " 42 ", "1,234,567.89", ".5", "1e-3", "12%"]) assert.ok(isNumber(s), s);
  for (const s of ["", " ", "abc", "1.2.3", "12a", "-", "1,23", "0x1F"]) assert.ok(!isNumber(s), s);
});

test("a cell shows on one line: line breaks become ↵", () => {
  assert.equal(cellText("a\r\nb\nc"), "a↵b↵c");
  assert.equal(cellText(undefined), "");
});

test("column widths follow the longest of the first rows, wide characters counting double, within min and max", () => {
  const rows = [["id", "name", "x".repeat(200)], ["1", "가나다라마바사", "y"]];
  const [id, name, long] = columnWidths(rows, 3, { char: 10, pad: 10, min: 40, max: 300 });
  assert.equal(id, 40, "short columns get the minimum");
  assert.equal(name, 14 * 10 + 10, "seven Hangul syllables count as fourteen");
  assert.equal(long, 300, "long text is cut at the maximum");
  assert.equal(columnWidths([["a"]], 2, { min: 40 })[1], 40, "a column no sampled row reaches still gets a width");
  assert.equal(columnWidths([["a"], ["x".repeat(50)]], 1, { sample: 1, char: 10, pad: 0, min: 0, max: 999 })[0], 10, "rows past the sample are not measured");
  const wide = [Array(500).fill("a"), Array(500).fill("a"), Array(500).fill("a"), Array(500).fill("x".repeat(30))];
  assert.equal(columnWidths(wide, 500, { cells: 1000, char: 10, pad: 0, min: 0, max: 999 })[0], 10, "a wide sheet measures fewer rows (at least 3)");
});

test("a sheet has as many columns as its widest row, and an empty file none", () => {
  const s = sheetOf(parseCsv("h1,h2\n1\n2,3,4\n"));
  assert.equal(s.cols, 3);
  assert.deepEqual(s.rows, [["h1", "h2"], ["1"], ["2", "3", "4"]]);
  assert.equal(s.widths.length, 3);
  assert.deepEqual(sheetOf([]), { rows: [], starts: [], cols: 0, widths: [] });
});

// A sheet with its row starts, as the viewer parses one.
const parsed = (text, sep = ",") => { const starts = [], rows = [...csvRows(text, sep, starts)]; return sheetOf(rows, starts); };
// editCells applied to the text, as the viewer applies it to the buffer.
const edit = (text, sheet, edits, sep = ",") => {
  const ch = editCells(text, sheet, sep, edits);
  return ch ? text.slice(0, ch.start) + ch.insert + text.slice(ch.end) : text;
};

test("each row's start in the text is recorded, past a BOM and across quoted line breaks", () => {
  assert.deepEqual(parsed('﻿a,b\r\n"x\ny",z\nlast').starts, [1, 6, 14]);
});

test("a row's field spans include their quotes and end at the row's line break", () => {
  assert.deepEqual(rowSpans("a,bb,\nx", 0, ","), { spans: [[0, 1], [2, 4], [5, 5]], end: 5 });
  assert.deepEqual(rowSpans('q,"a,""b"""\r\nx', 2, ","), { spans: [[2, 11]], end: 11 });
  assert.deepEqual(rowSpans('"multi\nline",z', 0, ","), { spans: [[0, 12], [13, 14]], end: 14 });
});

test("a value is quoted only when it needs it, or when the field it replaces was quoted", () => {
  assert.equal(fieldText("plain", ","), "plain");
  assert.equal(fieldText("a,b", ","), '"a,b"');
  assert.equal(fieldText('say "hi"', ","), '"say ""hi"""');
  assert.equal(fieldText("two\nlines", ","), '"two\nlines"');
  assert.equal(fieldText("a,b", "\t"), "a,b");
  assert.equal(fieldText("x", ",", true), '"x"');
});

test("editing a cell changes only that field's text: quotes, CRLF, BOM and the final line break stay", () => {
  const text = '﻿name,"note"\r\n1,"a, b"\r\n2,c\r\n', s = parsed(text);
  const out = edit(text, s, [{ r: 1, c: 1, value: "new" }]);
  assert.equal(out, '﻿name,"note"\r\n1,"new"\r\n2,c\r\n');
  assert.deepEqual(s.rows[1], ["1", "new"]);
  assert.deepEqual(parsed(out).starts, s.starts, "later rows' starts follow the edit");
  assert.equal(edit(out, s, [{ r: 2, c: 1, value: "x,y" }]), '﻿name,"note"\r\n1,"new"\r\n2,"x,y"\r\n');
});

test("edits in several rows make one change, and the sheet matches a fresh parse of the result", () => {
  const text = "a,b\n1,2\n3,4\n5,6", s = parsed(text);
  const ch = editCells(text, s, ",", [{ r: 3, c: 0, value: "five" }, { r: 1, c: 1, value: 'q"' }]);
  const out = text.slice(0, ch.start) + ch.insert + text.slice(ch.end);
  assert.equal(out, 'a,b\n1,"q"""\n3,4\nfive,6');
  assert.deepEqual({ rows: s.rows, starts: s.starts }, (({ rows, starts }) => ({ rows, starts }))(parsed(out)));
});

test("a cell past a short row's end is reached by adding separators; clearing one there adds nothing", () => {
  const text = "a,b,c\n1\n2,3\n", s = parsed(text);
  assert.equal(edit(text, s, [{ r: 1, c: 2, value: "x" }]), "a,b,c\n1,,x\n2,3\n");
  assert.deepEqual(s.rows[1], ["1", "", "x"]);
  assert.equal(editCells("a\n1\n", parsed("a\n1\n"), ",", [{ r: 1, c: 3, value: "" }]), null);
});

test("an edit past the widest row adds a column; unchanged values and rows out of range change nothing", () => {
  const text = "a\n1", s = parsed(text);
  assert.equal(edit(text, s, [{ r: 0, c: 1, value: "b" }]), "a,b\n1");
  assert.equal(s.cols, 2);
  assert.equal(s.widths.length, 2);
  assert.equal(editCells("a\n1", parsed("a\n1"), ",", [{ r: 1, c: 0, value: "1" }, { r: 9, c: 0, value: "x" }]), null);
});

test("TSV editing uses tabs; a blank line is one empty cell", () => {
  const text = "a\tb\n\nc\td", s = parsed(text, "\t");
  assert.equal(edit(text, s, [{ r: 1, c: 1, value: "x\ty" }], "\t"), 'a\tb\n\t"x\ty"\nc\td');
});

test("a big edit splits into runs of whole rows, in row order; edits applied run by run give the same text", () => {
  const edits = [{ r: 3, c: 0, value: "c" }, { r: 1, c: 1, value: "a2" }, { r: 1, c: 0, value: "a" }, { r: 2, c: 0, value: "b" }];
  assert.deepEqual(rowChunks(edits, 2).map(ch => ch.map(e => `${e.r}${e.c}`)), [["10", "11", "20"], ["30"]]);
  assert.deepEqual(rowChunks([], 2), []);
  const text = "h,i\n1,2\n3,4\n5,6", once = parsed(text), runs = parsed(text);
  let stepped = text;
  for (const run of rowChunks(edits, 1)) stepped = edit(stepped, runs, run);
  assert.equal(stepped, edit(text, once, edits));
  assert.deepEqual(runs.starts, once.starts);
});

test("copied cells are TSV, fields quoted when they hold a tab, a quote or a line break", () => {
  assert.equal(toTsv([["a", "b c"], ["x\ty", 'q"'], ["two\nlines", ""]]), 'a\tb c\n"x\ty"\t"q"""\n"two\nlines"\t');
});

test("scrolling to show a range moves as little as it can", () => {
  assert.equal(scrollToShow(100, 20, 0, 200), 0, "already in view");
  assert.equal(scrollToShow(300, 20, 0, 200), 120, "below: its far edge at the bottom");
  assert.equal(scrollToShow(40, 20, 100, 200), 40, "above: its near edge at the top");
  assert.equal(scrollToShow(0, 500, 100, 200), 0, "longer than the view: its start");
});

test("a scroll bar's thumb is as long as the share in view (at least 24px) and travels the rest of the track", () => {
  assert.deepEqual(thumbOf(200, 100, 400, 0), { len: 50, at: 0, ratio: 2 });
  assert.deepEqual(thumbOf(200, 100, 400, 300), { len: 50, at: 150, ratio: 2 });
  assert.equal(thumbOf(200, 10, 100000, 0).len, 24);
  assert.deepEqual(thumbOf(200, 400, 300, 0), { len: 200, at: 0, ratio: 0 }, "everything in view: a full thumb that never moves");
});

test("a click on the track jumps so the thumb's middle sits under it, held to the ends", () => {
  assert.equal(scrollAtTrack(100, 200, 100, 400), 150, "middle of the track: thumb 75..125, scroll 150");
  assert.equal(scrollAtTrack(10, 200, 100, 400), 0, "near the start: held at 0");
  assert.equal(scrollAtTrack(199, 200, 100, 400), 300, "near the end: held at the last scroll");
  assert.equal(scrollAtTrack(50, 200, 400, 300), 0, "nothing to scroll");
});

test("column starts and the column under a position", () => {
  assert.deepEqual(columnStarts([100, 50, 80]), [0, 100, 150, 230]);
  assert.deepEqual([0, 99, 100, 149, 150, 229, 999, -5].map(x => columnAt([100, 50, 80], x)), [0, 0, 1, 1, 2, 2, 2, 0]);
});

test("only the columns in the viewport are drawn, the first one shifted by how far it starts left of it", () => {
  const widths = [100, 50, 200, 80];
  assert.deepEqual(visibleColumns(widths, 0, 120), { first: 0, end: 2, shift: 0 });
  assert.deepEqual(visibleColumns(widths, 100, 50), { first: 1, end: 2, shift: 0 }, "a column ending at the edge is left out");
  assert.deepEqual(visibleColumns(widths, 130, 100), { first: 1, end: 3, shift: 30 });
  assert.deepEqual(visibleColumns(widths, 0, 9999), { first: 0, end: 4, shift: 0 });
  assert.deepEqual(visibleColumns([], 0, 100), { first: 0, end: 0, shift: 0 });
});

test("the sideways scroll stays within the grid, and at 0 when it fits", () => {
  assert.equal(clampX(-5, 500, 200), 0);
  assert.equal(clampX(400, 500, 200), 300);
  assert.equal(clampX(150, 500, 200), 150);
  assert.equal(clampX(50, 300, 800), 0);
});

test("rows come one at a time, so a big file can be parsed a slice per tick", () => {
  const it = csvRows('a,"b\nc"\nd,e\n');
  assert.deepEqual(it.next().value, ["a", "b\nc"]);
  assert.deepEqual(it.next().value, ["d", "e"]);
  assert.equal(it.next().done, true);
});
