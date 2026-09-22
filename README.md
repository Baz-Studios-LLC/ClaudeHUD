# ClaudeHUD

An overlay for working with Claude Code while playing World of Warcraft in borderless windowed mode. Windows and experimental Apple Silicon macOS builds are available.

## Apple Silicon Mac

Download the `mac-arm64.dmg` from GitHub Releases and drag ClaudeHUD into Applications. This build is ad-hoc signed, not Apple-notarized; approve it in System Settings → Privacy & Security if macOS blocks opening it. Intel Macs are not included.

Install Claude Desktop and Claude Code on the Mac, sign in with `claude auth login`, and pin the local Code conversation you want in Desktop. ClaudeHUD reads Desktop metadata from `~/Library/Application Support/Claude/claude-code-sessions` and detects Claude Code in `~/.local/bin` or Homebrew locations. Windows-local conversations are not copied to your Mac by installing ClaudeHUD.

Use **Settings → Pinned conversations** to select a thread. The overlay shortcut uses **Command + Shift + Space** on Mac. Game screenshots require macOS Screen Recording permission. Fullscreen-game overlay behavior and real Desktop thread integration still need testing on a Mac.

Mac updates are manual for now: **Check for updates** opens GitHub Releases. Download and replace the app in Applications. Apple Developer signing is needed before enabling automatic Mac updates. Build locally on macOS with `npm run dist:mac -- --publish never`.

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

The square button between Settings and Close maximizes the overlay; click it again to restore the previous size. **F11** or **Settings → Full screen** fills the monitor, including the taskbar area. **Escape** exits full screen first. Window mode is remembered between sessions, and collapsing still returns to the small HUD.

**Settings → Show thinking** displays collapsible thinking summaries when Claude Code provides them. It is off by default and persists between sessions. Enabling it requests summaries on the next message; existing saved summaries can be shown or hidden immediately. Availability and detail depend on the model and Claude Code output.

You can send messages while Claude is working. They appear in a queue above the composer and run in order after the current task finishes. **Send now** interrupts the current task and sends that message next; **Remove** deletes a queued message. Text and screenshots are saved with the conversation. Stop, errors, or restarting the app leave the queue paused until you choose **Send now**. Queues hold up to ten messages per conversation.

Click the **camera button** beside Send to attach a screenshot of the open World of Warcraft window. The overlay briefly hides during capture and returns with a thumbnail for review; the image is not sent until you press Send. Keep WoW restored in borderless mode. If multiple WoW windows are open, capture requires keeping just one open. Clipboard paste remains available for other images.

**Settings → Model** selects Claude Code default, Fable 5.1, Opus 5, Sonnet 5, or Haiku 4.5 for the next message. The choice persists across restarts and can be changed while Claude is idle. The header shows the selected model until Claude reports the actual model. Availability depends on your Claude account; Fable may use usage credits depending on your plan.

Paste screenshots into the message box with **Ctrl+V**. Review the thumbnails, remove any unwanted attachment, and send with or without text. Up to four PNG/JPEG/WebP/GIF images, each no larger than 30 MB, can be attached per message. Claude Code handles image preparation for its API limits. Sent screenshots are saved with the local conversation and sent to Claude as image content.

**Settings → Load conversation** lists the 200 most recently used local Claude Code sessions, including desktop Code sessions visible to the SDK. Search by title or folder, then select a row to load its history and resume its original session in its original project folder. Finish any running turn in the desktop app before continuing the same session in ClaudeHUD.

Each selected folder has its own Claude session and conversation. These are saved locally in `%APPDATA%\claudehud\conversations.json`; Claude Code stores its own session data as well. Switching folders resumes that folder's conversation. **Settings → New chat** starts fresh for the selected addon and clears its displayed history. **Reconnect Claude** checks your CLI login again.

The permission selector in Settings supports **Manual** (default: asks before changes and commands), **Auto** (Claude makes permission decisions), **Accept edits** (automatically approves file edits), **Plan** (plans before changes), and **Bypass permissions** (runs tools without approval prompts). Your selection is saved and applies to subsequent tasks. Stop an active task before changing modes. Auto availability depends on your Claude Code account/model configuration; any SDK error appears in chat. Existing project instructions are loaded. Unrelated MCP connectors are disabled in this initial integration. Stopping or quitting does not undo changes already made.

## Overlay

The context bar below the composer shows the latest request's input tokens (including cache reads and writes) against the SDK-reported model context window. It updates after Claude responses and survives restarts. Imported sessions may show tokens with a pending limit until the next response. It is not cumulative billing usage; compaction can reduce it.

The orange icon uses the supplied `icon.png`, tinted at runtime. The same native window grows and shrinks around its anchored header. Drag the header to move it; resize from the edges when expanded. Dragging reserves room for the expanded panel within the monitor. Settings persist locally in preferences.json in the app data folder: opacity, sound, hotkey, position, expanded size, open/collapsed state, and Settings/chat view. The selected addon, conversation, and permission mode also restore on launch. Off-screen positions are moved back onto an available monitor.

Click outside the overlay to collapse it automatically. Its folder picker and New chat confirmation keep the panel open.

The overlay uses an always-on-top Electron window without injecting into WoW. The collapsed window is only the size of its header and does not take keyboard focus. It also appears over other applications. In-game focus behavior still needs checking on your WoW setup.

## Verification

- `npm run check`: syntax checks.
- `npm test`: streaming, session restoration, approval/denial, questions, cancellation of approvals, error handling, and project-switch guards.
- `npm run smoke`: UI checks for message/approval rendering, anchored animation, and click toggling; screenshots under `artifacts/`.
- `node live-check.js`: sends real Claude requests, tests resumed conversation and approved/denied writes in `artifacts/connection-check`. Uses your Claude account usage.

## Updates and releases

Installed copies check GitHub Releases after startup and every four hours. Updates download automatically. Once downloaded, an **Update ready** chip appears in the expanded header. Click it while Claude is idle to install silently and relaunch ClaudeHUD. **Settings → Restart to update** uses the same silent installation; **Check for updates** is also available in the tray menu. Updates never install automatically on quit. Upgrading from an older build may show its installer wizard once before this behavior takes effect.

Build a Windows installer locally with `npm run dist -- --publish never`. To release, bump the version in `package.json` and the lockfile, commit, and push a matching `vX.Y.Z` tag. The Windows release workflow tests and builds the installer, blockmap, and `latest.yml`, uploads them to a draft release, and then publishes it. The workflow uses GitHub's temporary Actions token, never a credential bundled in the app.

Windows code signing is not configured yet; installers may show an unknown-publisher warning. Runtime files and account credentials are excluded from both Git and the packaged app.

## References

[Anthropic Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview), [permissions and questions](https://code.claude.com/docs/en/agent-sdk/user-input), [brand colors](https://github.com/anthropics/skills/blob/main/skills/brand-guidelines/SKILL.md).
