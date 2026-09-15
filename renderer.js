const $ = selector => document.querySelector(selector);
const surface = new URLSearchParams(location.search).get('surface') || 'panel';
for (const name of ['panel', 'toast']) $(`#${name}`).hidden = name !== surface;
const bridge = window.hud;
const action = (name, value) => bridge.action(name, value);
let busy = false, audio, project, connected = false;
const messageNodes = new Map(), requests = new Map();
const welcome = $('#messages').innerHTML;
function scrollToBottom() { $('#messages').scrollTop = $('#messages').scrollHeight; }
function controls() {
  $('#send').disabled = busy || !connected || !project;
  $('#stop').hidden = !busy; $('#choose-project').disabled = busy; $('#new-chat').disabled = busy; $('#conversations-open').disabled = busy;
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
    meta.append(strong, time); const p = document.createElement('p'); p.className = 'response-text';
    body.append(meta, p); article.append(avatar, body); $('#messages').append(article); messageNodes.set(item.id, body);
  }
  body.querySelector('.response-text').textContent = item.text;
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
      for (const option of question.options || []) {
        const button = document.createElement('button'); button.className = 'quiet'; button.textContent = option.label; button.title = option.description || '';
        button.onclick = () => { input.value = question.multiSelect && input.value ? `${input.value}, ${option.label}` : option.label; }; card.append(button);
      }
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
    project = data.project; connected = data.connection.ready; busy = data.busy;
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
bridge.onFocus(() => $('#prompt').focus());
bridge.onExpansion(({ expanded, transitioning }) => {
  document.body.classList.toggle('collapsed', !expanded); document.body.classList.toggle('transitioning', transitioning);
  $('#overlay-toggle').setAttribute('aria-expanded', String(expanded));
  $('#overlay-toggle').setAttribute('aria-label', expanded ? 'Collapse chat' : 'Open chat'); $('#overlay-toggle').title = expanded ? 'Collapse chat' : 'Open chat';
  for (const child of $('#panel').children) if (child.tagName !== 'HEADER') child.inert = !expanded;
});
bridge.onSettings(() => { $('#settings').hidden = false; });
bridge.onShortcut(ok => { if (!ok) $('#settings-note').textContent = 'Hotkey unavailable. Choose another shortcut in settings.'; });
$('#close-app').onclick = () => action('quit'); $('#overlay-toggle').onclick = () => action('toggle');
$('#toast').onclick = () => action('open');
$('#settings-toggle').onclick = () => { $('#settings').hidden = !$('#settings').hidden; };
$('#settings-close').onclick = () => { $('#settings').hidden = true; }; $('#quit').onclick = () => action('quit');
$('#choose-project').onclick = () => claude('project'); $('#reconnect').onclick = () => { if (!busy) claude('connect'); };
$('#new-chat').onclick = () => { if (window.confirm('Start a fresh conversation for this addon?')) claude('new-chat'); };
$('#stop').onclick = () => claude('stop');
$('#opacity').oninput = event => action('opacity', Number(event.target.value) / 100);
$('#sound').onchange = () => { if ($('#sound').checked) { audio ||= new AudioContext(); audio.resume(); } };
$('#shortcut').onchange = async event => {
  const ok = await action('shortcut', event.target.value); $('#settings-note').textContent = ok ? 'Shortcut updated.' : 'That shortcut is unavailable. Try another.';
  if (ok) $('#shortcut-hint').textContent = event.target.selectedOptions[0].textContent;
};
document.addEventListener('keydown', event => { if (event.key === 'Escape') { if (!$('#settings').hidden) $('#settings').hidden = true; else action('collapse'); } });
async function submit() {
  const text = $('#prompt').value.trim(); if (!text || busy) return;
  busy = true; controls(); const result = await claude('send', text);
  if (result) $('#prompt').value = ''; else { busy = false; controls(); }
}
$('#composer').onsubmit = event => { event.preventDefault(); submit(); };
$('#prompt').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); submit(); } };
controls();
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
      if (result) $('#conversation-picker').hidden = true;
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
