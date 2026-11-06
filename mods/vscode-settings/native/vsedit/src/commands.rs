//! Editor commands (commands.cjs): VS Code ids and titles, the default chords; user keybindings (keybindings.cjs):
//! <herdr home>/vscode-keybindings.json in VS Code's format, where "-id" removes a default; the last binding of a key wins.

use crate::file::disk_stamp;
use crate::settings::herdr_home;
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;

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
    ToggleComment,
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
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum FindOption {
    Case,
    Word,
    Regex,
}

/// The platform whose default keys apply (VS Code ships default keybindings per OS).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Os {
    Mac,
    Windows,
    Linux,
}

impl Os {
    pub fn current() -> Os {
        if cfg!(target_os = "macos") {
            Os::Mac
        } else if cfg!(windows) {
            Os::Windows
        } else {
            Os::Linux
        }
    }
}

pub struct Command {
    pub id: &'static str,
    #[allow(dead_code)] // phase 3: the command palette and the context menu show titles and key labels
    pub title: &'static str,
    /// The default chords (today the same on every OS, as in commands.cjs).
    pub chords: &'static [&'static str],
    /// An OS's own defaults instead of `chords` (none yet: per-OS keys follow once the JS defaults split).
    pub os_chords: &'static [(Os, &'static [&'static str])],
    pub act: Act,
}

impl Command {
    pub fn defaults(&self, os: Os) -> &'static [&'static str] {
        self.os_chords.iter().find(|(o, _)| *o == os).map_or(self.chords, |(_, c)| c)
    }
}

const fn c(id: &'static str, title: &'static str, chords: &'static [&'static str], act: Act) -> Command {
    Command { id, title, chords, os_chords: &[], act }
}

