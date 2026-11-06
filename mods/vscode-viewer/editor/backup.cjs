// Hot exit, like VS Code: unsaved text kept in <herdr home>/mods/vscode-viewer/.backups/<path hash>.json when the editor is
// closed from outside (tab closed, terminal gone), offered back the next time the file opens. Same format as main.js:
// { path, text, cursor: { line, col }, time (ms), mtimeMs, size } (mtimeMs/size: the file on disk when backed up, null if none).
const fs = require("fs");
const path = require("path");

const backupDir = () => process.env.VSEDIT_BACKUPS ?? path.join(__dirname, "..", ".backups");
// djb2-xor in base 36 — the same hash main.js uses for its image cache and backups.
const pathHash = (s) => { let h = 5381; for (const c of s) h = (h * 33 ^ c.charCodeAt(0)) >>> 0; return h.toString(36); };
const backupFile = (file) => path.join(backupDir(), `${pathHash(file)}.json`);

const diskStamp = (file) => { try { const st = fs.statSync(file); return { mtimeMs: st.mtimeMs, size: st.size }; } catch { return null; } };

// Synchronous: it runs from signal handlers right before exit.
function write(file, text, cursor) {
  const st = diskStamp(file), out = backupFile(file), tmp = `${out}.${process.pid}.tmp`;
  fs.mkdirSync(backupDir(), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify({ path: file, text, cursor, time: Date.now(), mtimeMs: st?.mtimeMs ?? null, size: st?.size ?? null }));
  fs.renameSync(tmp, out);
}

// The backup for this exact path, or null.
function read(file) {
  try { const b = JSON.parse(fs.readFileSync(backupFile(file), "utf8")); return b && b.path === file && typeof b.text === "string" ? b : null; } catch { return null; }
}

function remove(file) { try { fs.unlinkSync(backupFile(file)); } catch {} }

// True when the file on disk is no longer what it was when the backup was written. Compared to the second, since the
// viewer mod (main.js) only gets whole-second mtimes from stat.
function changedSince(b, file) {
  const st = diskStamp(file);
  return b.mtimeMs == null ? !!st : !st || Math.floor(st.mtimeMs / 1000) !== Math.floor(b.mtimeMs / 1000) || st.size !== b.size;
}

module.exports = { backupDir, backupFile, pathHash, write, read, remove, changedSince };
