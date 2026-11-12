//! Terminal input -> events (keys.cjs): xterm CSI/SS3, SGR mouse, bracketed paste, focus reports, Kitty CSI-u (with the
//! super/⌘ bit) and modifyOtherKeys. An incomplete sequence at the end is returned as the rest.

#[derive(Clone, Debug, PartialEq, Default)]
pub struct Key {
    pub name: String,
    pub ctrl: bool,
    pub shift: bool,
    pub alt: bool,
    pub cmd: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct Mouse {
    pub button: u32,
    pub x: i32,
    pub y: i32,
    pub release: bool,
    pub motion: bool,
    pub shift: bool,
    pub alt: bool,
    pub ctrl: bool,
}

impl Mouse {
    pub fn press(&self) -> bool {
        self.button == 0 && !self.release && !self.motion
    }
    pub fn wheel(&self) -> bool {
        self.button == 64 || self.button == 65
    }
    /// A click that extends the selection: Shift, or ⌥ (Alt) since Herdr keeps Shift+click for its own text selection.
    pub fn extend(&self) -> bool {
        self.shift || self.alt
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Ev {
    Key(Key),
    Text(String),
    Paste(String),
    Mouse(Mouse),
    Focus(bool),
}

impl Key {
    /// "ctrl+alt+shift+cmd+name" (commands.cjs chordOf).
    pub fn chord(&self) -> String {
        format!(
            "{}{}{}{}{}",
            if self.ctrl { "ctrl+" } else { "" },
            if self.alt { "alt+" } else { "" },
            if self.shift { "shift+" } else { "" },
            if self.cmd { "cmd+" } else { "" },
            self.name
        )
    }
}

pub fn key(name: &str) -> Ev {
    Ev::Key(Key { name: name.into(), ..Default::default() })
}

#[derive(Clone, Copy, Default)]
struct Mods {
    shift: bool,
    alt: bool,
    ctrl: bool,
    cmd: bool,
}

/// Modifier parameter: 1 + (shift 1, alt 2, ctrl 4, super/⌘ 8, hyper 16, meta 32).
fn mods(m: Option<&str>) -> Mods {
    let m = m.and_then(|s| s.parse::<u32>().ok()).filter(|v| *v > 0).unwrap_or(1) - 1;
    Mods { shift: m & 1 != 0, alt: m & 2 != 0 || m & 32 != 0, ctrl: m & 4 != 0, cmd: m & 8 != 0 }
}

fn with(name: &str, m: Mods) -> Ev {
    Ev::Key(Key { name: name.into(), ctrl: m.ctrl, shift: m.shift, alt: m.alt, cmd: m.cmd })
}

const CTRL_LETTERS: &[u8] = b"@abcdefghijklmnopqrstuvwxyz[\\]^_";

/// A single character outside escape sequences; None for plain text.
fn plain(ch: char, alt: bool) -> Option<Ev> {
    let m = Mods { alt, ..Default::default() };
    let c = ch as u32;
    match ch {
        '\r' | '\n' => Some(with("enter", m)),
        '\t' => Some(with("tab", m)),
        '\x7f' => Some(with("backspace", m)),
        '\x1b' => Some(key("escape")),
        _ if c < 0x20 => {
            let l = CTRL_LETTERS[c as usize] as char;
            let name = if l == '_' { "/".to_string() } else { l.to_string() };
            Some(with(&name, Mods { ctrl: true, alt, ..Default::default() }))
        }
        _ if alt => {
            let lower: String = ch.to_lowercase().collect();
            Some(with(&lower, Mods { alt: true, shift: lower != ch.to_string(), ..Default::default() }))
        }
        _ => None,
    }
}

/// CSI-u / modifyOtherKeys code point -> event.
fn code_key(code: u32, m: Option<&str>) -> Option<Ev> {
    let k = mods(m);
    match code {
        13 => return Some(with("enter", k)),
        9 => return Some(with("tab", k)),
        27 => return Some(with("escape", k)),
        127 | 8 => return Some(with("backspace", k)),
        57363 => return Some(with("menu", k)),
        57344..=63743 => return None,
        _ => {}
    }
    let ch = char::from_u32(code)?;
    if !k.ctrl && !k.alt && !k.cmd {
        return Some(Ev::Text(if k.shift { ch.to_uppercase().collect() } else { ch.to_string() }));
    }
    Some(with(&ch.to_lowercase().collect::<String>(), k))
}

fn csi_name(c: u8) -> Option<&'static str> {
    Some(match c {
        b'A' => "up",
        b'B' => "down",
        b'C' => "right",
        b'D' => "left",
        b'H' => "home",
        b'F' => "end",
        b'Z' => "tab",
        b'P' => "f1",
        b'Q' => "f2",
        b'R' => "f3",
        b'S' => "f4",
        _ => return None,
    })
}

fn tilde_name(n: &str) -> Option<&'static str> {
    Some(match n {
        "1" | "7" => "home",
        "2" => "insert",
        "3" => "delete",
        "4" | "8" => "end",
        "5" => "pageup",
        "6" => "pagedown",
        "11" => "f1",
        "12" => "f2",
        "13" => "f3",
        "14" => "f4",
        "15" => "f5",
        "17" => "f6",
        "18" => "f7",
        "19" => "f8",
        "20" => "f9",
        "21" => "f10",
        "23" => "f11",
        "24" => "f12",
        "29" => "menu",
        _ => return None,
    })
}

/// A CSI sequence's parameter bytes and final byte, when complete: (params, final, length).
fn csi(s: &[u8]) -> Option<(&str, u8, usize)> {
    let mut i = 2;
    while i < s.len() && (0x30..=0x3f).contains(&s[i]) {
        i += 1;
    }
    while i < s.len() && (0x20..=0x2f).contains(&s[i]) {
        i += 1;
    }
    let f = *s.get(i)?;
    (0x40..=0x7e).contains(&f).then(|| (std::str::from_utf8(&s[2..i]).unwrap_or(""), f, i + 1))
}

fn num(s: &str) -> Option<i32> {
    s.parse().ok()
}

/// One escape sequence at the start of `rest` (which starts with ESC): Some((events, length)), or None when it is
/// incomplete.
fn escape(rest: &str) -> Option<(Vec<Ev>, usize)> {
    let b = rest.as_bytes();
    if rest.starts_with("\x1b[200~") {
        let end = rest.find("\x1b[201~")?;
        return Some((vec![Ev::Paste(rest[6..end].to_string())], end + 6));
    }
    if b.len() == 1 {
        return Some((vec![key("escape")], 1));
    }
    if b[1] == b'[' {
        let (params, f, n) = csi(b)?;
        let parts: Vec<&str> = params.split(';').collect();
        // SGR mouse: CSI < b ; x ; y M|m
        if let Some(p) = params.strip_prefix('<') {
            let v: Vec<i32> = p.split(';').filter_map(num).collect();
            if (f == b'M' || f == b'm') && v.len() == 3 {
                let bt = v[0] as u32;
                return Some((
                    vec![Ev::Mouse(Mouse {
                        button: bt & 0x43,
                        x: v[1],
                        y: v[2],
                        release: f == b'm',
                        motion: bt & 32 != 0,
                        shift: bt & 4 != 0,
                        alt: bt & 8 != 0,
                        ctrl: bt & 16 != 0,
                    })],
                    n,
                ));
            }
            return Some((vec![], n));
        }
        if params.is_empty() && (f == b'I' || f == b'O') {
            return Some((vec![Ev::Focus(f == b'I')], n));
        }
        match f {
            b'~' if parts.len() == 3 && parts[0] == "27" => {
                // modifyOtherKeys: CSI 27 ; mods ; code ~
                let ev = num(parts[2]).and_then(|c| code_key(c as u32, Some(parts[1])));
                return Some((ev.into_iter().collect(), n));
            }
            b'u' => {
                // Kitty: CSI code[:alternates] ; mods[:event] [; text] u — releases (event 3) dropped
                let code = parts[0].split(':').next().and_then(num);
                let mut m = parts.get(1).map(|s| s.split(':'));
                let modifier = m.as_mut().and_then(|it| it.next()).filter(|s| !s.is_empty());
                let event = m.as_mut().and_then(|it| it.next());
                let ev = if event == Some("3") { None } else { code.and_then(|c| code_key(c as u32, modifier)) };
                return Some((ev.into_iter().collect(), n));
            }
            b'~' => {
                let m = parts.get(1).map(|s| s.split(':').next().unwrap_or(""));
                let ev = tilde_name(parts[0]).map(|name| with(name, mods(m)));
                return Some((ev.into_iter().collect(), n));
            }
            _ => {}
        }
        if let Some(name) = csi_name(f).filter(|_| !params.starts_with('?') && !params.starts_with('>')) {
            // CSI [1;] mods X
            let m = if parts.len() >= 2 { Some(parts[1].split(':').next().unwrap_or("")) } else if parts[0] != "1" && !parts[0].is_empty() { Some(parts[0]) } else { None };
            let mut k = mods(m);
            if f == b'Z' {
                k.shift = true;
            }
            return Some((vec![with(name, k)], n));
        }
        return Some((vec![], n)); // unknown CSI: ignored
    }
    if b[1] == b'O' {
        let f = *b.get(2)?;
        return Some((csi_name(f).map(key).into_iter().collect(), 3));
    }
    let next = rest[1..].chars().next().unwrap();
    let ev = match next {
        'b' => with("left", Mods { alt: true, ..Default::default() }),
        'f' => with("right", Mods { alt: true, ..Default::default() }),
        '\x1b' => return Some((vec![key("escape")], 1)),
        _ => plain(next, true).unwrap_or_else(|| with(&next.to_string(), Mods { alt: true, ..Default::default() })),
    };
    Some((vec![ev], 1 + next.len_utf8()))
}

/// Parses input; returns the events and the incomplete rest (a split escape sequence).
pub fn parse(input: &str) -> (Vec<Ev>, String) {
    let mut events = vec![];
    let mut text = String::new();
    let mut i = 0;
    let flush = |text: &mut String, events: &mut Vec<Ev>| {
        if !text.is_empty() {
            events.push(Ev::Text(std::mem::take(text)));
        }
    };
    while i < input.len() {
        let ch = input[i..].chars().next().unwrap();
        if ch != '\x1b' {
            match plain(ch, false) {
                Some(ev) => {
                    flush(&mut text, &mut events);
                    events.push(ev);
                }
                None => text.push(ch),
            }
            i += ch.len_utf8();
            continue;
        }
        flush(&mut text, &mut events);
        match escape(&input[i..]) {
            Some((evs, n)) => {
                events.extend(evs);
                i += n;
            }
            None => return (events, input[i..].to_string()),
        }
    }
    flush(&mut text, &mut events);
    (events, String::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn k(name: &str, ctrl: bool, alt: bool, shift: bool, cmd: bool) -> Ev {
        Ev::Key(Key { name: name.into(), ctrl, shift, alt, cmd })
    }

    #[test]
    fn plain_text_control_letters_and_arrows() {
        let (ev, rest) = parse("ab\x13\x1b[D\x1b[1;2C");
        assert_eq!(ev, vec![Ev::Text("ab".into()), k("s", true, false, false, false), key("left"), k("right", false, false, true, false)]);
        assert_eq!(rest, "");
    }

    #[test]
    fn kitty_csi_u_carries_the_command_bit_and_drops_releases() {
        let (ev, _) = parse("\x1b[115;9u\x1b[100;10u\x1b[27u\x1b[97;1:3u");
        assert_eq!(ev, vec![k("s", false, false, false, true), k("d", false, false, true, true), key("escape")]);
        assert_eq!(parse("\x1b[91;6u").0, vec![k("[", true, false, true, false)]);
    }

    #[test]
    fn sgr_mouse_wheel_and_motion() {
        let (ev, _) = parse("\x1b[<0;7;2M\x1b[<32;100;2M\x1b[<69;20;2M\x1b[<0;9;3m\x1b[<4;9;3M\x1b[<36;12;4M");
        let m = |button, x, y, release, motion, shift| Ev::Mouse(Mouse { button, x, y, release, motion, shift, ..Default::default() });
        assert_eq!(
            ev,
            vec![
                m(0, 7, 2, false, false, false),
                m(0, 100, 2, false, true, false),
                m(65, 20, 2, false, false, true),
                m(0, 9, 3, true, false, false),
                m(0, 9, 3, false, false, true), // Shift+press
                m(0, 12, 4, false, true, true), // Shift+drag
            ]
        );
    }

    #[test]
    fn sgr_mouse_alt_bit_extends_like_shift_and_ctrl_does_not() {
        let (ev, _) = parse("\x1b[<8;9;3M\x1b[<40;12;4M\x1b[<16;9;3M");
        let mice: Vec<Mouse> = ev.into_iter().filter_map(|e| if let Ev::Mouse(m) = e { Some(m) } else { None }).collect();
        assert_eq!(mice.iter().map(|m| (m.button, m.motion, m.alt, m.extend())).collect::<Vec<_>>(), [(0, false, true, true), (0, true, true, true), (0, false, false, false)], "⌥+press, ⌥+drag, Ctrl+press");
    }

    #[test]
    fn function_keys_paste_and_split_sequences() {
        assert_eq!(parse("\x1b[24~\x1b[15;3~\x1bOP").0, vec![key("f12"), k("f5", false, true, false, false), key("f1")]);
        assert_eq!(parse("\x1b[200~a\nb\x1b[201~").0, vec![Ev::Paste("a\nb".into())]);
        assert_eq!(parse("x\x1b[1;").1, "\x1b[1;");
        assert_eq!(parse("\x1b").0, vec![key("escape")]);
        assert_eq!(parse("\x1bb").0, vec![k("left", false, true, false, false)]);
    }

    #[test]
    fn chords_list_modifiers_in_a_fixed_order() {
        let Ev::Key(key) = k("k", true, true, true, true) else { unreachable!() };
        assert_eq!(key.chord(), "ctrl+alt+shift+cmd+k");
    }
}
