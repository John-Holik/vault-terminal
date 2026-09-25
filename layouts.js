const { app } = require("electron");
const fs = require("fs");
const path = require("path");

// Write a file atomically: write a temp sibling, then rename over the target. renameSync replaces
// the existing file in one step (MoveFileEx on Windows, rename(2) elsewhere), so a crash/quit
// mid-write can never leave a half-written store: a reader sees either the old file or the new one.
function writeFileAtomic(file, data) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

/* ---- terminal layout persistence (working state) ----
   One live snapshot of every workspace tab + pane, rewritten on each change and restored on boot. */
function layoutFile() { return path.join(app.getPath("userData"), "term-layout.json"); }
function loadLayout() {
  try { return JSON.parse(fs.readFileSync(layoutFile(), "utf8")); } catch { return null; }
}
function saveLayout(data) {
  try { writeFileAtomic(layoutFile(), JSON.stringify(data)); return true; } catch { return false; }
}

/* ---- saved layouts (named presets) ----
   One file of rows { id, name, createdAt, updatedAt, layout, splits, cells }. A save with a known id
   updates that row in place; otherwise a new row goes on top. The UI list is newest first. */
function layoutsFile() { return path.join(app.getPath("userData"), "saved-layouts.json"); }
function readLayouts() {
  try {
    const arr = JSON.parse(fs.readFileSync(layoutsFile(), "utf8"));
    return Array.isArray(arr) ? arr.filter((l) => l && l.id) : [];
  } catch { return []; }
}
function writeLayouts(rows) { try { writeFileAtomic(layoutsFile(), JSON.stringify(rows)); return true; } catch { return false; } }
function loadLayouts() {
  return readLayouts().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}
function saveNamedLayout({ id, name, data }) {
  const rows = readLayouts();
  const now = Date.now();
  const existing = id ? rows.find((l) => l.id === id) : null;
  if (existing) {
    Object.assign(existing, { name: name || existing.name, ...data, updatedAt: now });
  } else {
    rows.unshift({ id: id || ("L" + now.toString(36) + Math.random().toString(36).slice(2, 6)), name: name || "Layout", createdAt: now, updatedAt: now, ...data });
  }
  writeLayouts(rows);
  return loadLayouts();
}
function deleteLayout(id) {
  writeLayouts(readLayouts().filter((l) => l.id !== id));
  return loadLayouts();
}
function renameLayout(id, name) {
  const rows = readLayouts();
  const l = rows.find((x) => x.id === id);
  if (l) { l.name = name; l.updatedAt = Date.now(); writeLayouts(rows); }
  return loadLayouts();
}

module.exports = { writeFileAtomic, loadLayout, saveLayout, loadLayouts, saveNamedLayout, deleteLayout, renameLayout };
