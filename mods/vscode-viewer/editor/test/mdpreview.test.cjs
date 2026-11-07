// node --test mods/vscode-viewer/editor/test
process.env.VSEDIT_OS = "mac";
require("./no-inline.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const H = require("../highlight.cjs");
const MD = require("../mdpreview.cjs");
const { Editor } = require("../vsedit.cjs");

// A fake herdr-app where the `live` panes exist and pane.focus moves the focus (an unknown pane: no move).
function fakeHerdr(live) {
  const calls = [];
  let focus = "pEditor";
  const herdr = async (args) => {
    calls.push(args.join(" "));
    if (args[0] === "status") return JSON.stringify({ focused_pane: focus });
    if (args[1] === "pane.focus") focus = args[2] === "--terminal" ? "pEditor" : live.includes(args[3]) ? args[3] : focus;
    return '{"ok":true}';
  };
  return { herdr, calls };
}
const sharedOf = (files) => JSON.stringify({ "vscode-viewer.files": files });

test("viewer panes of a file: the local ones showing it; none from unreadable shared state", () => {
  const text = sharedOf({ a: { file: "/r/x.md", on: null }, b: { file: "/r/y.md", on: null }, c: { file: "/r/x.md", on: "box" } });
  assert.deepEqual(MD.viewerPanes(text, "/r/x.md"), ["a"]);
  assert.deepEqual(MD.viewerPanes("{oops", "/r/x.md"), []);
  assert.deepEqual(MD.viewerPanes("{}", "/r/x.md"), []);
});

test("with no preview shown (a closed pane lingering in shared state), a preview opens right of the editor, which keeps focus", async () => {
  const { herdr, calls } = fakeHerdr([]);
  const sharedText = sharedOf({ gone: { file: "/r/x.md", on: null } });
  assert.equal(await MD.showPreview({ file: "/r/x.md", terminal: "t1", toggle: true, sharedText, herdr }), "opened");
  assert.deepEqual(calls, ["do pane.focus --pane gone", "status", "do pane.focus --terminal t1",
    'do pane.split {"direction":"right","mod":"vscode-viewer","props":{"file":"/r/x.md","preview":true}}', "do pane.focus --terminal t1"]);
});

test("a shown preview is focused by Open Preview to the Side and closed by Toggle Preview", async () => {
  const sharedText = sharedOf({ p9: { file: "/r/x.md", on: null } });
  let h = fakeHerdr(["p9"]);
  assert.equal(await MD.showPreview({ file: "/r/x.md", terminal: "t1", toggle: false, sharedText, herdr: h.herdr }), "focused");
  assert.deepEqual(h.calls, ["do pane.focus --pane p9", "status"]);
  h = fakeHerdr(["p9"]);
  assert.equal(await MD.showPreview({ file: "/r/x.md", terminal: "t1", toggle: true, sharedText, herdr: h.herdr }), "closed");
  assert.deepEqual(h.calls.slice(2), ["do pane.close --pane p9", "do pane.focus --terminal t1"]);
});

test("a Markdown file has a Preview button at the breadcrumb row's end; other files don't, and the commands say why", async () => {
  const saved = process.env.HC_TERMINAL_ID;
  delete process.env.HC_TERMINAL_ID; // no herdr-app to ask, as on a remote machine
  try {
    const md = new Editor("/tmp/x.md", { lines: ["# Hi"], eol: "\n", finalNewline: true }, await H.loadGrammar(null), H.loadTheme(), MD.SCOPE);
    md.rows = 10; md.cols = 80;
    md.render(0);
    assert.equal(md.previewHit, 80 - " Preview ".length + 1);
    md.handle({ type: "mouse", button: 0, x: md.previewHit + 2, y: 1, release: false, motion: false });
    assert.equal(md.message.text, MD.REMOTE);
    const txt = new Editor("/tmp/x.txt", { lines: ["hi"], eol: "\n", finalNewline: true }, await H.loadGrammar(null), H.loadTheme(), null);
    txt.rows = 10; txt.cols = 80;
    assert.doesNotMatch(txt.render(0).out, /Preview/);
    assert.equal(txt.previewHit, null);
    txt.runCommand("markdown.showPreview");
    assert.equal(txt.message.text, "Preview: not a Markdown file");
  } finally { if (saved !== undefined) process.env.HC_TERMINAL_ID = saved; }
});
