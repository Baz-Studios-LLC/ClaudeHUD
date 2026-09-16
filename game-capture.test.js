const { test } = require('node:test');
const assert = require('node:assert/strict');
const { captureGame } = require('./game-capture');
const displays = [{ size: { width: 1920, height: 1080 }, scaleFactor: 2 }];
const thumbnail = { isEmpty: () => false, toPNG: () => Buffer.from('png') };
test('captures the WoW window at display resolution, not other windows', async () => {
  const image = await captureGame({ displays, desktopCapturer: { getSources: async options => {
    assert.deepEqual(options.types, ['window']);
    assert.deepEqual(options.thumbnailSize, { width: 3840, height: 2160 });
    return [{ name: 'Private document', thumbnail: {} }, { name: 'World of Warcraft', thumbnail }];
  } } });
  assert.deepEqual(image, { type: 'image/png', data: Buffer.from('png').toString('base64') });
});
test('missing, ambiguous, and empty game captures fail without desktop fallback', async () => {
  for (const [sources, error] of [
    [[{ name: 'World of Warcraft guide - Browser' }], /Could not find/],
    [[{ name: 'World of Warcraft' }, { name: 'World of Warcraft Classic' }], /More than one/],
    [[{ name: 'World of Warcraft', thumbnail: { isEmpty: () => true } }], /Restore/]
  ]) await assert.rejects(captureGame({ displays, desktopCapturer: { getSources: async () => sources } }), error);
});
