// node --test mods/vscode-viewer/test/csv.test.mjs
// CSV/TSV parsing (RFC 4180) and the sheet's layout rules (csv.js).
import test from "node:test";
import assert from "node:assert/strict";
import { parseCsv, csvRows, delimiterOf, columnLabel, isNumber, cellText, columnWidths, sheetOf, visibleColumns, clampX } from "../csv.js";

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

test("a sheet: the first row is the header, short rows are padded to the widest row, empty text has no header", () => {
  const s = sheetOf(parseCsv("h1,h2\n1\n2,3,4\n"));
  assert.equal(s.cols, 3);
  assert.deepEqual(s.header, ["h1", "h2", ""]);
  assert.deepEqual(s.body, [["1"], ["2", "3", "4"]]);
  assert.equal(s.widths.length, 3);
  assert.deepEqual(sheetOf([]), { header: [], body: [], cols: 0, widths: [] });
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
