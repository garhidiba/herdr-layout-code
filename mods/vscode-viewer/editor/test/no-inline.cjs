// Required first by tests that build editors without asking for inline suggestions: their default settings turn the
// provider off, so typing never reaches a real model (Ollama on this machine). inline.test.cjs uses a stub instead.
const S = require("../settings.cjs");
const normalize = S.normalize;
S.normalize = (raw = {}) => normalize({ "editor.inlineSuggest.provider": "off", ...raw });
