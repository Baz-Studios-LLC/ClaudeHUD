# ClaudeHUD

A Windows overlay for working with Claude Code while playing World of Warcraft in borderless windowed mode.

## Start

For automatic updates, install the Windows `.exe` from [GitHub Releases](https://github.com/Baz-Studios-LLC/ClaudeHUD/releases/latest). Source launches with `npm start` do not update themselves.

Install dependencies with `npm install`, then double-click `Start-ClaudeHUD.cmd` or run `npm start`.

Claude Code must be installed and signed in (`claude auth login`). ClaudeHUD detects the native install at `%USERPROFILE%\.local\bin\claude.exe`, falling back to PATH. Credentials stay with Claude Code; the overlay does not copy them.

1. Click **Choose addon folder** and select the addon you want Claude to work on.
2. Send a message. Responses appear live; **Stop** cancels the current task.
3. Review file edits and shell commands in the approval cards. **Allow once** approves the displayed operation; **Deny** declines it.
4. Click the orange icon or press **Ctrl + Shift + Space** to collapse or expand. **Escape** collapses chat. The **X quits the app** and stops active work.

Completed tasks and requests for input show a toast while collapsed. Right-click the tray icon for Open chat, Collapse, Settings, and Quit. Double-click the tray icon to open chat.

## Conversations and projects

**Load conversation** lists the 200 most recently used local Claude Code sessions, including desktop Code sessions visible to the SDK. Search by title or folder, then select a row to load its history and resume its original session in its original project folder. Finish any running turn in the desktop app before continuing the same session in ClaudeHUD.

Each selected folder has its own Claude session and conversation. These are saved locally in `%APPDATA%\claudehud\conversations.json`; Claude Code stores its own session data as well. Switching folders resumes that folder's conversation. **Settings → New chat** starts fresh for the selected addon and clears its displayed history. **Reconnect Claude** checks your CLI login again.

The permission selector beside the message box supports **Manual** (default: asks before changes and commands), **Auto** (Claude makes permission decisions), **Accept edits** (automatically approves file edits), **Plan** (plans before changes), and **Bypass permissions** (runs tools without approval prompts). Your selection is saved and applies to subsequent tasks. Stop an active task before changing modes. Auto availability depends on your Claude Code account/model configuration; any SDK error appears in chat. Existing project instructions are loaded. Unrelated MCP connectors are disabled in this initial integration. Stopping or quitting does not undo changes already made.

## Overlay

The orange icon uses the supplied `icon.png`, tinted at runtime. The same native window grows and shrinks around its anchored header. Drag the header to move it; resize from the edges when expanded. Dragging reserves room for the expanded panel within the monitor. Opacity and optional sound are in Settings; these overlay preferences currently reset on restart.

Click outside the overlay to collapse it automatically. Its folder picker and New chat confirmation keep the panel open.

The overlay uses an always-on-top Electron window without injecting into WoW. The collapsed window is only the size of its header and does not take keyboard focus. It also appears over other applications. In-game focus behavior still needs checking on your WoW setup.

## Verification

- `npm run check`: syntax checks.
- `npm test`: streaming, session restoration, approval/denial, questions, cancellation of approvals, error handling, and project-switch guards.
- `npm run smoke`: UI checks for message/approval rendering, anchored animation, and click toggling; screenshots under `artifacts/`.
- `node live-check.js`: sends real Claude requests, tests resumed conversation and approved/denied writes in `artifacts/connection-check`. Uses your Claude account usage.

## Updates and releases

Installed copies check GitHub Releases after startup and every four hours. Updates download automatically. **Settings → Restart to update** installs a downloaded update when Claude is idle; **Check for updates** is also available in the tray menu. Updates never install automatically on quit.

Build a Windows installer locally with `npm run dist -- --publish never`. To release, bump the version in `package.json` and the lockfile, commit, and push a matching `vX.Y.Z` tag. The Windows release workflow tests and builds the installer, blockmap, and `latest.yml`, uploads them to a draft release, and then publishes it. The workflow uses GitHub's temporary Actions token, never a credential bundled in the app.

Windows code signing is not configured yet; installers may show an unknown-publisher warning. Runtime files and account credentials are excluded from both Git and the packaged app.

## References

[Anthropic Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview), [permissions and questions](https://code.claude.com/docs/en/agent-sdk/user-input), [brand colors](https://github.com/anthropics/skills/blob/main/skills/brand-guidelines/SKILL.md).
