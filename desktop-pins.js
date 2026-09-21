const fs = require('node:fs');
const path = require('node:path');
function readDesktopPins(root = path.join(process.env.APPDATA || '', 'Claude', 'claude-code-sessions')) {
  if (!fs.existsSync(root)) throw new Error('Claude Desktop pinned conversations are unavailable. Open Claude Desktop first.');
  const pins = [];
  function scan(directory, depth) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory() && depth < 2) { scan(file, depth + 1); continue; }
      if (!entry.isFile() || !/^local_[a-f0-9-]+\.json$/i.test(entry.name)) continue;
      let item;
      try { item = JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch { throw new Error('Claude Desktop is updating its conversation list. Try again in a moment.'); }
      if (item.isStarred !== true || item.isArchived) continue;
      if (!/^local_[a-f0-9-]{36}$/i.test(item.sessionId) || !/^[a-f0-9-]{36}$/i.test(item.cliSessionId) || typeof item.cwd !== 'string') continue;
      pins.push({ id: item.sessionId, cliId: item.cliSessionId, title: item.title || 'Pinned conversation', project: item.cwd, modified: item.lastActivityAt || item.createdAt, priorIds: item.priorCliSessionIds || [] });
    }
  }
  scan(root, 0);
  return pins.sort((a, b) => a.title.localeCompare(b.title));
}
module.exports = { readDesktopPins };
