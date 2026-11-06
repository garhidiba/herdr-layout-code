// Line diff for the diff view: Myers' algorithm over interned lines, and VS Code-style folding of unchanged lines.
// No imports, so plain Node can test it.

// Lines as the tokenizer splits them, without the empty one after a final newline.
export function splitLines(text) {
  if (!text) return [];
  const lines = text.split(/\r\n|\r|\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// Ops in file order: { t: " ", o, n } (same), { t: "-", o } (removed), { t: "+", n } (added); o/n are 0-based line indexes.
// Past `limit` edits the middle is shown as removed then added: still a correct diff, just not the smallest.
export function diffLines(a, b, limit = 2000) {
  const ids = new Map(), id = (s) => { let v = ids.get(s); if (v === undefined) ids.set(s, v = ids.size); return v; };
  const x = a.map(id), y = b.map(id);
  let start = 0, endA = x.length, endB = y.length;
  while (start < endA && start < endB && x[start] === y[start]) start++;
  while (endA > start && endB > start && x[endA - 1] === y[endB - 1]) { endA--; endB--; }
  const ops = [];
  for (let i = 0; i < start; i++) ops.push({ t: " ", o: i, n: i });
  const middle = myers(x.slice(start, endA), y.slice(start, endB), limit);
  if (middle) for (const op of middle) ops.push({ t: op.t, o: op.o === undefined ? undefined : op.o + start, n: op.n === undefined ? undefined : op.n + start });
  else {
    for (let i = start; i < endA; i++) ops.push({ t: "-", o: i });
    for (let j = start; j < endB; j++) ops.push({ t: "+", n: j });
  }
  for (let i = endA, j = endB; i < x.length; i++, j++) ops.push({ t: " ", o: i, n: j });
  return removedFirst(ops);
}

// Myers' O((N+M)D) diff; keeps each step's frontier (only its 2d+1 diagonals) to walk back the path. Null past `limit` steps.
function myers(a, b, limit) {
  const n = a.length, m = b.length, max = n + m, off = max + 1, v = new Int32Array(2 * max + 3), trace = [];
  for (let d = 0; d <= max; d++) {
    if (d > limit) return null;
    trace.push(v.slice(off - d, off + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let i = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1, j = i - k;
      while (i < n && j < m && a[i] === b[j]) { i++; j++; }
      v[off + k] = i;
      if (i >= n && j >= m) return backtrack(trace, n, m);
    }
  }
  return [];
}

function backtrack(trace, n, m) {
  const ops = [];
  let i = n, j = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const prev = trace[d], k = i - j, at = (kk) => prev[kk + d];
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1)), pk = down ? k + 1 : k - 1, pi = at(pk), pj = pi - pk;
    while (i > pi && j > pj) ops.push({ t: " ", o: --i, n: --j });
    if (down) ops.push({ t: "+", n: --j }); else ops.push({ t: "-", o: --i });
  }
  while (i > 0 && j > 0) ops.push({ t: " ", o: --i, n: --j });
  return ops.reverse();
}

// Within each run of changes, removed lines come before added ones, as VS Code shows them.
function removedFirst(ops) {
  const out = [];
  for (let i = 0; i < ops.length;) {
    if (ops[i].t === " ") { out.push(ops[i++]); continue; }
    const run = [];
    while (i < ops.length && ops[i].t !== " ") run.push(ops[i++]);
    out.push(...run.filter((op) => op.t === "-"), ...run.filter((op) => op.t === "+"));
  }
  return out;
}

// What the view lists: every change with `context` unchanged lines around it; longer unchanged runs (at least
// `minFold` lines) become one { fold: start, count } row unless `open` has their start. Other rows are { op }.
export function visibleRows(ops, open = new Set(), context = 3, minFold = 3) {
  const near = new Uint8Array(ops.length);
  ops.forEach((op, i) => { if (op.t !== " ") for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) near[k] = 1; });
  const rows = [];
  for (let i = 0; i < ops.length;) {
    if (near[i]) { rows.push({ op: ops[i++] }); continue; }
    let end = i;
    while (end < ops.length && !near[end]) end++;
    if (end - i < minFold || open.has(i)) for (let k = i; k < end; k++) rows.push({ op: ops[k] });
    else rows.push({ fold: i, count: end - i });
    i = end;
  }
  return rows;
}