pub const COMMANDS: &[Command] = &[
    c("editor.action.revealDefinition", "Go to Definition", &["f12"], Act::Lang),
    c("editor.action.goToTypeDefinition", "Go to Type Definition", &[], Act::Lang),
    c("editor.action.goToImplementation", "Go to Implementations", &["cmd+f12"], Act::Lang),
    c("editor.action.goToReferences", "Go to References", &["shift+f12"], Act::Lang),
    c("editor.action.peekDefinition", "Peek Definition", &["alt+f12"], Act::Lang),
    c("editor.action.referenceSearch.trigger", "Peek References", &[], Act::Lang),
    c("editor.action.peekImplementation", "Peek Implementations", &[], Act::Lang),
    c("editor.action.peekTypeDefinition", "Peek Type Definition", &[], Act::Lang),
    c("references-view.findReferences", "Find All References", &["alt+shift+f12"], Act::Lang),
    c("references-view.findImplementations", "Find All Implementations", &[], Act::Lang),
    c("references-view.showCallHierarchy", "Show Call Hierarchy", &["alt+shift+h"], Act::Lang),
    c("editor.action.rename", "Rename Symbol", &["f2"], Act::Lang),
    c("editor.action.changeAll", "Change All Occurrences", &["cmd+f2", "ctrl+f2"], Act::Lang),
    c("editor.action.formatDocument", "Format Document", &["alt+shift+f"], Act::Lang),
    c("editor.action.refactor", "Refactor...", &["ctrl+shift+r"], Act::Lang),
    c("editor.action.sourceAction", "Source Action...", &[], Act::Lang),
    c("editor.action.clipboardCutAction", "Cut", &["cmd+x", "ctrl+x"], Act::Copy(true)),
    c("editor.action.clipboardCopyAction", "Copy", &["cmd+c", "ctrl+c"], Act::Copy(false)),
    c("editor.action.clipboardPasteAction", "Paste", &["cmd+v", "ctrl+v"], Act::Paste),
    c("workbench.action.showCommands", "Command Palette...", &["cmd+shift+p", "ctrl+shift+p", "f1"], Act::Lang),
    c("workbench.action.quickOpen", "Go to File...", &["cmd+p", "ctrl+p"], Act::QuickOpen),
    c("workbench.action.files.save", "File: Save", &["cmd+s", "ctrl+s"], Act::Save),
    c("workbench.action.files.toggleAutoSave", "File: Toggle Auto Save", &[], Act::ToggleAutoSave),
    c("workbench.action.files.setAutoSaveDelay", "File: Set Auto Save Delay…", &[], Act::AskAutoSaveDelay),
    c("workbench.action.openSettings", "Preferences: Open Settings", &["cmd+,"], Act::OpenSettingsUi(false)),
    c("workbench.action.openSettingsJson", "Preferences: Open Settings (JSON)", &[], Act::OpenSettingsJson),
    c("workbench.action.openGlobalKeybindings", "Preferences: Open Keyboard Shortcuts", &[], Act::OpenSettingsUi(true)),
    c("workbench.action.openGlobalKeybindingsFile", "Preferences: Open Keyboard Shortcuts (JSON)", &[], Act::OpenKeybindingsJson),
    c("workbench.action.closeActiveEditor", "View: Close Editor", &["cmd+w", "ctrl+q"], Act::Quit),
    c("undo", "Undo", &["cmd+z", "ctrl+z"], Act::Undo),
    c("redo", "Redo", &["cmd+shift+z", "ctrl+shift+z", "ctrl+y"], Act::Redo),
    c("editor.action.selectAll", "Select All", &["cmd+a", "ctrl+a"], Act::SelectAll),
    c("editor.action.commentLine", "Toggle Line Comment", &["cmd+/", "ctrl+/"], Act::ToggleComment),
    c("editor.action.addSelectionToNextFindMatch", "Add Selection to Next Find Match", &["cmd+d", "ctrl+d"], Act::SelectNextOccurrence),
    c("actions.find", "Find", &["cmd+f", "ctrl+f"], Act::OpenFind(false)),
    c("editor.action.startFindReplaceAction", "Replace", &["cmd+alt+f", "ctrl+h"], Act::OpenFind(true)),
    c("toggleFindCaseSensitive", "Toggle Match Case", &["cmd+alt+c", "alt+c"], Act::ToggleFind(FindOption::Case)),
    c("toggleFindWholeWord", "Toggle Match Whole Word", &["cmd+alt+w", "alt+w"], Act::ToggleFind(FindOption::Word)),
    c("toggleFindRegex", "Toggle Use Regular Expression", &["cmd+alt+r", "alt+r"], Act::ToggleFind(FindOption::Regex)),
    c("editor.action.replaceOne", "Replace Next Match", &["shift+cmd+1"], Act::ReplaceOne),
    c("editor.action.replaceAll", "Replace All", &["cmd+alt+enter"], Act::ReplaceAll),
    c("editor.action.nextMatchFindAction", "Find Next", &["cmd+g", "f3"], Act::FindAgain(1)),
    c("editor.action.previousMatchFindAction", "Find Previous", &["cmd+shift+g", "shift+f3"], Act::FindAgain(-1)),
    c("workbench.action.gotoSymbol", "Go to Symbol in Editor...", &["cmd+shift+o", "ctrl+shift+o"], Act::Lang),
    c("editor.action.marker.next", "Go to Next Problem (Error, Warning, Info)", &["f8", "alt+f8"], Act::Lang),
    c("editor.action.marker.prev", "Go to Previous Problem (Error, Warning, Info)", &["shift+f8", "alt+shift+f8"], Act::Lang),
    c("workbench.action.gotoLine", "Go to Line/Column...", &["ctrl+g"], Act::GotoLine),
    c("editor.action.deleteLines", "Delete Line", &["cmd+shift+k", "ctrl+shift+k"], Act::DeleteLines),
    c("editor.action.moveLinesUpAction", "Move Line Up", &["alt+up"], Act::MoveLines(-1)),
    c("editor.action.moveLinesDownAction", "Move Line Down", &["alt+down"], Act::MoveLines(1)),
    c("editor.action.copyLinesUpAction", "Copy Line Up", &["alt+shift+up"], Act::CopyLines(-1)),
    c("editor.action.copyLinesDownAction", "Copy Line Down", &["alt+shift+down"], Act::CopyLines(1)),
    c("editor.action.insertLineAfter", "Insert Line Below", &["cmd+enter", "ctrl+enter"], Act::InsertLine(true)),
    c("editor.action.insertLineBefore", "Insert Line Above", &["cmd+shift+enter", "ctrl+shift+enter"], Act::InsertLine(false)),
    c("editor.action.indentLines", "Indent Line", &["cmd+]", "ctrl+]"], Act::IndentLines(false)),
    c("editor.action.outdentLines", "Outdent Line", &["cmd+[", "ctrl+["], Act::IndentLines(true)),
    c("workbench.action.navigateBack", "Go Back", &["ctrl+-"], Act::Navigate(-1)),
    c("workbench.action.navigateForward", "Go Forward", &["ctrl+shift+-"], Act::Navigate(1)),
    c("editor.action.indentUsingSpaces", "Indent Using Spaces", &[], Act::PickTabSize(false)),
    c("editor.action.indentUsingTabs", "Indent Using Tabs", &[], Act::PickTabSize(true)),
    c("workbench.action.editor.changeEOL", "Change End of Line Sequence", &[], Act::PickEol),
    c("workbench.action.editor.changeLanguageMode", "Change Language Mode", &[], Act::PickLanguage),
    c("workbench.action.editor.nextChange", "Go to Next Change", &["alt+f5"], Act::GotoChange(1)),
    c("workbench.action.editor.previousChange", "Go to Previous Change", &["alt+shift+f5"], Act::GotoChange(-1)),
    c("editor.fold", "Fold", &["ctrl+shift+["], Act::Fold),
    c("editor.unfold", "Unfold", &["ctrl+shift+]"], Act::Unfold),
    c("editor.toggleFold", "Toggle Fold", &["ctrl+alt+l"], Act::ToggleFold),
    c("editor.foldAll", "Fold All", &["ctrl+alt+["], Act::FoldAll),
    c("editor.unfoldAll", "Unfold All", &["ctrl+alt+]"], Act::UnfoldAll),
    c("editor.action.showContextMenu", "Show Editor Context Menu", &["shift+f10", "menu"], Act::Lang),
];

