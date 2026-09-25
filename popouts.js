const { app, BrowserWindow, screen } = require("electron");
const fs = require("fs");
const path = require("path");
const { writeFileAtomic } = require("./layouts");

// Callbacks into main.js (set once via init): the main window to dock back into, and whether the
// app is quitting (a quit closes popouts without docking them back).
let getMainWin = () => null;
let isQuitting = () => false;
function init(opts) {
  getMainWin = opts.getMainWin;
  isQuitting = opts.isQuitting;
}

/* ---- popped-out terminal windows ----
   A torn-off terminal is just another window attaching to a PTY that already
   lives in the main process (by id), via the same replay-buffer reattach the main
   window uses after a reload. The session never restarts. Closing the popout
   (button or Alt+F4 / Cmd+W) docks it back into the main grid rather than killing it. */
const popouts = new Map();   // ptyId -> BrowserWindow
const popoutCfg = new Map(); // ptyId -> live cfg (mutated by rename/recolor so dock-back carries the changes)

/* ---- "pop out all" window group ----
   The windows from one "pop out all" move together as a single unit until a window is
   unpinned. Dragging any pinned member shifts every other pinned member by the same
   delta, so the whole set can be dragged onto another monitor in one motion. */
const winGroup = new WeakMap(); // BrowserWindow -> { groupId, pinned, last:{x,y}, suppressUntil }
let groupSeq = 0;
function nextGroupId() { return "grp" + ++groupSeq; }
function groupMembers(groupId) {
  const out = [];
  for (const w of popouts.values()) {
    if (w.isDestroyed()) continue;
    const st = winGroup.get(w);
    if (st && st.groupId === groupId) out.push(w);
  }
  return out;
}
function attachGroupMove(w) {
  w.on("move", () => {
    if (w.isDestroyed()) return;
    const st = winGroup.get(w);
    if (!st) return;
    const b = w.getBounds();
    const now = Date.now();
    // Detached window, or the echo 'move' from our own programmatic shift: just track, don't propagate.
    if (!st.pinned || now < (st.suppressUntil || 0)) { st.last = { x: b.x, y: b.y }; return; }
    const dx = b.x - st.last.x, dy = b.y - st.last.y;
    st.last = { x: b.x, y: b.y };
    if (dx === 0 && dy === 0) return;
    for (const other of groupMembers(st.groupId)) {
      if (other === w) continue;
      const ost = winGroup.get(other);
      if (!ost || !ost.pinned) continue;
      const ob = other.getBounds();
      const nx = ob.x + dx, ny = ob.y + dy;
      ost.suppressUntil = now + 150; // swallow the echo 'move' this setBounds triggers
      ost.last = { x: nx, y: ny };
      try { other.setBounds({ x: nx, y: ny, width: ob.width, height: ob.height }); } catch { /* ignore */ }
    }
  });
}
// Tile every pinned member across the monitor the given window sits on, reproducing the
// in-app grid at full size. Drives "maximize/snap = fill this monitor with the grid".
function tileGroupToDisplay(w) {
  const st = winGroup.get(w);
  if (!st || w.isDestroyed()) return;
  const wa = screen.getDisplayMatching(w.getBounds()).workArea;
  const layout = st.layout || 4;
  const now = Date.now();
  for (const m of groupMembers(st.groupId)) {
    const mst = winGroup.get(m);
    if (!mst || !mst.pinned) continue;
    const r = tileRect(layout, mst.slot || 0, wa);
    mst.suppressUntil = now + 400; // absorb the move/resize echoes from tiling so they don't drive the group
    mst.last = { x: r.x, y: r.y };
    try { if (m.isMaximized()) m.unmaximize(); m.setBounds(r); } catch { /* ignore */ }
  }
}

function popoutBoundsFile() { return path.join(app.getPath("userData"), "popout-bounds.json"); }
function loadPopoutBounds() { try { return JSON.parse(fs.readFileSync(popoutBoundsFile(), "utf8")) || {}; } catch { return {}; } }
function savePopoutBounds(obj) { try { writeFileAtomic(popoutBoundsFile(), JSON.stringify(obj)); } catch { /* ignore */ } }
function setPopoutBounds(key, patch) { if (!key) return; const all = loadPopoutBounds(); all[key] = { ...all[key], ...patch }; savePopoutBounds(all); }

