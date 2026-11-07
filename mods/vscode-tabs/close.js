// Closing tabs as VS Code closes editors (the tab's ×, the editor tab menu's Close items): an editor with unsaved
// changes is asked to close, so it shows its Save / Don't Save / Cancel dialog and ends itself unless cancelled; any
// other tab gets tab.close at once (an editor ending that way keeps unsaved text as a hot-exit backup). No Herdr
// imports, so node tests load it.
import { isUnsaved, editorTitleState } from "./tabfile.js";

// The shared value vscode-explorer's tab menu sets for its Close items: { tabs: [tab.close args, in order], at }.
export const CLOSE_REQUEST = "vscode-tabs.close";
// How long an editor has to show its dialog (or end) before the tab is closed as before.
export const ANSWER_MS = 5000;
const POLL_MS = 100;

// The close request (SIGUSR2, which both editors take as Close Editor): sent to the editor process of a terminal whose
// first process is `pid`, on its machine. That is the process itself on this computer (the launcher execs the editor);
// on a remote machine the launcher waits for the editor, so the editor is below it. Launchers (vsedit.sh) and any
// other process are left alone: SIGUSR2 would end them. Exits 1 when no editor is found.
const SIGNAL_SCRIPT = `q=$1
while [ -n "$q" ]; do
  next=
  for p in $q; do
    case $(ps -o args= -p "$p" 2>/dev/null) in
      *vsedit.sh*) ;;
      *vsedit*) kill -USR2 "$p"; exit ;;
    esac
    next="$next $(pgrep -P "$p" 2>/dev/null)"
  done
  q=$(echo $next)
done
exit 1`;
export const signalCommand = (pid) => ["sh", ["-c", SIGNAL_SCRIPT, "close", String(pid)]];

// closeTabs(list, sleep): closes each tab.close args of `list` in order, waiting for an asked editor's answer before
// the next, as VS Code asks one file at a time; Cancel keeps that tab and goes on. `requestClose(terminal)` sends the
// request (true when sent); `sleep(ms)` waits. An editor that neither asks nor ends within ANSWER_MS (hung, or an old
// one without the request) gets tab.close. A tab already being closed is skipped.
export function createTabCloser({ run, panes, requestClose, now = Date.now }) {
  const pending = new Set();
  async function closeOne(args, sleep) {
    const mine = panes().filter(p => p.tab === args.id);
    if (!mine.length || pending.has(args.id)) return; // gone meanwhile, or already asked
    const editor = mine.find(p => p.terminal && isUnsaved(p));
    if (!editor) return run("tab.close", args);
    pending.add(args.id);
    try {
      run("tab.select", { id: args.id }); // the dialog is in the tab
      if (editorTitleState(editor.title) === "closing") return; // it asks already
      if (!(await requestClose(editor.terminal))) return run("tab.close", args);
      const end = now() + ANSWER_MS;
      for (let asked = false; ;) {
        await sleep(POLL_MS);
        const p = panes().find(x => x.terminal === editor.terminal);
        if (!p) return; // it ended: Herdr closed its pane
        if (editorTitleState(p.title) === "closing") asked = true;
        else if (asked) return; // answered: Cancel keeps the tab; Save / Don't Save end the editor
        else if (now() >= end) return run("tab.close", args);
      }
    } finally {
      pending.delete(args.id);
    }
  }
  return async (list, sleep) => { for (const args of list) await closeOne(args, sleep); };
}
