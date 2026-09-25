/* ===== Vault Terminal: Chat History tab ===== */
(() => {
  const A = window.api;
  const E = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

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

  let histLoaded = false, histSessions = [], histProjectKey; // undefined = not chosen yet; null = "All projects"

  async function histInit() {
    if (histLoaded) return;
    histLoaded = true;
    document.getElementById("histrefresh").onclick = () => reloadHistory(true);
    document.getElementById("histsearch").oninput = renderHistList;
    document.getElementById("histproject").onchange = (e) => { histProjectKey = e.target.value || null; loadSessions(false); };
    await reloadHistory(false);
  }
  async function reloadHistory(force) {
    const projects = await A.listProjects();
    if (histProjectKey === undefined) histProjectKey = projects[0] ? projects[0].key : null;
    document.getElementById("histproject").innerHTML =
      `<option value="">All projects</option>` +
      projects.map((p) => `<option value="${E(p.key)}"${p.key === histProjectKey ? " selected" : ""}>${E(p.label)} · ${p.count}</option>`).join("");
    await loadSessions(force);
  }
  async function loadSessions(force) {
    histSessions = await A.listSessions(histProjectKey || null, force);
    renderHistList();
  }
  function histCard(s) {
    return `<div class="scard" data-id="${E(s.id)}">
      <div class="sc-main">
        <div class="sc-title">${E(s.title)}</div>
        <div class="sc-snip">${E(s.snippet || "")}</div>
      </div>
      <div class="sc-meta">
        <span class="sc-folder" title="${E(s.cwd || "")}">${E(s.cwd ? baseName(s.cwd) : "—")}</span>
        <span class="sc-time">${timeAgo(s.mtime)}</span>
        <span class="sc-msgs">${s.msgs} msg</span>
      </div>
    </div>`;
  }
  function renderHistList() {
    const q = document.getElementById("histsearch").value.trim().toLowerCase();
    let list = histSessions;
    if (q) list = list.filter((s) => (s.title + " " + s.snippet + " " + (s.cwd || "")).toLowerCase().includes(q));
    document.getElementById("histcount").textContent = `${list.length} session${list.length === 1 ? "" : "s"}`;
    document.getElementById("histlist").innerHTML = list.length
      ? list.map(histCard).join("")
      : `<p class="muted" style="padding:24px">No sessions found.</p>`;
    document.querySelectorAll("#histlist .scard").forEach((el) => (el.onclick = () => resumeSession(el.dataset.id)));
  }
  function resumeSession(id) {
    const s = histSessions.find((x) => x.id === id);
    if (!s) return;
    window.termResumeSession({ id: s.id, cwd: s.cwd, title: s.title });
  }

  window.histInit = histInit;
})();
