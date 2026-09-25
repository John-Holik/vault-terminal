// Vault Terminal's Claude Code hooks. Everything is app-owned: the three hook scripts and a
// claude-hooks.json live in this app's userData folder, and every Claude pane is launched with
// `--settings <claude-hooks.json>`. Claude Code merges those hooks with the user's own
// ~/.claude/settings.json hooks (verified 2026-09-25 on 2.1.282), so nothing in ~/.claude is
// touched, and turning the option off just stops passing --settings.
// The scripts run under this app's own binary as Node (ELECTRON_RUN_AS_NODE), so no system
// Node.js is needed. Each script is a no-op unless VT_PANE_KEY + VT_PANE_DIR are set on the pane.
const fs = require("fs");
const path = require("path");
const { app } = require("electron");

// Resolved on each use, not at load: main.js may still repoint userData (the smoke test uses a temp folder).
const hooksDir = () => path.join(app.getPath("userData"), "hooks");
const settingsFile = () => path.join(hooksDir(), "claude-hooks.json");
const fwd = (p) => p.replace(/\\/g, "/");

// Shared file-write helper embedded in every script: tmp + rename, falling back to a direct write.
const WRITE_FN = `function write(dest, obj) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = dest + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(obj));
    try { fs.renameSync(tmp, dest); }
    catch { fs.writeFileSync(dest, JSON.stringify(obj)); try { fs.unlinkSync(tmp); } catch {} }
  } catch {}
}`;

// Shared prologue: env guard + stdin collection. Every script prints NOTHING (SessionStart stdout is
// injected into Claude's context) and always exits 0.
const PROLOGUE = `const fs = require("fs");
const path = require("path");
const key = process.env.VT_PANE_KEY;
const dir = process.env.VT_PANE_DIR;
if (!key || !dir || !/^[A-Za-z0-9._-]{1,80}$/.test(key)) process.exit(0);
${WRITE_FN}
let raw = "";
const bail = setTimeout(() => process.exit(0), 3000);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("error", () => process.exit(0));
process.stdin.on("end", () => {
  clearTimeout(bail);
  let p = null;
  try { p = JSON.parse(raw); } catch {}
`;

// SessionStart: the pane's CURRENT session id (rotates on /clear, compaction, fork).
const SESSION_SRC = `// Vault Terminal SessionStart hook (auto-written by the app; edits are overwritten).
// Writes <VT_PANE_DIR>/<VT_PANE_KEY>.json = { sessionId, cwd, source, transcriptPath, ts }.
${PROLOGUE}  if (p && typeof p.session_id === "string") {
    write(path.join(dir, key + ".json"), {
      sessionId: p.session_id,
      cwd: p.cwd || null,
      source: p.source || null,
      transcriptPath: p.transcript_path || null,
      ts: Date.now(),
    });
  }
  process.exit(0);
});
`;

// PreToolUse / PostToolUse / PostToolUseFailure on AskUserQuestion: is a question on screen?
const ATTENTION_SRC = `// Vault Terminal attention hook (auto-written by the app; edits are overwritten).
// Writes <VT_PANE_DIR>/<VT_PANE_KEY>.attn = { awaiting, toolUseId, ts }. PreToolUse = the question
// is on screen; PostToolUse / PostToolUseFailure = answered or dismissed.
${PROLOGUE}  if (p && p.tool_name === "AskUserQuestion") {
    write(path.join(dir, key + ".attn"), {
      awaiting: p.hook_event_name === "PreToolUse",
      toolUseId: p.tool_use_id || null,
      ts: Date.now(),
    });
  }
  process.exit(0);
});
`;

// Stop / Notification: turn finished or Claude needs attention. A Stop also clears a stale
// AskUserQuestion flag, since a finished turn can't be waiting on an answer.
const EVENT_SRC = `// Vault Terminal event hook (auto-written by the app; edits are overwritten).
// Writes <VT_PANE_DIR>/<VT_PANE_KEY>.event = { type, message, ntype, ts }.
${PROLOGUE}  const ev = p && p.hook_event_name;
  const now = Date.now();
  if (ev === "Stop") {
    write(path.join(dir, key + ".event"), { type: "stop", message: String(p.last_assistant_message || "").slice(0, 300), ts: now });
    const attn = path.join(dir, key + ".attn");
    if (fs.existsSync(attn)) write(attn, { awaiting: false, toolUseId: null, ts: now });
  } else if (ev === "Notification") {
    write(path.join(dir, key + ".event"), { type: "notify", message: p.message || "", ntype: p.notification_type || "", ts: now });
  }
  process.exit(0);
});
`;

