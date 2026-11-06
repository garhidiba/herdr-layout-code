//! Document symbols (symbols.cjs): Go to Symbol in Editor and the breadcrumbs, as one flat list in document order, from
//! LSP textDocument/documentSymbol, tsserver's navtree, or a regex outline of the text. Positions are UTF-16 columns.

use crate::lang::edits::{p16, u16_of, P16};
use serde_json::Value;
use vscode_textmate::{OnigString, Scanner};

/// LSP SymbolKind (1-based) -> VS Code's name for it.
pub const KINDS: [&str; 27] = [
    "symbol", "file", "module", "namespace", "package", "class", "method", "property", "field", "constructor", "enum", "interface", "function", "variable",
    "constant", "string", "number", "boolean", "array", "object", "key", "null", "enum member", "struct", "event", "operator", "type parameter",
];

pub fn kind_name(v: &Value) -> String {
    v.as_u64().and_then(|k| KINDS.get(k as usize)).filter(|_| v.as_u64() != Some(0)).unwrap_or(&"symbol").to_string()
}

#[derive(Clone, Debug, PartialEq)]
pub struct Symbol {
    pub name: String,
    pub kind: String,
    pub detail: String,
    pub depth: usize,
    pub container: String,
    /// The whole declaration.
    pub range: (P16, P16),
    /// Where its name is.
    pub at: P16,
}

fn by_position(v: &mut [Symbol]) {
    v.sort_by(|a, b| a.at.cmp(&b.at));
}

/// An LSP Position.
pub fn lsp_pos(v: &Value) -> P16 {
    p16(v["line"].as_u64().unwrap_or(0) as usize, v["character"].as_u64().unwrap_or(0) as usize)
}

/// DocumentSymbol[] (hierarchical) or SymbolInformation[] (flat, with containerName) -> the list.
pub fn from_lsp(result: &Value) -> Vec<Symbol> {
    fn walk(list: &Value, depth: usize, container: Option<&str>, out: &mut Vec<Symbol>) {
        for s in list.as_array().into_iter().flatten() {
            let Some(name) = s["name"].as_str().filter(|n| !n.is_empty()) else { continue };
            let range = if s["range"].is_object() { &s["range"] } else { &s["location"]["range"] };
            if !range.is_object() {
                continue;
            }
            let sel = if s["selectionRange"].is_object() { &s["selectionRange"] } else { range };
            out.push(Symbol {
                name: name.into(),
                kind: kind_name(&s["kind"]),
                detail: s["detail"].as_str().unwrap_or("").into(),
                depth,
                container: container.or(s["containerName"].as_str()).unwrap_or("").into(),
                range: (lsp_pos(&range["start"]), lsp_pos(&range["end"])),
                at: lsp_pos(&sel["start"]),
            });
            walk(&s["children"], depth + 1, Some(name), out);
        }
    }
    let mut out = vec![];
    walk(result, 0, None, &mut out);
    by_position(&mut out);
    out
}

/// A tsserver 1-based { line, offset }.
pub fn ts_pos(v: &Value) -> P16 {
    p16((v["line"].as_u64().unwrap_or(1) as usize).saturating_sub(1), (v["offset"].as_u64().unwrap_or(1) as usize).saturating_sub(1))
}

