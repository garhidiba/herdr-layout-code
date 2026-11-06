// Preloaded into `node tokenize.cjs` (node -r) by parity.mjs: records the rule stack after the last
// tokenizeLine2 call and writes its frames on exit to the file named by $TEXTMATE_STACK_OUT, as
// [[ruleId, endRule, scopes, attrs], ...] root first (the fields StateStack.equals compares), or null.
// (A file, not stderr: writes to a pipe are asynchronous on macOS and get cut off at exit.)
// tokenize.cjs itself runs unchanged.
const fs = require("fs");
const Module = require("module");
const load = Module._load;
let last = null;
Module._load = function (request, parent, isMain) {
  const exports = load.apply(this, arguments);
  if (/lib[\\/]textmate\.js$/.test(request) && !exports.__stackHook) {
    exports.__stackHook = true;
    const loadGrammar = exports.Registry.prototype.loadGrammar;
    exports.Registry.prototype.loadGrammar = async function (...args) {
      const g = await loadGrammar.apply(this, args);
      if (g) {
        const tokenize = g.tokenizeLine2.bind(g);
        g.tokenizeLine2 = (...a) => { const r = tokenize(...a); last = r.ruleStack; return r; };
      }
      return g;
    };
  }
  return exports;
};
process.on("exit", () => {
  const frames = [];
  for (let s = last; s; s = s.parent) {
    const c = s.contentNameScopesList;
    frames.unshift([s.ruleId, s.endRule ?? null, c.getScopeNames().join(" "), c.tokenAttributes]);
  }
  fs.writeFileSync(process.env.TEXTMATE_STACK_OUT, JSON.stringify(last ? frames : null));
});
