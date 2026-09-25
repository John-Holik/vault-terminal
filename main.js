const { app, BrowserWindow, ipcMain, dialog, shell, screen, Tray, Menu, nativeImage, clipboard, Notification } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const pty = require("@lydell/node-pty");
const shells = require("./shells");
const hooks = require("./hooks");
const sessions = require("./sessions");
const settings = require("./settings");
const layouts = require("./layouts");
const popoutsMod = require("./popouts");
const { popouts, popoutCfg, winGroup, createPopout, tileRect, tileGroupToDisplay, nextGroupId, setPopoutBounds } = popoutsMod;

const SMOKE = process.env.VT_SMOKE === "1";
// Smoke runs get a throwaway profile so they never restore (and respawn) the user's real panes.
if (SMOKE) app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "vt-smoke-")));

// Settings snapshot for the preload, answered synchronously. Registered at load so it exists
// before any window (main or popout) runs its preload.
ipcMain.on("settings-get", (e) => { e.returnValue = settings.get(); });

let win;
let tray = null;
let isQuitting = false;

popoutsMod.init({ getMainWin: () => win, isQuitting: () => isQuitting });

// Broadcast to every open window (main + any popped-out terminal windows).
function sendAll(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

// Route a PTY message to just the window showing that pane: its popout if popped out, then the
// window that owns the pane (see ptyOwner), else the main grid window. Avoids broadcasting every
// pane's output to every window.
function sendPty(id, channel, payload) {
  const pop = popouts.get(id);
  if (pop && !pop.isDestroyed()) { pop.webContents.send(channel, payload); return; }
  const owner = ptyOwner.get(id);
  if (owner && !owner.isDestroyed()) { owner.send(channel, payload); return; }
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/* ---- run-in-background (tray) ----
   Closing the app while terminals are live doesn't quit: it hides the window (and any
   popped-out terminals) to the tray / menu bar so the PTY processes keep running and finish
   their work. Reopening from the tray shows everything exactly where it was, since the
   renderer was never torn down. A real quit only happens from the tray menu (or when no
   terminals are running). */
// Popouts hideApp hid. showApp re-shows only these, so a Dock click (macOS activate) never
// un-minimizes a popout the user minimized (macOS isVisible() is false for a minimized window).
const hiddenPopouts = new Set();
function showApp() {
  if (!win || win.isDestroyed()) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  for (const w of hiddenPopouts) { if (!w.isDestroyed()) w.show(); }
  hiddenPopouts.clear();
}
function hideApp() {
  if (win && !win.isDestroyed()) win.hide();
  for (const w of popouts.values()) { if (!w.isDestroyed()) { w.hide(); hiddenPopouts.add(w); } }
}
function createTray() {
  if (tray) return;
  // macOS menu bar wants a monochrome template image (the "Template" filename suffix marks it; the
  // @2x sibling is picked up automatically). Windows/Linux use the color icon.
  const icon = nativeImage.createFromPath(path.join(__dirname, "assets", process.platform === "darwin" ? "trayTemplate.png" : "tray.png"));
  tray = new Tray(icon);
  tray.setToolTip("Vault Terminal — terminals running in background");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open Vault Terminal", click: () => showApp() },
    { type: "separator" },
    { label: "Quit (stops all terminals)", click: () => quitApp() },
  ]));
  tray.on("click", () => showApp());
  tray.on("double-click", () => showApp());
}

