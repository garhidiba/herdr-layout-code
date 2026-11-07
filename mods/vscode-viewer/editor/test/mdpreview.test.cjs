// node --test mods/vscode-viewer/editor/test
process.env.VSEDIT_OS = "mac";
require("./no-inline.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const H = require("../highlight.cjs");
const MD = require("../mdpreview.cjs");
const { Editor } = require("../vsedit.cjs");
const fs = require("fs");
const os = require("os");
const path = require("path");

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

test("an HTML file's preview asks the viewer to render it as HTML", async () => {
  assert.equal(MD.previewOf(MD.MARKDOWN), true);
  assert.equal(MD.previewOf("text.html.basic"), "html");
  assert.equal(MD.previewOf("text.html.derivative"), "html");
  assert.equal(MD.previewOf("source.js"), null);
  const { herdr, calls } = fakeHerdr([]);
  assert.equal(await MD.showPreview({ file: "/r/x.html", preview: "html", terminal: "t1", toggle: false, sharedText: "{}", herdr }), "opened");
  assert.equal(calls[1], 'do pane.split {"direction":"right","mod":"vscode-viewer","props":{"file":"/r/x.html","preview":"html"}}');
});

const editorOf = async (file, lines, scope) => {
  const ed = new Editor(file, { lines, eol: "\n", finalNewline: true }, await H.loadGrammar(null), H.loadTheme(), scope);
  ed.rows = 10; ed.cols = 80;
  return ed;
};
// Runs `fn` with $HC_TERMINAL_ID set to `id` (undefined: unset), and `bin` (a folder) first on PATH.
async function withEnv(id, bin, fn) {
  const saved = { id: process.env.HC_TERMINAL_ID, path: process.env.PATH };
  if (id === undefined) delete process.env.HC_TERMINAL_ID; else process.env.HC_TERMINAL_ID = id;
  if (bin) process.env.PATH = `${bin}:${saved.path}`;
  try { return await fn(); } finally {
    if (saved.id === undefined) delete process.env.HC_TERMINAL_ID; else process.env.HC_TERMINAL_ID = saved.id;
    process.env.PATH = saved.path;
  }
}

test("Markdown and HTML files have a Preview button at the breadcrumb row's end; other files don't, and the commands say why", async () => {
  await withEnv(undefined, null, async () => { // no herdr-app to ask, as on a remote machine
    for (const [file, scope] of [["/tmp/x.md", MD.MARKDOWN], ["/tmp/x.html", "text.html.basic"]]) {
      const ed = await editorOf(file, ["# Hi"], scope);
      ed.render(0);
      assert.equal(ed.previewHit, 80 - " Preview ".length + 1);
      ed.handle({ type: "mouse", button: 0, x: ed.previewHit + 2, y: 1, release: false, motion: false });
      assert.equal(ed.message.text, MD.REMOTE);
    }
    const txt = await editorOf("/tmp/x.txt", ["hi"], null);
    assert.doesNotMatch(txt.render(0).out, /Preview/);
    assert.equal(txt.previewHit, null);
    txt.runCommand("markdown.showPreview");
    assert.equal(txt.message.text, "Preview: not a Markdown or HTML file");
  });
});

test("HTML: Open in Default Browser runs the platform's opener on this computer only", async () => {
  assert.deepEqual(MD.opener("darwin"), ["open"]);
  assert.deepEqual(MD.opener("linux"), ["xdg-open"]);
  assert.deepEqual(MD.opener("win32"), ["cmd", "/c", "start", ""]);
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "vsedit-browser-")), log = path.join(bin, "log");
  for (const name of ["herdr-app", ...MD.opener()]) fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "$@" >> "${log}"\n`, { mode: 0o755 });
  try {
    const html = await editorOf("/tmp/x.html", ["<p>hi</p>"], "text.html.basic");
    await withEnv(undefined, bin, () => html.runCommand("html.openInDefaultBrowser"));
    assert.equal(html.message.text, "Open in Browser: only for files on this computer");
    await withEnv("t1", bin, () => html.runCommand("html.openInDefaultBrowser"));
    for (let i = 0; i < 100 && !fs.existsSync(log); i++) await new Promise(r => setTimeout(r, 20));
    assert.equal(fs.readFileSync(log, "utf8"), "/tmp/x.html\n");
    const txt = await editorOf("/tmp/x.txt", ["hi"], null);
    txt.runCommand("html.openInDefaultBrowser");
    assert.equal(txt.message.text, "Open in Browser: not an HTML file");
  } finally { fs.rmSync(bin, { recursive: true, force: true }); }
});

