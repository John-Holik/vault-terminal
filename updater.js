// In-app updates from GitHub Releases (John-Holik/vault-terminal).
// Windows: electron-updater does the real thing (download the NSIS installer, "Restart to update").
// macOS/Linux: electron-updater refuses to install into an app that isn't Developer-ID signed (ours is
// ad-hoc), so the app only checks the Releases API, downloads the right dmg to ~/Downloads and opens it.
// State is pushed to every window as "update-state"; nothing downloads without a click.
const { app, net, shell } = require("electron");
const fs = require("fs");
const path = require("path");

const REPO = "John-Holik/vault-terminal";
const WIN = process.platform === "win32";
let send = () => {};
let beforeInstall = async () => {};
let state = { state: "idle", current: app.getVersion(), version: null, notes: "", progress: 0, error: null, platform: process.platform, file: null, asset: null };
const setState = (patch) => { state = { ...state, ...patch }; send("update-state", state); };
const cmpVer = (a, b) => { const x = String(a).split(".").map(Number), y = String(b).split(".").map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); } return 0; };

let au = null;
function winUpdater() {
  if (au) return au;
  const { autoUpdater } = require("electron-updater");
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = null;
  // VT_UPDATE_FEED=<url> points the updater at a generic feed (used by the local end-to-end test).
  if (process.env.VT_UPDATE_FEED) { autoUpdater.forceDevUpdateConfig = true; autoUpdater.setFeedURL({ provider: "generic", url: process.env.VT_UPDATE_FEED }); }
  autoUpdater.on("update-available", (info) => setState({ state: "available", version: info.version, notes: typeof info.releaseNotes === "string" ? info.releaseNotes : "", error: null }));
  autoUpdater.on("update-not-available", () => setState({ state: "none", version: null, error: null }));
  autoUpdater.on("download-progress", (p) => setState({ state: "downloading", progress: Math.round(p.percent || 0) }));
  autoUpdater.on("update-downloaded", (info) => setState({ state: "downloaded", version: info.version, progress: 100 }));
  autoUpdater.on("error", (err) => setState({ state: "error", error: String((err && err.message) || err) }));
  au = autoUpdater;
  return au;
}

// macOS/Linux: newest release via the public API; the matching asset is `...-mac-<arch>.dmg`.
async function githubLatest() {
  const r = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { "User-Agent": "vault-terminal", Accept: "application/vnd.github+json" } });
  if (!r.ok) throw new Error("GitHub API " + r.status);
  const rel = await r.json();
  const version = String(rel.tag_name || "").replace(/^v/, "");
  const suffix = process.platform === "darwin" ? `-mac-${process.arch}.dmg` : null;
  const asset = suffix ? (rel.assets || []).find((a) => a.name.endsWith(suffix)) : null;
  return { version, notes: rel.body || "", asset: asset ? { url: asset.browser_download_url, name: asset.name, size: asset.size } : null, page: rel.html_url };
}

async function check() {
  if (state.state === "downloading") return state;
  setState({ state: "checking", error: null });
  try {
    if (WIN) { await winUpdater().checkForUpdates(); return state; } // events set the state
    const l = await githubLatest();
    if (l.version && cmpVer(l.version, state.current) > 0) setState({ state: "available", version: l.version, notes: l.notes, asset: l.asset, page: l.page });
    else setState({ state: "none", version: null });
  } catch (err) { setState({ state: "error", error: String((err && err.message) || err) }); }
  return state;
}

async function download() {
  if (state.state !== "available") return state;
  try {
    if (WIN) { setState({ state: "downloading", progress: 0 }); await winUpdater().downloadUpdate(); return state; }
    if (!state.asset) { if (state.page) shell.openExternal(state.page); return state; } // no dmg for this arch: send them to the release page
    setState({ state: "downloading", progress: 0 });
    const r = await net.fetch(state.asset.url, { headers: { "User-Agent": "vault-terminal" } });
    if (!r.ok || !r.body) throw new Error("download " + r.status);
    const file = path.join(app.getPath("downloads"), state.asset.name);
    const out = fs.createWriteStream(file + ".part");
    const reader = r.body.getReader();
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out.write(Buffer.from(value));
      got += value.length;
      if (state.asset.size) setState({ state: "downloading", progress: Math.round((got / state.asset.size) * 100) });
    }
    await new Promise((res, rej) => out.end((e) => (e ? rej(e) : res())));
    fs.renameSync(file + ".part", file);
    setState({ state: "downloaded", progress: 100, file });
  } catch (err) { setState({ state: "error", error: String((err && err.message) || err) }); }
  return state;
}

// Windows: flush layouts (panes resume after the restart), then let the installer run and relaunch.
// macOS: open the dmg; the user drags it to Applications and allows it once more in Privacy & Security.
async function install() {
  if (state.state !== "downloaded") return state;
  if (WIN) { try { await beforeInstall(); } catch { /* ignore */ } winUpdater().quitAndInstall(false, true); return state; }
  if (state.file) { await shell.openPath(state.file); setState({ state: "opened" }); }
  return state;
}

// init({ send, beforeInstall, enabled }): wire the window broadcaster and start the schedule
// (15 s after launch, then every 6 h) when automatic checks are on.
function init(opts) {
  send = opts.send || send;
  beforeInstall = opts.beforeInstall || beforeInstall;
  if (opts.enabled) { setTimeout(check, 15000).unref(); setInterval(check, 6 * 3600 * 1000).unref(); }
}

module.exports = { init, check, download, install, getState: () => state };
