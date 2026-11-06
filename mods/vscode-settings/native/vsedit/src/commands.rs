//! Editor commands (commands.cjs): ids, titles and default keys per OS from the shared table
//! mods/vscode-viewer/editor/keymap.json, and what each runs here (`act_of`, commands.cjs's RUNS); user keybindings
//! (keybindings.cjs): <herdr home>/vscode-keybindings.json in VS Code's format, two-step chords included, where "-id"
//! removes a default; the last binding of a key wins.

use crate::file::disk_stamp;
use crate::settings::herdr_home;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// What a command does in the editor.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Act {
    /// A language feature, the context menu or the command palette: phase 3, still JS-only.
    Lang,
    Copy(bool),
    Paste,
    QuickOpen,
    Save,
    ToggleAutoSave,
    AskAutoSaveDelay,
    OpenSettingsUi(bool),
    OpenSettingsJson,
    OpenKeybindingsJson,
    Quit,
    Undo,
    Redo,
    SelectAll,
    /// None toggles; Some(true) adds line comments, Some(false) removes them.
    Comment(Option<bool>),
    TrimTrailing,
    SelectNextOccurrence,
    OpenFind(bool),
    ToggleFind(FindOption),
    ReplaceOne,
    ReplaceAll,
    FindAgain(i32),
    GotoLine,
    DeleteLines,
    MoveLines(i32),
    CopyLines(i32),
    InsertLine(bool),
    IndentLines(bool),
    Navigate(i32),
    PickTabSize(bool),
    PickEol,
    PickLanguage,
    GotoChange(i32),
    Fold,
    Unfold,
    ToggleFold,
    FoldAll,
    UnfoldAll,
    /// (dir, extend, word)
    Horizontal(i32, bool, bool),
    /// (rows, extend)
    Vertical(i32, bool),
    Home(bool),
    /// (end, extend)
    LineEdge(bool, bool),
    DocEdge(bool, bool),
    Page(i32, bool),
    ScrollLine(i32),
    Backspace(bool),
    DeleteForward(bool),
    DeleteAll(i32),
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum FindOption {
    Case,
    Word,
    Regex,
}

