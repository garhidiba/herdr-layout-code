//! Scope -> VS Code's language name and comment tokens (language.cjs); the file-name lookup is the tokenizer's.

pub use vscode_textmate::scope_of;

const NAMES: &[(&str, &str)] = &[
    ("source.asp.vb.net", "Visual Basic"), ("source.batchfile", "Batch"), ("source.c", "C"), ("source.clojure", "Clojure"),
    ("source.coffee", "CoffeeScript"), ("source.cpp", "C++"), ("source.cs", "C#"), ("source.css", "CSS"), ("source.css.less", "Less"),
    ("source.css.scss", "SCSS"), ("source.cuda-cpp", "CUDA C++"), ("source.dart", "Dart"), ("source.diff", "Diff"),
    ("source.dockerfile", "Dockerfile"), ("source.dotenv", "Dotenv"), ("source.fsharp", "F#"), ("source.go", "Go"),
    ("source.groovy", "Groovy"), ("source.hlsl", "HLSL"), ("source.ignore", "Ignore"), ("source.ini", "Ini"), ("source.java", "Java"),
    ("source.js", "JavaScript"), ("source.js.jsx", "JavaScript JSX"), ("source.json", "JSON"), ("source.json.comments", "JSON with Comments"),
    ("source.json.lines", "JSON Lines"), ("source.julia", "Julia"), ("source.kotlin", "Kotlin"), ("source.lua", "Lua"),
    ("source.makefile", "Makefile"), ("source.objc", "Objective-C"), ("source.objcpp", "Objective-C++"), ("source.perl", "Perl"),
    ("source.perl.6", "Raku"), ("source.php", "PHP"), ("source.powershell", "PowerShell"), ("source.python", "Python"), ("source.r", "R"),
    ("source.rst", "reStructuredText"), ("source.ruby", "Ruby"), ("source.rust", "Rust"), ("source.shaderlab", "ShaderLab"),
    ("source.shell", "Shell Script"), ("source.sql", "SQL"), ("source.swift", "Swift"), ("source.toml", "TOML"), ("source.ts", "TypeScript"),
    ("source.tsx", "TypeScript JSX"), ("source.yaml", "YAML"), ("text.bibtex", "BibTeX"), ("text.csv", "CSV"), ("text.git-commit", "Git Commit Message"),
    ("text.git-rebase", "Git Rebase Message"), ("text.gitignore", "Ignore"), ("text.html.cshtml", "Razor"), ("text.html.derivative", "HTML"),
    ("text.html.basic", "HTML"), ("text.html.handlebars", "Handlebars"), ("text.html.markdown", "Markdown"), ("text.log", "Log"),
    ("text.pug", "Pug"), ("text.tex", "TeX"), ("text.tex.latex", "LaTeX"), ("text.tsv", "TSV"), ("text.wat", "WebAssembly Text"),
    ("text.xml", "XML"), ("text.xml.xsl", "XSL"),
];