pub fn by_id(id: &str) -> Option<&'static Command> {
    COMMANDS.iter().find(|c| c.id == id)
}

/// "shift+cmd+k" -> (["shift", "cmd"], "k"); the key itself may be "+" ("ctrl++").
fn split(chord: &str) -> (Vec<&str>, &str) {
    let i = if chord.len() > 1 { chord[..chord.len() - 1].rfind('+') } else { None };
    match i {
        Some(i) => (chord[..i].split('+').collect(), &chord[i + 1..]),
        None => (vec![], chord),
    }
}

/// Chord strings in chordOf's modifier order.
pub fn normalize(chord: &str) -> String {
    let (mods, name) = split(chord);
    let mut out = String::new();
    for m in ["ctrl", "alt", "shift", "cmd"] {
        if mods.contains(&m) {
            out.push_str(m);
            out.push('+');
        }
    }
    out + name
}

/// Normalized chord -> macOS label in VS Code's glyphs: "shift+cmd+k" -> "⇧⌘K".
#[allow(dead_code)] // phase 3 (menu and palette labels)
pub fn label(chord: &str) -> String {
    let n = normalize(chord);
    let (mods, name) = split(&n);
    let mut out: String = mods.iter().map(|m| match *m { "ctrl" => "⌃", "alt" => "⌥", "shift" => "⇧", _ => "⌘" }).collect();
    out += &match name {
        "up" => "↑".into(),
        "down" => "↓".into(),
        "left" => "←".into(),
        "right" => "→".into(),
        "enter" => "↩".into(),
        "backspace" => "⌫".into(),
        "delete" => "⌦".into(),
        "tab" => "⇥".into(),
        "escape" => "Escape".into(),
        "pageup" => "PageUp".into(),
        "pagedown" => "PageDown".into(),
        "space" => "Space".into(),
        _ => {
            let mut cs = name.chars();
            cs.next().map(|f| f.to_uppercase().collect::<String>() + cs.as_str()).unwrap_or_default()
        }
    };
    out
}

/// A VS Code key ("Shift+Cmd+K") -> the editor's chord; None for two-step chords and unknown modifiers.
pub fn canon(key: &str) -> Option<String> {
    let s = key.trim().to_lowercase();
    if s.is_empty() || s.chars().any(char::is_whitespace) {
        return None;
    }
    let (mods, name) = split(&s);
    let mut out = vec![];
    for m in mods {
        out.push(match m {
            "ctrl" | "control" => "ctrl",
            "alt" | "option" | "opt" => "alt",
            "shift" => "shift",
            "cmd" | "meta" | "win" | "super" | "command" => "cmd",
            _ => return None,
        });
    }
    out.push(match name {
        "esc" => "escape",
        "return" => "enter",
        "del" => "delete",
        n => n,
    });
    Some(normalize(&out.join("+")))
}

#[derive(Clone, PartialEq, Debug)]
pub struct Binding {
    pub key: String,
    pub command: String,
    pub user: bool,
}

