const { contextBridge, ipcRenderer } = require("electron");

// Preloads run sandboxed (Electron's default), where only electron/events/timers/url can be
// required, so the home dir comes from the environment instead of os.homedir().
const HOME = process.env.HOME || process.env.USERPROFILE || "";

contextBridge.exposeInMainWorld("api", {
  platform: process.platform,
  home: HOME,
  // settings snapshot at load, synchronous so renderer modules can read it at startup
  settings: ipcRenderer.sendSync("settings-get"),
  getSettings: () => ipcRenderer.invoke("settings-get"),
  setSettings: (patch) => ipcRenderer.invoke("settings-set", patch),

  // shells + Claude pane hooks
  listShells: () => ipcRenderer.invoke("shells-list"),
  hooksStatus: () => ipcRenderer.invoke("hooks-status"),
  hooksInstall: () => ipcRenderer.invoke("hooks-install"),
  hooksUninstall: () => ipcRenderer.invoke("hooks-uninstall"),

  // folder picker, clipboard, misc
  pickFolder: (start) => ipcRenderer.invoke("pick-folder", start),
  clipReadText: () => ipcRenderer.invoke("clip-read-text"),
  clipWriteText: (t) => ipcRenderer.invoke("clip-write-text", t),
  notify: (title, body) => ipcRenderer.send("notify", { title, body }), // OS notification (main-side, so a macOS failure can fall back)
  appDir: () => ipcRenderer.invoke("app-dir"),
  openExternal: (url) => ipcRenderer.send("open-external", url),

  // terminals
  ptySpawn: (opts) => ipcRenderer.invoke("pty-spawn", opts),
  ptyWrite: (id, data) => ipcRenderer.send("pty-write", { id, data }),
  ptyResize: (id, cols, rows) => ipcRenderer.send("pty-resize", { id, cols, rows }),
  ptyKill: (id) => ipcRenderer.invoke("pty-kill", id),
  ptyList: () => ipcRenderer.invoke("pty-list"),
  ptyReplay: (arg) => ipcRenderer.invoke("pty-replay", arg),
  ptyAdopt: (id) => ipcRenderer.send("pty-adopt", id), // claim a live PTY's output for THIS window
  onPtyData: (cb) => ipcRenderer.on("pty-data", (e, m) => cb(m)),
  onPtyExit: (cb) => ipcRenderer.on("pty-exit", (e, m) => cb(m)),

  // popped-out terminal windows
  popoutOpen: (cfg) => ipcRenderer.invoke("popout-open", cfg),
  popoutOpenAll: (payload) => ipcRenderer.invoke("popout-open-all", payload),
  popoutCloseAll: () => ipcRenderer.send("popout-close-all"),
  popoutCloseOne: (ptyId) => ipcRenderer.send("popout-close-one", ptyId),
  popoutRename: (p) => ipcRenderer.send("popout-rename", p),
  popoutSetTheme: (p) => ipcRenderer.send("popout-set-theme", p),
  broadcastNeon: (on) => ipcRenderer.send("popout-neon", on),
  onPopoutNeon: (cb) => ipcRenderer.on("popout-neon-set", (e, m) => cb(m)),
  popoutMinimize: () => ipcRenderer.send("popout-minimize"),
  popoutClose: () => ipcRenderer.send("popout-close"),
  popoutSetAlwaysOnTop: (p) => ipcRenderer.send("popout-set-always-on-top", p),
  popoutSetLocked: (p) => ipcRenderer.send("popout-set-locked", p),
  popoutSetGrouped: (p) => ipcRenderer.send("popout-set-grouped", p),
  popoutTileGroup: () => ipcRenderer.send("popout-tile-group"),
  onPopoutRedock: (cb) => ipcRenderer.on("popout-redock", (e, m) => cb(m)),

  // Claude pane hook files: paneKey -> session id / { awaiting, ts } / { type, message, ts }
  paneLiveSessions: () => ipcRenderer.invoke("pane-live-sessions"),
  paneAttention: () => ipcRenderer.invoke("pane-attention"),
  paneEvents: () => ipcRenderer.invoke("pane-events"),

  // session history
  listProjects: () => ipcRenderer.invoke("list-projects"),
  listSessions: (projectKey, force) => ipcRenderer.invoke("list-sessions", { projectKey, force }),

  // terminal layout persistence
  loadTermLayout: () => ipcRenderer.invoke("term-layout-load"),
  saveTermLayout: (data) => ipcRenderer.invoke("term-layout-save", data),

  // saved layouts (named presets)
  listLayouts: () => ipcRenderer.invoke("layouts-list"),
  saveNamedLayout: (payload) => ipcRenderer.invoke("layouts-save", payload),
  deleteLayout: (id) => ipcRenderer.invoke("layouts-delete", id),
  renameLayout: (id, name) => ipcRenderer.invoke("layouts-rename", { id, name }),

  // dev reload
  reloadUI: () => ipcRenderer.send("reload-ui"),
  restartApp: () => ipcRenderer.invoke("restart-app"),
  onHotkeyReload: (cb) => ipcRenderer.on("hotkey-reload", (e, m) => cb(m)),
  toggleDevTools: () => ipcRenderer.send("toggle-devtools"),
});