// Tile rect for pane `slot` of a grid `layout` within a display work area. Mirrors the in-app
// grid: 1/2/3 across in one row; 4 = 2x2, 6 = 3x2, 8 = 4x2 (row-major), with a small gap between windows.
function tileRect(layout, slot, wa) {
  const gap = 8;
  const cols = layout === 4 ? 2 : layout === 6 ? 3 : layout === 8 ? 4 : layout;
  const rows = layout >= 4 ? 2 : 1;
  const col = slot % cols;
  const row = Math.floor(slot / cols);
  const w = Math.floor(wa.width / cols);
  const h = Math.floor(wa.height / rows);
  return { x: wa.x + col * w + gap / 2, y: wa.y + row * h + gap / 2, width: w - gap, height: h - gap };
}

function createPopout(cfg) {
  cfg = cfg || {};
  const saved = loadPopoutBounds()[cfg.key] || {};
  const b = cfg.bounds || {}; // explicit bounds (drag-drop point or "pop out all" tiling) win over saved
  const onTop = !!saved.alwaysOnTop;
  const w = new BrowserWindow({
    width: b.width || saved.width || 760,
    height: b.height || saved.height || 620,
    x: typeof b.x === "number" ? b.x : (typeof saved.x === "number" ? saved.x : undefined),
    y: typeof b.y === "number" ? b.y : (typeof saved.y === "number" ? saved.y : undefined),
    minWidth: 360,
    minHeight: 220,
    show: false,
    title: cfg.name || "Terminal",
    icon: path.join(__dirname, "assets", "logo.png"),
    backgroundColor: cfg.bg || "#0E0E11",
    frame: false, // frameless; custom titlebar in popout.html
    alwaysOnTop: onTop,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // keep painting PTY output while minimized / behind other windows
    },
  });
  w.removeMenu();
  if (saved.locked) w.setMovable(false);
  w.loadFile("popout.html", { query: {
    ptyId: String(cfg.ptyId || ""),
    shell: String(cfg.shell || ""),
    cwd: String(cfg.cwd || ""),
    name: String(cfg.name || ""),
    themeKey: String(cfg.themeKey || ""),
    convoId: String(cfg.convoId || ""),
    key: String(cfg.key || ""),
    alwaysOnTop: onTop ? "1" : "",
    locked: saved.locked ? "1" : "",
    grouped: cfg.grouped ? "1" : "",
    neon: cfg.neon ? "1" : "",
  } });
  w.once("ready-to-show", () => w.show());
  popouts.set(cfg.ptyId, w);
  popoutCfg.set(cfg.ptyId, cfg);
  if (cfg.grouped) {
    const gb = w.getBounds();
    winGroup.set(w, { groupId: cfg.groupId, pinned: true, last: { x: gb.x, y: gb.y }, suppressUntil: 0, slot: cfg.slot || 0, layout: cfg.layout || 4 });
    attachGroupMove(w);
    // Maximizing/snapping a grouped window fills the monitor with the whole grid, not just this pane.
    w.on("maximize", () => { const st = winGroup.get(w); if (st && st.pinned) tileGroupToDisplay(w); });
  }

  let boundsT;
  const saveBounds = () => {
    clearTimeout(boundsT);
    boundsT = setTimeout(() => { if (!w.isDestroyed()) { const b = w.getBounds(); setPopoutBounds(cfg.key, { x: b.x, y: b.y, width: b.width, height: b.height }); } }, 300);
  };
  w.on("move", saveBounds);
  w.on("resize", saveBounds);
  w.on("close", () => {
    clearTimeout(boundsT);
    if (!w.isDestroyed()) { const b = w.getBounds(); setPopoutBounds(cfg.key, { x: b.x, y: b.y, width: b.width, height: b.height }); }
    // dock the live terminal back into the main window instead of dropping the session; send the
    // live cfg so a rename/recolor made in the popout carries back into the grid
    const main = getMainWin();
    if (!isQuitting() && main && !main.isDestroyed()) main.webContents.send("popout-redock", popoutCfg.get(cfg.ptyId));
  });
  w.on("closed", () => { popouts.delete(cfg.ptyId); popoutCfg.delete(cfg.ptyId); });
  return w.id;
}

module.exports = { init, popouts, popoutCfg, winGroup, createPopout, tileRect, tileGroupToDisplay, nextGroupId, setPopoutBounds };
