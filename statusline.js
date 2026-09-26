#!/usr/bin/env node
// gsd-hook-version: 1.38.5
// Claude Code Statusline - GSD Edition
// Shows: model | current task (or GSD state) | directory | context usage

const fs = require('fs');
const path = require('path');
const os = require('os');

// --- Config + last-command readers ------------------------------------------

/**
 * Walk up from dir looking for .planning/config.json and return its parsed contents.
 * Returns {} if not found or unreadable.
 */
function readGsdConfig(dir) {
  const home = os.homedir();
  let current = dir;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(current, '.planning', 'config.json');
    if (fs.existsSync(candidate)) {
      try {
        return JSON.parse(fs.readFileSync(candidate, 'utf8')) || {};
      } catch (e) {
        return {};
      }
    }
    const parent = path.dirname(current);
    if (parent === current || current === home) break;
    current = parent;
  }
  return {};
}

/**
 * Lookup a dotted key path (e.g. 'statusline.show_last_command') in a config
 * object that may use either nested or flat keys.
 */
function getConfigValue(cfg, keyPath) {
  if (!cfg || typeof cfg !== 'object') return undefined;
  if (keyPath in cfg) return cfg[keyPath];
  const parts = keyPath.split('.');
  let cur = cfg;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object' || !(p in cur)) return undefined;
    cur = cur[p];
  }
  return cur;
}

/**
 * Extract the most recently invoked slash command from a Claude Code JSONL
 * transcript file. Returns the command name (no leading slash) or null.
 *
 * Claude Code embeds slash invocations in user messages as
 *   <command-name>/foo</command-name>
 * We scan lines from the end of the file, stopping at the first match.
 */
function readLastSlashCommand(transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== 'string') return null;
  let content;
  try {
    if (!fs.existsSync(transcriptPath)) return null;
    // Read only the tail — typical transcripts grow large. 256 KiB comfortably
    // covers dozens of recent turns while staying cheap per render.
    const stat = fs.statSync(transcriptPath);
    const MAX = 256 * 1024;
    const start = Math.max(0, stat.size - MAX);
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const buf = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      content = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    return null;
  }
  // Find the LAST occurrence — scan right-to-left via lastIndexOf on the tag.
  const tagClose = '</command-name>';
  const idx = content.lastIndexOf(tagClose);
  if (idx < 0) return null;
  const openTag = '<command-name>';
  const openIdx = content.lastIndexOf(openTag, idx);
  if (openIdx < 0) return null;
  let name = content.slice(openIdx + openTag.length, idx).trim();
  // Strip a leading slash if present, and any trailing arguments-on-same-line noise.
  if (name.startsWith('/')) name = name.slice(1);
  // Command names in Claude Code transcripts are plain identifiers like "gsd-plan-phase"
  // or namespaced like "plugin:skill". Reject anything with whitespace/newlines/control chars.
  if (!name || /[\s\\"<>]/.test(name) || name.length > 80) return null;
  return name;
}

// --- Effort reader -----------------------------------------------------------

// Effort from stdin if provided, else per-model setting (/effort saves to
// modelSettings.<model-id>.effortLevel), else the top-level effortLevel.
function readEffort(data) {
  const fromInput = data.effort_level || data.effort?.level || (typeof data.effort === 'string' ? data.effort : null);
  if (fromInput) return fromInput;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json'), 'utf8'));
    const modelId = data.model?.id;
    return (modelId && cfg.modelSettings?.[modelId]?.effortLevel) || cfg.effortLevel || null;
  } catch (e) { return null; }
}

// --- Git branch -------------------------------------------------------------

// Shown after the folder name when the script runs with --branch (or VT_STATUSLINE_BRANCH=1).
// Reads .git/HEAD directly (no git process): "ref: refs/heads/x" -> x, a detached HEAD -> short hash.
// A .git *file* (worktree / submodule) points at the real git dir via "gitdir: <path>".
const SHOW_BRANCH = process.argv.includes('--branch') || process.env.VT_STATUSLINE_BRANCH === '1';
function readGitBranch(dir) {
  try {
    let current = dir;
    for (let i = 0; i < 12; i++) {
      const dotGit = path.join(current, '.git');
      if (fs.existsSync(dotGit)) {
        let gitDir = dotGit;
        if (fs.statSync(dotGit).isFile()) {
          const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
          if (!m) return null;
          gitDir = path.resolve(current, m[1].trim());
        }
        const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
        const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
        return ref ? ref[1] : head.slice(0, 7);
      }
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  } catch (e) { /* not a repo, or unreadable */ }
  return null;
}
function branchSuffix(dir) {
  if (!SHOW_BRANCH) return '';
  const b = readGitBranch(dir);
  return b ? ` \x1b[35m(${b})\x1b[0m` : '';
}

// --- GSD state reader -------------------------------------------------------

/**
 * Walk up from dir looking for .planning/STATE.md.
 * Returns parsed state object or null.
 */
function readGsdState(dir) {
  const home = os.homedir();
  let current = dir;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(current, '.planning', 'STATE.md');
    if (fs.existsSync(candidate)) {
      try {
        return parseStateMd(fs.readFileSync(candidate, 'utf8'));
      } catch (e) {
        return null;
      }
    }
    const parent = path.dirname(current);
    if (parent === current || current === home) break;
    current = parent;
  }
  return null;
}

