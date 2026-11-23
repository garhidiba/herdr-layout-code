// A stand-in for the app's gpui-kit and gpui-base, so tests can drive sheet.js: builders record their calls and
// children, nothing draws. Load it with `register("./gpui-loader.mjs", import.meta.url)` before importing a view.
const el = () => {
  const node = { calls: [], kids: [] };
  const p = new Proxy(node, {
    get(t, k) {
      if (k in t || typeof k === "symbol") return t[k];
      return (...a) => {
        if (k === "when") return a[0] ? (a[1](p) ?? p) : p;
        if (k === "child") t.kids.push(a[0]);
        else if (k === "children") t.kids.push(...a[0]);
        else t.calls.push([k, ...a]);
        return p;
      };
    },
  });
  return p;
};
export const div = el, h_flex = el, v_flex = el;
export const Input = { new: () => el() };
export const InputState = {
  new: ({ value = "" } = {}) => {
    let v = value;
    const on = {};
    return { on: (e, h) => { on[e] = h; return true; }, handlers: on, value: () => v, set_value: (x) => { v = x; },
      set_selected_range() {}, focus() {}, release() { return true; } };
  },
};

// Every string drawn in a tree, in order.
export const texts = (n) => (typeof n === "string" ? [n] : n?.kids ? n.kids.flatMap(texts) : []);
// The handler `name` of the element with id `id` in a tree.
export function handler(n, id, name = "on_click") {
  if (!n?.calls) return null;
  if (n.calls.some(([k, v]) => k === "id" && v === id)) return n.calls.find(([k]) => k === name)?.at(-1) ?? null;
  for (const k of n.kids) { const h = handler(k, id, name); if (h) return h; }
  return null;
}

// A Context for handlers: spawned tasks run to the end before `cx.idle()` resolves. As in the app, a spawned body runs
// at once in the caller's call up to its first await, and `cx.notify()` throws while `cx.rendering(fn)` runs a render.
export function fakeCx() {
  const tasks = [];
  let inRender = false;
  const cx = {
    notified: 0, clip: null,
    notify() {
      if (inRender) throw new TypeError("cx.notify() is not allowed during the `render` phase; request a re-render from an event handler instead");
      cx.notified++;
    },
    rendering(fn) { inRender = true; try { return fn(); } finally { inRender = false; } },
    stop_propagation() {}, focus_handle: () => ({ focus() {} }),
    timer: { after() {} }, sleep: async () => {},
    spawn(fn) { tasks.push(fn(cx)); },
    write_to_clipboard(t) { cx.clip = t; }, read_from_clipboard: () => cx.clip,
    idle: async () => { while (tasks.length) await tasks.shift(); },
  };
  return cx;
}
