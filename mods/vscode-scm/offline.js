// A machine Herdr can't reach, said briefly: `win-amd64 is unreachable: cannot reach win-amd64: {"error":{...}}` →
// "win-amd64 is offline — …". Any other error text comes back as it was. No Herdr imports, so node tests load it.
// vscode-scm/offline.js and vscode-spaces/offline.js are copies (mods don't import each other; a test keeps them equal).
const MACHINE = /([\w.-]+) is unreachable|cannot reach ([\w.-]+)/;

export function friendlyError(error) {
  const text = String(error?.message ?? error);
  const name = MACHINE.exec(text);
  return name ? `${name[1] ?? name[2]} is offline — turn it on or start Herdr there, then it reconnects.` : text;
}
