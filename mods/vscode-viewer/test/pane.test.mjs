// node --test mods/vscode-viewer/test/pane.test.mjs
// A viewer learning its own pane (pane.js), which a tab's mod isn't given.
import test from "node:test";
import assert from "node:assert/strict";
import { ownPane } from "../pane.js";

const panes = [
  { pane: "p1", tab: "a", terminal: "t1" },
  { pane: "pv", tab: "a", terminal: null, mod: "vscode-viewer" }, // icon.png beside a shell
  { pane: "pw", tab: "b", terminal: null, mod: "vscode-viewer" }, { pane: "px", tab: "b", terminal: null, mod: "vscode-viewer" }, // two
];

test("on screen means in the shown tab: its one viewer pane is this viewer's", () => {
  assert.equal(ownPane({ panes, tab: "a" }), "pv");
  assert.equal(ownPane({ panes, tab: "c" }), null);
  assert.equal(ownPane({ panes, tab: undefined }), null);
});

test("with two viewers in the shown tab, the one whose header sits on top of this viewer", () => {
  const headers = { pw: { x: 276, y: 50, width: 300, height: 30 }, px: { x: 584, y: 50, width: 300, height: 30 } };
  assert.equal(ownPane({ panes, tab: "b", bounds: { x: 584, y: 80, width: 300, height: 600 }, headers }), "px");
  assert.equal(ownPane({ panes, tab: "b", bounds: { x: 276, y: 80.5, width: 300, height: 600 }, headers }), "pw");
  assert.equal(ownPane({ panes, tab: "b", bounds: null, headers }), null, "laid out, no bounds: can't tell");
  assert.equal(ownPane({ panes, tab: "b", bounds: { x: 900, y: 80, width: 300, height: 600 }, headers }), null);
  assert.equal(ownPane({ panes, tab: "b", bounds: { x: 584, y: 80, width: 300, height: 600 }, headers: null }), null);
});
