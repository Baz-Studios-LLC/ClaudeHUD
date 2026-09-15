# ClaudeHUD

A Windows overlay for working with Claude Code while playing World of Warcraft in borderless windowed mode.

## Start

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

Claude can read files in the selected workspace. File writes, edits, and shell commands require approval through the overlay. Existing project instructions are loaded. Unrelated MCP connectors are disabled in this initial integration. No permissions are bypassed. Stopping or quitting does not undo changes already made.

## Overlay

The orange icon uses the supplied `icon.png`, tinted at runtime. The same native window grows and shrinks around its anchored header. Drag the header to move it; resize from the edges when expanded. Dragging reserves room for the expanded panel within the monitor. Opacity and optional sound are in Settings; these overlay preferences currently reset on restart.

The overlay uses an always-on-top Electron window without injecting into WoW. The collapsed window is only the size of its header and does not take keyboard focus. It also appears over other applications. In-game focus behavior still needs checking on your WoW setup.

## Verification

- `npm run check`: syntax checks.
- `npm test`: streaming, session restoration, approval/denial, questions, cancellation of approvals, error handling, and project-switch guards.
- `npm run smoke`: UI checks for message/approval rendering, anchored animation, and click toggling; screenshots under `artifacts/`.
- `node live-check.js`: sends real Claude requests, tests resumed conversation and approved/denied writes in `artifacts/connection-check`. Uses your Claude account usage.

## References

[Anthropic Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview), [permissions and questions](https://code.claude.com/docs/en/agent-sdk/user-input), [brand colors](https://github.com/anthropics/skills/blob/main/skills/brand-guidelines/SKILL.md).
