const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Preferences, normalize, fitBounds } = require('./preferences');
test('settings survive a fresh instance including compact state and expanded dimensions', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hud-prefs-')), 'preferences.json');
  const prefs = new Preferences(file);
  const changes = { opacity: .85, sound: true, showThinking: true, shortcut: 'Alt+Shift+C', expanded: false, settingsOpen: true, bounds: { x: -800, y: 60, width: 500, height: 700 } };
  prefs.update(changes); assert.deepEqual(new Preferences(file).value, changes);
  prefs.update({ sound: false }); assert.equal(new Preferences(file).value.opacity, .85);
});
test('invalid settings and disconnected monitors recover safely', () => {
  assert.equal(normalize({ opacity: 12, shortcut: 'unknown' }).opacity, 1);
  assert.equal(normalize({ bounds: { x: 'bad' } }).bounds, null);
  assert.deepEqual(fitBounds({ x: 4000, y: 3000, width: 500, height: 700 }, { x: 0, y: 0, width: 1920, height: 1080 }), { x: 1420, y: 380, width: 500, height: 700 });
  assert.deepEqual(fitBounds({ x: -1800, y: 50, width: 500, height: 700 }, { x: -1920, y: 0, width: 1920, height: 1080 }), { x: -1800, y: 50, width: 500, height: 700 });
});
