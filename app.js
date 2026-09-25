/* ===== Vault Terminal: tabs, boot, reload/restart, settings modal ===== */
(() => {
  const A = window.api;
  const E = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const $ = (id) => document.getElementById(id);
  const TAB_KEY = "vt.tab";

  document.body.classList.add("plat-" + A.platform);
  // Mutable copy of the boot settings snapshot (the bridge-exposed object is frozen). terminal.js reads
  // defaults from it at spawn time; save() below patches it so new panes see changes without a reload.
  window.vtSettings = { ...A.settings };

  /* ---- tabs ---- */
  function activateTab(name) {
    try { localStorage.setItem(TAB_KEY, name); } catch { /* ignore */ }
    document.querySelectorAll(".seg .tab").forEach((x) => { const on = x.dataset.tab === name; x.classList.toggle("on", on); x.setAttribute("aria-selected", on ? "true" : "false"); x.tabIndex = on ? 0 : -1; });
    document.querySelectorAll(".panel").forEach((x) => x.classList.toggle("on", x.id === name));
    if (name === "history" && window.histInit) window.histInit();
    else if (name === "terminal" && window.fitActiveGrid) window.fitActiveGrid();
  }
  window.activateTab = activateTab;

  function setupTabs() {
    document.querySelectorAll(".panel").forEach((p) => p.setAttribute("role", "tabpanel"));
    // mirror title -> aria-label on icon-only controls
    document.querySelectorAll("button[title]:not([aria-label])").forEach((b) => b.setAttribute("aria-label", b.getAttribute("title")));
    const tabs = [...document.querySelectorAll(".seg .tab")];
    tabs.forEach((t, i) => {
      t.onclick = () => activateTab(t.dataset.tab);
      t.tabIndex = t.classList.contains("on") ? 0 : -1; // roving tabindex: arrow keys move between tabs
      t.onkeydown = (e) => {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
        e.preventDefault();
        const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
        next.focus(); activateTab(next.dataset.tab);
      };
    });
  }

  function restoreTab() {
    let saved = null;
    try { saved = localStorage.getItem(TAB_KEY); } catch { /* ignore */ }
    if (saved && document.querySelector(`.seg .tab[data-tab="${saved}"]`)) activateTab(saved);
  }

  /* ---- reload / restart ---- */
  // Flush the live terminal layout (with reconciled convoIds) before the renderer or the app is
  // torn down, so the restore doesn't read a snapshot up to 30s stale.
  async function flushLayout() {
    if (window.vtFlushLayout) { try { await window.vtFlushLayout(); } catch { /* ignore */ } }
  }
  async function doReloadUI() { await flushLayout(); A.reloadUI(); }
  function setupReload() {
    $("reloadui").onclick = doReloadUI;
    $("restartapp").onclick = async () => { await flushLayout(); A.restartApp(); };
    A.onHotkeyReload(doReloadUI);
  }

  /* ---- settings modal ---- */
  const modal = $("settings");
  // Patch the boot snapshot too, so terminal.js picks the new defaults up for the next pane without a reload.
  const save = (patch) => { Object.assign(window.vtSettings, patch); return A.setSettings(patch); };

  function renderHooks(st) {
    const el = $("s-hooks-status");
    let kind, text;
    if (st.installed) { kind = "ok"; text = "Installed in " + (st.hooksDir || "the app data folder"); }
    else if (st.reason) { kind = "warn"; text = st.reason; }
    else { kind = ""; text = "Not installed"; }
    el.className = "fstatus " + kind;
    el.innerHTML = `<span title="${E(text)}">${E(text)}</span>`;
  }

  async function openSettings() {
    const [s, shells, hs] = await Promise.all([A.getSettings(), A.listShells(), A.hooksStatus()]);
    $("s-shell").innerHTML = shells.map((x) => `<option value="${E(x.id)}"${x.id === s.defaultShell ? " selected" : ""}>${E(x.label)}</option>`).join("");
    $("s-cwd").value = s.defaultCwd;
    $("s-cwd").title = s.defaultCwd;
    $("s-skip").checked = !!s.claudeSkipPermissions;
    $("s-hooks").checked = !!s.claudeHooks;
    $("s-font").value = s.fontSize;
    $("s-tray").checked = !!s.closeToTray;
    $("s-optmeta").checked = !!s.macOptionIsMeta;
    renderHooks(hs);
    modal.hidden = false;
    $("s-close").focus();
  }
  function closeSettings() {
    modal.hidden = true;
    $("btsettings").focus();
  }

  function setupSettings() {
    $("btsettings").onclick = openSettings;
    $("s-close").onclick = closeSettings;
    modal.addEventListener("mousedown", (e) => { if (e.target === modal) closeSettings(); });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !modal.hidden) { e.preventDefault(); e.stopPropagation(); closeSettings(); }
    }, true);

    $("s-shell").onchange = (e) => save({ defaultShell: e.target.value });
    $("s-cwd-pick").onclick = async () => {
      const dir = await A.pickFolder($("s-cwd").value);
      if (!dir) return;
      $("s-cwd").value = dir;
      $("s-cwd").title = dir;
      save({ defaultCwd: dir });
    };
    $("s-skip").onchange = (e) => save({ claudeSkipPermissions: e.target.checked });
    $("s-tray").onchange = (e) => save({ closeToTray: e.target.checked });
    $("s-optmeta-row").style.display = A.platform === "darwin" ? "" : "none"; // macOS-only option
    $("s-optmeta").onchange = (e) => save({ macOptionIsMeta: e.target.checked });
    $("s-font").onchange = (e) => {
      const v = parseFloat(e.target.value);
      if (v >= 8 && v <= 32) save({ fontSize: v });
    };
    $("s-hooks").onchange = async (e) => {
      const box = e.target;
      const on = box.checked;
      box.disabled = true;
      await save({ claudeHooks: on });
      renderHooks(on ? await A.hooksInstall() : await A.hooksUninstall());
      box.disabled = false;
    };
  }

  /* ---- boot overlay ---- */
  let bootHidden = false;
  function hideBoot() {
    if (bootHidden) return;
    bootHidden = true;
    const el = $("bootscreen");
    if (!el) return;
    el.classList.add("hide");
    setTimeout(() => el.remove(), 320);
  }

  async function boot() {
    setupTabs();
    setupReload();
    setupSettings();
    try { await document.fonts.load("12px 'JetBrains Mono'"); } catch { /* ignore */ }
    await window.termInit();
    hideBoot();
    restoreTab();
  }
  // finally: the overlay comes down even if termInit throws (the rejection still surfaces in the console)
  boot().finally(hideBoot);
})();