// Window chrome per OS: Windows draws its min/max/close over our 40px header (titleBarOverlay),
// macOS insets the traffic lights into it, Linux keeps the normal frame.
function windowChrome() {
  if (process.platform === "win32") return { titleBarStyle: "hidden", titleBarOverlay: { color: "#0E0E11", symbolColor: "#9A9AA6", height: 40 } };
  if (process.platform === "darwin") return { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 14, y: 16 } };
  return { frame: true };
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 920,
    minHeight: 600,
    show: false,
    title: "Vault Terminal",
    icon: path.join(__dirname, "assets", "logo.png"),
    backgroundColor: "#0E0E11",
    ...windowChrome(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // keep processing PTY output while hidden to the tray
    },
  });
  win.removeMenu();
  win.maximize();
  win.show();
  win.loadFile("index.html");

  // The UI never opens browser windows itself (popouts are real BrowserWindows created in main),
  // so route any http(s) window.open to the OS browser and deny everything else.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  // A plain <a href="http..."> click is an in-page navigation, not a window.open: without this it
  // would navigate the whole app window away. Send those to the OS browser and keep the app where it is.
  win.webContents.on("will-navigate", (e, url) => {
    if (/^https?:\/\//i.test(url)) { e.preventDefault(); shell.openExternal(url); }
  });

  // Close semantics:
  //   quitting            -> close for real
  //   macOS               -> hide (the Dock icon stays; activate re-shows); tray only while PTYs are live
  //   Windows / Linux     -> hide to tray while PTYs are live and closeToTray is on, else close (app quits)
  win.on("close", (e) => {
    if (isQuitting) return;
    const toTray = ptys.size > 0 && settings.get().closeToTray;
    if (process.platform === "darwin") {
      e.preventDefault();
      if (toTray) createTray();
      // Hiding a native-fullscreen window leaves its Space black: leave fullscreen first, hide after.
      if (win.isFullScreen()) {
        win.once("leave-full-screen", () => { if (!win.isDestroyed()) win.hide(); });
        win.setFullScreen(false);
      } else win.hide();
      return;
    }
    if (!toTray) return;
    e.preventDefault();
    createTray();
    hideApp();
  });
  // Main window closed for good on Windows/Linux: quit, so open popouts can't keep a windowless app alive.
  win.on("closed", () => { if (!isQuitting && process.platform !== "darwin") app.quit(); });

  bindDevHotkeys(win);
}

// macOS needs an application menu for Cmd+C/V/Q/W and window management; elsewhere there is none.
// fileMenu on macOS is Close Window (Cmd+W): a popout docks back, the main window hides.
function setAppMenu() {
  if (process.platform === "darwin") Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: "appMenu" }, { role: "fileMenu" }, { role: "editMenu" }, { role: "windowMenu" }]));
  else Menu.setApplicationMenu(null);
}

// Full relaunch (restart button / Shift+F5):
//   - Destroy (not close) every window so no renderer can veto the shutdown after PTYs are gone.
//   - app.relaunch() fires when THIS process exits, but this process still holds the
//     single-instance lock; release it so the fresh instance can take it.
//   - Unconditional short app.exit(0) failsafe so the scheduled relaunch always fires.
let relaunching = false;
// Ask the main window to flush its live layout snapshot (with reconciled, post-/clear convoIds)
// to disk NOW and wait for it, so the restore after relaunch reads the freshest arrangement.
// Bounded so a hung renderer can never block the relaunch. Always resolves.
function flushWindowLayout(w, ms = 700) {
  if (!w || w.isDestroyed()) return Promise.resolve();
  let wc; try { wc = w.webContents; } catch { return Promise.resolve(); }
  if (!wc || wc.isDestroyed()) return Promise.resolve();
  const flush = wc.executeJavaScript(
    "(window.vtFlushLayout ? window.vtFlushLayout() : Promise.resolve())"
  ).catch(() => {});
  return Promise.race([flush, new Promise((r) => setTimeout(r, ms))]);
}
async function relaunchApp() {
  if (relaunching) return; // a double-click / hotkey mash must not schedule two relaunches
  relaunching = true;
  isQuitting = true; // disarm the "hide to tray on close" veto in win.on("close")
  app.relaunch();
  // Flush the working layout BEFORE anything is torn down, so the post-restart restore resumes
  // the conversations the panes are actually on.
  try { await flushWindowLayout(win); } catch { /* ignore */ }
  try { killAllPtys(); } catch { /* ignore */ }
  if (tray) { try { tray.destroy(); } catch { /* ignore */ } tray = null; }
  for (const w of BrowserWindow.getAllWindows()) { try { if (!w.isDestroyed()) w.destroy(); } catch { /* ignore */ } }
  try { app.releaseSingleInstanceLock(); } catch { /* ignore */ }
  app.quit();
  setTimeout(() => app.exit(0), 800); // failsafe: end the process so the scheduled relaunch fires
}
// Tray "Quit": flush the layout (fresh convoIds) before the quit tears down PTYs, so a later
// cold boot restores the exact conversations. before-quit still runs killAllPtys.
async function quitApp() {
  if (isQuitting) return;
  isQuitting = true; // disarm the hide-to-tray veto so the windows actually close
  try { await flushWindowLayout(win); } catch { /* ignore */ }
  app.quit();
}
// Dev hotkeys (fire even when an xterm pane has focus): F5 reloads the UI after the renderer
// flushes its layout, Shift+F5 is a full relaunch (picks up main.js/preload.js changes), F12 devtools.
function bindDevHotkeys(w) {
  w.webContents.on("before-input-event", (e, input) => {
    if (input.type !== "keyDown" || (input.key !== "F5" && input.key !== "F12")) return;
    e.preventDefault();
    if (input.isAutoRepeat) return; // a held key acts once (held F5 would reload into a booting page)
    if (input.key === "F5" && input.shift) relaunchApp();
    else if (input.key === "F5") w.webContents.send("hotkey-reload");
    else w.webContents.toggleDevTools();
  });
}

