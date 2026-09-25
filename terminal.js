/* ===== Vault Terminal — Terminal multiplexer ===== */
(() => {
  const A = window.api;
  const E = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  // Resolved by settings.js in main (never null): the configured folder, else the home dir.
  const DEFAULT_CWD = () => window.vtSettings.defaultCwd; // app.js owns window.vtSettings (mutable copy of api.settings) and patches it when the modal saves
  // Resolved by settings.js in main (never null): the configured shell id, else shells.defaultShellId().
  const DEFAULT_SHELL = () => window.vtSettings.defaultShell;
  const IS_MAC = A.platform === "darwin";

  const baseName = (p) => (p || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || (p || "");
  function timeAgo(ts) {
    if (!ts) return "—";
    const d = (Date.now() - ts) / 1000;
    if (d < 60) return "just now";
    if (d < 3600) return Math.floor(d / 60) + "m ago";
    if (d < 86400) return Math.floor(d / 3600) + "h ago";
    if (d < 2592000) return Math.floor(d / 86400) + "d ago";
    return Math.floor(d / 2592000) + "mo ago";
  }

  // Shells that exist on this machine ([{ id, label }]); filled from A.listShells() at the top of termInit.
  let SHELLS = [];
  const shellLabel = (id) => (SHELLS.find((s) => s.id === id) || SHELLS[0]).label;
  const shellOpts = (sel) => SHELLS.map((s) => `<option value="${s.id}"${s.id === sel ? " selected" : ""}>${s.label}</option>`).join("");
  // A shell id not listed on this machine (uninstalled, or saved on the other OS) runs as the platform
  // shell in main (shells.shellArgv falls back to powershell / default), so label the pane with that shell.
  const knownShell = (id) => (SHELLS.some((s) => s.id === id) ? id : SHELLS.find((s) => s.id === "powershell" || s.id === "default").id);

  // Shared theme table (themes.js, loaded before this script; also used by the popout window).
  // Fallback: a one-theme table so a missing/failed themes.js degrades to indigo, not a crash.
  const THEMES = window.VT_THEMES || {
    indigo: { name: "Indigo", bg: "#0E0E11", theme: { background: "#0E0E11", foreground: "#EDEDEF", cursor: "#6E79E6", cursorAccent: "#0E0E11", selectionBackground: "rgba(110,121,230,.35)" } },
  };
  const THEME_KEYS = Object.keys(THEMES);

  const SLOTS = 8;       // max panes a grid can hold (largest layout is 2×4)
  let grids = [];        // [{id, name, layout, broadcast, cells:[cell|null x8]}]
  let activeGrid = null;
  // False until termInit has rebuilt `grids` from the saved snapshot. Until then every save path is a
  // no-op, so an F5 / Shift+F5 / quit during boot can't overwrite term-layout.json with an empty layout.
  let restored = false;
  // Popout redocks that arrive before termInit's restore loop has finished; drained right after it.
  let redockQueue = [];
  let gridSeq = 0, cellSeq = 0;
  const byPty = new Map();
  // Popped-out panes' PTYs are NOT in byPty (their own window renders the output), so a
  // pty-exit for one is invisible to the grid. Track ptyId → reserved "popped" placeholder
  // so the exit can mark the slot dead and dock-back can still find it (onPtyExit/dockBackCell).
  const poppedPtys = new Map();

  const IDLE_MS = 6000;
  const ECHO_MS = 350; // PTY output arriving within this window of a keystroke is the redraw of what the user typed, not Claude working
  const uuid = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : "id-" + Math.random().toString(36).slice(2));
  let muted = localStorage.getItem("vt.muteChime") === "1";
  let railCollapsed = localStorage.getItem("vt.railCollapsed") === "1";
  let neon = localStorage.getItem("vt.neon") === "1";
  let autoSaveWorkspace = localStorage.getItem("vt.autoSaveWorkspace") !== "0"; // default on; saves edits back to a loaded workspace
  const pendingCwd = new Map(); // `${gid}:${idx}` -> chosen cwd for an idle pane
  let audioCtx = null;

  const $tabs = () => document.getElementById("gridtabs");
  const $host = () => document.getElementById("gridhost");
  const $lseg = () => document.getElementById("layoutseg");
  const activeGridObj = () => grids.find((g) => g.id === activeGrid);
  const cellDom = (gid, idx) => $host().querySelector(`.cell[data-grid="${gid}"][data-idx="${idx}"]`);
  const defaultName = (shell, cwd) => `${shellLabel(shell)} · ${baseName(cwd)}`;

  /* ---- grids ---- */
  function makeGrid(name) {
    const id = "g" + ++gridSeq;
    const g = { id, name: name || "Workspace " + (grids.length + 1), layout: 4, cells: new Array(SLOTS).fill(null) };
    grids.push(g);
    return g;
  }
  function addGrid() { const g = makeGrid(); activeGrid = g.id; renderAll(); persist(); }
  function switchGrid(id) {
    activeGrid = id;
    $host().querySelectorAll(".gridwrap").forEach((w) => { w.style.display = w.dataset.grid === id ? "grid" : "none"; });
    renderTabs();
    renderLayoutSeg();
    applyBroadcast();
    fitActiveGrid();
    renderGutters();
    persist();
  }
  function closeGrid(id) {
    const g = grids.find((x) => x.id === id);
    if (!g) return;
    for (let i = 0; i < SLOTS; i++) {
      const c = g.cells[i];
      // A popped-out pane's PTY is owned by its own window now; killing it here would leave
      // that window alive but dead ("process exited"). Let the popout live on standalone —
      // closing it later docks back via the free-slot fallback in dockBackCell.
      if (c && c.popped) continue;
      disposeCell(c);
    }
    const wrap = $host().querySelector(`.gridwrap[data-grid="${id}"]`);
    if (wrap) wrap.remove();
    grids = grids.filter((x) => x.id !== id);
    if (!grids.length) { activeGrid = makeGrid().id; }
    else if (activeGrid === id) { activeGrid = grids[0].id; }
    renderAll();
    persist();
  }
  function renameGrid(id, span) {
    span.contentEditable = "true";
    span.focus();
    document.getSelection().selectAllChildren(span);
    const done = () => {
      span.contentEditable = "false";
      const g = grids.find((x) => x.id === id);
      g.name = span.textContent.trim() || g.name;
      span.textContent = g.name;
      persist();
    };
    span.onblur = done;
    span.onkeydown = (e) => {
      if (e.key === "Enter") { e.preventDefault(); span.blur(); }
      if (e.key === "Escape") { span.textContent = grids.find((x) => x.id === id).name; span.blur(); }
    };
  }
  function setLayout(n) {
    const g = activeGridObj();
    if (!g) return;
    g.layout = n;
    const wrap = $host().querySelector(`.gridwrap[data-grid="${g.id}"]`);
    if (wrap) { wrap.dataset.layout = n; applySplit(g); }
    renderLayoutSeg();
    fitActiveGrid();
    renderGutters();
    persist();
  }

  /* ---- pane resizing (draggable gutters) ---- */
  // Per-layout column/row fraction splits, lazily defaulted to even. Stored on the grid
  // and persisted so a workspace keeps its custom proportions across reloads.
  // Column/row counts per layout. n is the pane count; 4/6/8 are multi-row grids.
  function layoutCols(n) { return n === 4 ? 2 : n === 6 ? 3 : n === 8 ? 4 : n; }
  function layoutRows(n) { return n >= 4 ? 2 : 1; }
  function defaultSplit(n) {
    const cols = new Array(layoutCols(n)).fill(1);
    const rows = new Array(layoutRows(n)).fill(1);
    return { cols, rows };
  }
  function gridSplit(g, n) {
    n = n || g.layout;
    g.splits = g.splits || {};
    if (!g.splits[n] || !Array.isArray(g.splits[n].cols)) g.splits[n] = defaultSplit(n);
    return g.splits[n];
  }
  // Push the current layout's fractions onto the wrap as CSS vars the grid template reads.
  function applySplit(g) {
    const wrap = $host().querySelector(`.gridwrap[data-grid="${g.id}"]`);
    if (!wrap) return;
    const s = gridSplit(g);
    for (let i = 1; i <= SLOTS; i++) { wrap.style.removeProperty(`--col${i}`); wrap.style.removeProperty(`--row${i}`); }
    s.cols.forEach((f, i) => wrap.style.setProperty(`--col${i + 1}`, f + "fr"));
    s.rows.forEach((f, i) => wrap.style.setProperty(`--row${i + 1}`, f + "fr"));
  }
  // Representative cell rect for a track. Columns map to the row-0 cell at that index;
  // rows map to the first cell in that row (idx = row*2 in the 2x2 layout).
  function trackCell(wrap, axis, t) {
    const g = grids.find((x) => x.id === wrap.dataset.grid);
    const perRow = layoutCols(g ? g.layout : 4);
    const idx = axis === "col" ? t : t * perRow;
    return wrap.querySelector(`.cell[data-idx="${idx}"]`);
  }
  // (Re)build the gutter handles for the active grid: one between each adjacent pair of
  // visible columns, plus the row divider in the 2x2 layout. Layout 1 has none.
  function renderGutters() {
    const host = $host();
    if (!host) return;
    host.querySelectorAll(".gutter").forEach((el) => el.remove());
    const g = activeGridObj();
    if (!g) return;
    const wrap = host.querySelector(`.gridwrap[data-grid="${g.id}"]`);
    if (!wrap) return;
    const add = (axis, a, b) => {
      const gut = document.createElement("div");
      gut.className = "gutter " + axis;
      gut.dataset.axis = axis; gut.dataset.a = a; gut.dataset.b = b;
      wireGutter(gut);
      wrap.appendChild(gut);
    };
    const cols = layoutCols(g.layout);
    for (let i = 0; i < cols - 1; i++) add("col", i, i + 1);
    if (layoutRows(g.layout) > 1) add("row", 0, 1);
    positionGutters();
  }
  // Keep each gutter centered on its grid gap. Hides gutters whose tracks are collapsed
  // (e.g. when a pane is maximized), since those cells report a zero-size rect.
  function positionGutters() {
    const g = activeGridObj();
    if (!g) return;
    const wrap = $host().querySelector(`.gridwrap[data-grid="${g.id}"]`);
    if (!wrap) return;
    const wr = wrap.getBoundingClientRect();
    wrap.querySelectorAll(".gutter").forEach((gut) => {
      const axis = gut.dataset.axis;
      const ca = trackCell(wrap, axis, +gut.dataset.a), cb = trackCell(wrap, axis, +gut.dataset.b);
      const ra = ca && ca.getBoundingClientRect(), rb = cb && cb.getBoundingClientRect();
      if (!ra || !rb || ra.width < 4 || ra.height < 4 || rb.width < 4 || rb.height < 4) { gut.style.display = "none"; return; }
      gut.style.display = "";
      if (axis === "col") gut.style.left = ((ra.right + rb.left) / 2 - wr.left) + "px";
      else gut.style.top = ((ra.bottom + rb.top) / 2 - wr.top) + "px";
    });
  }
  function wireGutter(gut) {
    gut.onpointerdown = (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const g = activeGridObj();
      if (!g) return;
      const wrap = gut.closest(".gridwrap");
      const axis = gut.dataset.axis, a = +gut.dataset.a, b = +gut.dataset.b;
      const arr = axis === "col" ? gridSplit(g).cols : gridSplit(g).rows;
      const ra = trackCell(wrap, axis, a).getBoundingClientRect();
      const rb = trackCell(wrap, axis, b).getBoundingClientRect();
      const aPx = axis === "col" ? ra.width : ra.height;
      const pairPx = aPx + (axis === "col" ? rb.width : rb.height);
      const pairFr = arr[a] + arr[b];
      const start = axis === "col" ? e.clientX : e.clientY;
      const MIN = 90; // px floor so a pane can't be dragged shut
      const vA = `--${axis}${a + 1}`, vB = `--${axis}${b + 1}`;
      gut.classList.add("dragging");
      try { gut.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      const onMove = (ev) => {
        const pos = axis === "col" ? ev.clientX : ev.clientY;
        const newApx = Math.max(MIN, Math.min(pairPx - MIN, aPx + (pos - start)));
        const fa = pairFr * (newApx / pairPx);
        arr[a] = fa; arr[b] = pairFr - fa;
        wrap.style.setProperty(vA, arr[a] + "fr"); wrap.style.setProperty(vB, arr[b] + "fr");
        positionGutters();
      };
      const onUp = () => {
        gut.removeEventListener("pointermove", onMove);
        gut.removeEventListener("pointerup", onUp);
        gut.removeEventListener("pointercancel", onUp);
        gut.classList.remove("dragging");
        try { gut.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
        fitActiveGrid();
        persist();
      };
      gut.addEventListener("pointermove", onMove);
      gut.addEventListener("pointerup", onUp);
      gut.addEventListener("pointercancel", onUp); // a cancelled drag must not leave the move handler live (it would resize on hover)
    };
  }

  /* ---- cells (panes) ---- */
  async function startCell(grid, idx, cfg) {
    cfg = cfg || {};
    const themeKey = cfg.themeKey || THEME_KEYS[idx % THEME_KEYS.length];
    const shell = knownShell(cfg.shell || DEFAULT_SHELL());
    const cwd = cfg.cwd || DEFAULT_CWD();
    const isClaude = shell === "claude";
    // conversation to resume: explicit resumeId, else a restored convoId; fresh Claude gets a new id.
    const priorConvo = cfg.resumeId || cfg.convoId || null;
    let sessionId = null, convoId = priorConvo;
    if (isClaude && !priorConvo) { sessionId = uuid(); convoId = sessionId; }
    // Stable per-pane key (survives relaunch via the snapshot). The SessionStart hook
    // writes this pane's live session id under it, so we can resume the right convo
    // even after a /clear rotates the id. Reused across resumes; minted for fresh panes.
    const paneKey = cfg.paneKey || uuid();
    const cell = {
      id: "c" + ++cellSeq, name: cfg.name || defaultName(shell, cwd), shell, cwd, themeKey, paneKey,
      started: true, convoId: isClaude ? convoId : null, fresh: !!sessionId,
      activity: "idle", lastDataAt: Date.now(), notified: false, attention: false, hasPrompted: false,
      mounted: false, exited: false, _gid: grid.id, _idx: idx,
    };
    grid.cells[idx] = cell;
    paintCell(grid, idx); // mounts xterm
    const cols = (cell.term && cell.term.cols) || 80, rows = (cell.term && cell.term.rows) || 24;
    let ptyId;
    try {
      ptyId = await A.ptySpawn({
        shell, cwd, cols, rows,
        resumeId: isClaude ? priorConvo : null, sessionId, paneKey: isClaude ? paneKey : null,
      });
    } catch (err) {
      if (cell.term) cell.term.write("\r\n\x1b[31mfailed to start: " + E(String(err)) + "\x1b[0m\r\n");
      return;
    }
    // The pane may have been closed / shell-switched while the spawn was in flight; don't
    // bind the fresh PTY to a discarded cell (it would run forever, invisible).
    if (grid.cells[idx] !== cell) { A.ptyKill(ptyId); return; }
    cell.ptyId = ptyId;
    cell._ptyCols = cols; cell._ptyRows = rows; // the PTY already opened at this size — don't resize it back to it
    byPty.set(ptyId, cell);
    if (cell.term) cell.term.focus();
    persist();
  }
  /* ---- replay-ordering gate (#21) ----
     While a reattach's ptyReplay fetch is pending, live pty-data chunks must not be written
     ahead of the (older) replay buffer — and the main process appends live chunks to its replay
     buffer as they arrive, so naively queueing them double-writes any byte that made it into the
     replay. Each chunk carries a monotonic per-pty seq, and the replay carries the seq as-of its
     snapshot: queue seq'd chunks during the fetch, then flush only those newer than the snapshot.
     Chunks without a seq (old main.js, pre-Shift+F5) write through immediately — the pre-#21
     behavior. NOTE: popout.js carries a verbatim twin of makeReplayGate (no shared module between
     the two windows); keep them in sync. */
  function makeReplayGate(write) {
    let waiting = true; // replay fetch still pending
    let lastSeq = null; // highest seq written so far (null until the first seq is known)
    const q = [];
    return {
      // Feed one live chunk; writes, queues, or drops it.
      data(data, seq) {
        const hasSeq = typeof seq === "number";
        if (waiting) {
          if (hasSeq) { q.push({ data, seq }); return; }
          write(data); // no seq → no ordering info; write through like today
          return;
        }
        if (hasSeq && lastSeq !== null && seq <= lastSeq) return; // already written via the replay buffer (stale event)
        if (hasSeq) lastSeq = seq;
        write(data);
      },
      // The replay fetch resolved: write the buffer, then flush only queued chunks newer than
      // its snapshot (older ones are already inside it). replaySeq null → old main.js: flush
      // everything in order, matching current behavior.
      settle(replayData, replaySeq) {
        waiting = false;
        if (typeof replaySeq === "number") lastSeq = replaySeq;
        if (replayData) write(replayData);
        for (const c of q) {
          if (lastSeq !== null && c.seq <= lastSeq) continue;
          lastSeq = c.seq;
          write(c.data);
        }
        q.length = 0;
      },
    };
  }
  // Fetch the replay buffer plus its seq snapshot. A current main.js answers the { id } arg
  // shape with { data, seq }; an old main.js (renderer reloaded before Shift+F5) doesn't know
  // that shape and returns "" — detected by the string result, then refetched the legacy way.
  async function fetchReplay(ptyId) {
    let r = null;
    try { r = await A.ptyReplay({ id: ptyId }); } catch { /* ignore */ }
    if (r && typeof r === "object") return { data: r.data || "", seq: typeof r.seq === "number" ? r.seq : null };
    let buf = "";
    try { buf = await A.ptyReplay(ptyId); } catch { /* ignore */ }
    return { data: buf || "", seq: null };
  }
  // Re-bind a pane to a PTY that's still alive in the main process (after a renderer reload),
  // instead of spawning a new one. Replays buffered output so the session looks continuous.
  async function reattachCell(grid, idx, saved) {
    const shell = knownShell(saved.shell || DEFAULT_SHELL());
    const cwd = saved.cwd || DEFAULT_CWD();
    const cell = {
      id: "c" + ++cellSeq, name: saved.name || defaultName(shell, cwd), shell, cwd,
      themeKey: saved.themeKey || THEME_KEYS[idx % THEME_KEYS.length], paneKey: saved.paneKey || uuid(),
      started: true, convoId: shell === "claude" ? (saved.convoId || null) : null, fresh: false,
      activity: "idle", lastDataAt: Date.now(), notified: false, attention: false, hasPrompted: false,
      mounted: false, exited: false, _gid: grid.id, _idx: idx, ptyId: saved.ptyId,
    };
    grid.cells[idx] = cell;
    paintCell(grid, idx); // mounts xterm
    byPty.set(saved.ptyId, cell);
    // Gate live output BEFORE the first await: chunks arriving while the replay fetch is
    // pending queue behind it instead of garbling ahead of it (#21). The gate stays on the
    // cell after settle to drop stale in-flight events the replay buffer already covered.
    cell.replayGate = makeReplayGate((d) => { if (cell.term) cell.term.write(d); });
    if (A.ptyAdopt) A.ptyAdopt(saved.ptyId); // route this PTY's output to THIS window
    const r = await fetchReplay(saved.ptyId);
    cell.replayGate.settle(r.data, r.seq);
    fitCell(cell); // resize the live PTY to the new pane; a TUI (Claude) repaints over the replay
  }
  function teardownView(cell) {
    if (!cell) return;
    if (cell.ro) cell.ro.disconnect();
    clearTimeout(cell._resizeT); // a pending resize must not fire at a disposed term / handed-off PTY
    if (cell.term) cell.term.dispose();
  }
  function disposeCell(cell) {
    if (!cell) return;
    if (cell.ptyId) { A.ptyKill(cell.ptyId); byPty.delete(cell.ptyId); }
    teardownView(cell);
  }
  // Pop a pane into its own window: hand the live PTY off to the new window and tear
  // down only this pane's view. The PTY keeps running in the main process untouched.
  function detachCell(grid, idx) {
    const cell = grid.cells[idx];
    if (!cell) return;
    if (cell.ptyId) byPty.delete(cell.ptyId); // the popout window owns this PTY's output now
    teardownView(cell);
    // Reserve the slot with a "popped" placeholder instead of freeing it, so no new terminal
    // can take its place. The placeholder carries enough to dock the live PTY back (via the
    // unpop button or closing the window) and survives a renderer refresh.
    grid.cells[idx] = {
      popped: true, ptyId: cell.ptyId, shell: cell.shell, cwd: cell.cwd, name: cell.name,
      themeKey: cell.themeKey, convoId: cell.convoId || null, paneKey: cell.paneKey || null,
      _gid: grid.id, _idx: idx,
    };
    poppedPtys.set(cell.ptyId, grid.cells[idx]);
    paintCell(grid, idx);
    persist();
  }
  // Single source for serializing a pane's identity fields. The three snapshot shapes —
  // pop-out cfg, saved workspace, working snapshot — all build on
  // this so their field sets can't drift; `extras` carries each call site's own fields.
  function cellData(c, extras) {
    return { shell: c.shell, cwd: c.cwd, name: c.name, themeKey: c.themeKey, convoId: c.convoId || null, paneKey: c.paneKey || null, ...extras };
  }
  function cellPopCfg(c) {
    return cellData(c, {
      ptyId: c.ptyId, key: c.convoId || (c.shell + ":" + c.cwd),
      bg: (THEMES[c.themeKey] || THEMES.indigo).bg, neon,
    });
  }
  // Dock a single popped pane back in: close its window, which fires popout-redock → dockBackCell.
  async function unpopCell(grid, idx) {
    const c = grid.cells[idx];
    if (!c || !c.popped) return;
    // PTY died while popped (onPtyExit cleared ptyId): the tracked map still holds its id.
    let id = c.ptyId;
    if (!id) for (const [pid, cell] of poppedPtys) { if (cell === c) { id = pid; break; } }
    // No id tracked (edge case — reloads normally reclaim dead placeholders): free the slot.
    if (!id) { grid.cells[idx] = null; paintCell(grid, idx); persist(); return; }
    if (await A.popoutCloseOne(id)) return; // window found: its close fires popout-redock → dockBackCell
    // No window (its redock was lost, e.g. it closed while this window was reloading): dock back here.
    // dockBackCell reattaches the live PTY, or restarts the pane resumed if it died. Skipped if a
    // redock already replaced the placeholder, so the conversation can't be resumed twice.
    if (grid.cells[idx] === c) dockBackCell({ ...cellData(c), ptyId: id });
  }
  // Pop one pane out. `bounds` (optional) places the new window — used by drag-to-tear (drop point).
  async function popOutCell(grid, idx, bounds) {
    const c = grid.cells[idx];
    if (!c || !c.started || c.exited || !c.ptyId || c._popping) return;
    c._popping = true; // guard against a double-trigger opening two windows for one pane
    try { await window.vtFlushLayout(); } catch { /* ignore */ }
    try { await A.popoutOpen({ ...cellPopCfg(c), slot: idx, bounds: bounds || null }); }
    catch { c._popping = false; return; } // window failed to open — leave the pane in place, still poppable
    detachCell(grid, idx);
  }
  // Pop every running pane out at once, tiled by the main process to mirror this layout.
  async function popOutAll() {
    const g = activeGridObj();
    if (!g) return;
    try { await window.vtFlushLayout(); } catch { /* ignore */ }
    const panes = [];
    for (let i = 0; i < g.layout; i++) {
      const c = g.cells[i];
      if (c && c.started && !c.exited && c.ptyId) panes.push({ slot: i, ...cellPopCfg(c) });
    }
    if (!panes.length) return;
    await A.popoutOpenAll({ layout: g.layout, panes });
    for (const p of panes) detachCell(g, p.slot);
  }
  // Dock every popped-out window back into the grid (inverse of pop-out-all).
  function unpopAll() { A.popoutCloseAll(); }
  // A popped-out window closed (button or Alt+F4): re-dock its live terminal into the grid,
  // preferring its original slot so "pop all" → "unpop all" restores the arrangement.
  async function dockBackCell(cfg) {
    if (!cfg || !cfg.ptyId || byPty.has(cfg.ptyId)) return;
    // If the PTY died while popped, onPtyExit cleared the placeholder's ptyId — the tracked
    // reference is then the only way to find its reserved slot again.
    const tracked = poppedPtys.get(cfg.ptyId) || null;
    poppedPtys.delete(cfg.ptyId);
    let g = null, idx = -1;
    // Prefer the reserved "popped" slot this PTY was torn from — in whatever workspace it lives.
    // Scan all 4 slots, not just the visible layout: the placeholder may sit in a slot hidden
    // by a since-shrunk layout, and missing it strands a stale reserved cell forever.
    for (const gg of grids) {
      for (let i = 0; i < gg.cells.length; i++) {
        const c = gg.cells[i];
        if (c && c.popped && (c.ptyId === cfg.ptyId || c === tracked)) { g = gg; idx = i; break; }
      }
      if (g) break;
    }
    // Fallback (a lost placeholder, e.g. its workspace was closed while popped): any free slot.
    if (!g) {
      g = activeGridObj();
      if (!g) return;
      if (typeof cfg.slot === "number" && cfg.slot >= 0 && cfg.slot < g.layout && !g.cells[cfg.slot]) idx = cfg.slot;
      else for (let i = 0; i < g.layout; i++) { if (!g.cells[i]) { idx = i; break; } }
      if (idx < 0) { g = makeGrid(); activeGrid = g.id; ensureDom(); idx = 0; }
    }
    g.cells[idx] = null; // clear the placeholder before the live PTY re-mounts here
    switchGrid(g.id);
    // The PTY may have died while this pane was popped out; reattaching would mount an empty dead
    // pane. Only reattach if it's still live in the main process, else restart (resumes the convo).
    let dead = !!(tracked && tracked.exited); // onPtyExit already saw this PTY die while popped
    if (!dead) {
      let live = null;
      try { live = new Set(await A.ptyList()); } catch { /* ignore — inconclusive, fall through to reattach */ }
      dead = !!(live && !live.has(cfg.ptyId));
    }
    if (dead) {
      startCell(g, idx, { shell: cfg.shell, cwd: cfg.cwd, name: cfg.name, themeKey: cfg.themeKey, convoId: cfg.convoId, paneKey: cfg.paneKey });
    } else {
      reattachCell(g, idx, { ptyId: cfg.ptyId, shell: cfg.shell, cwd: cfg.cwd, name: cfg.name, themeKey: cfg.themeKey, convoId: cfg.convoId, paneKey: cfg.paneKey });
    }
    persist();
  }
  function closeCell(grid, idx) {
    const had = grid.cells[idx] && grid.cells[idx].attention;
    disposeCell(grid.cells[idx]);
    grid.cells[idx] = null;
    paintCell(grid, idx);
    if (had) renderTabs();
    persist();
  }
  // Manual save (toolbar 💾 button): persist the working layout + each pane's CURRENT
  // session id right now, so the next launch restores this exact arrangement and resumes
  // the live conversations.
  // Reconciles convoIds from the hook map first so we save the post-/clear ids, then writes
  // the working snapshot and refreshes any bound saved-layout cards.
  const SAVE_BTN_TITLE = "Save layout + current session IDs now (restored on next launch)";
  let manualSaveT;
  async function saveLayoutNow() {
    const btn = document.getElementById("btsave");
    if (btn) { btn.classList.remove("saved", "nosave"); btn.classList.add("saving"); }
    await reconcileConvoIds();
    let ok = false;
    try {
      await A.saveTermLayout(buildSnapshot());
      for (const g of grids) {
        if (g.loadedLayoutId && g.cells.some((c) => c && c.started)) {
          await A.saveNamedLayout({ id: g.loadedLayoutId, name: g.name, data: workspaceData(g) });
        }
      }
      ok = true;
    } catch { /* ignore */ }
    if (!btn) return;
    const live = grids.reduce((n, g) => n + g.cells.filter((c) => c && c.started && !c.exited && c.shell === "claude").length, 0);
    btn.classList.remove("saving");
    btn.classList.add(ok ? "saved" : "nosave");
    btn.title = ok ? `Layout saved · ${live} session${live === 1 ? "" : "s"} tracked` : "Save failed";
    clearTimeout(manualSaveT);
    manualSaveT = setTimeout(() => { btn.classList.remove("saved", "nosave"); btn.title = SAVE_BTN_TITLE; }, 2200);
  }
  function restartCell(grid, idx) {
    const c = grid.cells[idx];
    if (!c) return;
    const cfg = { shell: c.shell, cwd: c.cwd, name: c.name, themeKey: c.themeKey, convoId: c.convoId };
    closeCell(grid, idx);
    startCell(grid, idx, cfg);
  }
  function changeShell(grid, idx, shell) {
    const c = grid.cells[idx];
    if (!c) return;
    closeCell(grid, idx);
    startCell(grid, idx, { shell, cwd: c.cwd, name: defaultName(shell, c.cwd), themeKey: c.themeKey });
  }
  function setCellTheme(grid, idx, k) {
    const c = grid.cells[idx];
    if (!c) return;
    c.themeKey = k;
    if (c.term) c.term.options.theme = THEMES[k].theme;
    const el = cellDom(grid.id, idx);
    if (el) {
      el.style.background = THEMES[k].bg;
      el.style.setProperty("--neon", THEMES[k].theme.cursor);
    }
    persist();
  }

  function mountTerm(cell, body) {
    const th = THEMES[cell.themeKey] || THEMES.indigo;
    const term = new Terminal({
      fontFamily: "'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace",
      fontSize: window.vtSettings.fontSize, cursorBlink: true, allowProposedApi: true, scrollback: 5000,
      rightClickSelectsWord: false, // xterm defaults this on for macOS; it would fight the right-click copy/paste handler below
      // Setting (macOS): Option sent as Meta for Claude Code's Option+P / Option+T shortcuts. Off lets non-US
      // layouts type @ [ ] { } | ~ with Option. Option+Enter sends ESC CR either way.
      macOptionIsMeta: A.platform === "darwin" && !!window.vtSettings.macOptionIsMeta,
      theme: th.theme,
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(body);
    cell.term = term;
    cell.fit = fit;
    cell.body = body;
    fitCell(cell);
    term.onData((d) => {
      noteTyping(cell, d);
      const g = grids.find((x) => x.id === cell._gid);
      if (g && g.broadcast) { for (const c of g.cells) if (c && c.ptyId) A.ptyWrite(c.ptyId, d); }
      else if (cell.ptyId) A.ptyWrite(cell.ptyId, d);
    });
    term.onBell(() => onAgentSignal(cell));
    // Keyboard copy/paste: Cmd+C / Cmd+V on macOS, Ctrl+Shift+C / Ctrl+Shift+V elsewhere
    // (plain Ctrl+C / Ctrl+V stay terminal keys: interrupt and literal-next).
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const k = (e.key || "").toLowerCase();
      if (IS_MAC) {
        if (!e.metaKey || e.ctrlKey || e.altKey) return true;
        if (k === "c" && term.hasSelection()) {
          e.preventDefault();
          A.clipWriteText(term.getSelection());
          return false;
        }
        return true; // Cmd+V: the Edit menu's native paste reaches xterm's textarea as a paste event
      }
      if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return true;
      // keyCode, not e.key: the virtual-key code stays C (67) / V (86) on non-Latin layouts
      // (Russian, Greek, ...), where e.key is the layout's own letter.
      if (e.keyCode === 67) {
        e.preventDefault();
        if (term.hasSelection()) A.clipWriteText(term.getSelection());
        return false;
      }
      if (e.keyCode === 86) {
        e.preventDefault(); // stop Chromium's own Ctrl+Shift+V paste-as-plain-text, which would paste twice
        A.clipReadText().then((t) => { if (t) term.paste(t); });
        return false;
      }
      return true;
    });
    if (term.textarea) term.textarea.addEventListener("focus", () => clearAttention(cell));
    // right-click: copy the selection if there is one, else paste the clipboard (Windows-console style)
    // Assign (not addEventListener): .cellbody persists across cell lifecycles, so a listener
    // would stack on every remount (restart/shell change) and old ones keep driving dead terms.
    body.oncontextmenu = async (e) => {
      e.preventDefault();
      if (term.hasSelection()) {
        const sel = term.getSelection();
        if (sel) await A.clipWriteText(sel);
        term.clearSelection();
      } else {
        const text = await A.clipReadText();
        if (text) term.paste(text);
      }
      term.focus();
    };
    const ro = new ResizeObserver(() => fitCell(cell));
    ro.observe(body);
    cell.ro = ro;
  }
  /* ---- pane sizing ----
     Every ConPTY resize makes Windows repaint the viewport, and that repaint arrives as
     pty-data — i.e. a duplicated screenful of text stamped into the pane's scrollback. The
     ResizeObserver below fires on every layout tick, so a window/gutter drag used to send one
     resize per frame and leave dozens of repeated blocks behind. Fit xterm immediately (cheap,
     local) but only push the size down to the PTY once it settles, and only when it changed.
     main.js drops same-size resizes too; this is the coalescing half. */
  const PTY_RESIZE_MS = 140;
  function syncPtySize(cell) {
    clearTimeout(cell._resizeT);
    cell._resizeT = setTimeout(() => {
      if (!cell.ptyId || !cell.term) return;
      const cols = cell.term.cols, rows = cell.term.rows;
      if (!(cols > 0) || !(rows > 0)) return;
      if (cols === cell._ptyCols && rows === cell._ptyRows) return;
      cell._ptyCols = cols; cell._ptyRows = rows;
      A.ptyResize(cell.ptyId, cols, rows);
    }, PTY_RESIZE_MS);
  }
  function fitCell(cell) {
    if (!cell || !cell.fit || !cell.body) return;
    const w = cell.body.clientWidth, h = cell.body.clientHeight;
    if (w < 8 || h < 8) return;
    // Refit only when the pane's pixel box actually changed. Dragging the window to a monitor
    // with a different scale factor re-measures the glyph cell, so the computed column count can
    // shift by one even though the pane is exactly the same size — and that phantom column costs
    // a real ConPTY resize, i.e. another duplicated screenful. The xterm font is fixed at
    // construction (app.js awaits the bundled JetBrains Mono before termInit, so no late swap
    // changes the metrics), which makes it safe for an unchanged box to keep its current grid.
    if (w === cell._boxW && h === cell._boxH) return;
    cell._boxW = w; cell._boxH = h;
    try { cell.fit.fit(); } catch { return; }
    syncPtySize(cell);
  }
  function fitActiveGrid() {
    const g = activeGridObj();
    if (!g) return;
    for (let i = 0; i < g.layout; i++) { const c = g.cells[i]; if (c && c.term) fitCell(c); }
    positionGutters();
  }

  /* ---- rendering ---- */
  function emptyStateHtml(cell) {
    const sel = (cell && cell.shell) || DEFAULT_SHELL();
    const cwd = (cell && cell.cwd) || DEFAULT_CWD();
    return `<div class="estate">
      <div class="elabel">${cell ? E(cell.name || "New terminal") : "New terminal"}</div>
      <div class="erow"><select class="eshell">${shellOpts(sel)}</select><button class="efolder" title="Choose folder">📁</button><button class="estart">Start</button></div>
      <div class="ecwd" title="${E(cwd)}">${E(baseName(cwd))}</div>
    </div>`;
  }
  function wireEmptyState(grid, idx, body) {
    const prev = grid.cells[idx];
    const sel = body.querySelector(".eshell");
    const key = grid.id + ":" + idx;
    body.querySelector(".efolder").onclick = async () => {
      const dir = await A.pickFolder(pendingCwd.get(key) || (prev && prev.cwd) || DEFAULT_CWD());
      if (dir) { pendingCwd.set(key, dir); const lbl = body.querySelector(".ecwd"); if (lbl) { lbl.textContent = baseName(dir); lbl.title = dir; } }
    };
    body.querySelector(".estart").onclick = () => {
      const cwd = pendingCwd.get(key) || (prev && prev.cwd) || DEFAULT_CWD();
      pendingCwd.delete(key);
      startCell(grid, idx, { shell: sel.value, cwd, name: prev ? prev.name : null, themeKey: prev ? prev.themeKey : null, convoId: prev ? prev.convoId : null, paneKey: prev ? prev.paneKey : null });
    };
  }
  function headHtml(cell) {
    const state = dotState(cell);
    return `<span class="cstat ${state}" title="${statTitle(cell)}"></span>
      <select class="hshell" title="Shell (switching restarts the pane)">${shellOpts(cell.shell)}</select>
      <input class="cname" value="${E(cell.name)}" spellcheck="false" />
      ${cell.exited ? '<span class="cexit">exited</span>' : ""}
      <button class="hbtn theme" title="Theme / neon color"><svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M12 2C6.49 2 2 6.49 2 12s4.49 10 10 10c1.38 0 2.5-1.12 2.5-2.5 0-.61-.23-1.2-.64-1.67-.08-.1-.13-.21-.13-.33 0-.28.22-.5.5-.5H16c3.31 0 6-2.69 6-6 0-4.96-4.49-9-10-9zm-5.5 9c-.83 0-1.5-.67-1.5-1.5S5.67 8 6.5 8 8 8.67 8 9.5 7.33 11 6.5 11zm3-4C8.67 7 8 6.33 8 5.5S8.67 4 9.5 4s1.5.67 1.5 1.5S10.33 7 9.5 7zm5 0c-.83 0-1.5-.67-1.5-1.5S13.67 4 14.5 4s1.5.67 1.5 1.5S15.33 7 14.5 7zm3 4c-.83 0-1.5-.67-1.5-1.5S16.67 8 17.5 8s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/></svg></button>
      <button class="hbtn pop" title="Pop out into its own window">⧉</button>
      <button class="hbtn max" title="Maximize / restore">⤢</button>
      <button class="hbtn restart" title="Restart">⟳</button>
      <button class="hbtn close" title="Close">✕</button>
      <div class="tpop" style="display:none">${THEME_KEYS.map((k) => `<button class="sw" data-k="${k}" title="${THEMES[k].name}" style="background:${THEMES[k].theme.cursor}"></button>`).join("")}</div>`;
  }
  // Drag the pane header to tear it off into its own window at the drop point.
  // (The main window runs maximized, so we trigger on a deliberate drag distance
  // rather than on leaving the window edge.) A plain click stays under threshold.
  function wireHeadDrag(grid, idx, head) {
    // Assign (not addEventListener): .cellhead persists across repaints, so addEventListener
    // would stack a new drag handler on every paint and pop N windows on the Nth pop.
    head.onpointerdown = (e) => {
      if (e.button !== 0 || e.target.closest("button, input, select, .tpop")) return;
      const c = grid.cells[idx];
      if (!c || !c.started || c.exited || !c.ptyId) return;
      const sx = e.screenX, sy = e.screenY;
      let dragging = false;
      try { head.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      const onMove = (ev) => {
        if (!dragging && Math.hypot(ev.screenX - sx, ev.screenY - sy) > 28) {
          dragging = true; head.classList.add("dragging");
        }
      };
      const cleanup = () => {
        head.removeEventListener("pointermove", onMove);
        head.removeEventListener("pointerup", onUp);
        head.removeEventListener("pointercancel", cleanup);
        head.classList.remove("dragging");
        try { head.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      };
      const onUp = (ev) => {
        cleanup();
        if (dragging) popOutCell(grid, idx, { x: Math.round(ev.screenX - 80), y: Math.round(ev.screenY - 16) });
      };
      head.addEventListener("pointermove", onMove);
      head.addEventListener("pointerup", onUp);
      head.addEventListener("pointercancel", cleanup); // cancelled drag: abort cleanly, no pop-out
    };
  }
  function wireHead(grid, idx, head, cell) {
    head.querySelector(".hshell").onchange = (e) => changeShell(grid, idx, e.target.value);
    const nameInp = head.querySelector(".cname");
    // Reflect the rename in the nav-bar live-status chip live (oninput) and on commit (onchange).
    nameInp.oninput = () => { cell.name = nameInp.value || cell.name; renderTermStatus(); };
    nameInp.onchange = () => { cell.name = nameInp.value.trim() || cell.name; nameInp.value = cell.name; renderTermStatus(); persist(); };
    nameInp.onkeydown = (e) => { if (e.key === "Enter") nameInp.blur(); };
    wireHeadDrag(grid, idx, head);
    head.querySelector(".pop").onclick = () => popOutCell(grid, idx);
    head.querySelector(".max").onclick = () => toggleMax(grid, idx);
    head.querySelector(".restart").onclick = () => restartCell(grid, idx);
    head.querySelector(".close").onclick = () => closeCell(grid, idx);
    const pop = head.querySelector(".tpop");
    head.querySelector(".theme").onclick = (e) => { e.stopPropagation(); closeAllPops(); pop.style.display = pop.style.display === "none" ? "flex" : "none"; };
    pop.querySelectorAll(".sw").forEach((b) => { b.onclick = (e) => { e.stopPropagation(); setCellTheme(grid, idx, b.dataset.k); pop.style.display = "none"; }; });
  }
  function toggleMax(grid, idx) {
    const wrap = $host().querySelector(`.gridwrap[data-grid="${grid.id}"]`);
    if (!wrap) return;
    const cell = wrap.querySelector(`.cell[data-idx="${idx}"]`);
    const already = cell.classList.contains("maxed");
    wrap.querySelectorAll(".cell.maxed").forEach((c) => c.classList.remove("maxed"));
    wrap.classList.toggle("hasmax", !already);
    if (!already) cell.classList.add("maxed");
    fitActiveGrid();
  }
  function closeAllPops() { document.querySelectorAll("#gridhost .tpop").forEach((p) => (p.style.display = "none")); }

  function paintCell(grid, idx) {
    const el = cellDom(grid.id, idx);
    if (!el) return;
    const cell = grid.cells[idx];
    const head = el.querySelector(".cellhead");
    const body = el.querySelector(".cellbody");
    // Popped-out: the live PTY lives in its own window. Reserve the slot (grayed, no Start UI)
    // with a button to dock it back, so nothing new can be opened in its place.
    if (cell && cell.popped) {
      el.classList.remove("running", "attn", "maxed");
      el.classList.add("popped");
      el.style.background = "";
      el.style.removeProperty("--neon");
      const wrap = el.closest(".gridwrap");
      if (wrap && wrap.classList.contains("hasmax") && !wrap.querySelector(".cell.maxed")) wrap.classList.remove("hasmax");
      const dead = !!cell.exited; // PTY died while popped out (onPtyExit marked this placeholder)
      head.innerHTML = `<span class="cidle">${E(cell.name || "terminal")}</span><span class="cpoplbl">${dead ? "popped · exited" : "popped ⧉"}</span>`;
      body.innerHTML = `<div class="pstate"><div class="picon">⧉</div><div class="plabel">${dead ? "Process exited in its popped-out window" : "Popped out to its own window"}</div><button class="punpop">${dead ? "Close window &amp; restart here" : "Dock back in"}</button></div>`;
      body.querySelector(".punpop").onclick = () => unpopCell(grid, idx);
      renderTermStatus();
      return;
    }
    if (!cell || !cell.started) {
      el.classList.remove("running", "attn", "maxed", "popped");
      el.style.background = "";
      el.style.removeProperty("--neon");
      const wrap = el.closest(".gridwrap");
      if (wrap && wrap.classList.contains("hasmax") && !wrap.querySelector(".cell.maxed")) wrap.classList.remove("hasmax");
      head.innerHTML = `<span class="cidle">${cell ? E(cell.name || "terminal") : "terminal " + (idx + 1)}</span>`;
      body.innerHTML = emptyStateHtml(cell);
      wireEmptyState(grid, idx, body);
      renderTermStatus();
      return;
    }
    el.classList.remove("popped");
    el.classList.add("running");
    el.style.background = (THEMES[cell.themeKey] || THEMES.indigo).bg;
    el.style.setProperty("--neon", (THEMES[cell.themeKey] || THEMES.indigo).theme.cursor);
    head.innerHTML = headHtml(cell);
    wireHead(grid, idx, head, cell);
    if (!cell.mounted) { body.innerHTML = ""; mountTerm(cell, body); cell.mounted = true; }
    renderTermStatus();
  }

  function renderTabs() {
    $tabs().innerHTML = grids.map((g) => {
      const attn = g.cells.filter((c) => c && c.attention).length;
      const st = gridStatus(g);
      const dot = `<span class="tstatus-dot gtdot ${st || ""}"${st ? "" : ' style="display:none"'} title="Live workspace status"></span>`;
      return `<div class="gtab${g.id === activeGrid ? " on" : ""}${attn ? " attn" : ""}" data-grid="${g.id}">${dot}<span class="gtname">${E(g.name)}</span>${attn ? `<span class="gtbadge">${attn}</span>` : ""}${grids.length > 1 ? '<span class="gtx" title="Close workspace">✕</span>' : ""}</div>`;
    }).join("");
    $tabs().querySelectorAll(".gtab").forEach((el) => {
      el.onclick = (e) => {
        if (e.target.classList.contains("gtx")) { e.stopPropagation(); closeGrid(el.dataset.grid); return; }
        switchGrid(el.dataset.grid);
      };
      el.querySelector(".gtname").ondblclick = (e) => { e.stopPropagation(); renameGrid(el.dataset.grid, e.target); };
    });
  }
  function renderLayoutSeg() {
    const g = activeGridObj();
    const opts = [[1, "1"], [2, "2"], [3, "3"], [4, "2×2"], [6, "2×3"], [8, "2×4"]];
    $lseg().innerHTML = opts.map(([n, l]) => `<button class="lz${g && g.layout === n ? " on" : ""}" data-n="${n}">${l}</button>`).join("");
    $lseg().querySelectorAll(".lz").forEach((b) => (b.onclick = () => setLayout(+b.dataset.n)));
  }
  function ensureDom() {
    const host = $host();
    [...host.querySelectorAll(".gridwrap")].forEach((w) => { if (!grids.some((g) => g.id === w.dataset.grid)) w.remove(); });
    for (const g of grids) {
      let wrap = host.querySelector(`.gridwrap[data-grid="${g.id}"]`);
      if (!wrap) {
        wrap = document.createElement("div");
        wrap.className = "gridwrap";
        wrap.dataset.grid = g.id;
        wrap.innerHTML = Array.from({ length: SLOTS }, (_, i) => `<div class="cell" data-grid="${g.id}" data-idx="${i}"><div class="cellhead"></div><div class="cellbody"></div></div>`).join("");
        host.appendChild(wrap);
      }
      wrap.dataset.layout = g.layout;
      wrap.style.display = g.id === activeGrid ? "grid" : "none";
      applySplit(g);
      for (let i = 0; i < SLOTS; i++) paintCell(g, i);
    }
  }
  function renderAll() { renderTabs(); renderLayoutSeg(); ensureDom(); applyBroadcast(); applyNeon(); fitActiveGrid(); renderGutters(); }

  /* ---- broadcast input ---- */
  function applyBroadcast() {
    const g = activeGridObj();
    const on = !!(g && g.broadcast);
    const btn = document.getElementById("btcast");
    if (btn) btn.classList.toggle("on", on);
    const wrap = g && $host().querySelector(`.gridwrap[data-grid="${g.id}"]`);
    if (wrap) wrap.classList.toggle("cast", on);
  }
  function toggleBroadcast() {
    const g = activeGridObj();
    if (!g) return;
    g.broadcast = !g.broadcast;
    applyBroadcast();
    persist();
  }

  /* ---- neon border ---- */
  function applyNeon() {
    const host = $host();
    if (host) host.classList.toggle("neon", neon);
    const btn = document.getElementById("btneon");
    if (btn) btn.classList.toggle("on", neon);
  }
  function toggleNeon() {
    neon = !neon;
    localStorage.setItem("vt.neon", neon ? "1" : "0");
    applyNeon();
    if (A.broadcastNeon) A.broadcastNeon(neon); // keep popped-out windows in sync
  }

  /* ---- activity + agent-completion notification ---- */
  function isFocused(cell) {
    return cell._gid === activeGrid && document.hasFocus() &&
      cell.term && cell.term.textarea && document.activeElement === cell.term.textarea;
  }
  function updateStat(cell) {
    // Nav-bar strip + workspace tabs first, so they stay live even if this pane's in-grid
    // head isn't currently mounted (e.g. a background workspace mid-repaint).
    updateStripDot(cell);
    updateTabStatus();
    const el = cellDom(cell._gid, cell._idx);
    if (!el) return;
    const dot = el.querySelector(".cstat");
    if (!dot) return;
    dot.className = "cstat " + dotState(cell);
    dot.title = statTitle(cell);
  }

  /* ---- nav-bar terminal status strip ----
     One chip per started pane (across all workspaces): name in the pane's neon color +
     a red (running) / green (waiting) dot. paintCell rebuilds the chip set, updateStat
     keeps each dot's color live, onAgentSignal flashes a finished pane white x5 then green. */
  function stripDot(cell) {
    const host = document.getElementById("termstatus");
    return host ? host.querySelector(`[data-cell="${cell.id}"] .tstatus-dot`) : null;
  }
  function dotState(cell) {
    if (cell.exited) return "exited";
    if (cell.awaiting) return "awaiting"; // Claude is blocked on a multiple-choice question — overrides all
    if (cell.activity === "running") return "running";
    if (cell.activity === "typing") return "typing";
    return "idle";
  }
  function statTitle(cell) {
    if (cell.exited) return "process exited";
    if (cell.awaiting) return "waiting for your answer (multiple-choice question)";
    if (cell.activity === "running") return "running a prompt";
    if (cell.activity === "typing") return "composing a prompt";
    return "waiting for a prompt";
  }
  // A keystroke into a pane means the user is composing (yellow), not Claude working.
  // Enter clears the typing window so the reply that follows reads as running (red), not key-echo.
  function noteTyping(cell, d) {
    if (!cell || cell.exited) return;
    // Enter submits the prompt: arm the agent-done notifier so a later running→quiet
    // reads as a finished turn. Until the first real submission, boot/reload output
    // settling never flashes white (the pane just returns to ready/green).
    if (/[\r\n]/.test(d)) { cell.typingAt = 0; cell.hasPrompted = true; return; }
    cell.typingAt = Date.now();
    // Don't steal the dot off a pane Claude is actively streaming into (type-ahead mid-response).
    if (cell.activity === "running" && Date.now() - (cell.lastDataAt || 0) < ECHO_MS) return;
    if (cell.activity !== "typing") { cell.activity = "typing"; updateStat(cell); }
  }
  // Which workspace groups in the nav-bar strip are expanded (only meaningful when >1
  // workspace has terminals; a lone workspace is always shown expanded).
  const expandedGroups = new Set();
  function chipHtml(c) {
    const neonColor = (THEMES[c.themeKey] || THEMES.indigo).theme.cursor;
    return `<button class="tstatus-chip" data-cell="${c.id}" title="${E(c.name)} — ${statTitle(c)}">` +
             `<span class="tstatus-dot ${dotState(c)}"></span>` +
             `<span class="tstatus-name" style="color:${neonColor}">${E(c.name)}</span>` +
           `</button>`;
  }
  // Group the live-status chips by workspace (tab). With one workspace it shows full chips;
  // with several, each workspace collapses to just its panes' status dots until clicked open.
  function renderTermStatus() {
    const host = document.getElementById("termstatus");
    if (!host) return;
    const groups = grids.filter((g) => g.cells.some((c) => c && c.started));
    const multi = groups.length > 1;
    host.classList.toggle("multi", multi);
    host.innerHTML = groups.map((g) => {
      const expanded = !multi || expandedGroups.has(g.id);
      const panes = g.cells.filter((c) => c && c.started);
      const label = expanded ? "Click to collapse" : "Click to expand";
      return `<div class="tstatus-group ${expanded ? "expanded" : "collapsed"}" data-grid="${g.id}" title="${E(g.name)} — ${label}">` +
               `<span class="tsg-label">${E(g.name)}</span>` +
               `<div class="tsg-panes">${panes.map(chipHtml).join("")}</div>` +
             `</div>`;
    }).join("");
    host.querySelectorAll(".tstatus-group").forEach((el) => {
      el.onclick = (e) => {
        const id = el.dataset.grid;
        const chip = el.classList.contains("expanded") && e.target.closest(".tstatus-chip");
        if (chip) { focusCellById(chip.dataset.cell); return; } // expanded: clicking a pane jumps to it
        // Accordion: opening one group collapses the rest; clicking the open one closes it.
        if (expandedGroups.has(id)) expandedGroups.delete(id);
        else { expandedGroups.clear(); expandedGroups.add(id); }
        renderTermStatus();
      };
    });
    updateTabStatus(); // pane set changed → refresh each workspace tab's live dot
  }
  function updateStripDot(cell) {
    const dot = stripDot(cell);
    if (dot) dot.className = "tstatus-dot " + dotState(cell);
  }
  // Aggregate live state for a workspace tab: the highest-priority state among its live
  // panes (a question waiting > something running > composing > idle). null = no live panes.
  function gridStatus(g) {
    const rank = { awaiting: 4, running: 3, typing: 2, idle: 1 };
    let best = null;
    for (const c of g.cells) {
      if (!c || !c.started || c.exited) continue;
      const st = dotState(c);
      if (!best || (rank[st] || 0) > (rank[best] || 0)) best = st;
    }
    return best;
  }
  // Patch every workspace tab's status dot in place (no innerHTML rebuild) so the tabs
  // track pane activity in real time, even for background workspaces.
  function updateTabStatus() {
    const host = $tabs();
    if (!host) return;
    for (const g of grids) {
      const dot = host.querySelector(`.gtab[data-grid="${g.id}"] .gtdot`);
      if (!dot) continue;
      const st = gridStatus(g);
      dot.className = "tstatus-dot gtdot" + (st ? " " + st : "");
      dot.style.display = st ? "" : "none";
    }
  }
  function flashTermStatus(cell) {
    const el = cellDom(cell._gid, cell._idx);
    const dots = [stripDot(cell), el ? el.querySelector(".cstat") : null];
    for (const dot of dots) {
      if (!dot) continue;
      dot.classList.remove("flash");
      void dot.offsetWidth; // reset so a repeat finish re-triggers the animation
      dot.classList.add("flash");
      dot.addEventListener("animationend", () => dot.classList.remove("flash"), { once: true });
    }
  }
  function focusCellById(id) {
    for (const g of grids) {
      const idx = g.cells.findIndex((c) => c && c.id === id);
      if (idx < 0) continue;
      const c = g.cells[idx];
      if (window.activateTab) window.activateTab("terminal");
      if (g.id !== activeGrid) switchGrid(g.id);
      clearAttention(c);
      setTimeout(() => { if (c.term) c.term.focus(); fitActiveGrid(); }, 0);
      return;
    }
  }
  function onAgentSignal(cell) {
    if (!cell || cell.exited) return;
    cell.activity = "done";
    updateStat(cell);
    flashTermStatus(cell); // nav-bar chip: flash white x5 then green
    if (isFocused(cell)) return; // user is already looking at it
    cell.attention = true;
    const el = cellDom(cell._gid, cell._idx);
    if (el) el.classList.add("attn");
    renderTabs();
    if (!muted) playChime();
    if (!document.hasFocus()) notifyOS(cell);
  }
  function clearAttention(cell) {
    if (!cell || !cell.attention) return;
    cell.attention = false;
    if (cell.activity === "done") cell.activity = "idle";
    const el = cellDom(cell._gid, cell._idx);
    if (el) el.classList.remove("attn");
    updateStat(cell);
    renderTabs();
  }
  function playChime() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      [880, 1175].forEach((f, i) => {
        const o = audioCtx.createOscillator(), gain = audioCtx.createGain();
        o.type = "sine"; o.frequency.value = f;
        const t0 = audioCtx.currentTime + i * 0.13;
        gain.gain.setValueAtTime(0, t0);
        gain.gain.linearRampToValueAtTime(0.12, t0 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
        o.connect(gain).connect(audioCtx.destination);
        o.start(t0); o.stop(t0 + 0.24);
      });
    } catch { /* ignore */ }
  }
  // Main-process notification: on an unsigned macOS build the OS may refuse it, and only main can see
  // that failure (it bounces the Dock instead).
  function notifyOS(cell) { A.notify("Agent finished", cell.name); }
  function tickActivity() {
    const now = Date.now();
    for (const g of grids) {
      for (const c of g.cells) {
        if (!c || !c.started || c.exited) continue;
        const quiet = c.lastDataAt && now - c.lastDataAt > IDLE_MS;
        // A composing prompt left untouched falls back to waiting (green) after the idle window.
        if (c.activity === "typing") {
          if (quiet && now - (c.typingAt || 0) > IDLE_MS) { c.activity = "idle"; updateStat(c); }
          continue;
        }
        if (c.activity !== "running" || !quiet) continue;
        if (c.shell === "claude") {
          if (!c.notified) {
            c.notified = true;
            // Only a turn that followed a real prompt is a genuine "agent done" → white
            // flash + chime. The first quiet after launch/reload (boot banner settling)
            // just returns the pane to ready, no flash.
            if (c.hasPrompted) onAgentSignal(c);
            else { c.activity = "idle"; updateStat(c); }
          }
        } else {
          c.activity = "idle"; updateStat(c); // other shells: just go green (waiting), no chime
        }
      }
    }
  }
  // Poll the per-pane attention flags the AskUserQuestion hook writes, and blink a pane's
  // status light orange while its Claude is blocked waiting on the user's multiple-choice answer.
  const ATTN_STALE_MS = 30 * 60 * 1000; // ignore a stuck "awaiting" flag older than this
  async function pollAttention() {
    let map = null;
    try { map = await A.paneAttention(); } catch { /* ignore */ }
    if (!map) return;
    const now = Date.now();
    for (const g of grids) {
      for (const c of g.cells) {
        if (!c || !c.started || c.exited || !c.paneKey) continue;
        const e = map[c.paneKey];
        const awaiting = !!(e && e.awaiting && now - (e.ts || 0) < ATTN_STALE_MS);
        if (!!c.awaiting !== awaiting) {
          c.awaiting = awaiting;
          updateStat(c);
        }
      }
    }
  }

  /* ---- saved-layouts rail ---- */
  function workspaceData(g) {
    return {
      layout: g.layout,
      splits: g.splits || null,
      cells: g.cells.map((c) => (c && (c.started || c.popped) ? cellData(c) : null)),
    };
  }
  async function saveCurrentWorkspace(name) {
    const g = activeGridObj();
    if (!g) return;
    // Reuse the binding if this grid is already a loaded workspace (avoids duplicates); else create new.
    const arr = await A.saveNamedLayout({ id: g.loadedLayoutId || null, name, data: workspaceData(g) });
    if (!g.loadedLayoutId && Array.isArray(arr) && arr[0]) g.loadedLayoutId = arr[0].id;
    g.name = name; // keep the tab name in sync with the saved card (auto-save uses g.name)
    renderTabs();
  }
  async function launchLayout(id) {
    // Already open in a tab? Just switch to it instead of relaunching a second copy.
    const open = grids.find((g) => g.loadedLayoutId === id);
    if (open) { if (open.id !== activeGrid) switchGrid(open.id); return; }
    const layouts = await A.listLayouts();
    const l = layouts.find((x) => x.id === id);
    if (!l) return;
    let g = activeGridObj();
    if (!g) return;
    // Don't clobber a tab that's in use: if the current tab has any live or popped-out terminal,
    // open the layout in a new tab. A tab with no active terminals gets loaded in place.
    const inUse = g.cells.some((c) => c && (c.popped || (c.started && !c.exited)));
    if (inUse) { g = makeGrid(); activeGrid = g.id; }
    for (let i = 0; i < SLOTS; i++) { disposeCell(g.cells[i]); g.cells[i] = null; }
    g.layout = l.layout || 4;
    g.splits = l.splits || {};
    g.name = l.name;
    g.loadedLayoutId = id; // bind so later edits auto-save back to this saved workspace
    renderAll();
    // Resume each pane's ACTUAL current session, not the id frozen into the saved layout.
    // A pane's session id rotates on /clear (and /resume, compaction); the vault-terminal-pane-session
    // hook records the live id keyed by the stable paneKey. Preferring it means a pane the
    // user /cleared reopens on its cleared (or fresh) session instead of resurrecting the old
    // conversation or failing to open. spawnPty falls back to fresh if that session has no file.
    let paneMap = null;
    try { paneMap = await A.paneLiveSessions(); } catch { /* none → use saved ids */ }
    (l.cells || []).forEach((c, i) => {
      if (!c || i >= SLOTS) return; // tolerate a malformed saved layout — never spawn past the last slot
      const convoId = (c.paneKey && paneMap && paneMap[c.paneKey]) || c.convoId || null;
      startCell(g, i, { shell: c.shell, cwd: c.cwd, themeKey: c.themeKey, name: c.name, convoId, paneKey: c.paneKey || null });
    });
    persist();
    renderRail(); // refresh the "live" badge on the loaded card
  }
  function lcard(l, linked) {
    const panes = (l.cells || []).filter(Boolean).length;
    const live = linked && linked.has(l.id);
    return `<div class="lcard${live ? " linked" : ""}" data-id="${E(l.id)}">
      <div class="lc-main"><div class="lc-name">${E(l.name)}${live ? '<span class="lc-live" title="Loaded — your edits auto-save here">● live</span>' : ""}</div><div class="lc-meta">${panes} pane${panes === 1 ? "" : "s"} · ${timeAgo(l.updatedAt || l.createdAt)}</div></div>
      <div class="lc-btns"><button class="lc-ren" title="Rename">✎</button><button class="lc-del" title="Delete">✕</button></div>
    </div>`;
  }
  async function renderRail() {
    const rail = document.getElementById("termrail");
    if (!rail) return;
    rail.classList.toggle("collapsed", railCollapsed);
    if (railCollapsed) {
      rail.innerHTML = `<button class="railcol" id="railcol" title="Expand saved layouts">»</button>`;
      document.getElementById("railcol").onclick = () => { railCollapsed = false; localStorage.setItem("vt.railCollapsed", "0"); renderRail(); };
      return;
    }
    const layouts = await A.listLayouts();
    const linked = autoSaveWorkspace ? new Set(grids.map((g) => g.loadedLayoutId).filter(Boolean)) : new Set();
    rail.innerHTML = `
      <div class="railhd"><span class="railhd-l">Saved layouts<span class="lsaving" id="lsaving" title="Layout auto-saves every 30s"></span></span><button class="railcol" id="railcol" title="Collapse">«</button></div>
      <button class="lsave" id="lsave">＋ Save workspace…</button>
      <div class="lsaveform" id="lsaveform" style="display:none">
        <input class="lname" id="lname" placeholder="layout name" spellcheck="false" />
        <div class="lsrow"><button class="lsok" id="lsok">Save</button><button class="lscancel" id="lscancel">Cancel</button></div>
      </div>
      <div class="llist">${layouts.length ? layouts.map((l) => lcard(l, linked)).join("") : '<p class="muted small" style="padding:10px 6px">No saved layouts yet. Arrange a workspace and click “Save”.</p>'}</div>`;
    document.getElementById("railcol").onclick = () => { railCollapsed = true; localStorage.setItem("vt.railCollapsed", "1"); renderRail(); };
    const form = document.getElementById("lsaveform");
    document.getElementById("lsave").onclick = () => {
      form.style.display = "block";
      const n = document.getElementById("lname");
      n.value = (activeGridObj() || {}).name || "";
      n.focus(); n.select();
    };
    document.getElementById("lscancel").onclick = () => { form.style.display = "none"; };
    document.getElementById("lname").onkeydown = (e) => {
      if (e.key === "Enter") document.getElementById("lsok").click();
      if (e.key === "Escape") form.style.display = "none";
    };
    document.getElementById("lsok").onclick = async () => {
      const name = document.getElementById("lname").value.trim() || "Layout";
      await saveCurrentWorkspace(name);
      renderRail();
    };
    rail.querySelectorAll(".lcard").forEach((el) => {
      el.querySelector(".lc-main").onclick = () => launchLayout(el.dataset.id);
      el.querySelector(".lc-del").onclick = (e) => {
        e.stopPropagation();
        const id = el.dataset.id;
        for (const g of grids) if (g.loadedLayoutId === id) g.loadedLayoutId = null; // stop auto-saving to a deleted card
        A.deleteLayout(id).then(renderRail);
      };
      el.querySelector(".lc-ren").onclick = (e) => { e.stopPropagation(); renameLayoutInline(el.dataset.id, el); };
    });
  }
  function renameLayoutInline(id, el) {
    const span = el.querySelector(".lc-name");
    span.contentEditable = "true";
    span.focus();
    document.getSelection().selectAllChildren(span);
    const done = async () => {
      span.contentEditable = "false";
      const name = span.textContent.trim();
      if (name) {
        await A.renameLayout(id, name);
        // If this saved workspace is currently loaded into a grid, rename its tab to match.
        let synced = false;
        for (const g of grids) if (g.loadedLayoutId === id && g.name !== name) { g.name = name; synced = true; }
        if (synced) { renderTabs(); persist(); }
      }
      renderRail();
    };
    span.onblur = done;
    span.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); span.blur(); } if (e.key === "Escape") span.blur(); };
  }

  /* ---- persistence ---- */
  // ptyId is included so a renderer reload can re-attach to PTYs still alive in the main process.
  function buildSnapshot() {
    return {
      activeGrid,
      grids: grids.map((g) => ({
        id: g.id, name: g.name, layout: g.layout, broadcast: !!g.broadcast, loadedLayoutId: g.loadedLayoutId || null, splits: g.splits || null,
        cells: g.cells.map((c) => (c ? cellData(c, { ptyId: c.ptyId || null, popped: !!c.popped }) : null)),
      })),
    };
  }
  // Auto-save: when a saved workspace is loaded into a grid, write edits (colors, names,
  // layout, panes) back to that saved layout. Debounced; fires on every persist() trigger,
  // which already covers theme/name/layout/broadcast/pane add/remove/shell changes.
  let autoSaveWsT;
  function autoSaveWorkspaces() {
    if (!autoSaveWorkspace || !grids.some((g) => g.loadedLayoutId)) return;
    clearTimeout(autoSaveWsT);
    autoSaveWsT = setTimeout(async () => {
      await reconcileConvoIds(); // save the live session ids, not the stale spawn-time ones
      for (const g of grids) {
        if (!g.loadedLayoutId) continue;
        // Don't overwrite a saved layout with an empty snapshot. After a full relaunch a bound
        // grid is restored with not-yet-started cells; only persist once it's actually live.
        if (!g.cells.some((c) => c && c.started)) continue;
        A.saveNamedLayout({ id: g.loadedLayoutId, name: g.name, data: workspaceData(g) });
      }
    }, 600);
  }
  // Little spinner next to "Saved layouts": ring-spins while a save is in flight,
  // flips to a green dot when it lands, then fades. No-op if the rail is collapsed/hidden.
  let savingFadeT;
  function flashSaving() {
    const el = document.getElementById("lsaving");
    if (!el) return;
    clearTimeout(savingFadeT);
    el.className = "lsaving on";
    return (ok) => {
      el.className = ok === false ? "lsaving" : "lsaving done";
      savingFadeT = setTimeout(() => { el.className = "lsaving"; }, 1000);
    };
  }
  // Refresh each live Claude pane's convoId from the hook-written map, so we save/resume
  // the conversation the pane is actually on — not the stale id it spawned with (a /clear,
  // /resume, or compaction rotates the id underneath us). Keyed by the pane's stable paneKey.
  async function reconcileConvoIds() {
    let map;
    try { map = await A.paneLiveSessions(); } catch { return; }
    if (!map) return;
    for (const g of grids) for (const c of g.cells) {
      if (!c || !c.started || c.exited || c.shell !== "claude" || !c.paneKey) continue;
      const live = map[c.paneKey];
      if (live && live !== c.convoId) c.convoId = live;
    }
  }
  let persistT;
  function persist() {
    if (!restored) return;
    autoSaveWorkspaces();
    clearTimeout(persistT);
    persistT = setTimeout(async () => {
      await reconcileConvoIds();
      const done = flashSaving();
      try { await A.saveTermLayout(buildSnapshot()); done && done(true); }
      catch { done && done(false); }
    }, 300);
  }
  // Flush the layout now (used by the reload/restart buttons, pop-out, and main's F5 flush so
  // live ptyIds are saved first). Reconciles convoIds like every other save path, so the flushed
  // snapshot carries post-/clear session ids — all callers await the returned promise.
  window.vtFlushLayout = async () => {
    if (!restored) return; // boot: the saved snapshot on disk is still the latest good one
    clearTimeout(persistT);
    await reconcileConvoIds();
    return A.saveTermLayout(buildSnapshot());
  };
  // Registered at load (not in termInit) so a popout closed while this window boots is queued, not dropped.
  if (A.onPopoutRedock) A.onPopoutRedock((cfg) => (redockQueue ? redockQueue.push(cfg) : dockBackCell(cfg)));

  async function termInit() {
    SHELLS = await A.listShells();
    A.onPtyData(({ id, data, seq }) => {
      const c = byPty.get(id);
      if (!c) return;
      const now = Date.now();
      const want = now - (c.typingAt || 0) < ECHO_MS ? "typing" : "running"; // key-echo vs Claude output
      c.lastDataAt = now;
      c.notified = false;
      if (c.activity !== want) { c.activity = want; updateStat(c); }
      if (c.replayGate) c.replayGate.data(data, seq); // reattached pane: order against the replay buffer (#21)
      else if (c.term) c.term.write(data);
    });
    A.onPtyExit(({ id }) => {
      const c = byPty.get(id);
      if (!c) {
        // A popped-out pane's PTY died: its placeholder isn't in byPty (the popout window
        // renders the output), so mark the reserved slot dead here. The map entry stays so
        // dockBackCell can still find this slot when the popout window eventually closes.
        const p = poppedPtys.get(id);
        if (p && p.popped && !p.exited) {
          p.exited = true;
          p.ptyId = null; // dead handle — never reattach to it (a reload reclaims the slot)
          for (const g of grids) { const i = g.cells.indexOf(p); if (i >= 0) { paintCell(g, i); break; } }
          persist();
        }
        return;
      }
      c.exited = true; c.ptyId = null;
      byPty.delete(id);
      if (c.term) c.term.write("\r\n\x1b[2m[process exited — ⟳ to restart]\x1b[0m\r\n");
      const g = grids.find((x) => x.id === c._gid);
      if (g) paintCell(g, c._idx);
    });
    document.getElementById("gtadd").onclick = () => addGrid();
    document.getElementById("btcast").onclick = toggleBroadcast;
    const popAllBtn = document.getElementById("btpopall");
    if (popAllBtn) popAllBtn.onclick = popOutAll;
    const unpopAllBtn = document.getElementById("btunpopall");
    if (unpopAllBtn) unpopAllBtn.onclick = unpopAll;
    const muteBtn = document.getElementById("btmute");
    const reflectMute = () => { muteBtn.classList.toggle("on", !muted); muteBtn.textContent = muted ? "🔕" : "🔔"; };
    reflectMute();
    muteBtn.onclick = () => { muted = !muted; localStorage.setItem("vt.muteChime", muted ? "1" : "0"); reflectMute(); };
    document.getElementById("btneon").onclick = toggleNeon;
    const saveBtn = document.getElementById("btsave");
    if (saveBtn) saveBtn.onclick = saveLayoutNow;
    const autowsBtn = document.getElementById("btautows");
    if (autowsBtn) {
      const reflectWs = () => autowsBtn.classList.toggle("on", autoSaveWorkspace);
      reflectWs();
      autowsBtn.onclick = () => {
        autoSaveWorkspace = !autoSaveWorkspace;
        localStorage.setItem("vt.autoSaveWorkspace", autoSaveWorkspace ? "1" : "0");
        reflectWs();
        if (autoSaveWorkspace) autoSaveWorkspaces(); // flush current edits when re-enabled
        renderRail(); // toggle the "live" badges
      };
    }
    document.addEventListener("click", closeAllPops);

    let saved = null;
    try { saved = await A.loadTermLayout(); } catch { /* ignore */ }
    if (saved && saved.grids && saved.grids.length) {
      grids = saved.grids.map((g, i) => ({
        id: g.id || "g" + (i + 1),
        name: g.name || "Workspace " + (i + 1),
        layout: g.layout || 4,
        broadcast: !!g.broadcast,
        loadedLayoutId: g.loadedLayoutId || null,
        splits: g.splits || {},
        // Pad (never discard) the saved cells to SLOTS: snapshots written before the 2×3/2×4
        // layouts existed hold 4-cell arrays, and dropping them blanked every pane on reload.
        cells: Array.from({ length: SLOTS }, (_, ci) => { const c = g.cells && g.cells[ci]; return c ? { ...c, started: false, mounted: false } : null; }),
      }));
      // Resume the id sequence past the highest restored id, not at grids.length — after a
      // workspace was closed the snapshot can hold e.g. [g1, g3], and gridSeq=2 would mint a
      // duplicate "g3" (two grids sharing DOM data-grid → cells/tabs mis-target).
      gridSeq = grids.reduce((m, g) => { const n = /^g(\d+)$/.exec(g.id); return n ? Math.max(m, +n[1]) : m; }, grids.length);
      activeGrid = saved.activeGrid && grids.some((x) => x.id === saved.activeGrid) ? saved.activeGrid : grids[0].id;
    } else {
      activeGrid = makeGrid().id;
    }
    restored = true;
    renderAll();

    // Re-attach panes whose PTYs are still alive in the main process (renderer reload, not full relaunch).
    // On a full relaunch the PTYs are gone, so re-attach fails for every pane; instead of leaving the
    // grid full of blank panes, resume each saved pane's session (same path launchLayout takes) so the
    // app opens straight to its terminals. Prefer the hook-written live convo id over the stale saved
    // one, exactly like launchLayout, so a /cleared pane reopens on its current session.
    try {
      const live = new Set(await A.ptyList());
      let paneMap = null;
      try { paneMap = await A.paneLiveSessions(); } catch { /* none → use saved ids */ }
      for (const g of grids) for (let i = 0; i < SLOTS; i++) {
        const c = g.cells[i];
        if (!c) continue;
        if (c.popped) {
          // Refresh: the popout window is still alive → keep the slot reserved (it owns the PTY)
          // and re-track it so a later pty-exit / dock-back still finds this placeholder.
          // Full relaunch: the PTY is gone → reclaim the slot so it's usable again.
          if (!c.ptyId || !live.has(c.ptyId)) { g.cells[i] = null; paintCell(g, i); }
          else poppedPtys.set(c.ptyId, c);
          continue;
        }
        if (c.ptyId && live.has(c.ptyId)) { await reattachCell(g, i, c); continue; }
        // Dead PTY (full relaunch): respawn/resume this pane from its saved snapshot.
        const convoId = (c.paneKey && paneMap && paneMap[c.paneKey]) || c.convoId || null;
        await startCell(g, i, { shell: c.shell, cwd: c.cwd, themeKey: c.themeKey, name: c.name, convoId, paneKey: c.paneKey || null });
      }
      persist();
    } catch { /* ignore */ }
    // Popouts closed while this window was booting: dock them now that their placeholders are re-tracked.
    const queued = redockQueue;
    redockQueue = null;
    for (const cfg of queued) await dockBackCell(cfg);

    renderRail();
    // Keep the resize gutters glued to their gaps as the host changes size (window resize,
    // rail collapse, devtools) — the per-cell ResizeObservers refit xterm but don't move gutters.
    const host = $host();
    if (host && window.ResizeObserver) new ResizeObserver(() => positionGutters()).observe(host);
    // Only do the per-second work when panes are actually live — otherwise these timers hammered
    // the main process with a readdir every second (pollAttention) and ran forever even with zero
    // Claude panes and while hidden to the tray (backgroundThrottling is off).
    const anyStartedPane = () => grids.some((g) => g.cells.some((c) => c && c.started && !c.exited));
    const anyClaudePane = () => grids.some((g) => g.cells.some((c) => c && c.started && !c.exited && c.paneKey));
    setInterval(() => { if (anyStartedPane()) tickActivity(); }, 1000);
    if (anyClaudePane()) pollAttention();
    setInterval(() => { if (anyClaudePane()) pollAttention(); }, 2000);
    // Heartbeat: auto-save the working layout + any bound saved workspaces every 30s,
    // so a crash/close never loses more than half a minute of arrangement.
    setInterval(() => { if (anyStartedPane()) persist(); }, 30000);
  }

  // Resume a past Claude conversation (Chat History tab, history.js) in the first free pane of
  // the active workspace, or in a new workspace when it's full.
  function termResumeSession({ id, cwd, title }) {
    if (window.activateTab) window.activateTab("terminal");
    let g = activeGridObj();
    let idx = -1;
    for (let i = 0; i < g.layout; i++) { const c = g.cells[i]; if (!c || (!c.started && !c.popped)) { idx = i; break; } }
    // Grid full: open a new workspace instead of overwriting slot 0 (which would orphan
    // that pane's live PTY and leave its xterm streaming into a detached DOM node).
    if (idx < 0) { g = makeGrid(); activeGrid = g.id; renderAll(); idx = 0; }
    startCell(g, idx, { shell: "claude", cwd: cwd || DEFAULT_CWD(), name: (title || "").slice(0, 44), resumeId: id });
  }

  window.fitActiveGrid = fitActiveGrid;
  window.termResumeSession = termResumeSession;
  // Not auto-run: app.js calls it once the JetBrains Mono webfont has loaded (xterm measures
  // the glyph cell at construction, so a late font swap would skew every pane's column count).
  window.termInit = termInit;
})();
