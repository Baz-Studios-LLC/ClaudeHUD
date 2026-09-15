const { test } = require('node:test');
const assert = require('node:assert/strict');
const { latestContext, withContextLimit } = require('./context-usage');
test('context uses latest input including cache, not cumulative usage or output', () => {
  const first = latestContext({ model: 'opus', usage: { input_tokens: 100, cache_creation_input_tokens: 2000, cache_read_input_tokens: 8000, output_tokens: 900 } });
  assert.equal(first.used, 10100);
  const limited = withContextLimit(first, { opus: { contextWindow: 200000, inputTokens: 999999 } });
  const next = latestContext({ model: 'opus', usage: { input_tokens: 50, cache_read_input_tokens: 1000 } }, limited);
  assert.equal(next.used, 1050); assert.equal(next.limit, 200000);
});
test('unknown limits are not guessed, and model changes clear the old limit', () => {
  const value = latestContext({ model: 'new', usage: { input_tokens: 20 } }, { model: 'old', limit: 200000 });
  assert.equal(value.limit, null);
  assert.equal(withContextLimit(value, { other: { contextWindow: 1000000 } }).limit, null);
  assert.equal(latestContext({ usage: { input_tokens: -1 } }, value), value);
  assert.equal(withContextLimit(null, {}), null);
});
