// The Image Viewer column right of the side panel (layouts/vscode.json: the `image-panel` block, props { imagePanel: true })
// and its zoom dialog (props { imageModal: { fit } }, opened by Expand): one picture filling the view, with Fit / Fit
// Width / Fit Height, zoom (− / % / +, ⌘/Ctrl+wheel, double-click), panning (drag, wheel) and the folder's other
// images (‹ ›). Both follow the space's image in the shared value STATE, so the dialog shows what the panel does.
// An image arrives by IMAGE_OPEN (vscode-explorer's menu item and its drag onto the panel button, through vscode-tabs'
// drag overlay), a drop from Finder, or Import (Herdr has only a folder picker: the folder's first image, then ‹ ›).
// Pictures go through the viewer's preview cache (preview.js cachePreview; a remote space's file is fetched first),
// the placing rules are imagefit.js'.
import { div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { props, shared, setShared, spaces, theme, exec, appHome, readTextFile, pickFolder, openOverlay, closeOverlay } from "herdr";
import { CACHE, pathHash, statOf, cachePreview, imageExt } from "./preview.js";
import { FITS, place, clampPan, zoomTo, zoomStep, pan, toggleFit, toggleZoom, imageSize, svgSize, imagesIn } from "./imagefit.js";

// { file, on, at }: show this image in the panel (vscode-explorer and vscode-tabs set it; taken once, within 5 s).
export const IMAGE_OPEN = "vscode-viewer.image-open";
// { [space id]: { file, on, fit } }: each space's image and its last fit, gone spaces dropped.
const STATE = "vscode-viewer.image-panel";
const ICONS = "mods/vscode-viewer/image";
const WHEEL_LINE = 40; // px per wheel line
const baseName = (p) => p.slice(p.lastIndexOf("/") + 1);
const folderOf = (p) => p.slice(0, p.lastIndexOf("/")) || "/";
const keyOf = (c) => c?.file ? `${c.on ?? ""}:${c.file}` : null;
// The first 256 KB's bytes (imagefit.js imageSize; a JPEG's size can follow a large EXIF block), or null.
async function headBytes(path) {
  const r = await exec("sh", ["-c", 'head -c 262144 "$1" | od -An -v -tu1', "sh", path]).catch(() => null);
  return r?.code === 0 ? r.stdout.trim().split(/\s+/).map(Number) : null;
}

export class ImagePanel {
  constructor(cx) {
    this.modal = props()?.imageModal ?? null;
    this.handle = cx.focus_handle();
    if (this.modal) this.handle.focus();
    this.want = null;     // the image asked for (keyOf), loaded or loading
    this.img = null;      // { file, on, path (for image()), dims: { width, height } | null }
    this.state = { fit: "contain", scale: 1, x: null, y: null }; // imagefit.js' view state
    this.view = null;     // the picture area's size
    this.list = null;     // { folder, on, names }: the images beside it
    this.busy = null; this.error = null; this.drag = null; this.taken = null;
  }

  space() { return spaces().find(s => s.active)?.id ?? null; }
  current() { return (shared(STATE) ?? {})[this.space()] ?? null; }
  // Merges `patch` into the shown space's entry.
  remember(patch) {
    const space = this.space(), all = shared(STATE) ?? {}, live = new Set(spaces().map(s => s.id));
    if (!space) return;
    setShared(STATE, { ...Object.fromEntries(Object.entries(all).filter(([k]) => live.has(k))), [space]: { ...all[space], ...patch } });
  }
  show(file, on) { this.want = null; this.remember({ file, on: on ?? null }); }

  // Copies the image into the cache, reads its size, then shows it at the space's fit (the dialog: the panel's).
  load(cur, cx) {
    const want = (this.want = keyOf(cur)), { file, on = null } = cur;
    this.busy = "Loading…"; this.error = null;
    cx.spawn(async cx => {
      try {
        const ext = imageExt(file);
        if (!ext) throw new Error(`${baseName(file)} is not an image`);
        const st = await statOf(exec, file, on);
        if (!st) throw new Error(`${baseName(file)} is no longer available`);
        const dir = `${appHome()}/${CACHE}`, id = pathHash(`image-panel:${on ?? ""}:${file}`);
        const made = await cachePreview(exec, { dir, id, file, on, kind: "image", ext, st,
          progress: p => { this.busy = `Fetching from ${on}… ${Math.round(p * 100)}%`; cx.notify(); } });
        const local = `${dir}/${made.shown}`;
        const dims = ext === "svg" ? svgSize(await readTextFile(local).catch(() => null)) : imageSize(await headBytes(local));
        if (this.want !== want) return;
        const fit = this.img ? cur.fit : this.modal?.fit ?? cur.fit;
        this.img = { file, on, path: `${CACHE}/${made.shown}`, dims };
        this.state = { fit: FITS.includes(fit) ? fit : "contain", scale: 1, x: null, y: null };
        if (this.list?.folder !== folderOf(file) || this.list?.on !== on) this.list = await this.siblings(folderOf(file), on);
      } catch (e) {
        if (this.want === want) { this.img = null; this.error = String(e?.message ?? e); }
      } finally {
        if (this.want === want) this.busy = null;
        cx.notify();
      }
    });
  }

  async siblings(folder, on) {
    const r = await exec("ls", ["-1", folder], { on }).catch(() => null);
    return { folder, on, names: r?.code === 0 ? imagesIn(r.stdout.split("\n"), n => Boolean(imageExt(n))) : [] };
  }

  // The folder's next (dir 1) or previous image, round.
  step(dir) {
    const l = this.list, n = l?.names.length ?? 0;
    if (!this.img || n < 2) return;
    const i = l.names.indexOf(baseName(this.img.file));
    this.show(`${l.folder === "/" ? "" : l.folder}/${l.names[(i + dir + n) % n]}`, l.on);
  }

  // Import: Herdr's folder picker (it has no file picker), then that folder's first image.
  importFolder(cx) {
    cx.spawn(async cx => {
      const folder = await pickFolder({ prompt: "Import" });
      if (!folder) return;
      const list = await this.siblings(folder, null);
      if (list.names.length) { this.list = list; this.show(`${folder === "/" ? "" : folder}/${list.names[0]}`, null); }
      else { this.error = `No images in ${baseName(folder) || folder}`; cx.notify(); }
    });
  }

  // A fit button's or key's change, kept as the space's fit; a hand zoom isn't kept.
  setState(next, cx) {
    this.state = next;
    if (next.fit && next.fit !== this.current()?.fit) this.remember({ fit: next.fit });
    cx.notify();
  }

  key(e, cx) {
    const d = this.img?.dims, v = this.view, k = e.key_char ?? e.key;
    if (e.modifiers.platform || e.modifiers.control) return;
    if (this.modal && e.key === "escape") return closeOverlay(props().overlay);
    if (e.key === "left" || e.key === "right") this.step(e.key === "left" ? -1 : 1);
    else if (!d || !v) return;
    else if (k === "+" || k === "=") this.setState(zoomStep(this.state, d, v, 1), cx);
    else if (k === "-" || k === "_") this.setState(zoomStep(this.state, d, v, -1), cx);
    else if (k === "0") this.setState(zoomTo(this.state, d, v, 1), cx);
    else if (FITS[["f", "w", "h"].indexOf(k.toLowerCase())]) this.setState(toggleFit(this.state, FITS[["f", "w", "h"].indexOf(k.toLowerCase())]), cx);
    else return;
    cx.stop_propagation();
  }

  // ⌘/Ctrl + wheel zooms at the pointer; a plain wheel pans a picture larger than the view.
  wheel(e, cx) {
    const d = this.img?.dims, v = this.view;
    if (!d || !v) return;
    const delta = e.delta_lines ? { x: e.delta_lines.x * WHEEL_LINE, y: e.delta_lines.y * WHEEL_LINE } : e.delta;
    if (e.modifiers.platform || e.modifiers.control) {
      const scale = place(this.state, d, v).scale * Math.exp(delta.y * 0.0025);
      this.setState(zoomTo(this.state, d, v, scale, e.local_position), cx);
    } else this.setState(pan(this.state, d, v, delta.x, delta.y), cx);
  }

  expand() {
    openOverlay({ mod: "vscode-viewer", kind: "dialog", width: 0.9, height: 0.9, props: { imageModal: { fit: this.state.fit ?? "contain" } } });
  }

  render(cx) {
    const t = theme();
    if (!this.modal) { // a request, taken once (setShared out of render)
      const ask = shared(IMAGE_OPEN);
      if (ask?.file && ask.at !== this.taken && Date.now() - ask.at < 5000) {
        this.taken = ask.at;
        cx.spawn(async () => this.show(ask.file, ask.on));
      }
    }
    const cur = this.current();
    if (keyOf(cur) !== this.want) {
      if (cur?.file) this.load(cur, cx);
      else { this.want = null; this.img = null; this.list = null; }
    }
    const d = this.img?.dims, v = this.view, ready = Boolean(d && v), p = ready ? place(this.state, d, v) : null;
    const button = (id, icon, label, action, { on = false, off = false } = {}) => div().id(id).size(24).flex_none().flex().items_center().justify_center().rounded(5)
      .text_color(off ? t.dim : on ? t.foreground : t.muted).when(on, el => el.bg(t.selected)).when(off, el => el.opacity(0.5))
      .when(!off, el => el.cursor_pointer().hover(s => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => action(cx)))
      .tooltip(label).accessibility_label(label).child(svg(`${ICONS}/${icon}.svg`).size(16));
    const fitButton = (fit, icon, label) => button(`image-fit-${fit}`, icon, label, cx => this.setState(toggleFit(this.state, fit), cx), { on: this.state.fit === fit, off: !ready });
    const zoom = (dir, cx) => this.setState(zoomStep(this.state, d, v, dir), cx);
    const count = this.list?.names.length ?? 0, at = this.img ? this.list?.names.indexOf(baseName(this.img.file)) ?? -1 : -1;
    const sep = () => div().w(1).h(14).mx(3).flex_none().bg(t.border);

    const title = h_flex().h(36).flex_none().pl(14).pr(6).gap(4).items_center().border_b(1).border_color(t.border)
      .child(div().flex_1().min_w(0).truncate().font_semibold().child(this.img ? baseName(this.img.file) : "Image Viewer"))
      .when(Boolean(d), el => el.child(div().flex_none().pr(4).text_size(11.5).text_color(t.dim).child(`${d.width} × ${d.height}`)))
      .when(!this.modal, el => el.child(button("image-import", "import", "Import… (a folder's images)", cx => this.importFolder(cx)))
        .child(button("image-expand", "expand", "Expand", () => this.expand(), { off: !this.img })))
      .when(Boolean(this.modal), el => el.child(button("image-close", "close", "Close (Esc)", () => closeOverlay(props().overlay))));
    const tools = h_flex().h(30).flex_none().px(6).gap(2).items_center().border_b(1).border_color(t.border)
      .when(count > 1, el => el.child(button("image-prev", "prev", "Previous image (←)", () => this.step(-1)))
        .child(div().flex_none().min_w(36).text_center().text_size(11.5).text_color(t.muted).child(`${at + 1} / ${count}`))
        .child(button("image-next", "next", "Next image (→)", () => this.step(1))))
      .child(div().flex_1())
      .child(fitButton("contain", "fit", "Fit (F)")).child(fitButton("width", "fit-width", "Fit Width (W)")).child(fitButton("height", "fit-height", "Fit Height (H)"))
      .child(sep())
      .child(button("image-zoom-out", "zoom-out", "Zoom Out (−)", cx => zoom(-1, cx), { off: !ready }))
      .child(div().id("image-zoom").h(24).min_w(46).px(4).flex_none().flex().items_center().justify_center().rounded(5).text_size(11.5)
        .text_color(ready ? t.muted : t.dim).when(ready, el => el.cursor_pointer().hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => this.setState(zoomTo(this.state, d, v, 1), cx)))
        .tooltip("Actual Size (0)").child(ready ? `${Math.round(p.scale * 100)}%` : "–"))
      .child(button("image-zoom-in", "zoom-in", "Zoom In (+)", cx => zoom(1, cx), { off: !ready }));

    const large = ready && (p.width > v.width + 0.5 || p.height > v.height + 0.5);
    const note = (text) => div().text_size(12).text_color(t.dim).text_center().child(text);
    const canvas = div().id(this.modal ? "image-modal-canvas" : "image-canvas").flex_1().min_h(0).relative().overflow_hidden().bg(t.canvas)
      .track_focus(this.handle)
      .on_size_change((s, cx) => { if (s.width !== v?.width || s.height !== v?.height) { this.view = s; cx.notify(); } })
      .on_key_down((e, cx) => this.key(e, cx))
      .on_drop((e, cx) => {
        const file = (e.paths ?? []).find(f => imageExt(f));
        if (file) this.show(file, null); else { this.error = "Drop an image file (PNG, JPEG, GIF, WebP, BMP, ICO, SVG, TIFF)"; cx.notify(); }
      })
      .on_scroll_wheel((e, cx) => this.wheel(e, cx))
      .on_mouse_down("left", (e, cx) => {
        this.handle.focus();
        if (!ready) return;
        if (e.click_count === 2) { this.drag = null; return this.setState(toggleZoom(this.state, d, v, e.local_position), cx); }
        if (large) this.drag = { at: e.position, x: p.x, y: p.y };
      })
      .on_mouse_move((e, cx) => {
        const g = this.drag;
        if (!g || !ready) return;
        this.state = { ...this.state, ...clampPan({ x: g.x + e.position.x - g.at.x, y: g.y + e.position.y - g.at.y }, d, v, p.scale) };
        cx.notify();
      })
      .on_mouse_up("left", (_e, cx) => { if (this.drag) { this.drag = null; cx.notify(); } })
      .on_hover((on) => { if (!on) this.drag = null; })
      .when(large, el => this.drag ? el.cursor_grabbing() : el.cursor_grab());
    const body = this.img
      ? ready
        ? canvas.child(image(this.img.path).absolute().left(p.x).top(p.y).w(p.width).h(p.height))
        // A size it couldn't read (TIFF, an odd file): shown whole, without zoom.
        : canvas.child(v_flex().size_full().items_center().justify_center().p(8).child(image(this.img.path).max_w("100%").max_h("100%")))
      : canvas.child(v_flex().size_full().items_center().justify_center().gap(8).p(20)
        .when(Boolean(this.busy || this.error), el => el.child(note(this.busy || this.error)))
        .when(!this.busy && !this.error, el => el.child(svg("mods/vscode-tabs/image.svg").size(36).text_color(t.dim))
          .child(note("Drop an image here, or drag one from the Explorer onto the image button above"))
          .child(h_flex().id("image-import-empty").h(26).px(10).gap(6).items_center().rounded(6).cursor_pointer().bg(t.raised).border_1().border_color(t.border)
            .text_size(12).text_color(t.foreground).hover(s => s.bg(t.hover)).on_click((_e, cx) => this.importFolder(cx))
            .child(svg(`${ICONS}/import.svg`).size(14)).child("Import Folder…"))));
    // A load over a shown image (or its failure) says so at the bottom without hiding the picture.
    const status = this.img && (this.busy || this.error);
    return v_flex().id(this.modal ? "image-modal" : "image-panel").size_full().min_h(0).overflow_hidden().bg(t.background).text_color(t.foreground).text_size(13)
      .when(!this.modal, el => el.rounded(10).border_1().border_color(t.border))
      .child(title).child(tools).child(body)
      .when(Boolean(status), el => el.child(div().h(22).flex_none().px(10).flex().items_center().border_t(1).border_color(t.border).text_size(11.5).text_color(t.dim).truncate().child(status)));
  }
}
