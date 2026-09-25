// Claude session history (Chat History tab) and the per-pane files written by the Vault Terminal hooks.
const fs = require("fs");
const path = require("path");
const os = require("os");
const { app } = require("electron");

// CLAUDE_CONFIG_DIR relocates ~/.claude (settings + transcripts); honor it like Claude Code does.
// Resolved on each use, not at require time: on macOS it may only arrive with the login-shell env (shells.loginPath).
const projectsDir = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");

// True if a Claude conversation with this id exists in ~/.claude/projects on THIS
// machine. Sessions are stored per-project as <id>.jsonl, so scan the project dirs.
function claudeSessionExists(id) {
  if (!id) return false;
  try {
    const projects = projectsDir();
    for (const e of fs.readdirSync(projects, { withFileTypes: true })) {
      if (e.isDirectory() && fs.existsSync(path.join(projects, e.name, id + ".jsonl"))) return true;
    }
  } catch { /* ignore */ }
  return false;
}

/* ---- session history (Chat History tab) ---- */
let sessionCache = null;
let sessionCacheAt = 0;
// Per-file cache for the session scan, keyed on mtime+size. Without it, scanSessions re-reads and
// JSON-parses every transcript (can be hundreds of MB) on each call on the main process, stalling
// node-pty keystroke/output delivery. Now only changed files re-parse.
const sessionFileCache = new Map(); // path -> { mtime, size, parsed }

function parseSessionFile(full) {
  let text;
  try { text = fs.readFileSync(full, "utf8"); } catch { return null; }
  let aiTitle = null, lastPrompt = null, firstPrompt = null, cwd = null, msgs = 0;
  const assistantIds = new Set(); // one API message can span several lines with the same message.id
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const t = o.type;
    if (!cwd && o.cwd) cwd = o.cwd;
    if (t === "ai-title" && o.aiTitle) aiTitle = o.aiTitle;
    else if (t === "last-prompt" && o.lastPrompt) lastPrompt = o.lastPrompt;
    else if (t === "assistant") {
      const mid = o.message && o.message.id;
      if (!mid || !assistantIds.has(mid)) { msgs++; if (mid) assistantIds.add(mid); }
    } else if (t === "user") {
      if (o.isMeta) continue; // injected caveats / command echoes, not something the user typed
      const c = o.message && o.message.content;
      let text = null;
      if (typeof c === "string") text = c;
      else if (Array.isArray(c)) {
        if (c.length && c.every((b) => b && b.type === "tool_result")) continue; // tool results ride on user lines
        const tb = c.find((b) => b && b.type === "text"); if (tb) text = tb.text;
      }
      msgs++;
      if (firstPrompt === null && text && !/^<(command-name|local-command-)/.test(text.trim())) firstPrompt = text;
    }
  }
  if (msgs === 0) return null;
  const id = path.basename(full).replace(/\.jsonl$/, "");
  const clean = (s) => (s || "").replace(/^<[^>]+>[\s\S]*?<\/[^>]+>\s*/g, "").replace(/\s+/g, " ").trim();
  const title = (aiTitle || clean(lastPrompt) || clean(firstPrompt) || "(untitled session)").slice(0, 90);
  const snippet = (clean(lastPrompt) || clean(firstPrompt) || "").slice(0, 170);
  let mtime = 0;
  try { mtime = fs.statSync(full).mtimeMs; } catch { /* ignore */ }
  return { id, title, snippet, cwd, msgs, mtime };
}

function scanSessions() {
  const projects = [];
  const sessions = [];
  const root = projectsDir();
  if (!fs.existsSync(root)) return { projects, sessions };
  const seen = new Set();
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    let files;
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
    if (!files.length) continue;
    const list = [];
    for (const f of files) {
      const full = path.join(dir, f);
      seen.add(full);
      let st; try { st = fs.statSync(full); } catch { continue; }
      const hit = sessionFileCache.get(full);
      let s;
      if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) s = hit.parsed;
      else { s = parseSessionFile(full); sessionFileCache.set(full, { mtime: st.mtimeMs, size: st.size, parsed: s }); }
      if (s) { s.project = e.name; list.push(s); }
    }
    if (!list.length) continue;
    list.sort((a, b) => b.mtime - a.mtime);
    const repCwd = (list.find((s) => s.cwd) || {}).cwd || null;
    for (const s of list) if (!s.cwd) s.cwd = repCwd;
    const label = repCwd ? (path.basename(repCwd.replace(/[\\/]+$/, "")) || repCwd) : e.name;
    projects.push({ key: e.name, cwd: repCwd, label, count: list.length, mtime: list[0].mtime });
    sessions.push(...list);
  }
  for (const k of [...sessionFileCache.keys()]) if (!seen.has(k)) sessionFileCache.delete(k); // drop deleted files
  projects.sort((a, b) => b.mtime - a.mtime);
  sessions.sort((a, b) => b.mtime - a.mtime);
  return { projects, sessions };
}

function getSessions(force) {
  const now = Date.now();
  if (force || !sessionCache || now - sessionCacheAt > 30000) {
    sessionCache = scanSessions();
    sessionCacheAt = now;
  }
  return sessionCache;
}

/* ---- live pane -> session map (written by the vault-terminal-pane-session SessionStart hook) ----
   A pane's Claude session id rotates on /clear, /resume, and compaction. The hook
   records the current id keyed by the pane's stable VT_PANE_KEY so we resume the
   conversation the pane is actually on, not the stale id it was spawned with. */
function paneSessionsDir() { return path.join(app.getPath("userData"), "pane-sessions"); }
function readPaneSessions() {
  const out = {};
  try {
    const dir = paneSessionsDir();
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const o = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        if (o && o.sessionId) out[f.slice(0, -5)] = o.sessionId;
      } catch { /* skip one bad file */ }
    }
  } catch { /* dir not created until the first hook write */ }
  return out;
}
// paneKey -> { awaiting, ts }: written by the vault-terminal-pane-attention PreToolUse/PostToolUse hook
// when a pane's Claude presents (Pre) or resolves (Post) an AskUserQuestion. Lets the renderer blink
// the pane's status light while Claude is blocked on the user's multiple-choice answer.
function readPaneAttention() {
  const out = {};
  try {
    const dir = paneSessionsDir();
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".attn")) continue;
      try {
        const o = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        out[f.slice(0, -5)] = { awaiting: !!(o && o.awaiting), ts: (o && o.ts) || 0 };
      } catch { /* skip one bad file */ }
    }
  } catch { /* dir not created until the first hook write */ }
  return out;
}
// paneKey -> { type, message, ts }: written by the vault-terminal-pane-notify Stop/Notification hook.
// "stop" = a pane's Claude finished a turn; "notify" = it needs attention/permission.
function readPaneEvents() {
  const out = {};
  try {
    const dir = paneSessionsDir();
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".event")) continue;
      try {
        const o = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        out[f.slice(0, -6)] = { type: (o && o.type) || "", message: (o && o.message) || "", ts: (o && o.ts) || 0 };
      } catch { /* skip one bad file */ }
    }
  } catch { /* dir not created until the first hook write */ }
  return out;
}

module.exports = { projectsDir, claudeSessionExists, paneSessionsDir, readPaneSessions, readPaneAttention, readPaneEvents, getSessions };
