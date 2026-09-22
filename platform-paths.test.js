const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { desktopDataRoot, claudeExecutable } = require('./platform-paths');
test('Mac paths work without shell PATH or APPDATA', () => {
  const home = path.resolve('test-home');
  assert.equal(desktopDataRoot('darwin', home, {}), path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions'));
  const native = path.join(home, '.local', 'bin', 'claude');
  assert.equal(claudeExecutable('darwin', home, candidate => candidate === native), native);
  assert.equal(claudeExecutable('darwin', home, candidate => candidate === '/opt/homebrew/bin/claude'), '/opt/homebrew/bin/claude');
  assert.equal(claudeExecutable('darwin', home, () => false), 'claude');
});
test('Windows paths preserve the native executable and Desktop data root', () => {
  const home = path.resolve('test-home');
  assert.equal(desktopDataRoot('win32', home, { APPDATA: home }), path.join(home, 'Claude', 'claude-code-sessions'));
  assert.equal(claudeExecutable('win32', home, () => true), path.join(home, '.local', 'bin', 'claude.exe'));
  assert.throws(() => desktopDataRoot('win32', home, {}));
});
