//! User settings (settings.cjs): <herdr home>/vscode-settings.json with VS Code's names, files.autoSaveDelay in
//! seconds. A missing file is created with the defaults; unknown keys are kept when a setting is written back.

use crate::file::{self, Stamp};
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

pub fn herdr_home() -> PathBuf {
    std::env::var_os("HERDR_APP_HOME").map(PathBuf::from).unwrap_or_else(|| home_dir().join(".config/herdr-app"))
}

pub fn home_dir() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"))
}

pub fn settings_file() -> PathBuf {
    std::env::var_os("VSEDIT_SETTINGS").map(PathBuf::from).unwrap_or_else(|| herdr_home().join("vscode-settings.json"))
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum AutoSave {
    Off,
    AfterDelay,
    OnFocusChange,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Settings {
    pub auto_save: AutoSave,
    pub auto_save_delay: f64,
    pub tab_size: usize,
    pub insert_spaces: bool,
    pub format_on_save: bool,
    pub trim_trailing_whitespace: bool,
    pub insert_final_newline: bool,
    pub breadcrumbs: bool,
    /// editor.hover.enabled: the hover after the pointer rests on a word
    pub hover: bool,
    /// editor.inlineSuggest.* (not written into a new file)
    pub inline: crate::inline::InlineSettings,
    /// extensions.ignoreRecommendations: no status bar offer to install a missing language server
    pub ignore_recommendations: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            auto_save: AutoSave::Off,
            auto_save_delay: 1.0,
            tab_size: 4,
            insert_spaces: true,
            format_on_save: false,
            trim_trailing_whitespace: false,
            insert_final_newline: false,
            breadcrumbs: true,
            hover: true,
            inline: crate::inline::InlineSettings::default(),
            ignore_recommendations: false,
        }
    }
}

fn defaults_json() -> Value {
    json!({
        "files.autoSave": "off", "files.autoSaveDelay": 1, "editor.tabSize": 4, "editor.insertSpaces": true,
        "editor.formatOnSave": false, "files.trimTrailingWhitespace": false, "files.insertFinalNewline": false,
        "breadcrumbs.enabled": true, "editor.hover.enabled": true, "extensions.ignoreRecommendations": false,
    })
}

/// A raw object -> every setting with a valid value (invalid ones fall back to the default).
pub fn normalize(raw: &Value) -> Settings {
    let auto_save = match raw.get("files.autoSave").and_then(Value::as_str) {
        Some("afterDelay") => AutoSave::AfterDelay,
        Some("onFocusChange") => AutoSave::OnFocusChange,
        _ => AutoSave::Off,
    };
    let mut v = Settings { auto_save, ..Settings::default() };
    let num = |k: &str| match raw.get(k) {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => s.trim().parse::<f64>().ok().or(if s.trim().is_empty() { Some(0.0) } else { None }),
        Some(Value::Bool(b)) => Some(*b as u8 as f64),
        _ => None,
    };
    if let Some(d) = num("files.autoSaveDelay").filter(|d| d.is_finite()) {
        v.auto_save_delay = d.clamp(0.1, 3600.0);
    }
    if let Some(t) = num("editor.tabSize").filter(|t| t.fract() == 0.0) {
        v.tab_size = t.clamp(1.0, 16.0) as usize;
    }
    let flag = |k: &str, d: bool| raw.get(k).and_then(Value::as_bool).unwrap_or(d);
    v.insert_spaces = flag("editor.insertSpaces", true);
    v.format_on_save = flag("editor.formatOnSave", false);
    v.trim_trailing_whitespace = flag("files.trimTrailingWhitespace", false);
    v.insert_final_newline = flag("files.insertFinalNewline", false);
    v.breadcrumbs = flag("breadcrumbs.enabled", true);
    v.hover = flag("editor.hover.enabled", true);
    v.inline = crate::inline::normalize(raw);
    v.ignore_recommendations = flag("extensions.ignoreRecommendations", false);
    v
}

pub fn read_raw(file: &Path) -> Map<String, Value> {
    fs::read_to_string(file).ok().and_then(|t| vscode_textmate::parse_jsonc(&t).ok()).and_then(|v| v.as_object().cloned()).unwrap_or_default()
}

/// The settings and the file's stamp; creates the file with the defaults when it doesn't exist.
pub fn load(file: &Path) -> (Settings, Option<Stamp>) {
    if !file.exists() {
        if let Some(dir) = file.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let _ = file::save(file, &(serde_json::to_string_pretty(&defaults_json()).unwrap_or_default() + "\n"));
    }
    (normalize(&Value::Object(read_raw(file))), file::disk_stamp(file))
}

/// Writes one setting, keeping the file's other keys (comments are not kept).
pub fn update(file: &Path, key: &str, value: Value) -> std::io::Result<(Settings, Option<Stamp>)> {
    let mut raw = read_raw(file);
    raw.insert(key.into(), value);
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir)?;
    }
    file::save(file, &(serde_json::to_string_pretty(&Value::Object(raw))? + "\n"))?;
    Ok(load(file))
}

/// A number as JavaScript prints it (1, 0.3).
pub fn js_number(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 1e15 {
        json!(n as i64)
    } else {
        json!(n)
    }
}

fn seconds(s: f64) -> String {
    let r = (s * 1000.0).round() / 1000.0;
    if r.fract() == 0.0 {
        format!("{}s", r as i64)
    } else {
        format!("{r}s")
    }
}

/// "Auto Save: after 1s" / "Auto Save: on focus change" / "Auto Save: off".
pub fn auto_save_label(v: &Settings) -> String {
    match v.auto_save {
        AutoSave::AfterDelay => format!("Auto Save: after {}", seconds(v.auto_save_delay)),
        AutoSave::OnFocusChange => "Auto Save: on focus change".into(),
        AutoSave::Off => "Auto Save: off".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_values_fall_back_and_numbers_are_clamped() {
        let v = normalize(&json!({ "files.autoSave": "sometimes", "files.autoSaveDelay": 99999, "editor.tabSize": 2.5, "breadcrumbs.enabled": false }));
        assert_eq!(v.auto_save, AutoSave::Off);
        assert_eq!(v.auto_save_delay, 3600.0);
        assert_eq!(v.tab_size, 4);
        assert!(!v.breadcrumbs);
        assert_eq!(auto_save_label(&normalize(&json!({ "files.autoSave": "afterDelay", "files.autoSaveDelay": 0.3 }))), "Auto Save: after 0.3s");
    }

    #[test]
    fn update_keeps_unknown_keys() {
        let dir = std::env::temp_dir().join(format!("vsedit-settings-{}", std::process::id()));
        let file = dir.join("vscode-settings.json");
        fs::create_dir_all(&dir).unwrap();
        fs::write(&file, "// mine\n{ \"keep.me\": 1, }").unwrap();
        let (v, _) = update(&file, "files.autoSave", json!("afterDelay")).unwrap();
        assert_eq!(v.auto_save, AutoSave::AfterDelay);
        assert_eq!(read_raw(&file).get("keep.me"), Some(&json!(1)));
        fs::remove_dir_all(dir).unwrap();
    }
}
