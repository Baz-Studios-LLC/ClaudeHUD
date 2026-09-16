const { test } = require('node:test');
const assert = require('node:assert/strict');
const { splitMessage } = require('./message-format');
test('fenced code keeps whitespace and separates multiple blocks from prose', () => {
  assert.deepEqual(splitMessage('Hi\n```lua\n  print("hi")\n```\nThen\n~~~js\nlet x = 1;\n~~~'), [
    { type: 'text', text: 'Hi\n' }, { type: 'code', language: 'lua', text: '  print("hi")\n' },
    { type: 'text', text: 'Then\n' }, { type: 'code', language: 'js', text: 'let x = 1;\n' }
  ]);
});
test('streaming fences, nested shorter fences, CRLF and literal HTML stay intact', () => {
  assert.deepEqual(splitMessage('````html\r\n<script>x</script>\r\n```\r\n'), [{ type: 'code', language: 'html', text: '<script>x</script>\r\n```\r\n' }]);
  assert.deepEqual(splitMessage('inline `code` and <img>'), [{ type: 'text', text: 'inline `code` and <img>' }]);
  assert.deepEqual(splitMessage('```\n'), [{ type: 'code', language: '', text: '' }]);
});
