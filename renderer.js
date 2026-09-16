const $ = selector => document.querySelector(selector);
const surface = new URLSearchParams(location.search).get('surface') || 'panel';
for (const name of ['panel', 'toast']) $(`#${name}`).hidden = name !== surface;
const bridge = window.hud;
const action = (name, value) => bridge.action(name, value);
let busy = false, audio, project, connected = false;
let submitting = false;
function renderQueue(items = []) {
  $('#message-queue').hidden = !items.length;
  $('#queue-items').replaceChildren();
  for (const item of items) {
    const row = document.createElement('div'); row.className = 'queued-message';
    const text = document.createElement('p'); text.textContent = item.text || 'Screenshot'; row.append(text);
    if (item.images?.length) {
      const images = document.createElement('div'); images.className = 'queued-images';
      for (const attachment of item.images) { const image = document.createElement('img'); image.src = `data:${attachment.type};base64,${attachment.data}`; image.alt = 'Queued screenshot'; images.append(image); }
      row.append(images);
    }
    const buttons = document.createElement('div'); buttons.className = 'queued-actions';
    for (const [label, name] of [['Send now', 'send-queued-now'], ['Remove', 'remove-queued']]) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'quiet'; button.textContent = label;
      button.title = name === 'send-queued-now' ? 'Interrupt the current task and send this message' : 'Remove this queued message';
      button.onclick = async () => { for (const control of $('#queue-items').querySelectorAll('button')) control.disabled = true; await claude(name, item.id); for (const control of $('#queue-items').querySelectorAll('button')) control.disabled = false; };
      buttons.append(button);
    }
    row.append(buttons); $('#queue-items').append(row);
  }
  controls();
}
let permissionMode = 'default';
let selectedModel = 'default';
function modelState(data) {
  selectedModel = data.model || 'default';
  $('#model-picker').value = selectedModel;
  const families = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', fable: 'Fable' };
  const labels = { default: 'Claude default', 'claude-fable-5-1': 'Fable 5.1', 'claude-opus-5': 'Opus 5', 'claude-sonnet-5': 'Sonnet 5', 'claude-haiku-4-5': 'Haiku 4.5' };
  const actual = data.activeModel;
  const match = actual?.match(/^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?/);
  const label = match ? `${families[match[1]]} ${match[2]}${match[3] && match[3].length < 3 ? '.' + match[3] : ''}` : actual;
  $('#model-label').textContent = label || labels[selectedModel];
  $('#model-label').title = actual ? `Current model: ${actual}` : `Next message: ${labels[selectedModel]}`;
}
let attachments = [], pasting = 0, draftEpoch = 0;
let capturing = false;
const modeDescriptions = { default: 'Ask before changes and commands', auto: 'Claude handles permission decisions', acceptEdits: 'Automatically accept file edits', plan: 'Plan before making changes', bypassPermissions: 'Allow tools without permission prompts' };
const messageNodes = new Map(), requests = new Map();
const welcome = $('#messages').innerHTML;
function updateJumpButton() {
  const messages = $('#messages');
  $('#jump-latest').hidden = messages.scrollHeight - messages.scrollTop - messages.clientHeight <= 24;
}
function scrollToBottom() { $('#messages').scrollTop = $('#messages').scrollHeight; updateJumpButton(); }
$('#messages').addEventListener('scroll', updateJumpButton, { passive: true });
$('#messages').addEventListener('load', updateJumpButton, true);
new ResizeObserver(updateJumpButton).observe($('#messages'));
new MutationObserver(updateJumpButton).observe($('#messages'), { childList: true, subtree: true, characterData: true });
$('#jump-latest').onclick = () => { scrollToBottom(); $('#prompt').focus(); };
function contextUsage(context) {
  const known = context && Number.isFinite(context.used);
  const hasLimit = known && Number.isFinite(context.limit) && context.limit > 0;
  const percent = hasLimit ? context.used / context.limit * 100 : 0;
  const format = number => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(number);
  $('#context-label').textContent = hasLimit ? `${format(context.used)} / ${format(context.limit)} · ${Math.round(percent)}%` : known ? `${format(context.used)} tokens · limit pending` : 'Available after a response';
  $('#context-meter').hidden = !hasLimit;
  $('#context-meter').value = Math.min(100, percent);
  $('#context-meter').setAttribute('aria-valuetext', hasLimit ? `${context.used.toLocaleString()} of ${context.limit.toLocaleString()} tokens` : 'Context limit unavailable');
  $('#context-usage').classList.toggle('context-high', percent >= 80);
}
function controls() {
  $('#send').disabled = submitting || pasting > 0 || capturing || !connected || !project;
  const queueing = busy || !$('#message-queue').hidden;
  $('#send').title = queueing ? 'Queue message' : 'Send message';
  $('#send').setAttribute('aria-label', queueing ? 'Queue message' : 'Send message');
  $('#queue-label').textContent = busy ? 'Queued · sends when Claude finishes' : 'Queue paused · choose Send now to continue';
  $('#capture-game').disabled = capturing || pasting > 0 || attachments.length >= 4;
  $('#stop').hidden = !busy; $('#choose-project').disabled = busy; $('#new-chat').disabled = busy; $('#conversations-open').disabled = busy;
  $('#permission-mode').disabled = busy;
  $('#model-picker').disabled = busy;
  $('#permission-mode').title = busy ? 'Stop the current task to change mode' : modeDescriptions[permissionMode];
}
function renderMessageText(container, text) {
  const parts = splitMessage(text);
  parts.forEach((part, index) => {
    let node = container.children[index];
    if (!node || node.dataset.kind !== part.type) {
      const replacement = document.createElement(part.type === 'code' ? 'section' : 'p');
      replacement.dataset.kind = part.type;
      if (node) node.replaceWith(replacement); else container.append(replacement);
      node = replacement;
      if (part.type === 'code') {
        node.className = 'code-block';
        const toolbar = document.createElement('div'); toolbar.className = 'code-toolbar';
        const language = document.createElement('span'); language.className = 'code-language';
        const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = 'Copy'; copy.setAttribute('aria-label', 'Copy code');
        const pre = document.createElement('pre'), code = document.createElement('code'); pre.append(code);
        copy.onclick = async () => {
          try {
            const result = await action('copy-code', code.textContent);
            if (!result?.ok) throw new Error('Copy failed');
            copy.textContent = 'Copied!';
          } catch { copy.textContent = 'Try again'; }
          clearTimeout(copy.resetTimer); copy.resetTimer = setTimeout(() => { copy.textContent = 'Copy'; }, 1800);
        };
        toolbar.append(language, copy); node.append(toolbar, pre);
      }
    }
    if (part.type === 'code') {
      node.querySelector('.code-language').textContent = part.language || 'Code';
      const code = node.querySelector('code'); if (code.textContent !== part.text) code.textContent = part.text;
    } else if (node.textContent !== part.text) node.textContent = part.text;
  });
  while (container.children.length > parts.length) container.lastElementChild.remove();
}
function message(item) {
  let body = messageNodes.get(item.id);
  const nearBottom = $('#messages').scrollHeight - $('#messages').scrollTop - $('#messages').clientHeight < 100;
  if (!body) {
    const article = document.createElement('article'); article.className = 'message';
    const avatar = document.createElement('div'); avatar.className = `avatar ${item.role === 'You' ? 'you' : 'claude'}`; avatar.textContent = item.role === 'You' ? 'Y' : '';
    body = document.createElement('div'); body.className = 'message-body';
    const meta = document.createElement('div'); meta.className = 'message-meta';
    const strong = document.createElement('strong'); strong.textContent = item.role;
    const time = document.createElement('time'); time.textContent = item.time ? new Date(item.time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
    meta.append(strong, time); const p = document.createElement('div'); p.className = 'response-text';
    body.append(meta, p); article.append(avatar, body); $('#messages').append(article); messageNodes.set(item.id, body);
    if (item.images?.length) {
      const images = document.createElement('div'); images.className = 'message-images';
      for (const attachment of item.images) {
        const image = document.createElement('img'); image.src = `data:${attachment.type};base64,${attachment.data}`; image.alt = 'Attached screenshot'; image.loading = 'lazy'; images.append(image);
      }
      body.append(images);
    }
  }
  renderMessageText(body.querySelector('.response-text'), item.text);
  if (nearBottom || item.role === 'You') scrollToBottom();
}
function localError(text) { message({ id: crypto.randomUUID(), role: 'System', text, time: Date.now() }); scrollToBottom(); }
async function claude(action, value) {
  try { const result = await bridge.claude(action, value); if (result?.error) { localError(result.error); return null; } return result; }
  catch (error) { localError(error.message); return null; }
}
function sound() {
  if (!$('#sound').checked || !audio) return;
  const oscillator = audio.createOscillator(), gain = audio.createGain();
  oscillator.connect(gain); gain.connect(audio.destination); oscillator.frequency.value = 660;
  gain.gain.setValueAtTime(.05, audio.currentTime); gain.gain.exponentialRampToValueAtTime(.001, audio.currentTime + .3);
  oscillator.start(); oscillator.stop(audio.currentTime + .3);
}
function permission(data) {
  const card = document.createElement('section'); card.className = 'permission-card';
  const heading = document.createElement('strong'); heading.textContent = data.tool === 'AskUserQuestion' ? 'Claude has a question' : `Allow ${data.tool}?`; card.append(heading);
  const answers = new Map();
  if (data.tool === 'AskUserQuestion') {
    for (const question of data.input.questions || []) {
      const label = document.createElement('label'); label.textContent = question.question;
      const input = document.createElement('textarea'); input.rows = 2; input.placeholder = 'Your answer…'; label.append(input); card.append(label); answers.set(question.question, input);
      const options = document.createElement('div'); options.className = 'question-options';
      const selected = new Set();
      const updateSelection = () => {
        for (const button of options.children) button.setAttribute('aria-pressed', String(selected.has(button.textContent)));
      };
      input.addEventListener('input', () => { selected.clear(); updateSelection(); });
      for (const option of question.options || []) {
        const button = document.createElement('button'); button.className = 'quiet'; button.textContent = option.label; button.title = option.description || '';
        button.type = 'button'; button.setAttribute('aria-pressed', 'false');
        button.onclick = () => {
          if (!question.multiSelect) selected.clear();
          if (selected.has(option.label)) selected.delete(option.label); else selected.add(option.label);
          input.value = [...selected].join(', '); updateSelection();
        }; options.append(button);
      }
      if (options.childElementCount) card.append(options);
    }
  } else {
    const details = document.createElement('pre'); details.textContent = JSON.stringify(data.input, null, 2); card.append(details);
  }
  const buttons = document.createElement('div'); buttons.className = 'permission-actions';
  for (const allow of [false, true]) {
    const button = document.createElement('button'); button.className = allow ? 'approve' : 'quiet'; button.textContent = allow ? (answers.size ? 'Send answer' : 'Allow once') : 'Deny';
    button.onclick = async () => {
      const result = await claude('respond', { id: data.id, allow, answers: Object.fromEntries([...answers].map(([key, input]) => [key, input.value])) });
      if (result) { card.classList.add('resolved'); buttons.textContent = allow ? 'Approved' : 'Denied'; }
    }; buttons.append(button);
  }
  card.append(buttons); requests.set(data.id, card); $('#messages').append(card); scrollToBottom(); sound();
}
bridge.onClaude(({ type, data }) => {
  if (type === 'snapshot') {
    draftEpoch++; attachments = []; renderAttachments();
    project = data.project; connected = data.connection.ready; busy = data.busy;
    renderQueue(data.queued);
    contextUsage(data.context);
    modelState(data);
    permissionMode = data.permissionMode || 'default'; $('#permission-mode').value = permissionMode;
    $('#conversation-title').textContent = data.title || 'Addon conversation';
    $('#conversation-title').title = data.title || 'Addon conversation';
    $('#choose-project').textContent = project ? project.split(/[\\/]/).pop() + ' ▾' : 'Choose addon folder ▾';
    $('#choose-project').title = project || 'Choose your WoW addon folder';
    $('#connection-label').textContent = connected ? 'Connected' : 'Offline';
    $('#connection-detail').textContent = connected ? (project ? 'Working in your selected addon folder.' : 'Choose your addon folder to start a conversation.') : data.connection.detail;
    $('#connection-banner').hidden = connected && !!project;
    $('#messages').innerHTML = welcome; messageNodes.clear(); requests.clear();
    for (const item of data.messages) message(item); scrollToBottom(); controls();
  }
  if (type === 'message') message(data);
  if (type === 'queue') renderQueue(data);
  if (type === 'model') modelState(data);
  if (type === 'context') contextUsage(data);
  if (type === 'busy') { busy = data; controls(); }
  if (type === 'activity') $('#status-label').textContent = data;
  if (type === 'permission') permission(data);
  if (type === 'permission-resolved') {
    const card = requests.get(data.id); if (card) { card.classList.add('resolved'); for (const control of card.querySelectorAll('button,textarea')) control.disabled = true; }
    requests.delete(data.id);
  }
  if (type === 'complete') sound();
});
bridge.onNotice(({ title, text }) => { $('#toast strong').textContent = title; $('#toast small').textContent = text; });
bridge.onStatus(status => {
  $('#status-label').textContent = status === 'Ready' ? 'Ready when you are' : status === 'Working' ? 'Claude is working…' : status;
  $('#badge-status').textContent = status; document.body.classList.toggle('working', status === 'Working');
});
function showSettings(open, persist = true) {
  $('#settings').hidden = !open;
  document.body.classList.toggle('settings-open', open);
  $('#settings-toggle').setAttribute('aria-expanded', String(open));
  if (persist) action('settings-view', open);
  (open ? $('#settings-close') : $('#prompt')).focus();
}
bridge.onFocus(() => ($('#settings').hidden ? $('#prompt') : $('#settings-close')).focus());
bridge.onExpansion(({ expanded, transitioning }) => {
  document.body.classList.toggle('collapsed', !expanded); document.body.classList.toggle('transitioning', transitioning);
  $('#overlay-toggle').setAttribute('aria-expanded', String(expanded));
  $('#overlay-toggle').setAttribute('aria-label', expanded ? 'Collapse chat' : 'Open chat'); $('#overlay-toggle').title = expanded ? 'Collapse chat' : 'Open chat';
  for (const child of $('#panel').children) if (child.tagName !== 'HEADER') child.inert = !expanded;
});
bridge.onSettings(() => showSettings(true));
bridge.onPreferences(value => {
  $('#opacity').value = Math.round(value.opacity * 100); $('#sound').checked = value.sound;
  $('#shortcut').value = value.shortcut;
  showSettings(value.settingsOpen, false);
});
bridge.onShortcut(ok => { if (!ok) $('#settings-note').textContent = 'Hotkey unavailable. Choose another shortcut in settings.'; });
$('#close-app').onclick = () => action('quit'); $('#overlay-toggle').onclick = () => action('toggle');
$('#toast').onclick = () => action('open');
$('#settings-toggle').onclick = () => showSettings($('#settings').hidden);
$('#settings-close').onclick = () => showSettings(false); $('#quit').onclick = () => action('quit');
$('#choose-project').onclick = () => claude('project'); $('#reconnect').onclick = () => { if (!busy) claude('connect'); };
$('#new-chat').onclick = () => claude('new-chat');
$('#stop').onclick = () => claude('stop');
$('#opacity').oninput = event => action('opacity', Number(event.target.value) / 100);
$('#sound').onchange = () => { action('sound', $('#sound').checked); if ($('#sound').checked) { audio ||= new AudioContext(); audio.resume(); } };
document.addEventListener('pointerdown', () => { if ($('#sound').checked) { audio ||= new AudioContext(); audio.resume(); } });
$('#shortcut').onchange = async event => {
  const ok = await action('shortcut', event.target.value); $('#settings-note').textContent = ok ? 'Shortcut updated.' : 'That shortcut is unavailable. Try another.';
};
document.addEventListener('keydown', event => { if (event.key === 'Escape') { if (!$('#settings').hidden) showSettings(false); else action('collapse'); } });
async function submit() {
  const text = $('#prompt').value.trim(); if ((!text && !attachments.length) || submitting || pasting || capturing) return;
  const sent = [...attachments];
  const originalText = $('#prompt').value, epoch = draftEpoch;
  submitting = true; controls();
  const result = await claude('send', { text, images: sent.map(({ type, data }) => ({ type, data })) });
  if (result && epoch === draftEpoch) {
    if ($('#prompt').value === originalText) $('#prompt').value = '';
    resizePrompt(); attachments = attachments.filter(item => !sent.includes(item)); renderAttachments();
  }
  submitting = false; controls();
}
function resizePrompt() {
  const prompt = $('#prompt');
  prompt.style.height = '30px';
  prompt.style.height = `${Math.min(110, Math.max(30, prompt.scrollHeight))}px`;
}
$('#prompt').addEventListener('input', resizePrompt);
let promptWidth = 0;
new ResizeObserver(entries => {
  const width = entries[0].contentRect.width;
  if (width > 0 && width !== promptWidth) { promptWidth = width; requestAnimationFrame(resizePrompt); }
}).observe($('#prompt'));
function renderAttachments() {
  $('#attachments').replaceChildren(); $('#attachments').hidden = !attachments.length;
  for (const attachment of attachments) {
    const preview = document.createElement('div'); preview.className = 'attachment';
    const image = document.createElement('img'); image.src = `data:${attachment.type};base64,${attachment.data}`; image.alt = 'Screenshot ready to send';
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.setAttribute('aria-label', 'Remove screenshot');
    remove.onclick = () => { attachments = attachments.filter(item => item !== attachment); renderAttachments(); };
    preview.append(image, remove); $('#attachments').append(preview);
  }
  controls();
}
$('#capture-game').onclick = async () => {
  if (capturing || pasting || attachments.length >= 4) return;
  capturing = true; controls();
  const epoch = draftEpoch;
  $('#capture-game').setAttribute('aria-busy', 'true');
  try {
    const result = await action('capture-game');
    if (result?.error) throw new Error(result.error);
    if (!result?.image) throw new Error('Could not capture the game.');
    if (epoch !== draftEpoch) throw new Error('Conversation changed. Take the screenshot again.');
    if (attachments.length >= 4) throw new Error('You can attach up to four screenshots per message.');
    attachments.push(result.image); renderAttachments();
  } catch (error) { localError(error.message); }
  finally { capturing = false; controls(); $('#capture-game').removeAttribute('aria-busy'); $('#prompt').focus(); }
};
$('#prompt').addEventListener('paste', async event => {
  const files = [...(event.clipboardData?.items || [])].filter(item => item.kind === 'file' && item.type.startsWith('image/')).map(item => item.getAsFile()).filter(Boolean);
  if (!files.length) return;
  event.preventDefault(); pasting++; controls();
  const epoch = draftEpoch;
  try {
    for (const file of files) {
      if (attachments.length >= 4) throw new Error('You can attach up to four screenshots per message.');
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) throw new Error('Paste a PNG, JPEG, WebP, or GIF image.');
      if (file.size > 30 * 1024 * 1024) throw new Error('That screenshot is larger than 30 MB. Use a smaller image.');
      const url = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('Could not read the clipboard image.')); reader.readAsDataURL(file); });
      if (epoch !== draftEpoch) throw new Error('Conversation changed. Paste your screenshot again.');
      if (attachments.length >= 4) throw new Error('You can attach up to four screenshots per message.');
      attachments.push({ type: file.type, data: url.split(',')[1] }); renderAttachments();
    }
  } catch (error) { localError(error.message); }
  finally { pasting--; controls(); }
});
$('#composer').onsubmit = event => { event.preventDefault(); submit(); };
$('#prompt').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); submit(); } };
controls();
$('#permission-mode').onchange = async event => {
  const result = await claude('permission-mode', event.target.value);
  if (result) permissionMode = result.mode;
  event.target.value = permissionMode; controls();
};
$('#model-picker').onchange = async event => {
  const result = await claude('model', event.target.value);
  if (result) modelState(result);
  else event.target.value = selectedModel;
};
bridge.onUpdate(value => {
  $('#update-status').textContent = `ClaudeHUD ${value.version} · ${value.detail}`;
  $('#install-update').hidden = value.phase !== 'ready';
  $('#check-updates').disabled = ['development', 'checking', 'downloading'].includes(value.phase);
});
$('#check-updates').onclick = () => action('check-updates');
$('#install-update').onclick = async () => { const result = await action('install-update'); if (result?.error) $('#update-status').textContent = result.error; };
let conversations = [];
function renderConversations() {
  const search = $('#conversation-search').value.toLowerCase();
  $('#conversation-list').replaceChildren();
  const matches = conversations.filter(item => `${item.title} ${item.project}`.toLowerCase().includes(search));
  for (const item of matches) {
    const button = document.createElement('button'); button.className = 'conversation-item';
    const title = document.createElement('strong'); title.textContent = item.title;
    const folder = document.createElement('small'); folder.textContent = item.project;
    const date = document.createElement('small'); date.textContent = new Date(item.modified).toLocaleString();
    button.append(title, folder, date);
    button.onclick = async () => {
      for (const row of $('#conversation-list').children) row.disabled = true;
      $('#conversation-note').textContent = 'Loading conversation…';
      const result = await claude('load-conversation', item.id);
      if (result) { $('#conversation-picker').hidden = true; showSettings(false); }
      else { $('#conversation-note').textContent = 'Could not load. See the error in chat.'; renderConversations(); }
    };
    $('#conversation-list').append(button);
  }
  if (!matches.length) $('#conversation-list').textContent = 'No matching local conversations.';
}
$('#conversations-open').onclick = async () => {
  $('#conversation-picker').hidden = false; $('#conversation-note').textContent = 'Loading recent conversations…';
  const result = await claude('list-conversations');
  conversations = result?.conversations || [];
  $('#conversation-note').textContent = 'Continue a saved conversation. Finish any active turn in the desktop app first.';
  renderConversations(); $('#conversation-search').focus();
};
$('#conversations-close').onclick = () => { $('#conversation-picker').hidden = true; };
$('#conversation-search').oninput = renderConversations;