/**
 * Parse STATE.md frontmatter + Phase line from body.
 * Returns { status, milestone, milestoneName, phaseNum, phaseTotal, phaseName }
 */
function parseStateMd(content) {
  const state = {};

  // YAML frontmatter between --- markers
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    for (const line of fmMatch[1].split('\n')) {
      const m = line.match(/^(\w+):\s*(.+)/);
      if (!m) continue;
      const [, key, val] = m;
      const v = val.trim().replace(/^["']|["']$/g, '');
      if (key === 'status') state.status = v === 'null' ? null : v;
      if (key === 'milestone') state.milestone = v === 'null' ? null : v;
      if (key === 'milestone_name') state.milestoneName = v === 'null' ? null : v;
    }
  }

  // Phase: N of M (name)  or  Phase: none active (...)
  const phaseMatch = content.match(/^Phase:\s*(\d+)\s+of\s+(\d+)(?:\s+\(([^)]+)\))?/m);
  if (phaseMatch) {
    state.phaseNum = phaseMatch[1];
    state.phaseTotal = phaseMatch[2];
    state.phaseName = phaseMatch[3] || null;
  }

  // Fallback: parse Status: from body when frontmatter is absent
  if (!state.status) {
    const bodyStatus = content.match(/^Status:\s*(.+)/m);
    if (bodyStatus) {
      const raw = bodyStatus[1].trim().toLowerCase();
      if (raw.includes('ready to plan') || raw.includes('planning')) state.status = 'planning';
      else if (raw.includes('execut')) state.status = 'executing';
      else if (raw.includes('complet') || raw.includes('archived')) state.status = 'complete';
    }
  }

  return state;
}

/**
 * Format GSD state into display string.
 * Format: "v1.9 Code Quality · executing · fix-graphiti-deployment (1/5)"
 * Gracefully degrades when parts are missing.
 */
function formatGsdState(s) {
  const parts = [];

  // Milestone: version + name (skip placeholder "milestone")
  if (s.milestone || s.milestoneName) {
    const ver = s.milestone || '';
    const name = (s.milestoneName && s.milestoneName !== 'milestone') ? s.milestoneName : '';
    const ms = [ver, name].filter(Boolean).join(' ');
    if (ms) parts.push(ms);
  }

  // Status
  if (s.status) parts.push(s.status);

  // Phase
  if (s.phaseNum && s.phaseTotal) {
    const phase = s.phaseName
      ? `${s.phaseName} (${s.phaseNum}/${s.phaseTotal})`
      : `ph ${s.phaseNum}/${s.phaseTotal}`;
    parts.push(phase);
  }

  return parts.join(' · ');
}

// --- stdin ------------------------------------------------------------------

