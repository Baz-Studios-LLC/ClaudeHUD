const fs = require('node:fs');
const path = require('node:path');
const shortcuts = ['CommandOrControl+Shift+Space', 'Alt+Shift+C', 'CommandOrControl+Shift+H'];
function normalize(value = {}) {
  value ||= {};
  const bounds = value.bounds;
  return { shortcut: shortcuts.includes(value.shortcut) ? value.shortcut : shortcuts[0],
    opacity: Number.isFinite(value.opacity) ? Math.max(.8, Math.min(1, value.opacity)) : 1,
    sound: value.sound === true, showThinking: value.showThinking === true, expanded: value.expanded !== false, settingsOpen: value.settingsOpen === true,
    windowMode: ['normal', 'maximized', 'fullscreen'].includes(value.windowMode) ? value.windowMode : 'normal',
    bounds: bounds && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(bounds[key])) ? { x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.max(380, Math.round(bounds.width)), height: Math.max(520, Math.round(bounds.height)) } : null };
}
class Preferences {
  constructor(file) { this.file = file; try { this.value = normalize(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { this.value = normalize(); } }
  update(patch) {
    this.value = normalize({ ...this.value, ...patch });
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.value)); fs.renameSync(this.file + '.tmp', this.file);
  }
}
function fitBounds(bounds, area) {
  const width = Math.min(bounds.width, area.width), height = Math.min(bounds.height, area.height);
  return { width, height, x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - width)), y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - height)) };
}
module.exports = { Preferences, normalize, fitBounds };