/// The status bar's name; "source.foo-bar" -> "Foo Bar" for scopes without a table entry.
pub fn language_name(scope: Option<&str>) -> String {
    let Some(scope) = scope else { return "Plain Text".into() };
    if let Some((_, n)) = NAMES.iter().find(|(s, _)| *s == scope) {
        return n.to_string();
    }
    let rest = scope.strip_prefix("source.").or_else(|| scope.strip_prefix("text.")).unwrap_or(scope);
    let last = rest.split('.').next().unwrap_or("");
    last.split(['-', '_'])
        .map(|w| {
            let mut c = w.chars();
            c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

const LINE: &[(&str, &[&str])] = &[
    ("//", &["source.js", "source.js.jsx", "source.ts", "source.tsx", "source.go", "source.c", "source.cpp", "source.cuda-cpp", "source.cs",
        "source.java", "source.rust", "source.swift", "source.dart", "source.kotlin", "source.css.scss", "source.css.less", "source.php",
        "source.groovy", "source.fsharp", "source.json.comments", "source.objc", "source.objcpp", "source.hlsl", "source.shaderlab"]),
    ("#", &["source.python", "source.shell", "source.ruby", "source.perl", "source.perl.6", "source.r", "source.yaml", "source.toml",
        "source.dockerfile", "source.makefile", "source.powershell", "source.coffee", "source.julia", "source.dotenv", "source.ignore",
        "text.gitignore", "text.git-commit", "text.git-rebase"]),
    ("--", &["source.lua", "source.sql"]),
    (";", &["source.clojure", "source.ini"]),
    ("%", &["text.tex", "text.tex.latex", "text.bibtex"]),
    ("@REM", &["source.batchfile"]),
    ("'", &["source.asp.vb.net"]),
];
const BLOCK: &[(&str, &str, Option<&str>)] = &[
    ("source.css", "/*", Some("*/")), ("text.html.basic", "<!--", Some("-->")), ("text.html.derivative", "<!--", Some("-->")),
    ("text.xml", "<!--", Some("-->")), ("text.xml.xsl", "<!--", Some("-->")), ("text.html.markdown", "<!--", Some("-->")),
    ("text.html.handlebars", "{{!--", Some("--}}")), ("text.pug", "//-", None),
];

/// (open, close): a line comment has no close.
pub fn comment_of(scope: Option<&str>) -> Option<(&'static str, Option<&'static str>)> {
    let scope = scope?;
    if let Some((t, _)) = LINE.iter().find(|(_, s)| s.contains(&scope)) {
        return Some((t, None));
    }
    BLOCK.iter().find(|(s, _, _)| *s == scope).map(|(_, o, c)| (*o, *c))
}

/// Block comment pairs of the languages that have both line and block comments (VS Code's language-configuration.json
/// blockComment); the BLOCK languages use their own pair.
const BLOCK_PAIRS: &[((&str, &str), &[&str])] = &[
    (("/*", "*/"), &["source.js", "source.js.jsx", "source.ts", "source.tsx", "source.go", "source.c", "source.cpp", "source.cuda-cpp", "source.cs",
        "source.java", "source.rust", "source.swift", "source.dart", "source.kotlin", "source.css.scss", "source.css.less", "source.php",
        "source.groovy", "source.json", "source.json.comments", "source.objc", "source.objcpp", "source.hlsl", "source.shaderlab", "source.sql"]),
    (("(*", "*)"), &["source.fsharp"]),
    (("\"\"\"", "\"\"\""), &["source.python"]),
    (("=begin", "=end"), &["source.ruby"]),
    (("--[[", "]]"), &["source.lua"]),
    (("###", "###"), &["source.coffee"]),
    (("<#", "#>"), &["source.powershell"]),
    (("#=", "=#"), &["source.julia"]),
];

/// (open, close) for Toggle Block Comment, or None when the language has none.
pub fn block_comment_of(scope: Option<&str>) -> Option<(&'static str, &'static str)> {
    let scope = scope?;
    if let Some((_, o, c)) = BLOCK.iter().find(|(s, _, _)| *s == scope) {
        return c.map(|c| (*o, c));
    }
    BLOCK_PAIRS.iter().find(|(_, s)| s.contains(&scope)).map(|(p, _)| *p)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn block_comments_come_from_the_language() {
        assert_eq!(block_comment_of(Some("source.ts")), Some(("/*", "*/")));
        assert_eq!(block_comment_of(Some("text.html.basic")), Some(("<!--", "-->")));
        assert_eq!(block_comment_of(Some("source.python")), Some(("\"\"\"", "\"\"\"")));
        assert_eq!(block_comment_of(Some("text.pug")), None);
        assert_eq!(block_comment_of(Some("source.shell")), None);
    }

    #[test]
    fn names_and_comments() {
        assert_eq!(language_name(Some("source.tsx")), "TypeScript JSX");
        assert_eq!(language_name(Some("source.foo-bar.x")), "Foo Bar");
        assert_eq!(language_name(None), "Plain Text");
        assert_eq!(comment_of(Some("source.go")), Some(("//", None)));
        assert_eq!(comment_of(Some("source.css")), Some(("/*", Some("*/"))));
        assert_eq!(comment_of(Some("text.pug")), Some(("//-", None)));
        assert_eq!(comment_of(None), None);
    }
}
