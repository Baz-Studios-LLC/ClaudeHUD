// Parse fenced code without interpreting model output as HTML.
function splitMessage(text) {
  const parts = [];
  let plain = '', block = null;
  for (const line of String(text || '').match(/[^\n]*\n|[^\n]+$/g) || []) {
    const stripped = line.replace(/\r?\n$/, '');
    if (block) {
      const close = stripped.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      if (close && close[1][0] === block.fence[0] && close[1].length >= block.fence.length) {
        parts.push({ type: 'code', language: block.language, text: block.text }); block = null;
      } else block.text += line;
    } else {
      const open = stripped.match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/);
      if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
        if (plain) parts.push({ type: 'text', text: plain });
        plain = '';
        block = { fence: open[1], language: open[2].trim().split(/\s+/)[0], text: '' };
      } else plain += line;
    }
  }
  if (block) parts.push({ type: 'code', language: block.language, text: block.text });
  if (plain) parts.push({ type: 'text', text: plain });
  return parts;
}
const markdownParser = (typeof module !== 'undefined' ? require('markdown-it') : window.markdownit)({ html: false, breaks: true });
markdownParser.validateLink = url => /^https?:\/\//i.test(url);
// Do not load remote images from model output; screenshots use our attachment UI.
markdownParser.disable('image');
function renderMarkdown(text) { return markdownParser.render(String(text || '')); }
if (typeof module !== 'undefined') module.exports = { splitMessage, renderMarkdown };