/// tsserver navtree -> the list, as VS Code's TypeScript extension shows it: the root item, aliases (imports) and
/// unnamed <function>/<class> items left out.
pub fn from_navtree(tree: &Value) -> Vec<Symbol> {
    fn walk(items: &Value, depth: usize, container: &str, out: &mut Vec<Symbol>) {
        for it in items.as_array().into_iter().flatten() {
            let text = it["text"].as_str().unwrap_or("");
            let span = &it["spans"][0];
            let keep = it["kind"] != "alias" && !text.is_empty() && !(text.starts_with('<') && text.ends_with('>')) && span.is_object();
            if keep {
                let name = if it["nameSpan"].is_object() { &it["nameSpan"] } else { span };
                out.push(Symbol {
                    name: text.into(),
                    kind: it["kind"].as_str().unwrap_or("").into(),
                    detail: String::new(),
                    depth,
                    container: container.into(),
                    range: (ts_pos(&span["start"]), ts_pos(&span["end"])),
                    at: ts_pos(&name["start"]),
                });
            }
            walk(&it["childItems"], if keep { depth + 1 } else { depth }, if keep { text } else { container }, out);
        }
    }
    let mut out = vec![];
    walk(&tree["childItems"], 0, "", &mut out);
    by_position(&mut out);
    out
}

/// Where VS Code's TypeScript reference CodeLens go (typescript.referencesCodeLens with showOnAllFunctions): named
/// functions, classes, interfaces, types and enums, enum members, members of classes / interfaces / types (not one
/// starting where its parent does), exported variables. The names' positions in order, from tsserver's navtree.
pub fn lenses_from_navtree(tree: &Value) -> Vec<P16> {
    fn want(it: &Value, parent: Option<&Value>) -> bool {
        let pk = parent.and_then(|p| p["kind"].as_str()).unwrap_or("");
        if pk == "enum" {
            return true;
        }
        match it["kind"].as_str().unwrap_or("") {
            "function" => it["nameSpan"].is_object(),
            "const" | "let" | "var" => it["kindModifiers"].as_str().unwrap_or("").split([',', ' ']).any(|m| m == "export"),
            "class" => it["text"] != "<class>",
            "interface" | "type" | "enum" => true,
            "method" | "getter" | "setter" | "constructor" | "property" => {
                let same = parent.is_some_and(|p| p["spans"][0]["start"].is_object() && p["spans"][0]["start"] == it["spans"][0]["start"]);
                matches!(pk, "class" | "interface" | "type") && !same
            }
            _ => false,
        }
    }
    fn walk(it: &Value, parent: Option<&Value>, out: &mut Vec<P16>) {
        let start = if it["nameSpan"].is_object() { &it["nameSpan"]["start"] } else { &it["spans"][0]["start"] };
        if start.is_object() && want(it, parent) {
            let p = ts_pos(start);
            if !out.contains(&p) {
                out.push(p);
            }
        }
        for child in it["childItems"].as_array().into_iter().flatten() {
            walk(child, Some(it), out);
        }
    }
    let mut out = vec![];
    for it in tree["childItems"].as_array().into_iter().flatten() {
        walk(it, None, &mut out);
    }
    out.sort();
    out
}

const MODIFIERS: &str = r"(?:(?:export|default|public|private|protected|internal|static|async|abstract|final|override|open|pub(?:\([^)]*\))?|unsafe|extern|inline|virtual|sealed|partial|data|suspend)\s+)*";
const KEYWORDS: &str = r"(class|struct|interface|trait|enum|impl|module|namespace|protocol|extension|object|type|function|func|fn|def|fun|sub|proc|macro_rules!)";
const NAME: &str = r"([\p{L}_$][\p{L}\p{N}_$]*(?:(?:\.|::)[\p{L}_$][\p{L}\p{N}_$]*)*)";

fn kind_of(keyword: &str) -> &'static str {
    match keyword {
        "class" | "impl" | "extension" => "class",
        "struct" => "struct",
        "interface" | "trait" | "protocol" => "interface",
        "enum" => "enum",
        "module" => "module",
        "namespace" => "namespace",
        "object" => "object",
        "type" => "type",
        _ => "function",
    }
}

fn indent_of(t: &str) -> usize {
    t.chars().take_while(|c| *c == ' ' || *c == '\t').map(|c| if c == '\t' { 4 } else { 1 }).sum()
}

