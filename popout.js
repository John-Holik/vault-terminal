/* ===== Vault Terminal — popped-out terminal window =====
   A standalone window hosting one xterm bound to a PTY that already lives in the
   main process. Config arrives via the loadFile query string; the PTY is reached
   by id over the same bridge the main window uses. */
(async () => {
  const A = window.api;
  const P = new URLSearchParams(location.search);
  const ptyId = P.get("ptyId");
  const key = P.get("key") || "";
  const name = P.get("name") || "Terminal";
  const themeKey = P.get("themeKey") || "indigo";
  let onTop = P.get("alwaysOnTop") === "1";
  let locked = P.get("locked") === "1";
  const grouped = P.get("grouped") === "1";
  const neon = P.get("neon") === "1";

  // Shared theme table (themes.js, loaded before this script; also used by the main grid).
  // Fallback: a one-theme table so a missing/failed themes.js degrades to indigo, not a crash.
  const THEMES = window.VT_THEMES || {
    indigo: { name: "Indigo", bg: "#0E0E11", theme: { background: "#0E0E11", foreground: "#EDEDEF", cursor: "#6E79E6", cursorAccent: "#0E0E11", selectionBackground: "rgba(110,121,230,.35)" } },
  };
  const THEME_KEYS = Object.keys(THEMES);
  let curTheme = THEMES[themeKey] ? themeKey : "indigo";
  const th = THEMES[curTheme];

  document.body.style.background = th.bg;
  document.documentElement.style.setProperty("--neon", th.theme.cursor);
  document.body.classList.toggle("neon", neon); // carry the main window's neon glow across
  if (A.onPopoutNeon) A.onPopoutNeon((on) => document.body.classList.toggle("neon", !!on));
  document.title = name;

  // xterm measures the glyph cell at construction, so load the bundled JetBrains Mono first
  // (same as the main window) or the pane would size itself against the fallback font.
  try { await document.fonts.load("12px 'JetBrains Mono'"); } catch { /* fall back to the next font in the stack */ }

  const body = document.getElementById("tbody");
  const term = new Terminal({
    fontFamily: "'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace",
    fontSize: A.settings.fontSize, cursorBlink: true, allowProposedApi: true, scrollback: 5000,
    rightClickSelectsWord: false, // see terminal.js mountTerm
    macOptionIsMeta: A.platform === "darwin" && !!A.settings.macOptionIsMeta, // setting, see terminal.js mountTerm
    theme: th.theme,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(body);

  // Fit xterm immediately, but coalesce the PTY resize: ConPTY repaints its viewport on every
  // resize and that repaint lands in the pane as duplicated text, so a window drag firing per
  // frame used to leave a stack of repeated blocks behind. (Twin of terminal.js syncPtySize.)
  let resizeT, ptyCols = 0, ptyRows = 0, boxW = 0, boxH = 0;
  function doFit() {
    const w = body.clientWidth, h = body.clientHeight;
    if (w < 8 || h < 8) return;
    if (w === boxW && h === boxH) return; // DPI-only change (dragged to another monitor) must not reflow — see terminal.js fitCell
    boxW = w; boxH = h;
    try { fit.fit(); } catch { return; }
    clearTimeout(resizeT);
    resizeT = setTimeout(() => {
      if (!ptyId || !(term.cols > 0) || !(term.rows > 0)) return;
      if (term.cols === ptyCols && term.rows === ptyRows) return;
      ptyCols = term.cols; ptyRows = term.rows;
      A.ptyResize(ptyId, ptyCols, ptyRows);
    }, 140);
  }
  new ResizeObserver(doFit).observe(body);
  window.addEventListener("resize", doFit);

  // status dot: red while the PTY is producing output (running a prompt), green when idle (waiting)
  const pdot = document.querySelector(".pdot");
  let idleT;
  const setStatus = (s) => { if (pdot) pdot.className = "pdot " + s; };
  const markRunning = () => { setStatus("running"); clearTimeout(idleT); idleT = setTimeout(() => setStatus("waiting"), 6000); };
  setStatus("waiting");

  term.onData((d) => { if (ptyId) A.ptyWrite(ptyId, d); });
  // Keyboard copy/paste: Cmd+C / Cmd+V on macOS, Ctrl+Shift+C / Ctrl+Shift+V elsewhere
  // (twin of the handler in terminal.js mountTerm).
  const IS_MAC = A.platform === "darwin";
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
    // keyCode, not e.key: stays C (67) / V (86) on non-Latin layouts (see terminal.js mountTerm)
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
  // right-click: copy the selection if there is one, else paste the clipboard (Windows-console style)
  body.addEventListener("contextmenu", async (e) => {
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
  });
  /* ---- replay-ordering gate (#21) — verbatim twin of makeReplayGate in terminal.js (no shared
     module between the two windows); keep them in sync. Live chunks arriving while the replay
     fetch is pending queue behind it; the per-pty seq tells which queued chunks the replay
     buffer already contains (main appends live data to it), so nothing double-writes. */
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
  const gate = makeReplayGate((d) => term.write(d));
  A.onPtyData(({ id, data, seq }) => { if (id === ptyId && data) { gate.data(data, seq); markRunning(); } });
  A.onPtyExit(({ id }) => { if (id === ptyId) { clearTimeout(idleT); setStatus("exited"); term.write("\r\n\x1b[2m[process exited]\x1b[0m\r\n"); } });

  // Replay the main process's ring buffer so the session looks continuous, then fit. A current
  // main.js answers the { id } arg shape with { data, seq }; an old main.js (window opened after
  // an F5 but before the Shift+F5 relaunch) doesn't know that shape and returns "" — detected by
  // the string result, then refetched the legacy way (no seq → gate falls back to old behavior).
  (async () => {
    let r = null;
    try { r = await A.ptyReplay({ id: ptyId }); } catch { /* ignore */ }
    if (!r || typeof r !== "object") {
      let buf = "";
      try { buf = await A.ptyReplay(ptyId); } catch { /* ignore */ }
      r = { data: buf || "", seq: null };
    }
    gate.settle(r.data || "", typeof r.seq === "number" ? r.seq : null);
    doFit();
    term.focus();
  })();

  /* ---- titlebar controls ---- */
  const btnTop = document.getElementById("btnTop");
  const btnLock = document.getElementById("btnLock");
  const reflectTop = () => btnTop.classList.toggle("on", onTop);
  const reflectLock = () => { btnLock.classList.toggle("on", locked); btnLock.textContent = locked ? "🔒" : "🔓"; };
  reflectTop();
  reflectLock();

  btnTop.onclick = () => { onTop = !onTop; A.popoutSetAlwaysOnTop({ key, value: onTop }); reflectTop(); };
  btnLock.onclick = () => { locked = !locked; A.popoutSetLocked({ key, value: locked }); reflectLock(); };

  // pin/unpin from the "pop out all" move-together group, plus fill-monitor tiling
  // (both only shown when this window was popped as part of a group)
  const btnPin = document.getElementById("btnPin");
  const btnMax = document.getElementById("btnMax");
  if (grouped) {
    let pinned = true;
    btnPin.style.display = "";
    btnMax.style.display = "";
    const reflectPin = () => {
      btnPin.classList.toggle("on", pinned);
      btnPin.title = pinned
        ? "Pinned to group — windows move together (click to unpin)"
        : "Unpinned — moves on its own (click to re-pin to group)";
    };
    reflectPin();
    btnPin.onclick = () => { pinned = !pinned; A.popoutSetGrouped({ value: pinned }); reflectPin(); };
    btnMax.onclick = () => A.popoutTileGroup();
  }
  document.getElementById("btnMin").onclick = () => A.popoutMinimize();
  document.getElementById("btnClose").onclick = () => A.popoutClose();

  /* ---- rename (changes travel back to the grid on dock) ---- */
  let curName = name;
  const nameInp = document.getElementById("pname");
  nameInp.value = name;
  nameInp.onchange = () => {
    curName = nameInp.value.trim() || curName;
    nameInp.value = curName;
    document.title = curName;
    A.popoutRename({ ptyId, name: curName });
  };
  nameInp.onkeydown = (e) => { if (e.key === "Enter") nameInp.blur(); };

  /* ---- theme / neon color (changes travel back to the grid on dock) ---- */
  const tpop = document.getElementById("tpop");
  tpop.innerHTML = THEME_KEYS.map((k) => `<button class="sw" data-k="${k}" title="${THEMES[k].name}" style="background:${THEMES[k].theme.cursor}"></button>`).join("");
  const reflectSw = () => tpop.querySelectorAll(".sw").forEach((b) => b.classList.toggle("on", b.dataset.k === curTheme));
  reflectSw();
  function applyTheme(k) {
    const t = THEMES[k];
    if (!t) return;
    curTheme = k;
    term.options.theme = t.theme;
    document.body.style.background = t.bg;
    document.documentElement.style.setProperty("--neon", t.theme.cursor);
    reflectSw();
    A.popoutSetTheme({ ptyId, themeKey: k, bg: t.bg });
  }
  document.getElementById("btnTheme").onclick = (e) => { e.stopPropagation(); tpop.classList.toggle("open"); };
  tpop.querySelectorAll(".sw").forEach((b) => { b.onclick = (e) => { e.stopPropagation(); applyTheme(b.dataset.k); tpop.classList.remove("open"); }; });
  document.addEventListener("click", () => tpop.classList.remove("open"));
})();
