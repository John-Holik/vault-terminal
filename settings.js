const { app } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const shells = require("./shells");
const { writeFileAtomic } = require("./layouts");

const DEFAULTS = {
  defaultShell: null,          // shell id from shells.listShells(); null -> shells.defaultShellId()
  defaultCwd: null,            // absolute dir; null -> os.homedir()
  claudeSkipPermissions: true, // spawn claude with --dangerously-skip-permissions
  claudeHooks: true,           // install/keep the 3 pane hooks in ~/.claude
  fontSize: 12.5,              // xterm fontSize (renderer reads it)
  closeToTray: true,           // window close hides to tray while PTYs are alive
  macOptionIsMeta: true,       // macOS: Option sends Meta (Claude's Option+P/T); off to type @ [ ] { } | ~ on non-US layouts
};

function settingsFile() { return path.join(app.getPath("userData"), "settings.json"); }

// Only the user's own choices are stored; defaults fill in at read time.
function readStored() {
  try { return JSON.parse(fs.readFileSync(settingsFile(), "utf8")) || {}; } catch { return {}; }
}

// Turn defaultCwd/defaultShell into real values on this machine: a missing folder falls back to
// the home dir, an unset or unavailable shell to the platform default.
function resolve(s) {
  if (!s.defaultCwd || !fs.existsSync(s.defaultCwd)) s.defaultCwd = os.homedir();
  if (!s.defaultShell || !shells.listShells().some((x) => x.id === s.defaultShell)) s.defaultShell = shells.defaultShellId();
  return s;
}

function get() { return resolve({ ...DEFAULTS, ...readStored() }); }

function set(patch) {
  const stored = { ...readStored(), ...patch };
  writeFileAtomic(settingsFile(), JSON.stringify(stored, null, 2));
  return resolve({ ...DEFAULTS, ...stored });
}

module.exports = { get, set, DEFAULTS };
