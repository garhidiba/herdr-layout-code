// The Image Viewer column right of the side panel (layouts/vscode.json: the `image-panel` block, props { imagePanel: true })
// and its zoom dialog (props { imageModal: { fit } }, opened by Expand): one picture filling the view, with Fit / Fit
// Width / Fit Height, zoom (− / % / +, ⌘/Ctrl+wheel, double-click), panning (drag, wheel) and the folder's other
// images (‹ ›). Both follow the space's image in the shared value STATE, so the dialog shows what the panel does.
// An image arrives by IMAGE_OPEN (vscode-explorer's menu item and its drag onto the panel button, through vscode-tabs'
// drag overlay), a drop from Finder, or Import (Herdr has only a folder picker: the folder's first image, then ‹ ›).
// Pictures go through the viewer's preview cache (preview.js cachePreview; a remote space's file is fetched first),
// the placing rules are imagefit.js'. A strong downscale is drawn from a resampled copy (Smooth, the default; imagefit.js
// resampleWidth). The two toolbar rows hide while the pointer is away (over the picture, fading), unless pinned. The
// column shares the layout's `side` row with the side panel, so Herdr's own gutter between them trades their widths.
import { div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { props, shared, setShared, spaces, theme, exec, appHome, readTextFile, pickFolder, openOverlay, closeOverlay, layout, run, window } from "herdr";
import { CACHE, pathHash, statOf, cachePreview, prune, imageExt } from "./preview.js";
import { FITS, place, clampPan, zoomTo, zoomStep, pan, toggleFit, nextFit, FIT_NAMES, imageSize, svgSize, imagesIn, resampleWidth, resampleName,
  scopeOf, stateKey, scopedEntry, withEntry, viewOf, fromView, drawnAt, widthToApply } from "./imagefit.js";

// { file, on, at }: show this image in the panel (vscode-explorer and vscode-tabs set it; taken once, within 5 s).
export const IMAGE_OPEN = "vscode-viewer.image-open";
// { [space id | "*"]: { file, on, fit, view } }: each space's image (or, in global scope, the one entry "*"), its last
// fit and its view (imagefit.js viewOf), gone spaces dropped. The scope is vscode-settings.json's "imageViewer.scope".
const STATE = "vscode-viewer.image-panel";
// Kept for every space and both views: the toolbar pinned (true) or hiding (default); Smooth downscales (default) or off.
const PINNED = "vscode-viewer.image-toolbar-pinned", SMOOTH = "vscode-viewer.image-smooth";
const ICONS = "mods/vscode-viewer/image";
// Device px per px (the screen's backing scale), for copies drawn 1:1: Herdr tells mods none, so it is asked of macOS
// (the main screen, again every 30 s: the window may move to another display) or Linux's GDK_SCALE; 1 otherwise.
let density = 1, densityAt = 0;
async function screenDensity() {
  if (Date.now() - densityAt < 30000) return density;
  densityAt = Date.now();
  const platform = window()?.platform;
  const r = platform === "macos" ? await exec("osascript", ["-l", "JavaScript", "-e", 'ObjC.import("AppKit"); $.NSScreen.mainScreen.backingScaleFactor']).catch(() => null)
    : platform === "linux" ? await exec("sh", ["-c", 'echo "${GDK_SCALE:-1}"']).catch(() => null) : null;
  const n = Number(r?.stdout?.trim());
  density = r?.code === 0 && n >= 1 && n <= 4 ? n : 1;
  return density;
}
// layouts/vscode.json's Image Viewer column and the row it shares with the side panel (which fills the rest of it).
const COLUMN = "image-panel", SIDE = "side";
// Here: resamples image $1 to $3 px wide as $2 (format $4), Lanczos through ImageMagick when installed, else macOS's sips;
// exits 3 with neither (the original is drawn then). Lands whole: written aside, then renamed. Herdr's PATH may leave magick out.
const RESAMPLE = `PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"; [ -f "$2" ] && exit 0
if command -v magick >/dev/null 2>&1; then magick "$1[0]" -filter Lanczos -resize "$3"x "$4:$2.part"
elif command -v convert >/dev/null 2>&1; then convert "$1[0]" -filter Lanczos -resize "$3"x "$4:$2.part"
elif command -v sips >/dev/null 2>&1; then sips -s format "$4" --resampleWidth "$3" "$1" --out "$2.part" >/dev/null
else exit 3; fi && mv "$2.part" "$2"`;
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
    this.hover = false; this.flashUntil = 0;
    this.scope = "space"; this.pending = null; this.seenView = null; this.saveToken = 0;
    // The scope setting, read now and every 2 s (the Settings dialog writes the file); the screen's density too (30 s).
    cx.spawn(async cx => {
      for (;;) {
        const before = density;
        if ((await screenDensity()) !== before) cx.notify();
        const scope = scopeOf(await readTextFile(`${appHome()}/vscode-settings.json`).catch(() => null));
        if (scope !== this.scope) { this.scope = scope; cx.notify(); }
        await cx.sleep(2000);
      }
    });
    this.sharp = null; this.sharpWant = null; this.sharpToken = 0; // the resampled copy shown, the one asked for
    this.widthKey = null; this.widthToken = 0; // the scope key whose width the column has
  }

  space() { return spaces().find(s => s.active)?.id ?? null; }
  current() { return scopedEntry(shared(STATE), this.scope, this.space()); }
  // What this view shows: its entry's key and image.
  wantKey(cur) { return cur?.file ? `${stateKey(this.scope, this.space())}|${keyOf(cur)}` : null; }
  // Merges `patch` into the shown entry (the space's, or the global one).
  remember(patch) {
    const space = this.space();
    if (space) setShared(STATE, withEntry(shared(STATE), this.scope, space, new Set(spaces().map(s => s.id)), patch));
  }
  show(file, on) { this.want = null; this.remember({ file, on: on ?? null, view: null }); }
  // The view, kept 300 ms after the last zoom or pan (the dialog keeps its own until it closes: close()).
  saveSoon(cx) {
    if (this.modal) return;
    const token = ++this.saveToken, want = this.want;
    cx.spawn(async cx => {
      await cx.sleep(300);
      if (token !== this.saveToken || want !== this.want) return; // another space or image meanwhile
      const view = this.keptView();
      if (!view) return;
      this.seenView = JSON.stringify(view);
      this.remember({ view, ...(view.fit ? { fit: view.fit } : {}) });
    });
  }
  keptView() { return this.img?.dims && this.view ? viewOf(this.state, this.img.dims, this.view) : null; }
  // Herdr ends this copy (the dialog closing, by any way): the dialog hands its view back to the panel.
  close() {
    const view = this.modal && this.keptView();
    if (view) this.remember({ view, ...(view.fit ? { fit: view.fit } : {}) });
  }

  // Copies the image into the cache, reads its size, then shows it at the space's fit (the dialog: the panel's).
  load(cur, cx) {
    const want = (this.want = this.wantKey(cur)), { file, on = null } = cur;
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
        // Its kept view (the dialog's first picture: the panel's), applied once the view's size is known (render).
        const first = !this.img && this.modal, fit = first ? this.modal.fit ?? cur.fit : cur.fit;
        this.pending = (first ? this.modal.view : cur.view) ?? { fit: FITS.includes(fit) ? fit : "contain" };
        this.seenView = JSON.stringify(cur.view ?? null);
        this.img = { file, on, path: `${CACHE}/${made.shown}`, dims, local, id, st, ext };
        // A new picture shows the toolbar for a moment.
        this.flashUntil = Date.now() + 1500;
        cx.spawn(async cx => { await cx.sleep(1600); cx.notify(); });
        this.state = fromView(null);
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
    this.saveSoon(cx);
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

  // Asks for the copy at `width` (null: none) 150 ms after the last change of it; the shown copy stays until it lands.
  wantSharp(width, cx) {
    const img = this.img, ask = width && `${img.path}@${width}`;
    if (ask === this.sharpWant) return;
    this.sharpWant = ask;
    const token = ++this.sharpToken;
    if (!ask) return;
    cx.spawn(async cx => {
      await cx.sleep(150);
      if (token !== this.sharpToken) return;
      const dir = `${appHome()}/${CACHE}`, [name, format] = resampleName(img.id, img.st, width, img.ext);
      const r = await exec("sh", ["-c", RESAMPLE, "sh", img.local, `${dir}/${name}`, String(width), format]).catch(() => null);
      if (r?.code !== 0 || this.img?.path !== img.path) return;
      this.sharp = { of: img.path, path: `${CACHE}/${name}`, width };
      cx.notify();
      await prune(exec, dir, [name, img.path.split("/").pop()]).catch(() => {});
    });
  }

  // The column's width is kept per scope (the entry's `width`): a new scope key (another space, or the scope switched)
  // gives the column that key's width, when it has one; dragging keeps the new width there (saveWidth). The `side` row
  // grows by as much while the column shows, so the side panel keeps its width.
  applyWidth(cur, cx) {
    const key = this.modal ? null : stateKey(this.scope, this.space());
    if (!key || key === this.widthKey) return;
    this.widthKey = key;
    const tree = layout(), column = findNode(tree, COLUMN), now = column?.size?.px ?? null, px = widthToApply(cur, now);
    const side = column && !column.hidden ? findNode(tree, SIDE)?.size?.px : null;
    if (!px) return;
    cx.spawn(async () => {
      if (side && now) run("layout.resize", { id: SIDE, px: Math.round(side + px - now) });
      run("layout.resize", { id: COLUMN, px });
    });
  }
  columnPx() { return findNode(layout(), COLUMN)?.size?.px ?? null; }
  // After the column's size settles (300 ms), its layout width into the entry, when it changed.
  saveWidth(cx) {
    if (this.modal) return;
    const token = ++this.widthToken, key = this.widthKey;
    cx.spawn(async cx => {
      await cx.sleep(300);
      const px = this.columnPx();
      if (token !== this.widthToken || key !== this.widthKey || !px || Math.round(px) === this.current()?.width) return;
      this.remember({ width: Math.round(px) });
    });
  }

  expand() {
    openOverlay({ mod: "vscode-viewer", kind: "dialog", width: 0.9, height: 0.9, props: { imageModal: { fit: this.state.fit ?? "contain", view: this.keptView() } } });
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
    if (this.wantKey(cur) !== this.want) {
      if (cur?.file) this.load(cur, cx);
      else { this.want = null; this.img = null; this.list = null; }
    } else if (!this.modal && this.img && JSON.stringify(cur?.view ?? null) !== this.seenView) {
      // A view kept by someone else (the dialog closing): shown here too.
      this.seenView = JSON.stringify(cur?.view ?? null);
      this.pending = cur?.view ?? null;
    }
    const d = this.img?.dims, v = this.view, ready = Boolean(d && v);
    if (ready && this.pending) { this.state = fromView(this.pending, d, v); this.pending = null; }
    const p = ready ? place(this.state, d, v) : null;
    const smooth = shared(SMOOTH) !== false, pinned = shared(PINNED) === true;
    const sharpWidth = ready && smooth ? resampleWidth(d, p.width, density, this.img.ext) : null;
    if (this.img) this.wantSharp(sharpWidth, cx);
    // The copy for this size (or an older one, until the new lands), else the original.
    const copy = sharpWidth && this.sharp?.of === this.img?.path ? this.sharp : null;
    const src = copy ? copy.path : this.img?.path, drawn = ready ? drawnAt(p, density) : null;
    this.applyWidth(cur, cx);
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
      .child(button("image-smooth", "smooth", smooth ? "Interpolation: Smooth (resampled downscales) · click for Off" : "Interpolation: Off (GPU scaling) · click for Smooth",
        () => setShared(SMOOTH, !smooth), { on: smooth }))
      .child(button("image-pin", "pin", pinned ? "Auto-hide the toolbar" : "Keep the toolbar visible", () => setShared(PINNED, !pinned), { on: pinned }))
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
        if (e.click_count === 2) {
          const fit = nextFit(this.state, d, v);
          this.drag = null; this.label = { text: FIT_NAMES[fit], until: Date.now() + 1000 };
          cx.spawn(async cx => { await cx.sleep(1050); cx.notify(); });
          return this.setState(toggleFit({ fit: null }, fit), cx);
        }
        if (large) this.drag = { at: e.position, x: p.x, y: p.y };
      })
      .on_mouse_move((e, cx) => {
        const g = this.drag;
        if (!g || !ready) return;
        this.setState({ ...this.state, ...clampPan({ x: g.x + e.position.x - g.at.x, y: g.y + e.position.y - g.at.y }, d, v, p.scale) }, cx);
      })
      .on_mouse_up("left", (_e, cx) => { if (this.drag) { this.drag = null; cx.notify(); } })
      .on_hover((on) => { if (!on) this.drag = null; })
      .when(large, el => this.drag ? el.cursor_grabbing() : el.cursor_grab());
    const body = this.img
      ? ready
        ? canvas.child(image(src).absolute().left(drawn.x).top(drawn.y).w(drawn.width).h(drawn.height))
          // The fit a double-click picked, named for a moment in the middle of the picture.
          .when(Boolean(this.label && Date.now() < this.label.until), el => el.child(div().absolute().top(0).left(0).right(0).bottom(0).flex().items_center().justify_center()
            .child(div().px(12).py(5).rounded(8).bg(t.popover).border_1().border_color(t.border).text_size(13).text_color(t.foreground).child(this.label.text))))
        // A size it couldn't read (TIFF, an odd file): shown whole, without zoom.
        : canvas.child(v_flex().size_full().items_center().justify_center().child(image(this.img.path).max_w("100%").max_h("100%")))
      : canvas.child(v_flex().size_full().items_center().justify_center().gap(8).p(20)
        .when(Boolean(this.busy || this.error), el => el.child(note(this.busy || this.error)))
        .when(!this.busy && !this.error, el => el.child(svg("mods/vscode-tabs/image.svg").size(36).text_color(t.dim))
          .child(note("Drop an image here, or drag one from the Explorer onto the image button above"))
          .child(h_flex().id("image-import-empty").h(26).px(10).gap(6).items_center().rounded(6).cursor_pointer().bg(t.raised).border_1().border_color(t.border)
            .text_size(12).text_color(t.foreground).hover(s => s.bg(t.hover)).on_click((_e, cx) => this.importFolder(cx))
            .child(svg(`${ICONS}/import.svg`).size(14)).child("Import Folder…"))));
    // A load over a shown image (or its failure) says so at the bottom without hiding the picture.
    const status = this.img && (this.busy || this.error);
    // The rows lie over the picture's top, taking no room from it (a fit touches the walls): pinned always shown, else
    // while the pointer is in the view, for a moment after a new picture, and while there is none.
    const showBars = pinned || this.hover || !this.img || Date.now() < this.flashUntil;
    const bars = v_flex().id("image-bars").absolute().top(0).left(0).right(0).bg(t.background).child(title).child(tools)
      .opacity(showBars ? 0.94 : 0).transition("opacity", 160);
    const card = v_flex().id(this.modal ? "image-modal" : "image-panel").min_h(0).relative().overflow_hidden().bg(t.background).text_color(t.foreground).text_size(13)
      .when(Boolean(this.modal), el => el.size_full()).when(!this.modal, el => el.flex_1().min_w(0).h_full().rounded(10).border_1().border_color(t.border))
      .on_hover((on, cx) => { if (on !== this.hover) { this.hover = on; cx.notify(); } })
      .on_mouse_move((_e, cx) => { if (!this.hover) { this.hover = true; cx.notify(); } })
      .child(body).child(bars)
      // The Explorer's card look: GPUI clips children to the rectangle only, so the picture's corners are covered by a
      // ring in the color behind the card (inner radius 10), then the card's 1px border is drawn over it.
      .when(!this.modal, el => el.child(div().absolute().top(-10).left(-10).right(-10).bottom(-10).rounded(20).border(10).border_color(t.canvas))
        .child(div().absolute().top(0).left(0).right(0).bottom(0).rounded(10).border_1().border_color(t.border)))
      .when(Boolean(status), el => el.child(div().absolute().left(0).right(0).bottom(0).h(22).px(10).bg(t.background).opacity(0.94).flex().items_center().border_t(1).border_color(t.border).text_size(11.5).text_color(t.dim).truncate().child(status)));
    if (this.modal) return card;
    return h_flex().id("image-column").size_full().min_h(0).on_size_change((_s, cx) => this.saveWidth(cx)).child(card);
  }
}

// A layout node by id, or null.
function findNode(n, id) { return n?.id === id ? n : (n?.children ?? []).map(c => findNode(c, id)).find(Boolean) ?? null; }
