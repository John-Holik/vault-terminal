/* ===== Vault Terminal — shared terminal theme table =====
   Single source of truth for the xterm pane themes. Loaded as a plain <script>
   BEFORE its consumers: terminal.js (index.html) and popout.js (popout.html).
   Both read window.VT_THEMES with a one-theme local fallback, so a missing or
   failed load degrades to indigo instead of crashing the terminal grid. */
(() => {
  window.VT_THEMES = {
    indigo:  { name: "Indigo",  bg: "#0E0E11", theme: { background: "#0E0E11", foreground: "#EDEDEF", cursor: "#6E79E6", cursorAccent: "#0E0E11", selectionBackground: "rgba(110,121,230,.35)" } },
    matrix:  { name: "Matrix",  bg: "#0B140E", theme: { background: "#0B140E", foreground: "#C8F7C5", cursor: "#3FB950", cursorAccent: "#0B140E", selectionBackground: "rgba(63,185,80,.35)" } },
    amber:   { name: "Amber",   bg: "#15100A", theme: { background: "#15100A", foreground: "#F0D29A", cursor: "#E2A33B", cursorAccent: "#15100A", selectionBackground: "rgba(226,163,59,.35)" } },
    crimson: { name: "Crimson", bg: "#160B0E", theme: { background: "#160B0E", foreground: "#F3A9B4", cursor: "#F7768E", cursorAccent: "#160B0E", selectionBackground: "rgba(247,118,142,.35)" } },
    cyan:    { name: "Cyan",    bg: "#081416", theme: { background: "#081416", foreground: "#A5E8EE", cursor: "#22D3EE", cursorAccent: "#081416", selectionBackground: "rgba(34,211,238,.3)" } },
    slate:   { name: "Slate",   bg: "#0B0E14", theme: { background: "#0B0E14", foreground: "#E6E8EC", cursor: "#7AA2F7", cursorAccent: "#0B0E14", selectionBackground: "rgba(122,162,247,.3)" } },
    violet:  { name: "Violet",  bg: "#120C1A", theme: { background: "#120C1A", foreground: "#D8C9F7", cursor: "#A78BFA", cursorAccent: "#120C1A", selectionBackground: "rgba(167,139,250,.32)" } },
    magenta: { name: "Magenta", bg: "#160A12", theme: { background: "#160A12", foreground: "#F6B6D6", cursor: "#F472B6", cursorAccent: "#160A12", selectionBackground: "rgba(244,114,182,.32)" } },
    orange:  { name: "Orange",  bg: "#160E07", theme: { background: "#160E07", foreground: "#F7C79A", cursor: "#FB923C", cursorAccent: "#160E07", selectionBackground: "rgba(251,146,60,.32)" } },
    teal:    { name: "Teal",    bg: "#07140F", theme: { background: "#07140F", foreground: "#9DEAD9", cursor: "#2DD4BF", cursorAccent: "#07140F", selectionBackground: "rgba(45,212,191,.3)" } },
    lime:    { name: "Lime",    bg: "#0E1305", theme: { background: "#0E1305", foreground: "#D4F2A0", cursor: "#A3E635", cursorAccent: "#0E1305", selectionBackground: "rgba(163,230,53,.3)" } },
    gold:    { name: "Gold",    bg: "#14110A", theme: { background: "#14110A", foreground: "#F3E2A0", cursor: "#FACC15", cursorAccent: "#14110A", selectionBackground: "rgba(250,204,21,.3)" } },
  };
})();
