//! Markdown and HTML preview beside the editor (mdpreview.cjs; VS Code's Open Preview to the Side / Toggle Preview): a
//! terminal can't draw rich text, so the preview is the vscode-viewer mod (`{file, preview: true | "html"}`) in a pane
//! right of the editor's, through herdr-app. Which viewer panes show a file: the shared value vscode-viewer.files
//! (`{[pane]: {file, on}}`, saved in <herdr home>/shared.json); a pane that closed may linger there, so one counts only
//! once `pane.focus` lands on it (`herdr-app status`'s focused_pane).

use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};

pub const MARKDOWN: &str = "text.html.markdown";
pub const HTML: [&str; 2] = ["text.html.basic", "text.html.derivative"];
pub const REMOTE: &str = "Preview: open from the Explorer on this computer";

/// The viewer's preview prop for a language: true (Markdown), "html" (the viewer converts it: vscode-viewer/html.js).
pub fn preview_of(scope: Option<&str>) -> Option<Value> {
    match scope? {
        MARKDOWN => Some(Value::Bool(true)),
        s if HTML.contains(&s) => Some("html".into()),
        _ => None,
    }
}

/// $HC_TERMINAL_ID and herdr-app's path when this editor runs in Herdr on this computer (not on a remote machine, nor
/// outside Herdr).
fn herdr_app() -> Option<(String, PathBuf)> {
    Some((std::env::var("HC_TERMINAL_ID").ok()?, crate::term::which("herdr-app")?))
}

/// HTML: Open in Default Browser's program and its arguments before the file, per platform.
pub fn opener(os: &str) -> &'static [&'static str] {
    match os {
        "macos" => &["open"],
        "windows" => &["cmd", "/c", "start", ""],
        _ => &["xdg-open"],
    }
}

/// HTML: Open in Default Browser: the platform's opener on `file`; Err(message) on a remote machine (its browser isn't
/// this computer's) or when the opener is missing.
pub fn open_in_browser(file: &str) -> Result<(), String> {
    herdr_app().ok_or("Open in Browser: only for files on this computer")?;
    let [cmd, args @ ..] = opener(std::env::consts::OS) else { unreachable!() };
    let argv: Vec<&str> = args.iter().copied().chain([file]).collect();
    crate::errorpage::launch(cmd, &argv).then_some(()).ok_or(format!("Open in Browser: {cmd} not found"))
}

/// The local viewer panes that show `file`, from shared.json's text (anything unreadable: none).
pub fn viewer_panes(shared_text: &str, file: &str) -> Vec<String> {
    let Ok(v) = serde_json::from_str::<Value>(shared_text) else { return vec![] };
    let Some(files) = v.get("vscode-viewer.files").and_then(Value::as_object) else { return vec![] };
    files
        .iter()
        .filter(|(_, e)| e.get("file").and_then(Value::as_str) == Some(file) && e.get("on").is_none_or(Value::is_null))
        .map(|(pane, _)| pane.clone())
        .collect()
}

/// `herdr(args)` -> herdr-app's stdout. toggle: a shown preview closes (focus back to the editor), else one opens;
/// otherwise a shown preview is focused, else one opens and the editor keeps focus. -> "closed" | "focused" | "opened".
pub fn show_preview(file: &str, preview: &Value, terminal: &str, toggle: bool, shared_text: &str, herdr: &dyn Fn(&[&str]) -> String) -> &'static str {
    let focused_pane = || serde_json::from_str::<Value>(&herdr(&["status"])).ok().and_then(|v| v.get("focused_pane")?.as_str().map(String::from));
    let editor = || herdr(&["do", "pane.focus", "--terminal", terminal]);
    for pane in viewer_panes(shared_text, file) {
        herdr(&["do", "pane.focus", "--pane", &pane]);
        if focused_pane().as_deref() != Some(pane.as_str()) {
            continue;
        }
        if !toggle {
            return "focused";
        }
        herdr(&["do", "pane.close", "--pane", &pane]);
        editor();
        return "closed";
    }
    editor(); // pane.split splits the focused pane
    let split = json!({ "direction": "right", "mod": "vscode-viewer", "props": { "file": file, "preview": preview } }).to_string();
    herdr(&["do", "pane.split", &split]);
    editor();
    "opened"
}

/// One preview request at a time.
static BUSY: AtomicBool = AtomicBool::new(false);

