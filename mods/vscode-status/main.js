import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex, HoverCard } from "gpui-base";
import { spaces, agents, theme, run, window, keys, exec, readTextFile, appHome } from "herdr";

// Newest Codex rollout log that has a rate_limits event (local file, no network or token).
const CODEX_SCRIPT = 'for f in $(ls -t "$HOME"/.codex/sessions/*/*/*/rollout-*.jsonl 2>/dev/null | head -8); do l=$(grep \'"rate_limits"\' "$f" | tail -1); [ -n "$l" ] && { echo "$l"; break; }; done';

// A window whose reset time has passed is back to 0%.
const pad = (n) => String(n).padStart(2, "0");
const clock = (ms) => { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };

function windowLabel(w) {
  if (!w) return null;
  const ms = w.resets_at * 1000 - Date.now();
  const title = w.window_minutes >= 10080 ? "Weekly" : `${Math.round(w.window_minutes / 60)}-hour session`;
  if (!(ms > 0)) return { used: 0, name: "", title, reset: "window has reset" };
  const mins = Math.ceil(ms / 60000);
  const hours = Math.floor(mins / 60);
  // Weekly window: days + hours (hours + minutes once under a day); session window: hours + minutes.
  const name = w.window_minutes >= 10080 && hours >= 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h` : `${hours}h ${mins % 60}m`;
  return { used: Math.round(w.used_percent), name, title, reset: `resets ${clock(w.resets_at * 1000)} (${name} left)` };
}

// 29412.43 -> "29,412"
const credits = (b) => `${Math.round(Number(b)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;

export default class WorkspaceStatus extends View {
  init(_props, cx) {
    this.codex = null; this.claude = null;
    this.poll(cx); this.pollClaude(cx);
    cx.timer.every(60000, cx => this.poll(cx));
    cx.timer.every(10000, cx => this.pollClaude(cx));
  }

  // claude-usage.json is written by claude-usage-tap.sh (Claude Code's statusLine); until then "–".
  pollClaude(cx) {
    cx.spawn(async cx => {
      let wins = null;
      try {
        const text = await readTextFile(`${appHome()}/claude-usage.json`);
        const saved = text ? JSON.parse(text) : null, rl = saved?.rate_limits;
        this.claudeAt = saved?.at ? saved.at * 1000 : null;
        const win = (w, minutes) => {
          if (!w) return null;
          const at = typeof w.resets_at === "number" ? w.resets_at : Date.parse(w.resets_at) / 1000;
          return windowLabel({ used_percent: w.used_percentage ?? w.utilization ?? 0, window_minutes: minutes, resets_at: at });
        };
        if (rl) wins = [win(rl.five_hour, 300), win(rl.seven_day, 10080)].filter(Boolean);
      } catch {}
      this.claude = wins?.length ? wins : [{ name: "", used: null }];
      cx.notify();
    });
  }

  poll(cx) {
    cx.spawn(async cx => {
      try {
        const r = await exec("sh", ["-c", CODEX_SCRIPT]);
        const rl = r.code === 0 && r.stdout.trim() ? JSON.parse(r.stdout.trim()).payload?.rate_limits : null;
        this.codex = rl ? [windowLabel(rl.primary), windowLabel(rl.secondary)].filter(Boolean) : null;
        const c = rl?.credits;
        this.codexCredits = c?.has_credits && !c.unlimited && c.balance != null ? credits(c.balance) : null;
      } catch { this.codex = null; this.codexCredits = null; }
      cx.notify();
    });
  }

  // The palette key as actually bound, not a hardcoded one; without a
  // binding the hint stays useful ("commands") instead of lying.
  hint(t) {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? `${key}  commands` : "commands";
  }

  // The hover card for one provider: every window with its bar, usage and reset time.
  card(t, title, wins, extra, note) {
    const bar = (used, color) => div().w_full().h(6).rounded(3).bg(t.border).overflow_hidden().child(div().w(Math.max(2, Math.round(220 * used / 100))).h(6).rounded(3).bg(color));
    return v_flex().w(250).p(12).gap(10).rounded(8).bg(t.popover).border_1().border_color(t.border).text_size(12).text_color(t.foreground)
      .child(div().font_semibold().child(title))
      .children(wins.filter(w => w.used !== null).map(w => {
        const color = w.used >= 90 ? t.ansi1 : w.used >= 70 ? t.ansi3 : t.ansi2;
        return v_flex().gap(4)
          .child(h_flex().justify_between().child(div().child(w.title)).child(div().text_color(color).child(`${w.used}% used`)))
          .child(bar(w.used, color))
          .child(div().text_size(11).text_color(t.dim).child(w.reset));
      }))
      .when(wins.every(w => w.used === null), el => el.child(div().text_color(t.dim).child("No data yet. It appears once a session refreshes its status line.")))
      .when(Boolean(extra), el => el.child(h_flex().justify_between().child(div().text_color(t.muted).child("Credits")).child(div().child(extra))))
      .when(Boolean(note), el => el.child(div().text_size(11).text_color(t.dim).child(note)));
  }

  render() {
    const t = theme();
    const space = spaces().find(s => s.active);
    const list = agents();
    const needs = list.filter(a => a.status === "blocked").length;
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);
    return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), el => el.child(label("branch", space.branch)))
      .child(h_flex().gap(6).items_center().child(div().size(6).rounded(3).bg(t.dim)).child(`${list.length} agents`)
        .when(needs > 0, el => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))))
      .child(div().flex_1())
      .children([["claude", "Claude", this.claude, this.claudeCredits, this.claudeAt ? `Updated ${clock(this.claudeAt)}` : null], ["codex", "Codex", this.codex, this.codexCredits, null]].filter(([, , w]) => w?.length).map(([name, title, wins, extra, note]) =>
        HoverCard.new(`usage-${name}`).anchor("bottom_center").open_delay(200).trigger(
        h_flex().gap(6).items_center().child(image(`mods/vscode-status/${name}.svg`).w(13).h(13).flex_none())
          .children(wins.map(w => {
            if (w.used === null) return div().text_color(t.dim).child("–");
            const color = w.used >= 90 ? t.ansi1 : w.used >= 70 ? t.ansi3 : t.ansi2;
            return h_flex().gap(5).items_center()
              .when(Boolean(w.name), el => el.child(div().text_color(t.dim).child(w.name)))
              .child(div().w(40).h(5).rounded(3).bg(t.border).overflow_hidden().child(div().w(Math.max(2, Math.round(40 * w.used / 100))).h(5).rounded(3).bg(color)))
              .child(div().text_color(w.used >= 90 ? t.ansi1 : t.muted).child(`${w.used}%`));
          }))
          .when(Boolean(extra), el => el.child(div().text_color(t.dim).child(extra))))
        .content(this.card(t, title, wins, extra, note))))
      .child(div().id("palette").text_color(t.dim).on_click(() => run("app.palette")).child(this.hint(t)));
  }
}
