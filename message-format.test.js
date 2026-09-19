const { test } = require('node:test');
const assert = require('node:assert/strict');
const { splitMessage, renderMarkdown } = require('./message-format');
test('Markdown formats prose, nested lists, inline code, headings, and tables', () => {
  const html = renderMarkdown('# Changes\n\n**Two** bugs and `self.text`.\n\n1. First\n2. Second\n   - Nested\n\n> Note\n\n| File | Status |\n| --- | --- |\n| Skin.lua | Fixed |');
  for (const expected of ['<h1>Changes</h1>', '<strong>Two</strong>', '<code>self.text</code>', '<ol>', '<ul>', '<blockquote>', '<table>']) assert.ok(html.includes(expected), expected);
});
test('Markdown escapes HTML and rejects unsafe links and remote images', () => {
  const html = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[bad](javascript:alert(1)) [local](file:///C:/secret) [web](https://example.com)\n\n![remote](https://example.com/image.png)');
  assert.ok(!/<script|<img|onerror="|href="(?:javascript|file):/.test(html));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('href="https://example.com"'));
  assert.ok(renderMarkdown('**unfinished').includes('**unfinished'));
  assert.ok(renderMarkdown('**finished**').includes('<strong>finished</strong>'));
});
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