function runStatusline() {
  let input = '';
  // Timeout guard: if stdin doesn't close within 3s (e.g. pipe issues on
  // Windows/Git Bash), exit silently instead of hanging. See #775.
  const stdinTimeout = setTimeout(() => process.exit(0), 3000);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => input += chunk);
  process.stdin.on('end', () => {
  clearTimeout(stdinTimeout);
  try {
    const data = JSON.parse(input);
    const modelName = data.model?.display_name || 'Claude';
    const modelLower = modelName.toLowerCase();
    // Red for Opus, green for Sonnet, dim for everything else
    let modelStr;
    if (modelLower.includes('opus')) {
      modelStr = `\x1b[31m${modelName}\x1b[0m`;
    } else if (modelLower.includes('sonnet')) {
      modelStr = `\x1b[32m${modelName}\x1b[0m`;
    } else {
      modelStr = `\x1b[2m${modelName}\x1b[0m`;
    }
    // Append effort level next to model name
    const effort = readEffort(data);
    if (effort) {
      const effortColor = effort === 'high' ? '\x1b[31m' : effort === 'low' ? '\x1b[32m' : '\x1b[33m';
      modelStr += ` ${effortColor}[${effort}]\x1b[0m`;
    }
    const dir = data.workspace?.current_dir || process.cwd();
    const session = data.session_id || '';
    const remaining = data.context_window?.remaining_percentage;

    // Context window display (shows USED percentage scaled to usable context)
    // Claude Code reserves a buffer for autocompact. By default this is ~16.5%
    // of the total window, but users can override it via CLAUDE_CODE_AUTO_COMPACT_WINDOW
    // (a token count). When the env var is set, compute the buffer % dynamically so
    // the meter correctly reflects early-compaction configurations (#2219).
    const totalCtx = data.context_window?.total_tokens || 1_000_000;
    const acw = parseInt(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW || '0', 10);
    const AUTO_COMPACT_BUFFER_PCT = acw > 0
      ? Math.min(100, (acw / totalCtx) * 100)
      : 16.5;
    let ctx = '';
    if (remaining != null) {
      // Normalize: subtract buffer from remaining, scale to usable range
      const usableRemaining = Math.max(0, ((remaining - AUTO_COMPACT_BUFFER_PCT) / (100 - AUTO_COMPACT_BUFFER_PCT)) * 100);
      const used = Math.max(0, Math.min(100, Math.round(100 - usableRemaining)));

      // Write context metrics to bridge file for the context-monitor PostToolUse hook.
      // The monitor reads this file to inject agent-facing warnings when context is low.
      // Reject session IDs with path separators or traversal sequences to prevent
      // a malicious session_id from writing files outside the temp directory.
      const sessionSafe = session && !/[/\\]|\.\./.test(session);
      if (sessionSafe) {
        try {
          const bridgePath = path.join(os.tmpdir(), `claude-ctx-${session}.json`);
          // used_pct written to the bridge must match CC's native /context reporting:
          // raw used = 100 - remaining_percentage (no buffer normalization applied).
          // The normalized `used` value is correct for the statusline progress bar but
          // inflates the context monitor warning messages by ~13 points (#2451).
          const rawUsedPct = Math.round(100 - remaining);
          const bridgeData = JSON.stringify({
            session_id: session,
            remaining_percentage: remaining,
            used_pct: rawUsedPct,
            timestamp: Math.floor(Date.now() / 1000)
          });
          fs.writeFileSync(bridgePath, bridgeData);
        } catch (e) {
          // Silent fail -- bridge is best-effort, don't break statusline
        }
      }

      // Color based on usable context thresholds (percentage only, no bar)
      // " │ Context: " prefix is dim/plain; the percentage keeps threshold color.
      const ctxLabel = ` │ \x1b[38;5;208mContext: \x1b[0m`;
      if (used < 50) {
        ctx = `${ctxLabel}\x1b[32m${used}%\x1b[0m`;
      } else if (used < 65) {
        ctx = `${ctxLabel}\x1b[33m${used}%\x1b[0m`;
      } else if (used < 80) {
        ctx = `${ctxLabel}\x1b[38;5;208m${used}%\x1b[0m`;
      } else {
        ctx = `${ctxLabel}\x1b[5;31m💀 ${used}%\x1b[0m`;
      }
    }

    // 5-hour rolling session usage (Claude.ai subscription plans only).
    // The field is absent until the first API response in the session; when
    // absent we show nothing rather than "0%", which would be misleading.
    // Color thresholds mirror the context window percentage coloring.
    let fiveHourStr = '';
    const fiveHourPct = data.rate_limits?.five_hour?.used_percentage;
    if (fiveHourPct != null) {
      const fh = Math.round(fiveHourPct);
      let fhColor;
      if (fh < 50) {
        fhColor = '\x1b[32m';       // green
      } else if (fh < 65) {
        fhColor = '\x1b[33m';       // yellow
      } else if (fh < 80) {
        fhColor = '\x1b[38;5;208m'; // orange
      } else {
        fhColor = '\x1b[31m';       // red
      }
      // Compute time-until-reset from reset_at (Unix seconds) or resets_at (ISO string)
      let resetSuffix = '';
      const resetRaw = data.rate_limits?.five_hour?.reset_at ?? data.rate_limits?.five_hour?.resets_at;
      if (resetRaw != null) {
        const resetMs = typeof resetRaw === 'number' ? resetRaw * 1000 : new Date(resetRaw).getTime();
        const minsLeft = Math.round((resetMs - Date.now()) / 60000);
        if (!isNaN(minsLeft) && minsLeft >= 0) {
          const resetLabel = minsLeft >= 60
            ? `${Math.floor(minsLeft / 60)}h${minsLeft % 60 > 0 ? `${minsLeft % 60}m` : ''}`
            : `${minsLeft}m`;
          resetSuffix = ` \x1b[37m↺ ${resetLabel}\x1b[0m`;
        }
      }
      fiveHourStr = ` │ ${fhColor}5h:${fh}%\x1b[0m${resetSuffix}`;

      // Bridge Anthropic's REAL 5-hour usage to disk so other tools (the Vault
      // Command Center) can show the true number instead of estimating it from
      // token logs. Best-effort: never break the statusline on a write failure.
      try {
        const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
        const resetMs = resetRaw == null ? null
          : (typeof resetRaw === 'number' ? resetRaw * 1000 : new Date(resetRaw).getTime());
        fs.writeFileSync(
          path.join(claudeDir, 'cache', 'five-hour-usage.json'),
          JSON.stringify({ used_percentage: fiveHourPct, reset_at_ms: resetMs, updated_at_ms: Date.now() })
        );
      } catch (e) { /* best-effort bridge */ }
    }

    // Bridge Anthropic's REAL weekly (7-day) usage to disk too, so the Vault
    // Command Center can show it next to the 5-hour gauge. Written independently
    // of the 5-hour field — the docs note each window may be absent on its own.
    const sevenDay = data.rate_limits?.seven_day;
    if (sevenDay != null && typeof sevenDay.used_percentage === 'number') {
      try {
        const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
        const sdRaw = sevenDay.reset_at ?? sevenDay.resets_at;
        const sdResetMs = sdRaw == null ? null
          : (typeof sdRaw === 'number' ? sdRaw * 1000 : new Date(sdRaw).getTime());
        fs.writeFileSync(
          path.join(claudeDir, 'cache', 'seven-day-usage.json'),
          JSON.stringify({ used_percentage: sevenDay.used_percentage, reset_at_ms: sdResetMs, updated_at_ms: Date.now() })
        );
      } catch (e) { /* best-effort bridge */ }
    }

    // Last-message token count (output tokens from most recent API response)
    let lastMsgTokens = '';
    const msgTokens = data.message_tokens ?? data.usage?.output_tokens ?? data.last_message_tokens;
    if (msgTokens != null) {
      const fmt = msgTokens >= 1000 ? `${(msgTokens / 1000).toFixed(1)}k` : `${msgTokens}`;
      lastMsgTokens = ` │ \x1b[37mmsg: ${fmt}\x1b[0m`;
    }

    // Current task from todos
    let task = '';
    const homeDir = os.homedir();
    // Respect CLAUDE_CONFIG_DIR for custom config directory setups (#870)
    const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(homeDir, '.claude');
    const todosDir = path.join(claudeDir, 'todos');
    if (session && fs.existsSync(todosDir)) {
      try {
        const files = fs.readdirSync(todosDir)
          .filter(f => f.startsWith(session) && f.includes('-agent-') && f.endsWith('.json'))
          .map(f => ({ name: f, mtime: fs.statSync(path.join(todosDir, f)).mtime }))
          .sort((a, b) => b.mtime - a.mtime);

        if (files.length > 0) {
          try {
            const todos = JSON.parse(fs.readFileSync(path.join(todosDir, files[0].name), 'utf8'));
            const inProgress = todos.find(t => t.status === 'in_progress');
            if (inProgress) task = inProgress.activeForm || '';
          } catch (e) {}
        }
      } catch (e) {
        // Silently fail on file system errors - don't break statusline
      }
    }

    // GSD state (milestone · status · phase) — shown when no todo task
    const gsdStateStr = task ? '' : formatGsdState(readGsdState(dir) || {});

    // GSD update available?
    // Check shared cache first (#1421), fall back to runtime-specific cache for
    // backward compatibility with older gsd-check-update.js versions.
    let gsdUpdate = '';
    const sharedCacheFile = path.join(homeDir, '.cache', 'gsd', 'gsd-update-check.json');
    const legacyCacheFile = path.join(claudeDir, 'cache', 'gsd-update-check.json');
    const cacheFile = fs.existsSync(sharedCacheFile) ? sharedCacheFile : legacyCacheFile;
    if (fs.existsSync(cacheFile)) {
      try {
        const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        if (cache.update_available) {
          gsdUpdate = '\x1b[33m⬆ /gsd-update\x1b[0m │ ';
        }
        if (cache.stale_hooks && cache.stale_hooks.length > 0) {
          // If installed version is ahead of npm latest, this is a dev install.
          // Running /gsd-update would downgrade — show a contextual warning instead.
          const isDevInstall = (() => {
            if (!cache.installed || !cache.latest || cache.latest === 'unknown') return false;
            const parseV = v => v.replace(/^v/, '').split('.').map(Number);
            const [ai, bi, ci] = parseV(cache.installed);
            const [an, bn, cn] = parseV(cache.latest);
            return ai > an || (ai === an && bi > bn) || (ai === an && bi === bn && ci > cn);
          })();
          if (isDevInstall) {
            gsdUpdate += '\x1b[33m⚠ dev install — re-run installer to sync hooks\x1b[0m │ ';
          } else {
            gsdUpdate += '\x1b[31m⚠ stale hooks — run /gsd-update\x1b[0m │ ';
          }
        }
      } catch (e) {}
    }

    // Last-slash-command suffix (opt-in via statusline.show_last_command, #2538).
    // Reads the active session transcript for the most recent <command-name> tag.
    // Failure here must never break the statusline — wrap the entire lookup.
    let lastCmdSuffix = '';
    try {
      const cfg = readGsdConfig(dir);
      if (getConfigValue(cfg, 'statusline.show_last_command') === true) {
        const transcriptPath = data.transcript_path;
        const lastCmd = readLastSlashCommand(transcriptPath);
        if (lastCmd) {
          lastCmdSuffix = ` │ \x1b[2mlast: /${lastCmd}\x1b[0m`;
        }
      }
    } catch (e) {
      // Never break the statusline on config/transcript errors
    }

    // Output
    const dirname = path.basename(dir);
    const branch = branchSuffix(dir);
    const middle = task
      ? `\x1b[1m${task}\x1b[0m`
      : gsdStateStr
        ? `\x1b[2m${gsdStateStr}\x1b[0m`
        : null;

    if (middle) {
      process.stdout.write(`${gsdUpdate}${modelStr} │ ${middle}${ctx}${lastMsgTokens}${fiveHourStr} │ \x1b[34m${dirname}\x1b[0m${branch}${lastCmdSuffix}`);
    } else {
      process.stdout.write(`${gsdUpdate}${modelStr}${ctx}${lastMsgTokens}${fiveHourStr} │ \x1b[34m${dirname}\x1b[0m${branch}${lastCmdSuffix}`);
    }
  } catch (e) {
    // Silent fail - don't break statusline on parse errors
  }
});
}

