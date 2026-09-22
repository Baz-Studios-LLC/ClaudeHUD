const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
function desktopDataRoot(platform = process.platform, home = os.homedir(), env = process.env) {
  const base = platform === 'darwin' ? path.join(home, 'Library', 'Application Support') : env.APPDATA;
  if (!base) throw new Error('Claude Desktop data location is unavailable on this platform.');
  return path.join(base, 'Claude', 'claude-code-sessions');
}
function claudeExecutable(platform = process.platform, home = os.homedir(), exists = fs.existsSync) {
  const candidates = [path.join(home, '.local', 'bin', platform === 'win32' ? 'claude.exe' : 'claude')];
  if (platform === 'darwin') candidates.push('/opt/homebrew/bin/claude', '/usr/local/bin/claude');
  return candidates.find(candidate => exists(candidate)) || 'claude';
}
module.exports = { desktopDataRoot, claudeExecutable };
