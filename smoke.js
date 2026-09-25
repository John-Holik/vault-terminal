// Smoke test: run the app with VT_SMOKE=1 (main.js runs smokeMain() and exits 0/1/2) and exit with
// electron's exit code. Kills it and exits 4 if it hasn't finished after 90 s.
const { spawn } = require("child_process");
const electron = require("electron"); // path to the electron binary when required from plain Node

const env = { ...process.env, VT_SMOKE: "1" };
delete env.ELECTRON_RUN_AS_NODE; // otherwise electron runs as plain node and never loads the app

const child = spawn(electron, ["."], { cwd: __dirname, env, stdio: "inherit" });
const timer = setTimeout(() => {
  console.error("[smoke] timed out after 90 s");
  child.kill();
  process.exit(4);
}, 90000);
child.on("exit", (code) => {
  clearTimeout(timer);
  process.exit(code === null ? 1 : code);
});