// Export helpers for unit tests. Harmless when run as a script.
module.exports = {
  readGsdState, parseStateMd, formatGsdState,
  readGsdConfig, getConfigValue, readLastSlashCommand,
};

/**
 * Render the statusline from an already-parsed hook input object. Exported for
 * testing without feeding stdin. Returns the rendered string.
 */
function renderStatusline(data) {
  const modelName = data.model?.display_name || 'Claude';
  const modelLower = modelName.toLowerCase();
  let modelStr;
  if (modelLower.includes('opus')) {
    modelStr = `\x1b[31m${modelName}\x1b[0m`;
  } else if (modelLower.includes('sonnet')) {
    modelStr = `\x1b[32m${modelName}\x1b[0m`;
  } else {
    modelStr = `\x1b[2m${modelName}\x1b[0m`;
  }
  // Append effort level next to model name
  const effort = readEffort(data);
  if (effort) {
    const effortColor = effort === 'high' ? '\x1b[31m' : effort === 'low' ? '\x1b[32m' : '\x1b[33m';
    modelStr += ` ${effortColor}[${effort}]\x1b[0m`;
  }
  const dir = data.workspace?.current_dir || process.cwd();
  const dirname = path.basename(dir);
  const branch = branchSuffix(dir);

  let lastCmdSuffix = '';
  try {
    const cfg = readGsdConfig(dir);
    if (getConfigValue(cfg, 'statusline.show_last_command') === true) {
      const lastCmd = readLastSlashCommand(data.transcript_path);
      if (lastCmd) {
        lastCmdSuffix = ` │ \x1b[2mlast: /${lastCmd}\x1b[0m`;
      }
    }
  } catch (e) { /* swallow */ }

  const gsdStateStr = formatGsdState(readGsdState(dir) || {});
  const middle = gsdStateStr ? `\x1b[2m${gsdStateStr}\x1b[0m` : null;
  if (middle) {
    return `${modelStr} │ ${middle} │ \x1b[34m${dirname}\x1b[0m${branch}${lastCmdSuffix}`;
  }
  return `${modelStr} │ \x1b[34m${dirname}\x1b[0m${branch}${lastCmdSuffix}`;
}

module.exports.renderStatusline = renderStatusline;

if (require.main === module) runStatusline();
