//! A port of vscode-textmate 9.3.2 (with vscode-oniguruma 1.7.0's scanner semantics) to Rust: TextMate grammars,
//! VS Code themes, `tokenizeLine2` tokens with the same encoded metadata and color ids as the JS.

mod file;
mod grammar;
mod matcher;
mod onig;
mod raw;
mod registry;
mod rule;
mod theme;

pub use file::{scope_of, split_lines, tokenize_file, viewer, Viewer};
pub use grammar::{Grammar, StateStack, TokenizeLineResult2};
pub use raw::{parse_jsonc, parse_raw_grammar};
pub use registry::{Loader, Registry};