/* ---- embedded terminals (xterm.js <-> node-pty) ---- */
const ptys = new Map();
const ptyBuf = new Map(); // id -> recent output, replayed to re-attach panes after a renderer reload
const ptyChunkSeq = new Map(); // id -> count of data chunks ever appended to ptyBuf. Monotonic (a buffer trim never rewinds it); lets a reattaching renderer order live pty-data against a pty-replay snapshot
const ptyMeta = new Map(); // id -> { shell, cwd, cols, rows, lastDataAt }
const ptyOwner = new Map(); // id -> webContents of the window currently hosting the pane. Routes pty-data via sendPty; reassigned on adopt.
const PTY_BUF_CAP = 262144; // ~256 KB of scrollback per pane
let ptySeq = 0;
// Per-run prefix for pty ids. ptyIds are persisted in term-layout.json (that's how an F5 reattaches
// to live panes), but the counter restarts at 1 every launch, so a stale id from a previous run
// could otherwise match a live pane this run. Same-run ids still match, so F5 reattach works.
const PTY_RUN = crypto.randomUUID().slice(0, 8);

function spawnPty({ shell, cwd, cols, rows, resumeId, sessionId, paneKey }) {
  const cfg = settings.get();
  // A resume id from another machine (or a deleted session) won't exist locally and
  // `claude --resume` aborts with "No conversation found". Fall back to a fresh session
  // so the pane still opens. The fresh session reuses the requested id: no local transcript has it,
  // so --session-id can't collide, and the renderer's convoId stays correct even with hooks off.
  if (shell === "claude" && resumeId && !sessions.claudeSessionExists(resumeId)) {
    if (!sessionId) sessionId = resumeId;
    resumeId = null;
  }
  // Claude panes get the app's pane hooks via --settings (hooks.js); Claude merges them with the user's own.
  const settingsFile = shell === "claude" && cfg.claudeHooks ? hooks.settingsArg() : null;
  const { file, args } = shells.shellArgv(shell, { resumeId, sessionId, skipPermissions: cfg.claudeSkipPermissions, settingsFile });
  const id = "p" + PTY_RUN + "-" + ++ptySeq;
  const dir = cwd && fs.existsSync(cwd) ? cwd : cfg.defaultCwd;
  const env = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" };
  if (process.platform === "darwin" && !env.LANG) env.LANG = "en_US.UTF-8";
  // Drop pane tags inherited from a parent terminal (this app launched from inside another tagged
  // Claude pane), so its hooks can't write this pane's session under the parent's key. Also drop
  // CLAUDECODE: every pane is its own top-level session, not a nested one.
  for (const k of ["VT_PANE_KEY", "VT_PANE_DIR", "VCC_PANE_KEY", "VCC_PANE_DIR", "CLAUDECODE"]) delete env[k];
  // Tag Claude panes so the pane-session SessionStart hook can report this pane's current
  // session id back to us (it rotates on /clear, /resume, compaction).
  if (shell === "claude" && paneKey && settingsFile) {
    env.VT_PANE_KEY = paneKey;
    env.VT_PANE_DIR = sessions.paneSessionsDir();
  }
  const proc = pty.spawn(file, args, {
    name: "xterm-256color",
    cols: cols || 80,
    rows: rows || 24,
    cwd: dir,
    env,
  });
  ptys.set(id, proc);
  ptyMeta.set(id, { shell: shell || "claude", cwd: dir, cols: cols || 80, rows: rows || 24, lastDataAt: Date.now() });
  // agent shells may run with approvals disabled, so log every agent spawn
  if (!shell || shell === "claude" || shell === "codex") console.log(`[agent-spawn] ${shell || "claude"} id=${id} cwd=${dir}`);
  proc.onData((data) => {
    let b = (ptyBuf.get(id) || "") + data;
    if (b.length > PTY_BUF_CAP) b = b.slice(-PTY_BUF_CAP);
    ptyBuf.set(id, b);
    const seq = (ptyChunkSeq.get(id) || 0) + 1; // seq N == "ptyBuf now holds chunks 1..N"; pty-replay returns the matching snapshot seq
    ptyChunkSeq.set(id, seq);
    const mm = ptyMeta.get(id); if (mm) mm.lastDataAt = Date.now();
    sendPty(id, "pty-data", { id, data, seq });
  });
  proc.onExit(({ exitCode }) => {
    ptys.delete(id);
    ptyBuf.delete(id);
    ptyChunkSeq.delete(id);
    ptyMeta.delete(id);
    ptyOwner.delete(id);
    sendAll("pty-exit", { id, exitCode });
  });
  return id;
}