/// A regex outline of functions, classes and the like. A declaration's range runs to the line before the next non-blank
/// line indented no deeper (its closing brace there, if any, included); nesting follows the ranges.
pub fn outline(lines: &[String]) -> Vec<Symbol> {
    let decl = format!(r"^(\s*){MODIFIERS}{KEYWORDS}\s*\*?\s+(?:\([^)]*\)\s*)?{NAME}");
    let arrow = r"^(\s*)(?:export\s+)?(?:const|let|var)\s+([\p{L}_$][\p{L}\p{N}_$]*)\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[\p{L}_$][\p{L}\p{N}_$]*\s*=>)";
    let closer = r"^\s*(?:[}\])]|end\b)";
    let (Ok(mut decl), Ok(mut arrow), Ok(mut closer)) = (Scanner::new(&[decl]), Scanner::new(&[arrow.into()]), Scanner::new(&[closer.into()])) else { return vec![] };
    let group = |m: &vscode_textmate::Match, k: usize, t: &str| -> Option<(usize, usize)> {
        m.captures.get(k).filter(|c| c.0 >= 0 && c.1 >= c.0).map(|c| (c.0 as usize, c.1 as usize)).filter(|(a, b)| t.get(*a..*b).is_some())
    };
    let mut found: Vec<Symbol> = vec![];
    for (line, t) in lines.iter().enumerate() {
        if found.len() >= 5000 {
            break;
        }
        if t.len() > 1000 {
            continue;
        }
        let s = OnigString::new(t.clone());
        let (lead, name, kind) = if let Some(m) = decl.find_next_match(&s, 0) {
            let (Some(l), Some(k), Some(n)) = (group(&m, 1, t), group(&m, 2, t), group(&m, 3, t)) else { continue };
            (l.1, &t[n.0..n.1], kind_of(&t[k.0..k.1]))
        } else if let Some(m) = arrow.find_next_match(&s, 0) {
            let (Some(l), Some(n)) = (group(&m, 1, t), group(&m, 2, t)) else { continue };
            (l.1, &t[n.0..n.1], "function")
        } else {
            continue;
        };
        let col = t[lead..].find(name).map_or(0, |i| i + lead);
        let indent = indent_of(t);
        let mut end = line;
        for (l, text) in lines.iter().enumerate().skip(line + 1) {
            if text.trim().is_empty() {
                continue;
            }
            if indent_of(text) <= indent {
                if closer.find_next_match(&OnigString::new(text.clone()), 0).is_some() {
                    end = l;
                }
                break;
            }
            end = l;
        }
        found.push(Symbol {
            name: name.into(),
            kind: kind.into(),
            detail: String::new(),
            depth: 0,
            container: String::new(),
            range: (p16(line, 0), p16(end, lines[end].encode_utf16().count())),
            at: p16(line, u16_of(t, col)),
        });
    }
    let mut open: Vec<(usize, String)> = vec![]; // (end line, name)
    for s in &mut found {
        while open.last().is_some_and(|o| o.0 < s.at.line) {
            open.pop();
        }
        s.depth = open.len();
        s.container = open.last().map_or(String::new(), |o| o.1.clone());
        open.push((s.range.1.line, s.name.clone()));
    }
    found
}

