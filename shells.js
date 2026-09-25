// Shell discovery and pty argv for Vault Terminal (win32 and darwin/linux side by side).
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

const WIN = process.platform === "win32";
const HOME = os.homedir();
const WIN_PS = WIN ? path.join(process.env.SystemRoot || process.env.windir, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : null;
const userShell = () => process.env.SHELL || "/bin/zsh";
// Path under an env-var dir, or null when the var is unset (avoids cwd-relative false positives).
const envPath = (v, ...rest) => (process.env[v] ? path.join(process.env[v], ...rest) : null);
const firstExisting = (cands) => cands.find((p) => p && fs.existsSync(p)) || null;

let claudeBin = null;
let codexBin = null;
let binsResolved = false;

// GUI-launched apps on macOS get launchd's bare environment (PATH /usr/bin:/bin:/usr/sbin:/sbin, none of
// the user's exports), so ask the user's login shell for its environment and merge it in: every exported
// variable (API keys, proxies, CLAUDE_CONFIG_DIR, ...) into process.env, and PATH as login entries first,
// then the original, then common install dirs. No-op on win32. Never throws; on failure the original
// environment is kept.
function loginPath() {
  if (WIN) return;
  const orig = (process.env.PATH || "").split(":");
  let login = [];
  try {
    // Interactive + login so both ~/.zshrc (Claude installer) and ~/.zprofile (Codex installer) apply.
    // The env guards stop oh-my-zsh update prompts / tmux autostart from stalling the probe.
    const guards = { DISABLE_AUTO_UPDATE: "true", ZSH_TMUX_AUTOSTART: "false", ZSH_TMUX_AUTOSTARTED: "true" };
    const env = { ...process.env, ...guards };
    // The shell runs this app's binary as Node to print its environment as one JSON line between markers.
    // The command is plain enough for sh/bash/zsh/fish, fish exports its PATH list colon-joined, and JSON
    // keeps multi-line values intact.
    const cmd = `/usr/bin/env ELECTRON_RUN_AS_NODE=1 '${process.execPath}' -p '"__VT_ENV__" + JSON.stringify(process.env) + "__VT_ENV__"'`;
    // SIGKILL: an interactive shell ignores the default SIGTERM, so a stuck rc file would outlive the timeout.
    const r = spawnSync(userShell(), ["-ilc", cmd], { encoding: "utf8", timeout: 8000, killSignal: "SIGKILL", env });
    const m = /__VT_ENV__(.*)__VT_ENV__/.exec(r.stdout || "");
    if (m) {
      const e = JSON.parse(m[1]);
      login = (e.PATH || "").split(":");
      for (const k of ["PATH", "PWD", "OLDPWD", "SHLVL", "_", "ELECTRON_RUN_AS_NODE", ...Object.keys(guards)]) delete e[k];
      Object.assign(process.env, e);
    }
  } catch { /* keep the original environment */ }
  const common = [path.join(HOME, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"].filter((d) => fs.existsSync(d));
  process.env.PATH = [...new Set([...login, ...orig, ...common])].filter(Boolean).join(":");
  binsResolved = false; // PATH changed: re-resolve claude/codex on next use
}

// First executable called `name` on PATH, as an absolute path, or null.
// win32 only accepts name.exe: node-pty can't exec the .cmd/.ps1 npm shims.
function findOnPath(name) {
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const p = path.resolve(dir.replace(/"/g, ""), WIN ? name + ".exe" : name);
    try {
      if (WIN) { if (fs.existsSync(p)) return p; }
      else { fs.accessSync(p, fs.constants.X_OK); if (!fs.statSync(p).isDirectory()) return p; }
    } catch { /* not here */ }
  }
  return null;
}

// Fill claudeBin/codexBin. main calls it after loginPath(); listShells/shellArgv/getters also run it lazily.
function resolveBins() {
  if (binsResolved) return;
  binsResolved = true;
  if (WIN) {
    claudeBin = firstExisting([
      path.join(HOME, ".local", "bin", "claude.exe"),
      envPath("LOCALAPPDATA", "Programs", "claude", "claude.exe"),
      envPath("APPDATA", "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"), // npm -g: real exe after postinstall (the npm bin dir only holds shims)
    ]) || findOnPath("claude");
    // codex ships a native binary in an arch-specific optional dep of the global npm package;
    // spawn it directly (the npm `codex` on PATH is a .ps1/.cmd shim node-pty can't exec cleanly).
    // npm layout (see codexNpmCandidates) or the standalone installer's %LOCALAPPDATA%\Programs\OpenAI\Codex\bin.
    const root = envPath("APPDATA", "npm", "node_modules");
    codexBin = firstExisting([
      ...codexNpmCandidates(root ? [root] : []),
      envPath("LOCALAPPDATA", "Programs", "OpenAI", "Codex", "bin", "codex.exe"),
    ]) || findOnPath("codex");
  } else {
    claudeBin = firstExisting([
      path.join(HOME, ".local", "bin", "claude"),
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
    ]) || findOnPath("claude");
    // The standalone installer links ~/.local/bin/codex; the npm `codex` on PATH is a node shebang
    // script, which node-pty can exec on unix.
    codexBin = firstExisting([
      path.join(HOME, ".local", "bin", "codex"),
      "/opt/homebrew/bin/codex",
      "/usr/local/bin/codex",
      ...codexNpmCandidates(["/opt/homebrew/lib/node_modules", "/usr/local/lib/node_modules"]),
    ]) || findOnPath("codex");
  }
}

// The npm package puts Codex's native binary in an arch-specific optional dep:
// <root>/@openai/codex/node_modules/@openai/codex-<platform>-<arch>/vendor/<triple>/bin/codex[.exe]
// (nested) or <root>/@openai/codex-<platform>-<arch>/... (hoisted). Returns every candidate path.
function codexNpmCandidates(roots) {
  const triple = { "darwin-arm64": "aarch64-apple-darwin", "darwin-x64": "x86_64-apple-darwin", "win32-x64": "x86_64-pc-windows-msvc", "win32-arm64": "aarch64-pc-windows-msvc", "linux-x64": "x86_64-unknown-linux-musl", "linux-arm64": "aarch64-unknown-linux-musl" }[process.platform + "-" + process.arch];
  if (!triple) return [];
  const pkg = "codex-" + process.platform + "-" + process.arch;
  const exe = WIN ? "codex.exe" : "codex";
  const out = [];
  for (const r of roots) {
    out.push(path.join(r, "@openai", "codex", "node_modules", "@openai", pkg, "vendor", triple, "bin", exe));
    out.push(path.join(r, "@openai", pkg, "vendor", triple, "bin", exe));
  }
  return out;
}

// Non-agent shells present on this machine, in menu order: [{ id, label, file, args }].
function plainShells() {
  if (WIN) {
    const out = [];
    const pwsh = findOnPath("pwsh");
    if (pwsh) out.push({ id: "pwsh", label: "PowerShell 7", file: pwsh, args: ["-NoLogo"] });
    out.push({ id: "powershell", label: "Windows PowerShell", file: WIN_PS, args: ["-NoLogo"] });
    out.push({ id: "cmd", label: "Command Prompt", file: "cmd.exe", args: [] });
    const bash = firstExisting([
      envPath("ProgramFiles", "Git", "bin", "bash.exe"),
      envPath("ProgramFiles(x86)", "Git", "bin", "bash.exe"),
      envPath("LOCALAPPDATA", "Programs", "Git", "bin", "bash.exe"),
    ]);
    if (bash) out.push({ id: "gitbash", label: "Git Bash", file: bash, args: ["--login", "-i"] });
    const act = firstExisting([
      path.join(HOME, "anaconda3", "Scripts", "activate.bat"),
      path.join(HOME, "miniconda3", "Scripts", "activate.bat"),
    ]);
    if (act) out.push({ id: "anaconda", label: "Anaconda", file: "cmd.exe", args: ["/K", act, path.dirname(path.dirname(act))] });
    return out;
  }
  const sh = userShell();
  const out = [{ id: "default", label: path.basename(sh), file: sh, args: ["-l"] }];
  if (path.basename(sh) !== "bash" && fs.existsSync("/bin/bash")) out.push({ id: "bash", label: "bash", file: "/bin/bash", args: ["-l"] });
  return out;
}

// [{ id, label }] for the shell picker. claude/codex are always listed (without a binary they
// launch through the user's shell, which may still find them); the rest are existence-gated.
function listShells() {
  resolveBins();
  return [
    { id: "claude", label: "Claude" },
    { id: "codex", label: "Codex" },
    ...plainShells().map(({ id, label }) => ({ id, label })),
  ];
}

function defaultShellId() {
  resolveBins();
  if (claudeBin) return "claude";
  return WIN ? "powershell" : "default";
}

// { file, args } for a pty. Unknown or unsupported ids (e.g. a layout saved on the other OS) fall
// back to the platform default shell.
function shellArgv(id, { resumeId, sessionId, skipPermissions, settingsFile } = {}) {
  resolveBins();
  // Session ids arrive from the renderer and get interpolated into a shell -Command/-lc string in
  // the no-native-binary fallback below. Constrain them to id-shaped chars so they can never carry
  // shell metacharacters. Claude ids are uuid-shaped.
  const safeId = (s) => (typeof s === "string" && /^[A-Za-z0-9._-]{1,80}$/.test(s) ? s : null);
  resumeId = safeId(resumeId);
  sessionId = safeId(sessionId);
  if (id === "claude" || id === "codex") {
    const args = [];
    if (id === "claude") {
      if (skipPermissions) args.push("--dangerously-skip-permissions");
      if (settingsFile) args.push("--settings", settingsFile); // the app's pane hooks (hooks.js), merged with the user's own
      if (resumeId) args.push("--resume", resumeId);
      else if (sessionId) args.push("--session-id", sessionId);
    }
    const bin = id === "claude" ? claudeBin : codexBin;
    if (bin) return { file: bin, args };
    // No binary found: route through a shell, which resolves whatever is on its PATH. Args are passed
    // as positionals ($0 = the command, "$@" = its args on unix; single-quoted on PowerShell), so a
    // settings path with spaces is never re-parsed by the shell.
    if (WIN) {
      const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
      return { file: WIN_PS, args: ["-NoLogo", "-NoProfile", "-Command", ["&", q(id), ...args.map(q)].join(" ")] };
    }
    // fish has no $0 / "$@": its -c puts the trailing args in $argv (never word-split). Other non-POSIX
    // shells (tcsh, nu, ...) go through /bin/sh on the merged login PATH from loginPath().
    const sh = userShell(), base = path.basename(sh);
    if (base === "fish") return { file: sh, args: ["-ilc", "exec $argv", id, ...args] };
    if (!["sh", "bash", "zsh", "dash", "ksh"].includes(base)) return { file: "/bin/sh", args: ["-c", 'exec "$0" "$@"', id, ...args] };
    return { file: sh, args: ["-ilc", 'exec "$0" "$@"', id, ...args] };
  }
  const shells = plainShells();
  const hit = shells.find((s) => s.id === id) || shells.find((s) => s.id === (WIN ? "powershell" : "default"));
  return { file: hit.file, args: hit.args };
}

module.exports = {
  listShells, defaultShellId, shellArgv, loginPath, findOnPath, resolveBins,
  get CLAUDE_BIN() { resolveBins(); return claudeBin; },
  get CODEX_BIN() { resolveBins(); return codexBin; },
};
