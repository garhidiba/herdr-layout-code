//! Tokenizer timing for tests/bench.mjs. For each file: load the grammar the way the viewer does (a new registry
//! per file), tokenize every line twice (the first pass also compiles the regexes, the second is "warm") and print
//! the times as JSON. Lines over 4,000 UTF-16 units are skipped as in tokenize.cjs, or with --chunked tokenized in
//! ~1,000-unit pieces carrying the rule stack as the editor's LongLine does; --whole tokenizes them in one call.
//!
//! --cold stops after the first pass (a whole cold run, timed from outside).
//!
//!   cargo run --release -p vscode-textmate --example bench -- --vscode <dir> [--chunked | --whole] [--cold] [--max-lines N] <file>...

use std::path::Path;
use std::time::{Duration, Instant};
use vscode_textmate::{scope_of, split_lines, viewer, Grammar, StateStack};

const MAX_LINE: usize = 4000;
const CHUNK: usize = 1000;

/// highlight.cjs's `cutAt` on UTF-16 units: after the last `;`/`}` (else `,`/space) in the piece's second half.
fn cut_at(text: &[u16], pos: usize) -> usize {
    if text.len() - pos <= CHUNK {
        return text.len();
    }
    let piece = &text[pos + CHUNK / 2..pos + CHUNK];
    let last = |c: u8| piece.iter().rposition(|&u| u == c as u16);
    let k = last(b';').max(last(b'}')).or_else(|| last(b',').max(last(b' ')));
    let mut end = k.map_or(pos + CHUNK, |k| pos + CHUNK / 2 + k + 1);
    if (0xd800..=0xdbff).contains(&text[end - 1]) {
        end += 1;
    }
    end
}

fn pass(g: &mut Grammar, lines: &[&str], mode: &str) -> Result<usize, String> {
    let (mut stack, mut tokens): (Option<StateStack>, usize) = (None, 0);
    for line in lines {
        let units: Vec<u16> = line.encode_utf16().collect();
        if units.len() <= MAX_LINE || mode == "whole" {
            let r = g.tokenize_line2(line, stack.as_ref(), Duration::ZERO)?;
            tokens += r.tokens.len() / 2;
            stack = Some(r.rule_stack);
        } else if mode == "chunked" {
            let mut pos = 0;
            while pos < units.len() {
                let end = cut_at(&units, pos);
                let r = g.tokenize_line2(&String::from_utf16_lossy(&units[pos..end]), stack.as_ref(), Duration::ZERO)?;
                tokens += r.tokens.len() / 2;
                stack = Some(r.rule_stack);
                pos = end;
            }
        }
    }
    Ok(tokens)
}

fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let flag = |name: &str| args.iter().position(|a| a == name).map(|i| args[i + 1].clone());
    let vscode = flag("--vscode").ok_or("--vscode <dir> is required")?;
    let max_lines: usize = flag("--max-lines").map_or(8000, |n| n.parse().unwrap_or(8000));
    let mode = if args.iter().any(|a| a == "--chunked") { "chunked" } else if args.iter().any(|a| a == "--whole") { "whole" } else { "skip" };
    let mut skip_next = false;
    let mut out = vec![];
    for a in &args {
        if std::mem::take(&mut skip_next) || a.starts_with("--") {
            skip_next = matches!(a.as_str(), "--vscode" | "--max-lines");
            continue;
        }
        let text = String::from_utf8_lossy(&std::fs::read(a).map_err(|e| format!("{a}: {e}"))?).into_owned();
        let lines: Vec<&str> = split_lines(&text).into_iter().take(max_lines).collect();
        let t = Instant::now();
        let mut v = viewer(Path::new(&vscode))?;
        let name = Path::new(a).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let Some(mut g) = scope_of(&v.index, &name).and_then(|s| v.registry.load_grammar(&s).transpose()).transpose()? else { continue };
        let load = t.elapsed();
        let t = Instant::now();
        let tokens = pass(&mut g, &lines, mode)?;
        let first = t.elapsed();
        if args.iter().any(|a| a == "--cold") {
            continue;
        }
        let t = Instant::now();
        pass(&mut g, &lines, mode)?;
        let warm = t.elapsed();
        let ms = |d: Duration| d.as_secs_f64() * 1000.0;
        out.push(serde_json::json!({ "file": a, "lines": lines.len(), "tokens": tokens, "loadMs": ms(load), "firstMs": ms(first), "warmMs": ms(warm) }));
    }
    println!("{}", serde_json::Value::Array(out));
    Ok(())
}