const SCRIPTS = [
  { file: "vt-hook-session.js", src: SESSION_SRC },
  { file: "vt-hook-attention.js", src: ATTENTION_SRC },
  { file: "vt-hook-event.js", src: EVENT_SRC },
];

// One settings entry that runs <file> under this app's binary as Node. Windows forces the
// PowerShell shell form (Claude picks Git Bash or PowerShell there, and the command differs);
// macOS/Linux use the plain `sh -c` form. Both were verified to deliver the hook's stdin.
function hookEntry(file, extra) {
  const script = fwd(path.join(hooksDir(), file));
  const exe = fwd(process.execPath);
  const base = process.platform === "win32"
    ? { type: "command", shell: "powershell", command: `$env:ELECTRON_RUN_AS_NODE='1'; & '${exe.replace(/'/g, "''")}' '${script.replace(/'/g, "''")}'` }
    : { type: "command", command: `ELECTRON_RUN_AS_NODE=1 "${exe.replace(/(["$\\])/g, "\\$1")}" "${script.replace(/(["$\\])/g, "\\$1")}"` };
  return { ...base, timeout: 10, ...extra };
}

function settingsJson() {
  const bg = { async: true }; // Stop/Notification are pure side effects: never delay the turn end
  const attn = () => hookEntry("vt-hook-attention.js"); // synchronous so Pre/Post writes keep their order
  return JSON.stringify({ hooks: {
    SessionStart: [{ hooks: [hookEntry("vt-hook-session.js")] }],
    PreToolUse: [{ matcher: "AskUserQuestion", hooks: [attn()] }],
    PostToolUse: [{ matcher: "AskUserQuestion", hooks: [attn()] }],
    PostToolUseFailure: [{ matcher: "AskUserQuestion", hooks: [attn()] }],
    Stop: [{ hooks: [hookEntry("vt-hook-event.js", bg)] }],
    Notification: [{ hooks: [hookEntry("vt-hook-event.js", bg)] }],
  } }, null, 2) + "\n";
}

// Write a file only when its content differs (no mtime churn); tmp + rename.
function writeIfChanged(p, content) {
  let existing = null;
  try { existing = fs.readFileSync(p, "utf8"); } catch { /* missing */ }
  if (existing === content) return false;
  fs.writeFileSync(p + ".tmp", content);
  fs.renameSync(p + ".tmp", p);
  return true;
}

// { installed, runtime, hooksDir, settingsFile, reason }. installed = all four files present.
function status() {
  try {
    const present = [...SCRIPTS.map((s) => path.join(hooksDir(), s.file)), settingsFile()].every((p) => fs.existsSync(p));
    return { installed: present, runtime: process.execPath, hooksDir: hooksDir(), settingsFile: settingsFile(), reason: null };
  } catch (err) {
    return { installed: false, runtime: process.execPath, hooksDir: hooksDir(), settingsFile: settingsFile(), reason: String(err) };
  }
}

// Write/refresh the scripts and claude-hooks.json (the latter embeds process.execPath, which
// changes when the app moves or updates, so this runs on every launch). Idempotent; never throws.
function ensure() {
  try {
    fs.mkdirSync(hooksDir(), { recursive: true });
    for (const s of SCRIPTS) writeIfChanged(path.join(hooksDir(), s.file), s.src);
    writeIfChanged(settingsFile(), settingsJson());
    return status();
  } catch (err) {
    return { installed: false, runtime: process.execPath, hooksDir: hooksDir(), settingsFile: settingsFile(), reason: String(err) };
  }
}

// Remove the hooks folder. Nothing outside userData was ever written.
function uninstall() {
  try { fs.rmSync(hooksDir(), { recursive: true, force: true }); } catch { /* ignore */ }
  return status();
}

// The --settings path to pass to claude, or null when the hooks aren't installed.
function settingsArg() { return status().installed ? settingsFile() : null; }

module.exports = { ensure, install: ensure, uninstall, status, settingsArg, hooksDir, settingsFile, SCRIPTS };