/// What each command id runs (commands.cjs's RUNS); None for an id the editor doesn't know.
pub fn act_of(id: &str) -> Option<Act> {
    use Act::*;
    Some(match id {
        "editor.action.revealDefinition" | "editor.action.goToTypeDefinition" | "editor.action.goToImplementation" | "editor.action.goToReferences"
        | "editor.action.peekDefinition" | "editor.action.referenceSearch.trigger" | "editor.action.peekImplementation"
        | "editor.action.peekTypeDefinition" | "references-view.findReferences" | "references-view.findImplementations"
        | "references-view.showCallHierarchy" | "editor.action.rename" | "editor.action.changeAll" | "editor.action.formatDocument"
        | "editor.action.refactor" | "editor.action.sourceAction" | "workbench.action.showCommands" | "workbench.action.gotoSymbol"
        | "editor.action.marker.next" | "editor.action.marker.prev" | "editor.action.showContextMenu" => Lang,
        "editor.action.clipboardCutAction" => Copy(true),
        "editor.action.clipboardCopyAction" => Copy(false),
        "editor.action.clipboardPasteAction" => Paste,
        "workbench.action.quickOpen" => QuickOpen,
        "workbench.action.files.save" => Save,
        "workbench.action.files.toggleAutoSave" => ToggleAutoSave,
        "workbench.action.files.setAutoSaveDelay" => AskAutoSaveDelay,
        "workbench.action.openSettings" => OpenSettingsUi(false),
        "workbench.action.openSettingsJson" => OpenSettingsJson,
        "workbench.action.openGlobalKeybindings" => OpenSettingsUi(true),
        "workbench.action.openGlobalKeybindingsFile" => OpenKeybindingsJson,
        "workbench.action.closeActiveEditor" => Quit,
        "undo" => Undo,
        "redo" => Redo,
        "editor.action.selectAll" => SelectAll,
        "editor.action.commentLine" => Comment(None),
        "editor.action.addCommentLine" => Comment(Some(true)),
        "editor.action.removeCommentLine" => Comment(Some(false)),
        "editor.action.trimTrailingWhitespace" => TrimTrailing,
        "editor.action.addSelectionToNextFindMatch" => SelectNextOccurrence,
        "actions.find" => OpenFind(false),
        "editor.action.startFindReplaceAction" => OpenFind(true),
        "toggleFindCaseSensitive" => ToggleFind(FindOption::Case),
        "toggleFindWholeWord" => ToggleFind(FindOption::Word),
        "toggleFindRegex" => ToggleFind(FindOption::Regex),
        "editor.action.replaceOne" => ReplaceOne,
        "editor.action.replaceAll" => ReplaceAll,
        "editor.action.nextMatchFindAction" => FindAgain(1),
        "editor.action.previousMatchFindAction" => FindAgain(-1),
        "workbench.action.gotoLine" => GotoLine,
        "editor.action.deleteLines" => DeleteLines,
        "editor.action.moveLinesUpAction" => MoveLines(-1),
        "editor.action.moveLinesDownAction" => MoveLines(1),
        "editor.action.copyLinesUpAction" => CopyLines(-1),
        "editor.action.copyLinesDownAction" => CopyLines(1),
        "editor.action.insertLineAfter" => InsertLine(true),
        "editor.action.insertLineBefore" => InsertLine(false),
        "editor.action.indentLines" => IndentLines(false),
        "editor.action.outdentLines" => IndentLines(true),
        "workbench.action.navigateBack" => Navigate(-1),
        "workbench.action.navigateForward" => Navigate(1),
        "editor.action.indentUsingSpaces" => PickTabSize(false),
        "editor.action.indentUsingTabs" => PickTabSize(true),
        "workbench.action.editor.changeEOL" => PickEol,
        "workbench.action.editor.changeLanguageMode" => PickLanguage,
        "workbench.action.editor.nextChange" => GotoChange(1),
        "workbench.action.editor.previousChange" => GotoChange(-1),
        "editor.fold" => Fold,
        "editor.unfold" => Unfold,
        "editor.toggleFold" => ToggleFold,
        "editor.foldAll" => FoldAll,
        "editor.unfoldAll" => UnfoldAll,
        "cursorLeft" => Horizontal(-1, false, false),
        "cursorLeftSelect" => Horizontal(-1, true, false),
        "cursorRight" => Horizontal(1, false, false),
        "cursorRightSelect" => Horizontal(1, true, false),
        "cursorUp" => Vertical(-1, false),
        "cursorUpSelect" => Vertical(-1, true),
        "cursorDown" => Vertical(1, false),
        "cursorDownSelect" => Vertical(1, true),
        "cursorWordLeft" => Horizontal(-1, false, true),
        "cursorWordLeftSelect" => Horizontal(-1, true, true),
        "cursorWordEndRight" => Horizontal(1, false, true),
        "cursorWordEndRightSelect" => Horizontal(1, true, true),
        "cursorHome" => Home(false),
        "cursorHomeSelect" => Home(true),
        "cursorEnd" | "cursorLineEnd" => LineEdge(true, false),
        "cursorEndSelect" | "cursorLineEndSelect" => LineEdge(true, true),
        "cursorLineStart" => LineEdge(false, false),
        "cursorLineStartSelect" => LineEdge(false, true),
        "cursorTop" => DocEdge(false, false),
        "cursorTopSelect" => DocEdge(false, true),
        "cursorBottom" => DocEdge(true, false),
        "cursorBottomSelect" => DocEdge(true, true),
        "cursorPageUp" => Page(-1, false),
        "cursorPageUpSelect" => Page(-1, true),
        "cursorPageDown" => Page(1, false),
        "cursorPageDownSelect" => Page(1, true),
        "scrollLineUp" => ScrollLine(-1),
        "scrollLineDown" => ScrollLine(1),
        "deleteLeft" => Backspace(false),
        "deleteRight" => DeleteForward(false),
        "deleteWordLeft" => Backspace(true),
        "deleteWordRight" => DeleteForward(true),
        "deleteAllLeft" => DeleteAll(-1),
        "deleteAllRight" => DeleteAll(1),
        _ => return None,
    })
}

