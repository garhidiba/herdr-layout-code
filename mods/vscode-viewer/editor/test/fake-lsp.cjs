#!/usr/bin/env node
// A stand-in language server for tests: `node fake-lsp.cjs <name> [args...]` answers initialize and publishes one error
// diagnostic for each opened or changed document, its message naming the server and its arguments (so a test sees which
// table entry started it, and how).
const [name, ...args] = process.argv.slice(2);
let buf = Buffer.alloc(0);
const send = (m) => { const body = JSON.stringify({ jsonrpc: "2.0", ...m }); process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`); };
const publish = (uri) => send({ method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [
  { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, source: name, message: `fake ${[name, ...args].join(" ")}` },
] } });
function onMessage(m) {
  if (m.method === "initialize") send({ id: m.id, result: { capabilities: { textDocumentSync: 1 } } });
  else if (m.method === "shutdown") send({ id: m.id, result: null });
  else if (m.method === "exit") process.exit(0);
  else if (m.method === "textDocument/didOpen" || m.method === "textDocument/didChange") publish(m.params.textDocument.uri);
  else if (m.id !== undefined && m.method) send({ id: m.id, result: null });
}
process.stdin.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    const end = buf.indexOf("\r\n\r\n");
    if (end < 0) return;
    const len = Number(/Content-Length: *(\d+)/i.exec(buf.subarray(0, end).toString())?.[1]);
    if (buf.length < end + 4 + len) return;
    const body = buf.subarray(end + 4, end + 4 + len).toString();
    buf = buf.subarray(end + 4 + len);
    onMessage(JSON.parse(body));
  }
});
process.stdin.on("end", () => process.exit(0));