pub struct Keymap {
    #[allow(dead_code)] // phase 3 (labels)
    pub bindings: Vec<Binding>,
    pub by_chord: HashMap<String, String>,
}

impl Keymap {
    /// This OS's defaults, then the user's entries in order.
    pub fn resolve(user: &[Value]) -> Keymap {
        Keymap::resolve_for(COMMANDS, Os::current(), user)
    }

    pub fn resolve_for(commands: &'static [Command], os: Os, user: &[Value]) -> Keymap {
        let mut bindings: Vec<Binding> =
            commands.iter().flat_map(|c| c.defaults(os).iter().map(|ch| Binding { key: normalize(ch), command: c.id.into(), user: false })).collect();
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
        let by_chord = bindings.iter().map(|b| (b.key.clone(), b.command.clone())).collect();
        Keymap { bindings, by_chord }
    }

    pub fn command(&self, chord: &str) -> Option<&'static Command> {
        self.by_chord.get(chord).and_then(|id| by_id(id))
    }

    /// The key shown for a command: the user's newest binding still in effect, else the first default.
    #[allow(dead_code)] // phase 3 (menu and palette labels)
    pub fn label(&self, id: &str) -> String {
        let live: Vec<&Binding> = self.bindings.iter().filter(|b| b.command == id && self.by_chord.get(&b.key).map(String::as_str) == Some(id)).collect();
        live.iter().rev().find(|b| b.user).or(live.first()).map(|b| label(&b.key)).unwrap_or_default()
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

    #[test]
    fn chords_normalize_and_label_like_vs_code() {
        assert_eq!(normalize("shift+cmd+1"), "shift+cmd+1");
        assert_eq!(normalize("cmd+shift+k"), "shift+cmd+k");
        assert_eq!(label("shift+cmd+k"), "⇧⌘K");
        assert_eq!(label("ctrl++"), "⌃+");
        assert_eq!(canon("Shift+Cmd+K").as_deref(), Some("shift+cmd+k"));
        assert_eq!(canon("cmd+k cmd+s"), None);
        assert_eq!(canon("hyper+k"), None);
    }

    #[test]
    fn user_bindings_add_keys_and_minus_removes_defaults() {
        let km = Keymap::resolve(&[json!({ "key": "cmd+shift+d", "command": "editor.action.deleteLines" }), json!({ "key": "cmd+shift+k", "command": "-editor.action.deleteLines" })]);
        assert_eq!(km.command("shift+cmd+d").map(|c| c.id), Some("editor.action.deleteLines"));
        assert!(km.command("shift+cmd+k").is_none());
        assert_eq!(km.command("ctrl+shift+k").map(|c| c.id), Some("editor.action.deleteLines"));
        assert_eq!(km.label("editor.action.deleteLines"), "⇧⌘D");
        let gone = Keymap::resolve(&[json!({ "command": "-undo" })]);
        assert!(gone.command("cmd+z").is_none() && gone.label("undo").is_empty());
    }

    #[test]
    fn an_os_can_have_its_own_default_keys() {
        static CMDS: &[Command] = &[Command { id: "undo", title: "Undo", chords: &["cmd+z"], os_chords: &[(Os::Windows, &["ctrl+z"])], act: Act::Undo }];
        assert!(Keymap::resolve_for(CMDS, Os::Mac, &[]).command("cmd+z").is_some());
        let win = Keymap::resolve_for(CMDS, Os::Windows, &[]);
        assert!(win.command("ctrl+z").is_some() && win.command("cmd+z").is_none());
        assert!(COMMANDS.iter().all(|c| c.defaults(Os::Linux) == c.chords), "the defaults match commands.cjs on every OS for now");
    }

    #[test]
    fn the_last_binding_of_a_key_wins() {
        let km = Keymap::resolve(&[json!({ "key": "cmd+s", "command": "undo" })]);
        assert_eq!(km.command("cmd+s").map(|c| c.id), Some("undo"));
        assert_eq!(km.label("workbench.action.files.save"), "⌃S");
    }

    #[test]
    fn invalid_files_report_an_error_and_keep_the_defaults() {
        assert!(parse_text(Some("{}")).1.is_some());
        assert_eq!(parse_text(Some("// c\n[{\"key\":\"f5\",\"command\":\"undo\"},]")).0.len(), 1);
        assert_eq!(parse_text(None), (vec![], None));
    }
}
