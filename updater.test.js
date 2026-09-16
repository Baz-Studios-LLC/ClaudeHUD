const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createUpdater } = require('./updater');
test('installed updater downloads but never restarts an active Claude task', async () => {
  const engine = new EventEmitter(); let busy = true, installed = 0, checks = 0;
  engine.checkForUpdates = async () => { checks++; engine.emit('update-available', { version: '0.2.0' }); };
  engine.quitAndInstall = (silent, relaunch) => { assert.equal(silent, true); assert.equal(relaunch, true); installed++; };
  const updater = createUpdater({ app: { isPackaged: true, getVersion: () => '0.1.0' }, updater: engine, emit() {}, isBusy: () => busy });
  assert.equal(engine.autoInstallOnAppQuit, false); assert.equal(engine.autoDownload, true);
  await updater.check(); await updater.check(); assert.equal(checks, 1);
  engine.emit('update-downloaded', { version: '0.2.0' });
  assert.ok(updater.install().error); assert.equal(installed, 0);
  busy = false; updater.install(); updater.install(); assert.equal(installed, 1); updater.dispose();
});
test('development builds do not contact update servers', async () => {
  const updater = createUpdater({ app: { isPackaged: false, getVersion: () => '0.1.0' }, updater: {}, emit() {}, isBusy: () => false });
  await updater.check(); assert.equal(updater.snapshot().phase, 'development'); assert.ok(updater.install().error); updater.dispose();
});