/// The OS whose keys are in effect: VSEDIT_OS (mac | win | linux), else the platform's.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Os {
    Mac,
    Win,
    Linux,
}

impl Os {
    pub fn current() -> Os {
        Os::pick(std::env::var("VSEDIT_OS").ok().as_deref())
    }
    fn pick(env: Option<&str>) -> Os {
        match env {
            Some("mac") => Os::Mac,
            Some("win") => Os::Win,
            Some("linux") => Os::Linux,
            _ if cfg!(target_os = "macos") => Os::Mac,
            _ if cfg!(windows) => Os::Win,
            _ => Os::Linux,
        }
    }
    fn key(self) -> &'static str {
        match self {
            Os::Mac => "mac",
            Os::Win => "win",
            Os::Linux => "linux",
        }
    }
}

pub struct Command {
    pub id: String,
    #[allow(dead_code)] // phase 3: the command palette and the context menu show titles
    pub title: String,
    /// Default keys (normalized) per OS: mac, win, linux.
    pub keys: [Vec<String>; 3],
    pub act: Act,
}

/// keymap.json's commands; an id with nothing to run is an error (the table and the editor are out of step).
pub fn parse_keymap(v: &Value) -> Result<Vec<Command>, String> {
    let list = v.get("commands").and_then(Value::as_array).ok_or("keymap.json: no commands")?;
    list.iter()
        .map(|c| {
            let id = c.get("id").and_then(Value::as_str).ok_or("keymap.json: a command without an id")?;
            let act = act_of(id).ok_or_else(|| format!("keymap.json: no editor action for {id}"))?;
            let keys = [Os::Mac, Os::Win, Os::Linux].map(|os| {
                c.pointer(&format!("/keys/{}", os.key())).and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(normalize).collect()
            });
            let title = c.get("title").and_then(Value::as_str).unwrap_or("").to_string();
            Ok(Command { id: id.into(), title, keys, act })
        })
        .collect()
}

static COMMANDS: OnceLock<Vec<Command>> = OnceLock::new();

/// Loads the shared key table once (main, before anything resolves keys).
pub fn load_commands(file: &Path) -> Result<(), String> {
    let text = std::fs::read_to_string(file).map_err(|e| format!("{}: {e}", file.display()))?;
    let list = parse_keymap(&vscode_textmate::parse_jsonc(&text)?)?;
    let _ = COMMANDS.set(list);
    Ok(())
}

pub fn commands() -> &'static [Command] {
    COMMANDS.get_or_init(|| {
        if cfg!(test) {
            // unit tests read the repository's table
            let file = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../vscode-viewer/editor/keymap.json");
            let text = std::fs::read_to_string(file).unwrap_or_default();
            return vscode_textmate::parse_jsonc(&text).ok().and_then(|v| parse_keymap(&v).ok()).unwrap_or_default();
        }
        vec![]
    })
}

pub fn by_id(id: &str) -> Option<&'static Command> {
    commands().iter().find(|c| c.id == id)
}

/// "shift+cmd+k" -> (["shift", "cmd"], "k"); the key itself may be "+" ("ctrl++").
fn split(step: &str) -> (Vec<&str>, &str) {
    let i = if step.len() > 1 { step[..step.len() - 1].rfind('+') } else { None };
    match i {
        Some(i) => (step[..i].split('+').collect(), &step[i + 1..]),
        None => (vec![], step),
    }
}

