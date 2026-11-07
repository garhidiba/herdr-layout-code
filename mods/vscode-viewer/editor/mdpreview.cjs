// Markdown preview beside the editor (VS Code's Open Preview to the Side / Toggle Preview): a terminal can't draw rich
// Markdown, so the preview is the vscode-viewer mod (`{file, preview: true}`) in a pane right of the editor's, through
// herdr-app. Which viewer panes show a file: the shared value vscode-viewer.files (`{[pane]: {file, on}}`, saved in
// <herdr home>/shared.json); a pane that closed may linger there, so one counts only once `pane.focus` lands on it
// (`herdr-app status`'s focused_pane).
const fs = require("fs");
const os = require("os");
const path = require("path");

const SCOPE = "text.html.markdown";
const REMOTE = "Preview: open from the Explorer on this computer";

const sharedFile = () => path.join(process.env.HERDR_APP_HOME ?? path.join(os.homedir(), ".config", "herdr-app"), "shared.json");
// The local viewer panes that show `file`, from shared.json's text (anything unreadable: none).
function viewerPanes(sharedText, file) {
  let files;
  try { files = JSON.parse(sharedText)["vscode-viewer.files"]; } catch { return []; }
  return Object.entries(files && typeof files === "object" ? files : {}).filter(([, v]) => v?.file === file && !v.on).map(([pane]) => pane);
}

// `herdr(args)` -> Promise of herdr-app's stdout. toggle: a shown preview closes (focus back to the editor), else one
// opens; otherwise a shown preview is focused, else one opens and the editor keeps focus. -> "closed" | "focused" | "opened".
async function showPreview({ file, terminal, toggle, sharedText, herdr }) {
  const focusedPane = async () => { try { return JSON.parse(await herdr(["status"])).focused_pane ?? null; } catch { return null; } };
  const editor = () => herdr(["do", "pane.focus", "--terminal", terminal]);
  for (const pane of viewerPanes(sharedText, file)) {
    await herdr(["do", "pane.focus", "--pane", pane]);
    if (await focusedPane() !== pane) continue;
    if (!toggle) return "focused";
    await herdr(["do", "pane.close", "--pane", pane]);
    await editor();
    return "closed";
  }
  await editor(); // pane.split splits the focused pane
  await herdr(["do", "pane.split", JSON.stringify({ direction: "right", mod: "vscode-viewer", props: { file, preview: true } })]);
  await editor();
  return "opened";
}

module.exports = { SCOPE, REMOTE, sharedFile, viewerPanes, showPreview };
