# Vault Terminal

A terminal multiplexer for Claude Code and everyday shells. Workspace tabs hold 1, 2, 3, 2x2, 2x3 or 2x4 pane layouts with drag-to-resize dividers. Each pane gets one of 12 color themes, with an optional neon border. Panes pop out into their own windows (one at a time, all at once tiled to match the layout, or by dragging a pane header off the grid) and dock back when closed. Typing can be broadcast to every pane in a workspace. Saved layouts reopen with the same panes, and Claude panes resume their conversations after a restart.

## Features

- Workspace tabs, each with its own layout: 1 / 2 / 3 / 2x2 / 2x3 / 2x4
- Drag-to-resize panes
- 12 per-pane color themes, optional neon border
- Pop out a single pane, pop out all panes tiled to the layout, or drag a pane header off the grid; dock back into the grid
- Broadcast typing to every pane in the active workspace
- Saved layouts that reopen with the same panes and shells
- Claude session resume after a restart, including after `/clear`
- Orange status dot when Claude is waiting on a multiple-choice answer
- Windows and macOS (Apple silicon and Intel)

## Install

Download from the [Releases](https://github.com/John-Holik/vault-terminal/releases) page.

### Windows

Run `vault-terminal-<version>-win-x64.exe`. It installs for the current user and adds a desktop shortcut.

The installer is not code-signed:

- If Windows says **Smart App Control blocked an app**, there is no per-app override. The app only runs with Smart App Control turned off (Windows Security > App & browser control).
- Otherwise SmartScreen may show **Windows protected your PC**: click **More info**, then **Run anyway**.

### macOS

Download `vault-terminal-<version>-mac-arm64.dmg` for Apple silicon or `vault-terminal-<version>-mac-x64.dmg` for Intel, open it and drag **Vault Terminal** to Applications.

The app is ad-hoc signed but not notarized (there is no Apple Developer ID), so macOS blocks the first launch. To allow it:

- **macOS 15 Sequoia or later:** open the app once and dismiss the warning. Then open System Settings > Privacy & Security, scroll down to Security and click **Open Anyway** (the button is available for about an hour after the blocked launch). Enter your login password.
- **macOS 14:** in Finder (not Launchpad), Control-click the app, choose **Open**, then click **Open** in the dialog.
- **Either version, from Terminal:**

  ```sh
  xattr -dr com.apple.quarantine "/Applications/Vault Terminal.app"
  ```

**Permissions:** macOS asks for Local Network access the first time a command inside the app (ssh, curl to a LAN host, a dev server) touches the local network, and for folder access when a command reads Documents, Desktop or Downloads. Because the app is ad-hoc signed, macOS treats each new version as a new app and asks again after updates. These can be changed in System Settings > Privacy & Security > Local Network / Files and Folders.

## Shells

Detected at launch:

- **Claude Code** and **Codex**: always in the shell picker; they need to be installed and reachable from your shell. Claude is the default shell when it is found.
- **Windows:** Windows PowerShell, PowerShell 7 (if `pwsh` is on the PATH), Command Prompt, Git Bash (if Git for Windows is installed), Anaconda (if `anaconda3` or `miniconda3` is in your home folder).
- **macOS:** your login shell (`$SHELL`), plus bash if your login shell is something else.

## Claude Code integration

Vault Terminal uses three Claude Code hooks:

- **Session:** records each pane's current session id, so after a restart the pane resumes the right conversation, even after `/clear`.
- **Attention:** marks when Claude is waiting on a multiple-choice answer (orange dot).
- **Notify:** records turn-finished and needs-attention events.

The hook scripts live in the app's user-data folder (`hooks/`, next to a small `hooks/claude-hooks.json`). Each Claude pane is launched with `--settings <user-data>/hooks/claude-hooks.json`, and Claude Code merges those hooks with the ones in your own settings. Your `~/.claude` files are not modified. The hooks do nothing outside Vault Terminal panes.

The hooks run on the app's own bundled runtime, so they do not need Node.js installed. To turn them off, uncheck **Claude status hooks** in Settings (gear icon); panes then launch without `--settings`.

**Skip Claude permission prompts** (on by default) launches Claude with `--dangerously-skip-permissions`. Turn it off in Settings if you want Claude to ask before running tools.

## Keyboard

| Key | Action |
|---|---|
| F5 | Reload the UI; terminals keep running |
| Shift+F5 | Full restart |
| F12 | Developer tools |
| Right-click | Copy the selection, or paste if nothing is selected |
| Cmd+C / Cmd+V | Copy / paste (macOS) |
| Ctrl+Shift+C / Ctrl+Shift+V | Copy / paste (Windows) |

## Data

Settings, the working layout, saved layouts and pane-session files are stored in the app's user-data folder:

- Windows: `%APPDATA%\Vault Terminal`
- macOS: `~/Library/Application Support/Vault Terminal`

## Development

```sh
npm install
npm start          # run from source
npm run smoke      # headless smoke test
npm run dist       # build installers for the current OS into dist/
```

Releases are built by GitHub Actions when a `v*` tag is pushed (the tag must match the `package.json` version): a Windows x64 installer, and macOS arm64 and x64 builds as dmg and zip.

## Credits

Extracted from the author's Vault Command Center. Built with [Electron](https://www.electronjs.org/), [xterm.js](https://xtermjs.org/), [node-pty](https://github.com/lydell/node-pty) (prebuilt fork by @lydell) and [JetBrains Mono](https://www.jetbrains.com/lp/mono/) (SIL Open Font License 1.1).

## License

[MIT](LICENSE)