function killAllPtys() {
  for (const p of ptys.values()) { try { p.kill(); } catch { /* ignore */ } }
  ptys.clear();
  ptyBuf.clear();
  ptyChunkSeq.clear();
  ptyMeta.clear();
  ptyOwner.clear();
}

/* ---- IPC (the preload.js contract) ---- */
function registerIpc() {
  // settings
  ipcMain.handle("settings-get", () => settings.get());
  ipcMain.handle("settings-set", (e, patch) => settings.set(patch || {}));

  // shells + Claude pane hooks
  ipcMain.handle("shells-list", () => shells.listShells());
  ipcMain.handle("hooks-status", () => hooks.status());
  ipcMain.handle("hooks-install", async () => { await hooks.install(); return hooks.status(); });
  ipcMain.handle("hooks-uninstall", async () => { await hooks.uninstall(); return hooks.status(); });

  // folder picker
  ipcMain.handle("pick-folder", async (e, start) => {
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender) || win, {
      properties: ["openDirectory", "createDirectory"],
      defaultPath: start && fs.existsSync(start) ? start : settings.get().defaultCwd,
    });
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
  });

  // plain-text clipboard for terminal copy/paste
  ipcMain.handle("clip-read-text", () => clipboard.readText());
  // OS notification from the main process so a failure is observable: unsigned/ad-hoc macOS builds
  // may not be allowed to post notifications (Electron 42+ needs a signed app); bounce the Dock instead.
  ipcMain.on("notify", (e, { title, body }) => {
    try {
      const n = new Notification({ title: String(title || "Vault Terminal"), body: String(body || ""), silent: true });
      n.on("failed", () => {
        if (process.platform === "darwin" && app.dock) app.dock.bounce("informational");
        else if (win && !win.isDestroyed()) win.flashFrame(true);
      });
      n.show();
    } catch { /* ignore */ }
  });
  ipcMain.handle("clip-write-text", (e, t) => { clipboard.writeText(String(t || "")); return true; });

  // terminals
  ipcMain.handle("pty-spawn", (e, opts) => { const id = spawnPty(opts || {}); ptyOwner.set(id, e.sender); return id; });
  // A window claims a live PTY's output (on reattach after reload or dock-back) so sendPty routes it there.
  ipcMain.on("pty-adopt", (e, id) => { if (id) ptyOwner.set(id, e.sender); });
  ipcMain.on("pty-write", (e, { id, data }) => { const p = ptys.get(id); if (p) p.write(data); });
  // A no-op resize is NOT free on Windows: node-pty forwards every call to ResizePseudoConsole,
  // and ConPTY answers a resize by repainting the whole viewport, which lands in the pane as a
  // duplicated block of text. Renderers refit on any layout tick, so only forward a real size change.
  ipcMain.on("pty-resize", (e, { id, cols, rows }) => {
    const p = ptys.get(id);
    if (!p || !(cols > 0) || !(rows > 0)) return;
    const m = ptyMeta.get(id);
    if (m && m.cols === cols && m.rows === rows) return;
    try { p.resize(cols, rows); } catch { /* ignore */ }
    if (m) { m.cols = cols; m.rows = rows; }
  });
  ipcMain.handle("pty-kill", (e, id) => { const p = ptys.get(id); if (p) { try { p.kill(); } catch { /* ignore */ } } ptys.delete(id); ptyBuf.delete(id); ptyChunkSeq.delete(id); ptyMeta.delete(id); ptyOwner.delete(id); return true; });
  // re-attach live panes after a renderer reload (PTYs survive in the main process)
  ipcMain.handle("pty-list", () => [...ptys.keys()]);
  // Two arg shapes. Plain id: returns the raw buffer string. { id }: returns { data, seq } where
  // seq is the chunk counter as-of this buffer, so the renderer can drop queued live chunks the
  // replay already contains.
  ipcMain.handle("pty-replay", (e, arg) => {
    if (arg && typeof arg === "object") {
      return { data: ptyBuf.get(arg.id) || "", seq: ptyChunkSeq.get(arg.id) || 0 };
    }
    return ptyBuf.get(arg) || "";
  });

  // popped-out terminal windows
  ipcMain.handle("popout-open", (e, cfg) => createPopout(cfg || {}));
  // pop every pane out at once, tiled to match the grid layout on the display under the cursor
  ipcMain.handle("popout-open-all", (e, { layout, panes }) => {
    const wa = (screen.getDisplayNearestPoint(screen.getCursorScreenPoint()) || screen.getPrimaryDisplay()).workArea;
    const groupId = nextGroupId(); // this batch moves together until a window is unpinned
    for (const p of (panes || [])) createPopout({ ...p, bounds: tileRect(layout, p.slot, wa), grouped: true, groupId, layout });
    return true;
  });
  // dock every open popout back into the grid at once (inverse of "pop out all")
  ipcMain.on("popout-close-all", () => { for (const w of [...popouts.values()]) { if (!w.isDestroyed()) w.close(); } });
  // dock a single popout back in (the "unpop" button on a reserved grid slot); false = no window
  // for this PTY, so the renderer docks it back itself
  ipcMain.handle("popout-close-one", (e, ptyId) => { const w = popouts.get(ptyId); if (w && !w.isDestroyed()) { w.close(); return true; } return false; });
  // rename / recolor a popout: update its live cfg so the change carries back on dock
  ipcMain.on("popout-rename", (e, { ptyId, name }) => {
    const cfg = popoutCfg.get(ptyId);
    if (cfg) cfg.name = name;
    const w = BrowserWindow.fromWebContents(e.sender);
    if (w && !w.isDestroyed()) w.setTitle(name || "Terminal");
  });
  ipcMain.on("popout-set-theme", (e, { ptyId, themeKey, bg }) => {
    const cfg = popoutCfg.get(ptyId);
    if (cfg) { cfg.themeKey = themeKey; if (bg) cfg.bg = bg; }
    const w = BrowserWindow.fromWebContents(e.sender);
    if (w && !w.isDestroyed() && bg) { try { w.setBackgroundColor(bg); } catch { /* ignore */ } }
  });
  // live-sync the neon toggle to every open popout
  ipcMain.on("popout-neon", (e, on) => sendAll("popout-neon-set", !!on));
  ipcMain.on("popout-minimize", (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.minimize(); });
  ipcMain.on("popout-close", (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.close(); });
  ipcMain.on("popout-set-always-on-top", (e, { key, value }) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (w) w.setAlwaysOnTop(!!value);
    setPopoutBounds(key, { alwaysOnTop: !!value });
  });
  ipcMain.on("popout-set-locked", (e, { key, value }) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (w) w.setMovable(!value);
    setPopoutBounds(key, { locked: !!value });
  });
  // pin/unpin a "pop out all" window from its move-together group
  ipcMain.on("popout-set-grouped", (e, { value }) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    const st = w && winGroup.get(w);
    if (!st) return;
    st.pinned = !!value;
    if (st.pinned) { const b = w.getBounds(); st.last = { x: b.x, y: b.y }; st.suppressUntil = 0; } // rejoin without jumping
  });
  // fill the current monitor with the whole grid (the group's "fullscreen the 2x2")
  ipcMain.on("popout-tile-group", (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (w) tileGroupToDisplay(w);
  });

  // Claude pane hook files
  ipcMain.handle("pane-live-sessions", () => sessions.readPaneSessions());
  ipcMain.handle("pane-attention", () => sessions.readPaneAttention());
  ipcMain.handle("pane-events", () => sessions.readPaneEvents());

  // session history
  ipcMain.handle("list-projects", () => sessions.getSessions().projects);
  ipcMain.handle("list-sessions", (e, opts) => {
    const { projectKey, force } = opts || {};
    const all = sessions.getSessions(force).sessions;
    return projectKey ? all.filter((s) => s.project === projectKey) : all;
  });

  // terminal layout persistence (working state)
  ipcMain.handle("term-layout-load", () => layouts.loadLayout());
  ipcMain.handle("term-layout-save", (e, data) => layouts.saveLayout(data));

  // saved layouts (named presets)
  ipcMain.handle("layouts-list", () => layouts.loadLayouts());
  ipcMain.handle("layouts-save", (e, payload) => layouts.saveNamedLayout(payload || {}));
  ipcMain.handle("layouts-delete", (e, id) => layouts.deleteLayout(id));
  ipcMain.handle("layouts-rename", (e, { id, name }) => layouts.renameLayout(id, name));

  // dev reload / restart
  ipcMain.on("reload-ui", () => { if (win && !win.isDestroyed()) win.webContents.reloadIgnoringCache(); });
  ipcMain.handle("restart-app", () => relaunchApp());
  ipcMain.on("toggle-devtools", (e) => e.sender.toggleDevTools());

  // open http(s) links in the OS browser
  ipcMain.on("open-external", (e, url) => { if (/^https?:\/\//i.test(String(url))) shell.openExternal(url); });

  // app install dir
  ipcMain.handle("app-dir", () => app.getAppPath());
}

/* ---- smoke test (VT_SMOKE=1, driven by smoke.js) ----
   Prints one JSON line per step and always exits: 0 all ok, 1 a step failed, 2 threw, 3 timed out. */
async function smokeMain() {
  setTimeout(() => app.exit(3), 110000).unref();
  const log = (o) => console.log(JSON.stringify(o));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn()) return true; await sleep(100); }
    return false;
  };
  try {
    // 1. shells
    shells.loginPath();
    log({ step: "shells", shells: shells.listShells(), claudeBin: shells.CLAUDE_BIN });

    // 2. pty: spawn the platform's plain shell, echo a marker, wait for it to come back
    const shellId = process.platform === "win32" ? "powershell" : "default";
    const id = spawnPty({ shell: shellId, cols: 120, rows: 30 });
    const out = () => ptyBuf.get(id) || "";
    // A cold CI runner can take >10 s to start Windows PowerShell, so the waits are generous.
    await waitFor(() => out().length > 0, 20000); // shell has drawn its first output
    await sleep(500);
    // The empty quotes keep the echoed keystrokes from matching; only the command's output reads VT_SMOKE_OK.
    if (ptys.has(id)) ptys.get(id).write('echo VT_SMOKE_""OK\r');
    const ptyOk = await waitFor(() => out().includes("VT_SMOKE_OK"), 30000);
    log({ step: "pty", ok: ptyOk, shell: shellId, ...(ptyOk ? {} : { tail: out().slice(-500) }) });
    if (ptys.has(id)) ptys.get(id).kill();

    // 2b. hooks: write the app-owned hook files, then run the SessionStart script exactly the way
    // Claude will (this binary as Node, stdin JSON) and check it records the pane's session id.
    const hs = hooks.ensure();
    let hooksOk = false, hookErr = null;
    if (hs.installed) {
      const { spawnSync } = require("child_process");
      const paneDir = path.join(app.getPath("userData"), "pane-sessions");
      const r = spawnSync(process.execPath, [path.join(hooks.hooksDir(), "vt-hook-session.js")], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", VT_PANE_KEY: "smoke", VT_PANE_DIR: paneDir },
        input: JSON.stringify({ session_id: "smoke-session", cwd: "/", hook_event_name: "SessionStart", source: "startup" }),
        encoding: "utf8", timeout: 15000,
      });
      hookErr = (r.stderr || "") + (r.stdout ? " stdout:" + r.stdout : ""); // stdout must stay empty
      let rec = null; try { rec = JSON.parse(fs.readFileSync(path.join(paneDir, "smoke.json"), "utf8")); } catch { /* missing */ }
      hooksOk = !!(rec && rec.sessionId === "smoke-session") && !r.stdout;
    }
    log({ step: "hooks", ok: hooksOk, settingsFile: hs.settingsFile, ...(hooksOk ? {} : { status: hs, err: hookErr }) });

    // 3. renderer: load the real UI hidden, collect console errors, check the grid rendered
    registerIpc();
    const errors = [];
    win = new BrowserWindow({
      show: false,
      width: 1180,
      height: 760,
      backgroundColor: "#0E0E11",
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    // Electron >= 35 carries { level: "error", message } on the event (or a details object);
    // older builds pass (event, level 0-3, message) with 3 = error.
    win.webContents.on("console-message", (e, a, b) => {
      const d = a && typeof a === "object" ? a : typeof e.level === "string" ? e : { level: a, message: b };
      if (d.level === "error" || d.level === 3) errors.push(String(d.message));
    });
    win.webContents.on("preload-error", (e, p, err) => errors.push("preload: " + (err && err.message)));
    await win.loadFile("index.html");
    await sleep(2000);
    const found = await waitFor(() => win.webContents.executeJavaScript("!!(window.api && document.querySelector('#gridhost .cell'))"), 8000);
    const rendererOk = found && errors.length === 0;
    log({ step: "renderer", ok: rendererOk, errors });

    // 4. done
    const ok = ptyOk && hooksOk && rendererOk;
    log({ step: "done", ok });
    killAllPtys();
    app.exit(ok ? 0 : 1);
  } catch (err) {
    log({ step: "error", error: String((err && err.stack) || err) });
    killAllPtys();
    app.exit(2);
  }
}

if (SMOKE) {
  app.whenReady().then(smokeMain);
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showApp());

  app.whenReady().then(() => {
    // Merge the login-shell PATH first (macOS/Linux GUI launches get a bare PATH), before anything spawns.
    shells.loginPath();
    // Keep the Claude pane hooks current (idempotent) before any Claude pane spawns.
    if (settings.get().claudeHooks) hooks.ensure();
    if (process.platform === "win32") app.setAppUserModelId("com.johnholik.vaultterminal");
    setAppMenu();
    registerIpc();
    createWindow();
    app.on("activate", () => showApp());
  });

  app.on("before-quit", () => {
    isQuitting = true;
    killAllPtys();
    if (tray) { tray.destroy(); tray = null; }
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