/// Keys in chordOf's modifier order; a two-step chord step by step.
pub fn normalize(key: &str) -> String {
    key.split_whitespace()
        .map(|step| {
            let (mods, name) = split(step);
            let mut out = String::new();
            for m in ["ctrl", "alt", "shift", "cmd"] {
                if mods.contains(&m) {
                    out.push_str(m);
                    out.push('+');
                }
            }
            out + name
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn capital(name: &str) -> String {
    let mut c = name.chars();
    c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
}

/// A key as VS Code shows it on that OS: macOS glyphs ("⇧⌘K", "⌘K ⌘J"), elsewhere "Ctrl+Shift+K", "Ctrl+K Ctrl+J".
pub fn label(key: &str, os: Os) -> String {
    normalize(key)
        .split(' ')
        .map(|step| {
            let (mods, name) = split(step);
            if os == Os::Mac {
                let glyphs: String = mods.iter().map(|m| match *m { "ctrl" => "⌃", "alt" => "⌥", "shift" => "⇧", _ => "⌘" }).collect();
                let k = match name {
                    "up" => "↑".into(),
                    "down" => "↓".into(),
                    "left" => "←".into(),
                    "right" => "→".into(),
                    "enter" => "↩".into(),
                    "backspace" => "⌫".into(),
                    "delete" => "⌦".into(),
                    "tab" => "⇥".into(),
                    "pageup" => "PageUp".into(),
                    "pagedown" => "PageDown".into(),
                    _ => capital(name),
                };
                return glyphs + &k;
            }
            let mut parts: Vec<String> = ["ctrl", "shift", "alt", "cmd"]
                .iter()
                .filter(|m| mods.contains(m))
                .map(|m| match *m { "ctrl" => "Ctrl".into(), "shift" => "Shift".into(), "alt" => "Alt".into(), _ => (if os == Os::Win { "Windows" } else { "Super" }).to_string() })
                .collect();
            parts.push(match name {
                "up" => "UpArrow".into(),
                "down" => "DownArrow".into(),
                "left" => "LeftArrow".into(),
                "right" => "RightArrow".into(),
                "pageup" => "PageUp".into(),
                "pagedown" => "PageDown".into(),
                _ => capital(name),
            });
            parts.join("+")
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// A VS Code key ("Shift+Cmd+K", "ctrl+k ctrl+c") -> the editor's key; None for more than two steps or an unknown
/// modifier.
pub fn canon(key: &str) -> Option<String> {
    let lower = key.trim().to_lowercase();
    let steps: Vec<&str> = lower.split_whitespace().collect();
    if steps.is_empty() || steps.len() > 2 {
        return None;
    }
    let mut out = vec![];
    for step in steps {
        let (mods, name) = split(step);
        if name.is_empty() {
            return None;
        }
        let mut parts = vec![];
        for m in mods {
            parts.push(match m {
                "ctrl" | "control" => "ctrl",
                "alt" | "option" | "opt" => "alt",
                "shift" => "shift",
                "cmd" | "meta" | "win" | "super" | "command" => "cmd",
                _ => return None,
            });
        }
        parts.push(match name {
            "esc" => "escape",
            "return" => "enter",
            "del" => "delete",
            n => n,
        });
        out.push(parts.join("+"));
    }
    Some(normalize(&out.join(" ")))
}

#[derive(Clone, PartialEq, Debug)]
pub struct Binding {
    pub key: String,
    pub command: String,
    pub user: bool,
}

pub struct Keymap {
    pub os: Os,
    pub bindings: Vec<Binding>,
    pub by_chord: HashMap<String, String>,
    /// The first steps of the two-step keys in effect.
    pub prefixes: HashSet<String>,
}

impl Keymap {
    /// This OS's defaults, then the user's entries in order.
    pub fn resolve(user: &[Value]) -> Keymap {
        Keymap::resolve_os(commands(), Os::current(), user)
    }

    pub fn resolve_os(commands: &[Command], os: Os, user: &[Value]) -> Keymap {
        let i = os as usize;
        let mut bindings: Vec<Binding> = commands.iter().flat_map(|c| c.keys[i].iter().map(|k| Binding { key: k.clone(), command: c.id.clone(), user: false })).collect();
        for e in user {
            let Some(command) = e.get("command").and_then(Value::as_str) else { continue };
            if command.trim_start_matches('-').is_empty() {
                continue;
            }
            let key = match e.get("key") {
                None | Some(Value::Null) => None,
                Some(k) => match k.as_str().and_then(canon) {
                    Some(k) => Some(k),
                    None => continue,
                },
            };
            if let Some(id) = command.strip_prefix('-') {
                bindings.retain(|b| b.command != id || key.as_ref().is_some_and(|k| &b.key != k));
            } else if let Some(key) = key {
                bindings.push(Binding { key, command: command.into(), user: true });
            }
        }
        let by_chord: HashMap<String, String> = bindings.iter().map(|b| (b.key.clone(), b.command.clone())).collect();
        let prefixes = by_chord.keys().filter_map(|k| k.split_once(' ').map(|(a, _)| a.to_string())).collect();
        Keymap { os, bindings, by_chord, prefixes }
    }

    pub fn command(&self, chord: &str) -> Option<&'static Command> {
        self.by_chord.get(chord).and_then(|id| by_id(id))
    }

    pub fn id(&self, chord: &str) -> Option<&str> {
        self.by_chord.get(chord).map(String::as_str)
    }

    pub fn key_label(&self, key: &str) -> String {
        label(key, self.os)
    }

    /// The key shown for a command: the user's newest binding still in effect, else the first default.
    #[allow(dead_code)] // phase 3 (menu and palette labels)
    pub fn label(&self, id: &str) -> String {
        let live: Vec<&Binding> = self.bindings.iter().filter(|b| b.command == id && self.by_chord.get(&b.key).map(String::as_str) == Some(id)).collect();
        live.iter().rev().find(|b| b.user).or(live.first()).map(|b| self.key_label(&b.key)).unwrap_or_default()
    }
}

pub fn keybindings_file() -> PathBuf {
    std::env::var_os("VSEDIT_KEYBINDINGS").map(PathBuf::from).unwrap_or_else(|| herdr_home().join("vscode-keybindings.json"))
}

/// File text -> (user entries, error).
pub fn parse_text(text: Option<&str>) -> (Vec<Value>, Option<String>) {
    let Some(text) = text.filter(|t| !t.trim().is_empty()) else { return (vec![], None) };
    match vscode_textmate::parse_jsonc(text) {
        Ok(Value::Array(a)) => (a, None),
        Ok(_) => (vec![], Some("vscode-keybindings.json is not a JSON array".into())),
        Err(e) => (vec![], Some(format!("vscode-keybindings.json: {e}"))),
    }
}

/// The user's keymap, kept current by `poll` (every 2 s).
pub struct LiveKeys {
    file: PathBuf,
    stamp: Option<Option<(u64, u64)>>,
    pub keymap: Keymap,
    pub error: Option<String>,
}

impl LiveKeys {
    pub fn new() -> LiveKeys {
        let mut k = LiveKeys { file: keybindings_file(), stamp: None, keymap: Keymap::resolve(&[]), error: None };
        k.poll();
        k
    }
    /// True when the file changed and was read again.
    pub fn poll(&mut self) -> bool {
        let st = disk_stamp(&self.file).map(|s| (s.mtime_ms.to_bits(), s.size));
        if self.stamp == Some(st) {
            return false;
        }
        self.stamp = Some(st);
        let text = std::fs::read_to_string(&self.file).ok();
        let (user, error) = parse_text(text.as_deref());
        self.keymap = Keymap::resolve(&user);
        self.error = error;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn km(os: Os, user: &[Value]) -> Keymap {
        Keymap::resolve_os(commands(), os, user)
    }

    #[test]
    fn every_command_of_the_shared_table_runs_something() {
        assert!(commands().len() > 100, "keymap.json was not read");
        assert!(by_id("cursorHome").is_some() && by_id("deleteAllRight").is_some());
        assert!(parse_keymap(&json!({ "commands": [{ "id": "no.such", "keys": {} }] })).is_err());
    }

    #[test]
    fn each_os_gets_its_own_defaults() {
        let mac = km(Os::Mac, &[]);
        assert_eq!(mac.id("cmd+s"), Some("workbench.action.files.save"));
        assert_eq!(mac.id("ctrl+a"), Some("cursorLineStart"));
        assert_eq!(mac.id("ctrl+k"), Some("deleteAllRight"));
        let linux = km(Os::Linux, &[]);
        assert_eq!(linux.id("ctrl+s"), Some("workbench.action.files.save"));
        assert_eq!(linux.id("ctrl+a"), Some("editor.action.selectAll"));
        assert!(linux.id("cmd+s").is_none());
        assert_eq!(Os::pick(Some("win")), Os::Win);
    }

    #[test]
    fn two_step_chords_have_their_first_key_as_a_prefix() {
        let mac = km(Os::Mac, &[]);
        assert!(mac.prefixes.contains("cmd+k"));
        assert_eq!(mac.id("cmd+k cmd+c"), Some("editor.action.addCommentLine"));
        assert!(km(Os::Linux, &[]).prefixes.contains("ctrl+k"));
    }

    #[test]
    fn keys_normalize_and_label_as_vs_code_shows_them() {
        assert_eq!(normalize("cmd+shift+k  cmd+alt+j"), "shift+cmd+k alt+cmd+j");
        assert_eq!(label("shift+cmd+k", Os::Mac), "⇧⌘K");
        assert_eq!(label("cmd+k cmd+j", Os::Mac), "⌘K ⌘J");
        assert_eq!(label("ctrl+shift+k", Os::Linux), "Ctrl+Shift+K");
        assert_eq!(label("alt+up", Os::Win), "Alt+UpArrow");
        assert_eq!(canon("Shift+Cmd+K").as_deref(), Some("shift+cmd+k"));
        assert_eq!(canon("ctrl+k ctrl+c").as_deref(), Some("ctrl+k ctrl+c"));
        assert_eq!(canon("a b c"), None);
        assert_eq!(canon("hyper+k"), None);
    }

    #[test]
    fn user_bindings_add_keys_and_minus_removes_defaults() {
        let k = km(Os::Mac, &[json!({ "key": "cmd+shift+d", "command": "editor.action.deleteLines" }), json!({ "key": "cmd+shift+k", "command": "-editor.action.deleteLines" })]);
        assert_eq!(k.id("shift+cmd+d"), Some("editor.action.deleteLines"));
        assert!(k.id("shift+cmd+k").is_none());
        assert_eq!(k.label("editor.action.deleteLines"), "⇧⌘D");
        let gone = km(Os::Mac, &[json!({ "command": "-undo" })]);
        assert!(gone.id("cmd+z").is_none() && gone.label("undo").is_empty());
        let chord = km(Os::Linux, &[json!({ "key": "ctrl+k ctrl+s", "command": "workbench.action.files.save" })]);
        assert_eq!(chord.id("ctrl+k ctrl+s"), Some("workbench.action.files.save"));
    }

    #[test]
    fn the_last_binding_of_a_key_wins() {
        let k = km(Os::Mac, &[json!({ "key": "cmd+s", "command": "undo" })]);
        assert_eq!(k.id("cmd+s"), Some("undo"));
        assert!(k.label("workbench.action.files.save").is_empty() || k.label("workbench.action.files.save") != "⌘S");
    }

    #[test]
    fn invalid_files_report_an_error_and_keep_the_defaults() {
        assert!(parse_text(Some("{}")).1.is_some());
        assert_eq!(parse_text(Some("// c\n[{\"key\":\"f5\",\"command\":\"undo\"},]")).0.len(), 1);
        assert_eq!(parse_text(None), (vec![], None));
    }
}
