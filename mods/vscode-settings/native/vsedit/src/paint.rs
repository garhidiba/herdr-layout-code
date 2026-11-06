//! Terminal painting (paint.cjs): the theme palette, 24-bit SGR, a Painter that emits attributes only when they change,
//! fitting text to columns.

use crate::width::char_width;
use serde_json::Value;
use std::fmt::Write;

/// An opaque color as "#rrggbb" (lowercase).
pub type Color = String;

fn hex(c: &str) -> [u8; 3] {
    let v = |i: usize| u8::from_str_radix(c.get(i..i + 2).unwrap_or("00"), 16).unwrap_or(0);
    [v(1), v(3), v(5)]
}

fn is_hex(c: &str, len: usize) -> bool {
    c.len() == len && c.starts_with('#') && c[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

pub fn opaque(c: Option<&str>) -> Option<Color> {
    c.filter(|c| is_hex(c, 7)).map(str::to_lowercase)
}

/// An alpha color (#rrggbbaa) composited over an opaque one.
pub fn blend(c: Option<&str>, under: &str) -> Color {
    if let Some(o) = opaque(c) {
        return o;
    }
    let Some(c) = c.filter(|c| is_hex(c, 9)) else { return under.to_string() };
    let a = u8::from_str_radix(&c[7..9], 16).unwrap_or(255) as f64 / 255.0;
    let (top, bot) = (hex(c), hex(under));
    let mut out = String::from("#");
    for i in 0..3 {
        let v = (top[i] as f64 * a + bot[i] as f64 * (1.0 - a)).round() as u8;
        let _ = write!(out, "{v:02x}");
    }
    out
}

#[derive(Clone)]
pub struct Palette {
    pub bg: Color,
    pub fg: Color,
    pub selection: Color,
    pub line_number: Color,
    pub line_number_active: Color,
    pub current_line: Color,
    pub find_match: Color,
    pub match_other: Color,
    pub warn: Color,
    pub error: Color,
    pub ok: Color,
    pub bar: Color,
    pub bar_fg: Color,
    pub widget: Color,
    pub input: Color,
    pub cursor: Color,
    pub accent: Color,
    pub button: Color,
    pub toggle_on: Color,
    pub toggle_fg: Color,
    pub border: Color,
    pub highlight: Color,
    pub slider: Color,
    pub slider_hover: Color,
    pub slider_active: Color,
    pub ruler_find: Color,
    pub ruler_selection: Color,
    pub ruler_cursor: Color,
    pub ruler_word: Color,
    pub guide: Color,
    pub guide_active: Color,
    pub bracket_match: Color,
    pub word_highlight: Color,
    pub selection_highlight: Color,
    /// documentHighlight writes (reads take word_highlight), Find in Selection's range, CodeLens, a ⌘/Ctrl-hovered link
    pub word_highlight_strong: Color,
    pub ruler_word_strong: Color,
    pub find_range: Color,
    pub code_lens: Color,
    pub link: Color,
    pub git_added: Color,
    pub git_modified: Color,
    pub git_deleted: Color,
    pub ruler_added: Color,
    pub ruler_modified: Color,
    pub ruler_deleted: Color,
    pub fold_control: Color,
    pub fold_background: Color,
    pub fold_placeholder: Color,
    /// inline suggestions' ghost text
    pub ghost: Color,
    pub hover_bg: Color,
    pub hover_border: Color,
    pub light_bulb: Color,
    pub peek: Color,
    pub peek_line: Color,
    /// Diagnostics by severity (1 error, 2 warning, 3 information; 0 unused): squiggles and gutter marks, ruler marks.
    pub diag: [Color; 4],
    pub ruler_diag: [Color; 4],
}

impl Palette {
    pub fn of(colors: &Value) -> Palette {
        let get = |k: &str| colors.get(k).and_then(Value::as_str);
        let op = |k: &str, d: &str| opaque(get(k)).unwrap_or_else(|| d.to_string());
        let bg = op("editor.background", "#282c34");
        let selection = op("editor.selectionBackground", "#3e4451");
        let bl = |k: &str, d: &str| blend(Some(get(k).unwrap_or(d)), &bg);
        let widget = op("editorWidget.background", "#21252b");
        let focus = op("focusBorder", "#528bff");
        let git = |kind: &str, d: &str| {
            let bar = blend(Some(get(&format!("editorGutter.{kind}Background")).unwrap_or(d)), &bg);
            let ruler = blend(Some(get(&format!("editorOverviewRuler.{kind}Foreground")).map(str::to_string).unwrap_or(format!("{bar}99")).as_str()), &bg);
            (bar, ruler)
        };
        let (git_added, ruler_added) = git("added", "#109868");
        let (git_modified, ruler_modified) = git("modified", "#948b60");
        let (git_deleted, ruler_deleted) = git("deleted", "#9a353d");
        Palette {
            fg: op("editor.foreground", "#abb2bf"),
            line_number: op("editorLineNumber.foreground", "#636d83"),
            line_number_active: op("editorLineNumber.activeForeground", "#abb2bf"),
            current_line: op("editor.lineHighlightBackground", "#2c313c"),
            find_match: op("editor.findMatchBackground", "#42557b"),
            match_other: bl("editor.findMatchHighlightBackground", "#528bff3d"),
            warn: "#e5c07b".into(),
            error: "#e06c75".into(),
            ok: "#98c379".into(),
            bar: op("statusBar.background", "#21252b"),
            bar_fg: op("statusBar.foreground", "#9da5b4"),
            input: op("input.background", "#1b1d23"),
            cursor: op("editorCursor.foreground", "#528bff"),
            accent: focus.clone(),
            button: op("button.background", "#4d78cc"),
            toggle_on: blend(Some(get("inputOption.activeBackground").map(str::to_string).unwrap_or(format!("{focus}66")).as_str()), &widget),
            toggle_fg: op("inputOption.activeForeground", "#ffffff"),
            border: op("editorWidget.border", "#3a3f4b"),
            highlight: op("list.highlightForeground", "#d7dae0"),
            slider: bl("scrollbarSlider.background", "#4e566680"),
            slider_hover: bl("scrollbarSlider.hoverBackground", "#5a637580"),
            slider_active: bl("scrollbarSlider.activeBackground", "#747d9180"),
            ruler_find: bl("editorOverviewRuler.findMatchForeground", "#d18616"),
            ruler_selection: bl("editorOverviewRuler.selectionHighlightForeground", "#a0a0a0cc"),
            ruler_cursor: op("editorCursor.foreground", "#528bff"),
            ruler_word: bl("editorOverviewRuler.wordHighlightForeground", "#a0a0a0cc"),
            guide: bl("editorIndentGuide.background", "#abb2bf26"),
            guide_active: bl("editorIndentGuide.activeBackground", "#626772"),
            bracket_match: blend(Some(get("editorBracketMatch.background").or(get("editorBracketMatch.border")).unwrap_or("#515a6b")), &bg),
            word_highlight: bl("editor.wordHighlightBackground", "#d2e0ff2f"),
            selection_highlight: bl("editor.selectionHighlightBackground", "#add6ff26"),
            word_highlight_strong: bl("editor.wordHighlightStrongBackground", "#004972b8"),
            ruler_word_strong: bl("editorOverviewRuler.wordHighlightStrongForeground", "#c0a0c0cc"),
            find_range: bl("editor.findRangeHighlightBackground", "#3a3d4166"),
            code_lens: bl("editorCodeLens.foreground", "#999999"),
            link: op("editorLink.activeForeground", "#4e94ce"),
            git_added,
            git_modified,
            git_deleted,
            ruler_added,
            ruler_modified,
            ruler_deleted,
            fold_control: bl("editorGutter.foldingControlForeground", "#c5c5c5"),
            fold_background: blend(Some(get("editor.foldBackground").map(str::to_string).unwrap_or(format!("{selection}4d")).as_str()), &bg),
            fold_placeholder: bl("editor.foldPlaceholderForeground", "#808080"),
            ghost: bl("editorGhostText.foreground", "#ffffff56"),
            hover_bg: op("editorHoverWidget.background", "#21252b"),
            hover_border: op("editorHoverWidget.border", "#454545"),
            light_bulb: op("editorLightBulb.foreground", "#ffcc00"),
            peek: op("peekViewEditor.background", "#1b1d23"),
            peek_line: op("list.activeSelectionBackground", "#2c313a"),
            diag: [String::new(), op("editorError.foreground", "#f14c4c"), op("editorWarning.foreground", "#cca700"), op("editorInfo.foreground", "#3794ff")],
            ruler_diag: [
                String::new(),
                bl("editorOverviewRuler.errorForeground", "#ff1212b3"),
                bl("editorOverviewRuler.warningForeground", "#cca700"),
                bl("editorOverviewRuler.infoForeground", "#3794ff"),
            ],
            widget,
            selection,
            bg,
        }
    }
}

fn sgr_color(out: &mut String, kind: u8, c: &str) {
    let [r, g, b] = hex(c);
    let _ = write!(out, "\x1b[{kind};2;{r};{g};{b}m");
}

/// Paints cells, emitting SGR only when an attribute changes. `curly`: a problem's underline color for these cells, a
/// plain underline (`SGR 4`) colored with `58:2::r:g:b`: the most widely drawn form (a curly `4:3` one
/// showed nothing in Herdr's terminal).
pub struct Painter {
    pub out: String,
    fg: Option<Color>,
    bg: Option<Color>,
    style: i32,
    curly: Option<Color>,
}

impl Default for Painter {
    fn default() -> Self {
        Painter { out: String::new(), fg: None, bg: None, style: -1, curly: None }
    }
}

impl Painter {
    pub fn set(&mut self, fg: &str, bg: &str, style: u32, curly: Option<&str>) {
        if style as i32 != self.style || curly != self.curly.as_deref() {
            self.out.push_str("\x1b[22;23;24;29m");
            for (bit, code) in [(1, "\x1b[3m"), (2, "\x1b[1m"), (4, "\x1b[4m"), (8, "\x1b[9m")] {
                if style & bit != 0 {
                    self.out.push_str(code);
                }
            }
            if let Some(c) = curly {
                let [r, g, b] = hex(c);
                let _ = write!(self.out, "\x1b[4m\x1b[58:2::{r}:{g}:{b}m");
            } else if self.curly.is_some() {
                self.out.push_str("\x1b[59m");
            }
            self.style = style as i32;
            self.curly = curly.map(str::to_string);
        }
        if self.fg.as_deref() != Some(fg) {
            sgr_color(&mut self.out, 38, fg);
            self.fg = Some(fg.to_string());
        }
        if self.bg.as_deref() != Some(bg) {
            sgr_color(&mut self.out, 48, bg);
            self.bg = Some(bg.to_string());
        }
    }
    pub fn text(&mut self, s: &str, fg: &str, bg: &str) {
        self.styled(s, fg, bg, 0, None);
    }
    pub fn styled(&mut self, s: &str, fg: &str, bg: &str, style: u32, curly: Option<&str>) {
        self.set(fg, bg, style, curly);
        self.out.push_str(s);
    }
    pub fn move_to(&mut self, row: i32, col: i32) {
        let _ = write!(self.out, "\x1b[{row};{col}H");
    }
}

/// Fits text into `width` display columns (cut with …, or padded).
pub fn fit(s: &str, width: usize) -> String {
    if width == 0 {
        return String::new();
    }
    let mut out = String::new();
    let mut w = 0;
    for ch in s.chars() {
        let cw = char_width(ch);
        if w + cw > width {
            while w > width - 1 {
                let last = out.pop().unwrap();
                w -= char_width(last);
            }
            return out + "…" + &" ".repeat(width - 1 - w);
        }
        out.push(ch);
        w += cw;
    }
    out + &" ".repeat(width - w)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alpha_colors_blend_over_the_background() {
        assert_eq!(blend(Some("#abb2bf26"), "#282c34"), "#3c4049");
        assert_eq!(blend(Some("#626772"), "#282c34"), "#626772");
        assert_eq!(blend(None, "#282c34"), "#282c34");
    }

    #[test]
    fn fit_cuts_with_an_ellipsis_or_pads() {
        assert_eq!(fit("hello", 3), "he…");
        assert_eq!(fit("hi", 4), "hi  ");
        assert_eq!(fit("한글", 3), "한…");
    }

    #[test]
    fn the_painter_emits_attributes_only_when_they_change() {
        let mut p = Painter::default();
        p.text("a", "#ffffff", "#000000");
        p.text("b", "#ffffff", "#000000");
        assert_eq!(p.out, "\x1b[22;23;24;29m\x1b[38;2;255;255;255m\x1b[48;2;0;0;0mab");
    }
}