/// Runs show_preview on a thread with the real herdr-app; Err(message) when there is none here (a remote machine, or
/// outside Herdr).
pub fn spawn(file: String, preview: Value, toggle: bool) -> Result<(), &'static str> {
    let Some((terminal, bin)) = herdr_app() else { return Err(REMOTE) };
    if BUSY.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let shared_text = std::fs::read_to_string(crate::settings::herdr_home().join("shared.json")).unwrap_or_default();
    std::thread::spawn(move || {
        let herdr = |args: &[&str]| {
            let out = Command::new(&bin).args(args).stdin(Stdio::null()).stderr(Stdio::null()).output();
            out.map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default()
        };
        show_preview(&file, &preview, &terminal, toggle, &shared_text, &herdr);
        BUSY.store(false, Ordering::SeqCst);
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// A fake herdr-app where the `live` panes exist and pane.focus moves the focus (an unknown pane: no move).
    fn run(live: &[&str], toggle: bool, shared: &str) -> (&'static str, Vec<String>) {
        let calls = RefCell::new(vec![]);
        let focus = RefCell::new("pEditor".to_string());
        let herdr = |args: &[&str]| {
            calls.borrow_mut().push(args.join(" "));
            if args[0] == "status" {
                return json!({ "focused_pane": *focus.borrow() }).to_string();
            }
            if args[1] == "pane.focus" {
                if args[2] == "--terminal" {
                    *focus.borrow_mut() = "pEditor".into();
                } else if live.contains(&args[3]) {
                    *focus.borrow_mut() = args[3].into();
                }
            }
            r#"{"ok":true}"#.into()
        };
        let r = show_preview("/r/x.md", &Value::Bool(true), "t1", toggle, shared, &herdr);
        (r, calls.into_inner())
    }
    fn shared_of(files: Value) -> String {
        json!({ "vscode-viewer.files": files }).to_string()
    }

    #[test]
    fn viewer_panes_are_the_local_ones_showing_the_file() {
        let text = shared_of(json!({ "a": { "file": "/r/x.md", "on": null }, "b": { "file": "/r/y.md", "on": null }, "c": { "file": "/r/x.md", "on": "box" } }));
        assert_eq!(viewer_panes(&text, "/r/x.md"), vec!["a"]);
        assert!(viewer_panes("{oops", "/r/x.md").is_empty());
        assert!(viewer_panes("{}", "/r/x.md").is_empty());
    }

    #[test]
    fn with_no_preview_shown_one_opens_right_of_the_editor_which_keeps_focus() {
        let (r, calls) = run(&[], true, &shared_of(json!({ "gone": { "file": "/r/x.md", "on": null } })));
        assert_eq!(r, "opened");
        assert_eq!(
            calls,
            [
                "do pane.focus --pane gone",
                "status",
                "do pane.focus --terminal t1",
                r#"do pane.split {"direction":"right","mod":"vscode-viewer","props":{"file":"/r/x.md","preview":true}}"#,
                "do pane.focus --terminal t1"
            ]
        );
    }

    #[test]
    fn a_shown_preview_is_focused_by_open_to_the_side_and_closed_by_toggle() {
        let shared = shared_of(json!({ "p9": { "file": "/r/x.md", "on": null } }));
        assert_eq!(run(&["p9"], false, &shared), ("focused", vec!["do pane.focus --pane p9".to_string(), "status".into()]));
        let (r, calls) = run(&["p9"], true, &shared);
        assert_eq!(r, "closed");
        assert_eq!(calls[2..], ["do pane.close --pane p9", "do pane.focus --terminal t1"]);
    }

    #[test]
    fn an_html_files_preview_asks_the_viewer_to_render_it_as_html() {
        assert_eq!(preview_of(Some(MARKDOWN)), Some(json!(true)));
        assert_eq!(preview_of(Some("text.html.basic")), Some(json!("html")));
        assert_eq!(preview_of(Some("text.html.derivative")), Some(json!("html")));
        assert_eq!(preview_of(Some("source.js")), None);
        assert_eq!(preview_of(None), None);
        let calls = RefCell::new(vec![]);
        let herdr = |args: &[&str]| {
            calls.borrow_mut().push(args.join(" "));
            String::new()
        };
        assert_eq!(show_preview("/r/x.html", &json!("html"), "t1", false, "{}", &herdr), "opened");
        assert_eq!(calls.borrow()[1], r#"do pane.split {"direction":"right","mod":"vscode-viewer","props":{"file":"/r/x.html","preview":"html"}}"#);
    }

    #[test]
    fn the_browser_opener_is_the_platforms() {
        assert_eq!(opener("macos"), ["open"]);
        assert_eq!(opener("linux"), ["xdg-open"]);
        assert_eq!(opener("windows"), ["cmd", "/c", "start", ""]);
    }
}