/// The symbols whose range holds `p`, outermost first (the breadcrumbs' symbol part).
pub fn symbol_path(items: &[Symbol], p: P16) -> Vec<&Symbol> {
    let mut chain: Vec<&Symbol> = vec![];
    for s in items {
        if s.range.0 <= p && p <= s.range.1 && chain.last().is_none_or(|c| s.depth > c.depth) {
            chain.push(s);
        }
    }
    chain
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn lines(text: &str) -> Vec<String> {
        text.split('\n').map(str::to_string).collect()
    }

    #[test]
    fn code_lens_positions_follow_the_typescript_rules() {
        let sp = |line: u64, offset: u64| json!({ "start": { "line": line, "offset": offset } });
        let tree = json!({ "kind": "script", "childItems": [
            { "text": "Shop", "kind": "class", "spans": [sp(1, 1)], "nameSpan": sp(1, 14), "childItems": [
                { "text": "constructor", "kind": "constructor", "spans": [sp(2, 3)] }, { "text": "buy", "kind": "method", "spans": [sp(3, 3)], "nameSpan": sp(3, 3) }] },
            { "text": "greet", "kind": "function", "spans": [sp(5, 1)], "nameSpan": sp(5, 17) },
            { "text": "x", "kind": "const", "kindModifiers": "", "spans": [sp(7, 1)], "nameSpan": sp(7, 7) },
            { "text": "y", "kind": "const", "kindModifiers": "export", "spans": [sp(8, 1)], "nameSpan": sp(8, 14) },
            { "text": "o", "kind": "const", "kindModifiers": "", "spans": [sp(9, 1)], "nameSpan": sp(9, 7), "childItems": [{ "text": "m", "kind": "method", "spans": [sp(9, 12)] }] }] });
        assert_eq!(lenses_from_navtree(&tree), vec![p16(0, 13), p16(1, 2), p16(2, 2), p16(4, 16), p16(7, 13)]);
    }

    #[test]
    fn the_outline_nests_declarations_by_indentation() {
        let src = lines("export class Shop {\n  buy(n) {}\n  async function pay() {\n    return 1;\n  }\n}\nconst add = (a, b) => a + b;\npub fn main() {\n}");
        let o = outline(&src);
        let names: Vec<(&str, &str, usize, &str)> = o.iter().map(|s| (s.name.as_str(), s.kind.as_str(), s.depth, s.container.as_str())).collect();
        assert_eq!(names, [("Shop", "class", 0, ""), ("pay", "function", 1, "Shop"), ("add", "function", 0, ""), ("main", "function", 0, "")]);
        assert_eq!(o[0].range, (p16(0, 0), p16(5, 1)));
        assert_eq!(o[1].at, p16(2, 17));
        let path: Vec<&str> = symbol_path(&o, p16(3, 4)).iter().map(|s| s.name.as_str()).collect();
        assert_eq!(path, ["Shop", "pay"]);
    }

    #[test]
    fn lsp_and_navtree_symbols_flatten_in_document_order() {
        let r = |l: u64, c: u64, el: u64, ec: u64| json!({ "start": { "line": l, "character": c }, "end": { "line": el, "character": ec } });
        let lsp = json!([{ "name": "A", "kind": 5, "range": r(0, 0, 9, 1), "selectionRange": r(0, 6, 0, 7), "children": [{ "name": "m", "kind": 6, "range": r(2, 2, 3, 3) }] }]);
        let got = from_lsp(&lsp);
        assert_eq!((got[0].kind.as_str(), got[1].container.as_str(), got[1].depth, got[0].at), ("class", "A", 1, p16(0, 6)));
        let sp = |l: u64, o: u64, el: u64, eo: u64| json!({ "start": { "line": l, "offset": o }, "end": { "line": el, "offset": eo } });
        let tree = json!({ "text": "\"f\"", "kind": "module", "childItems": [
            { "text": "x", "kind": "alias", "spans": [sp(1, 1, 1, 9)] },
            { "text": "Shop", "kind": "class", "spans": [sp(2, 1, 4, 2)], "nameSpan": sp(2, 7, 2, 11), "childItems": [{ "text": "buy", "kind": "method", "spans": [sp(3, 3, 3, 9)] }] },
            { "text": "<function>", "kind": "function", "spans": [sp(5, 1, 5, 9)] }] });
        let got = from_navtree(&tree);
        let names: Vec<(&str, usize, &str)> = got.iter().map(|s| (s.name.as_str(), s.depth, s.container.as_str())).collect();
        assert_eq!(names, [("Shop", 0, ""), ("buy", 1, "Shop")]);
        assert_eq!(got[0].at, p16(1, 6));
    }
}
