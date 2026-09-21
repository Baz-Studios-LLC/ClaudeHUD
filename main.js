const { app, BrowserWindow, ipcMain, globalShortcut, screen, Tray, Menu, nativeImage, dialog, desktopCapturer, clipboard, shell, protocol } = require('electron');
const { captureGame } = require('./game-capture');
const { ClaudeService } = require('./claude-service');
const { readDesktopPins } = require('./desktop-pins');
const { createUpdater } = require('./updater');
const { Preferences, fitBounds } = require('./preferences');
const path = require('node:path');
const fs = require('node:fs');
protocol.registerSchemesAsPrivileged([{ scheme: 'hud-image', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
let panel, toast, timer, tray;
let claude;
let updates;
let preferences, savePositionTimer;
let windowMode = 'normal', normalBounds, sizingWindow = false;
function sendWindowMode() { panel.webContents.send('window-mode', expanded ? windowMode : 'normal'); }
function applyWindowMode() {
  sizingWindow = true;
  try {
    const display = screen.getDisplayMatching(normalBounds || panel.getBounds());
    const bounds = windowMode === 'fullscreen' ? display.bounds : windowMode === 'maximized' ? display.workArea : fitBounds(normalBounds, display.workArea);
    panel.setBounds(bounds); panel.setResizable(windowMode === 'normal');
  } finally { sizingWindow = false; }
  sendWindowMode();
}
function setWindowMode(mode) {
  if (!expanded || transitioning || capturing || !['normal', 'maximized', 'fullscreen'].includes(mode)) return;
  if (windowMode === 'normal') normalBounds = panel.getBounds();
  windowMode = mode; applyWindowMode(); saveWindow();
}
function saveWindow() {
  if (smoke || !preferences || !panel || panel.isDestroyed()) return;
  const bounds = expanded && windowMode !== 'normal' ? normalBounds : panel.getBounds();
  preferences.update({ expanded, windowMode, bounds: { x: bounds.x, y: bounds.y, ...expandedSize } });
}
function scheduleSaveWindow() { if (transitioning) return; clearTimeout(savePositionTimer); savePositionTimer = setTimeout(saveWindow, 200); }
let nativeDialogOpen = false;
let contextMenuOpen = false;
function textMenuTemplate(params, contents) {
  const items = [];
  if (params.isEditable) {
    if (params.misspelledWord) {
      for (const suggestion of params.dictionarySuggestions || []) {
        items.push({ label: suggestion, click: () => contents.replaceMisspelling(suggestion) });
      }
      if (!params.dictionarySuggestions?.length) items.push({ label: 'No spelling suggestions', enabled: false });
      items.push({ label: 'Add to dictionary', click: () => contents.session.addWordToSpellCheckerDictionary(params.misspelledWord) });
      items.push({ type: 'separator' });
    }
    items.push(
      { role: 'undo', enabled: params.editFlags.canUndo },
      { role: 'redo', enabled: params.editFlags.canRedo },
      { type: 'separator' },
      { role: 'cut', enabled: params.editFlags.canCut },
      { role: 'copy', enabled: params.editFlags.canCopy },
      { role: 'paste', enabled: params.editFlags.canPaste },
      { type: 'separator' },
      { role: 'selectAll', enabled: params.editFlags.canSelectAll }
    );
  } else if (params.selectionText && params.editFlags.canCopy) {
    items.push({ label: 'Copy', accelerator: 'CmdOrCtrl+C', click: () => clipboard.writeText(params.selectionText) });
  }
  return items;
}
let capturing = false;
let expanded = true;
let expandedSize = { width: 460, height: 740 };
let transitionTimer, finishTransition;
let transitioning = false;
let animationFrames = [];
const compactSize = { width: 155, height: 54 };
let shortcut = 'CommandOrControl+Shift+Space';
let state = 'Ready';
const smoke = process.argv.includes('--smoke-test');
let smokeCopiedCode = null;
if (smoke) app.setPath('userData', path.join(__dirname, 'artifacts', 'smoke-profile'));
const ownsInstance = smoke || app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();
app.on('second-instance', () => { if (panel && !panel.isDestroyed()) void openPanel(); });
function windowOptions(width, height) {
  return { width, height, frame: false, transparent: true, backgroundColor: '#00000000', alwaysOnTop: true,
    show: false, skipTaskbar: true, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } };
}
function sendState() {
  for (const win of [panel, toast]) if (win && !win.isDestroyed()) win.webContents.send('status', state);
}
function notify(title, text) {
  toast.webContents.send('notice', { title, text });
  if (expanded) return;
  const bounds = panel.getBounds(), work = screen.getDisplayMatching(bounds).workArea;
  toast.setPosition(Math.max(work.x, Math.min(bounds.x, work.x + work.width - 340)), Math.min(bounds.y + compactSize.height + 10, work.y + work.height - 96));
  toast.showInactive(); clearTimeout(timer); timer = setTimeout(() => toast.hide(), 6500);
}
function claudeEvent(type, data) {
  const previousState = state;
  panel.webContents.send('claude-event', { type, data });
  if (type === 'busy' && data) state = 'Working';
  if (type === 'permission') { state = 'Needs input'; notify('Claude needs your input', data.tool === 'AskUserQuestion' ? 'Open chat to answer a question.' : `Review ${data.tool} in chat.`); }
  if (type === 'permission-resolved') state = claude.pending.size ? 'Needs input' : 'Working';
  if (type === 'complete') { state = 'Finished'; notify('Claude finished', data.text.slice(0, 100)); }
  if (type === 'failure') { state = 'Needs attention'; notify('Claude needs attention', data.text.slice(0, 100)); }
  if (type === 'stopped') state = 'Stopped';
  if (state !== previousState) sendState();
}
function setExpanded(next) {
  if (capturing) return Promise.resolve();
  if (next === expanded && !transitionTimer) {
    if (next) { panel.focus(); panel.webContents.send('focus-input'); }
    return Promise.resolve();
  }
  clearInterval(transitionTimer);
  if (finishTransition) finishTransition();
  transitioning = true;
  if (!next && windowMode !== 'normal') {
    sizingWindow = true; panel.setBounds(normalBounds); sizingWindow = false;
  }
  const start = panel.getBounds();
  expanded = next;
  toast.hide();
  panel.setMinimumSize(compactSize.width, compactSize.height);
  panel.setResizable(false);
  panel.setFocusable(next);
  panel.webContents.send('expansion', { expanded: next, transitioning: true });
  const target = next ? expandedSize : compactSize;
  const animationStart = performance.now();
  if (smoke) animationFrames = [];
  // Animate the same native window. Its top-left corner and header icon never move.
  return new Promise(resolve => {
    finishTransition = resolve;
    transitionTimer = setInterval(() => {
      const t = Math.min(1, (performance.now() - animationStart) / 240);
      const eased = 1 - Math.pow(1 - t, 3);
      panel.setBounds({ x: start.x, y: start.y,
        width: Math.round(start.width + (target.width - start.width) * eased),
        height: Math.round(start.height + (target.height - start.height) * eased) });
      if (smoke) animationFrames.push(panel.getBounds());
      if (t === 1) {
        clearInterval(transitionTimer); transitionTimer = null; finishTransition = null;
        panel.setResizable(next);
        if (next) panel.setMinimumSize(380, 520);
        transitioning = false;
        if (next) {
          normalBounds = panel.getBounds();
          if (windowMode !== 'normal') applyWindowMode();
        }
        sendWindowMode();
        saveWindow();
        panel.webContents.send('expansion', { expanded: next, transitioning: false });
        if (next) { panel.focus(); panel.webContents.send('focus-input'); }
        resolve();
      }
    }, 16);
  });
}
function openPanel() { return setExpanded(true); }
function collapse() { return setExpanded(false); }
function toggle() { return setExpanded(!expanded); }
function collapseOnBlur() {
  if (expanded && !nativeDialogOpen && !contextMenuOpen && !capturing && !quitting) return collapse();
  return Promise.resolve();
}
function createTrayIcon() {
  return nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray-icon.png'));
}
function setupTray() {
  tray = new Tray(createTrayIcon()); tray.setToolTip('ClaudeHUD');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open chat', click: openPanel },
    { label: 'Collapse to badge', click: collapse },
    { type: 'separator' },
    { label: 'Overlay settings', click: () => { openPanel(); panel.webContents.send('open-settings'); } },
    { label: 'Check for updates', click: () => { openPanel(); panel.webContents.send('open-settings'); void updates?.check(); } },
    { type: 'separator' },
    { label: 'Quit ClaudeHUD', click: () => app.quit() }
  ]));
  tray.on('double-click', openPanel);
}
function bindShortcut(value) {
  if (!['CommandOrControl+Shift+Space', 'Alt+Shift+C', 'CommandOrControl+Shift+H'].includes(value)) return false;
  if (value === shortcut && globalShortcut.isRegistered(value)) return true;
  if (!globalShortcut.register(value, toggle)) return false;
  globalShortcut.unregister(shortcut); shortcut = value;
  if (!smoke) preferences.update({ shortcut });
  return true;
}
app.whenReady().then(async () => {
  protocol.handle('hud-image', async request => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== 'image' || !claude) return new Response(null, { status: 404 });
      const file = claude.attachments.path(url.pathname.slice(1));
      const type = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }[path.extname(file).slice(1)];
      return new Response(await fs.promises.readFile(file), { headers: { 'Content-Type': type, 'Cache-Control': 'private, max-age=31536000' } });
    } catch { return new Response(null, { status: 404 }); }
  });
  if (!ownsInstance) return;
  if (!smoke) {
    const previous = path.join(app.getPath('appData'), 'claudhud', 'conversations.json');
    const current = path.join(app.getPath('userData'), 'conversations.json');
    if (!fs.existsSync(current) && fs.existsSync(previous)) {
      fs.mkdirSync(path.dirname(current), { recursive: true }); fs.copyFileSync(previous, current);
    }
  }
  preferences = new Preferences(path.join(app.getPath('userData'), 'preferences.json'));
  const saved = smoke ? require('./preferences').normalize() : preferences.value;
  const area = saved.bounds ? screen.getDisplayMatching(saved.bounds).workArea : screen.getPrimaryDisplay().workArea;
  const bounds = fitBounds(saved.bounds || { width: 460, height: Math.min(740, area.height - 40), x: area.x + area.width - 488, y: area.y + 20 }, area);
  expandedSize = { width: bounds.width, height: bounds.height }; expanded = saved.expanded; shortcut = saved.shortcut;
  normalBounds = bounds; windowMode = saved.windowMode;
  const size = expanded ? expandedSize : compactSize;
  panel = new BrowserWindow({ ...windowOptions(size.width, size.height), minWidth: expanded ? 380 : compactSize.width, minHeight: expanded ? 520 : compactSize.height, resizable: expanded, focusable: expanded, x: bounds.x, y: bounds.y });
  panel.setOpacity(saved.opacity);
  panel.setIcon(nativeImage.createFromPath(path.join(__dirname, 'assets', 'app-icon.png')));
  panel.webContents.on('context-menu', (_event, params) => {
    if (contextMenuOpen) return;
    const template = textMenuTemplate(params, panel.webContents);
    if (!template.length) return;
    const menu = Menu.buildFromTemplate(template);
    contextMenuOpen = true;
    menu.popup({ window: panel, callback: () => {
      contextMenuOpen = false;
      if (!panel.isDestroyed() && expanded) panel.focus();
    } });
  });
  panel.on('blur', () => {
    if (!smoke) void collapseOnBlur();
  });
  panel.on('resize', () => { if (expanded && !transitioning && !sizingWindow && windowMode === 'normal') { const bounds = panel.getBounds(); normalBounds = bounds; expandedSize = { width: bounds.width, height: bounds.height }; scheduleSaveWindow(); } });
  panel.on('move', scheduleSaveWindow);
  // Reserve room for the expanded panel when dragging its compact header.
  panel.on('will-move', (event, bounds) => {
    if (transitionTimer || (expanded && windowMode !== 'normal')) { event.preventDefault(); return; }
    const work = screen.getDisplayMatching(bounds).workArea;
    const x = Math.max(work.x, Math.min(bounds.x, work.x + work.width - expandedSize.width));
    const y = Math.max(work.y, Math.min(bounds.y, work.y + work.height - expandedSize.height));
    if (x !== bounds.x || y !== bounds.y) { event.preventDefault(); panel.setPosition(x, y); }
  });
  toast = new BrowserWindow({ ...windowOptions(340, 96), resizable: false, focusable: false, x: area.x + area.width - 364, y: area.y + 148 });
  for (const win of [panel, toast]) {
    if (smoke) win.webContents.on('console-message', event => console.log('Renderer:', event.message));
    win.setAlwaysOnTop(true, 'screen-saver');
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
  }
  await Promise.all([panel.loadFile('index.html'), toast.loadFile('index.html', { query: { surface: 'toast' } })]);
  const registered = globalShortcut.register(shortcut, toggle);
  panel.webContents.send('shortcut-status', registered);
  panel.webContents.send('preferences', saved);
  panel.webContents.send('expansion', { expanded, transitioning: false });
  if (expanded && windowMode !== 'normal') applyWindowMode(); else sendWindowMode();
  setupTray(); sendState(); if (expanded) panel.show(); else panel.showInactive();
  updates = createUpdater({ app, updater: require('electron-updater').autoUpdater, isBusy: () => !!(claude?.busy || claude?.promoting || capturing), emit: value => {
    panel.webContents.send('update-status', value);
    if (value.phase === 'ready') notify('ClaudeHUD update ready', 'Open Settings to restart and install.');
  } });
  updates.start();
  if (!smoke) {
    claude = new ClaudeService({ storage: path.join(app.getPath('userData'), 'conversations.json'), emit: claudeEvent, pinnedProvider: readDesktopPins, showThinking: () => preferences.value.showThinking });
    panel.webContents.send('claude-event', { type: 'snapshot', data: claude.snapshot() });
    void claude.connect();
  }
  if (smoke) {
    try {
      let replacement, dictionaryWord;
      const spellingMenu = textMenuTemplate({ isEditable: true, misspelledWord: 'teh', dictionarySuggestions: ['the'], editFlags: { canCopy: false, canPaste: true } }, {
        replaceMisspelling: word => { replacement = word; },
        session: { addWordToSpellCheckerDictionary: word => { dictionaryWord = word; } }
      });
      spellingMenu.find(item => item.label === 'the').click();
      spellingMenu.find(item => item.label === 'Add to dictionary').click();
      if (replacement !== 'the' || dictionaryWord !== 'teh' || !spellingMenu.find(item => item.role === 'paste').enabled) throw new Error('Spelling menu failed');
      if (textMenuTemplate({ isEditable: false, selectionText: '', editFlags: {} }, {}).length) throw new Error('Empty context menu');
      fs.mkdirSync(path.join(__dirname, 'artifacts'), { recursive: true });
      claude = new ClaudeService({ storage: path.join(app.getPath('userData'), 'image-test.json'), emit() {} });
      const storedImage = claude.attachments.store({ type: 'image/png', data: fs.readFileSync(path.join(__dirname, 'assets', 'app-icon.png')).toString('base64') });
      const imageLoaded = await panel.webContents.executeJavaScript(`new Promise(resolve => {
        const image = new Image(); image.onload = () => resolve(image.naturalWidth > 0); image.onerror = () => resolve(false);
        image.src = ${JSON.stringify(storedImage.url)};
      })`);
      if (!imageLoaded) throw new Error('Stored screenshot could not be displayed');
      panel.webContents.send('claude-event', { type: 'snapshot', data: { project: 'C:\\Addons\\TestAddon', connection: { ready: true }, busy: false, messages: [] } });
      panel.webContents.send('claude-event', { type: 'message', data: { id: 'test-message', role: 'Claude', text: 'Connected UI test response\n```lua\n  print("Hello, Azeroth!")\n-- <script> stays literal\n```', time: Date.now() } });
      panel.webContents.send('claude-event', { type: 'permission', data: { id: 'test-permission', tool: 'Write', input: { file_path: 'TestAddon.lua', content: '-- UI test only' } } });
      await new Promise(resolve => setTimeout(resolve, 500));
      const result = await panel.webContents.executeJavaScript(`({messages: document.querySelectorAll('.message').length, ready: document.querySelector('#status-label').textContent, text: document.querySelector('#messages').textContent})`);
      if (result.messages !== 1 || !result.text.includes('Connected UI test response') || !result.text.includes('Allow Write?')) throw new Error(JSON.stringify(result));
      panel.webContents.send('claude-event', { type: 'message', data: { id: 'thinking-test', role: 'Claude', text: '', thinking: 'Checking the addon layout.' } });
      await new Promise(resolve => setTimeout(resolve, 100));
      const thinkingResult = await panel.webContents.executeJavaScript(`(() => {
        const block = document.querySelector('.thinking');
        const toggle = document.querySelector('#show-thinking');
        const hidden = getComputedStyle(block).display === 'none';
        toggle.checked = true; toggle.dispatchEvent(new Event('change'));
        const shown = getComputedStyle(block).display !== 'none';
        block.open = false;
        const collapsed = !block.open;
        toggle.checked = false; toggle.dispatchEvent(new Event('change'));
        return hidden && shown && collapsed && getComputedStyle(block).display === 'none';
      })()`);
      if (!thinkingResult) throw new Error('Thinking visibility toggle failed');
      panel.webContents.send('claude-event', { type: 'message', data: { id: 'empty-test', role: 'Claude', text: '\n  ', thinking: ' ' } });
      panel.webContents.send('claude-event', { type: 'message', data: { id: 'thinking-test', role: 'Claude', text: '\n ', thinking: 'Checking the addon layout.' } });
      await new Promise(resolve => setTimeout(resolve, 100));
      const blankRowsHidden = await panel.webContents.executeJavaScript(`(() => {
        const rows = [...document.querySelectorAll('.message')];
        return rows.filter(row => getComputedStyle(row).display !== 'none').length === 1;
      })()`);
      if (!blankRowsHidden) throw new Error('Blank or hidden-thinking rows are visible');
      panel.webContents.send('claude-event', { type: 'message', data: { id: 'empty-test', role: 'Claude', text: 'Streaming content arrived.' } });
      await new Promise(resolve => setTimeout(resolve, 100));
      if (!await panel.webContents.executeJavaScript(`[...document.querySelectorAll('.message')].some(row => !row.hidden && row.textContent.includes('Streaming content arrived.'))`)) throw new Error('Streaming placeholder did not reappear');
      const codeResult = await panel.webContents.executeJavaScript(`(async () => {
        const block = document.querySelector('.code-block');
        const copy = block.querySelector('button'); copy.click();
        await new Promise(resolve => setTimeout(resolve, 100));
        return { text: block.querySelector('code').textContent, label: copy.textContent, unsafe: !!block.querySelector('script') };
      })()`);
      if (codeResult.text !== '  print("Hello, Azeroth!")\n-- <script> stays literal\n' || codeResult.label !== 'Copied!' || codeResult.unsafe || smokeCopiedCode !== codeResult.text) throw new Error('Code formatting/copy failed');
      panel.webContents.send('update-status', { phase: 'downloading', version: app.getVersion(), detail: 'Downloading…' });
      await new Promise(resolve => setTimeout(resolve, 100));
      if (!await panel.webContents.executeJavaScript(`document.querySelector('#update-ready').hidden`)) throw new Error('Update chip appeared before download finished');
      panel.webContents.send('update-status', { phase: 'ready', version: app.getVersion(), nextVersion: '0.1.10', detail: 'Update downloaded.' });
      panel.webContents.send('claude-event', { type: 'busy', data: true });
      panel.webContents.send('claude-event', { type: 'queue', data: [{ id: 'queue-test', text: 'Also check the minimap button spacing.', images: [] }] });
      await new Promise(resolve => setTimeout(resolve, 100));
      const queueResult = await panel.webContents.executeJavaScript(`({ visible: !document.querySelector('#message-queue').hidden, enabled: !document.querySelector('#send').disabled, label: document.querySelector('#send').getAttribute('aria-label'), actions: [...document.querySelectorAll('.queued-actions button')].map(button => button.textContent) })`);
      if (!queueResult.visible || !queueResult.enabled || queueResult.label !== 'Queue message' || queueResult.actions.join(',') !== 'Edit,Send now,Remove') throw new Error('Queue controls failed');
      await panel.webContents.executeJavaScript(`(async () => {
        const originalClaude = claude, calls = [];
        try {
          claude = async (name, value) => { calls.push({ name, value }); return { ok: true }; };
          await document.querySelector('.queued-actions button').onclick();
          const editor = document.querySelector('#queue-items textarea');
          if (!editor) throw new Error('Queue editor missing');
          editor.value = 'Updated queued message'; editor.dispatchEvent(new Event('input'));
          renderQueue(queuedItems);
          if (document.querySelector('#queue-items textarea').value !== 'Updated queued message') throw new Error('Queue redraw lost edit');
          await document.querySelector('.queued-actions button').onclick();
          if (calls[0].name !== 'edit-queued' || calls[1].value.text !== 'Updated queued message' || queueEditor) throw new Error('Queue edit save failed');
        } finally { claude = originalClaude; }
      })()`);
      if (!await panel.webContents.executeJavaScript(`!document.querySelector('#update-ready').hidden && document.querySelector('#update-ready').disabled`)) throw new Error('Update chip must wait while Claude works');
      fs.writeFileSync(path.join(__dirname, 'artifacts', 'queue.png'), (await panel.webContents.capturePage()).toPNG());
      panel.webContents.send('claude-event', { type: 'queue', data: [] });
      panel.webContents.send('claude-event', { type: 'busy', data: false });
      await new Promise(resolve => setTimeout(resolve, 100));
      if (!await panel.webContents.executeJavaScript(`!document.querySelector('#update-ready').hidden && !document.querySelector('#update-ready').disabled`)) throw new Error('Update chip did not become available');
      fs.writeFileSync(path.join(__dirname, 'artifacts', 'panel.png'), (await panel.webContents.capturePage()).toPNG());
      await panel.webContents.executeJavaScript(`document.querySelector('#settings-toggle').click()`);
      await new Promise(resolve => setTimeout(resolve, 150));
      fs.writeFileSync(path.join(__dirname, 'artifacts', 'settings.png'), (await panel.webContents.capturePage()).toPNG());
      await panel.webContents.executeJavaScript(`document.querySelector('#settings-close').click()`);
      const pasteResult = await panel.webContents.executeJavaScript(`(async () => {
        const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
        const transfer = new DataTransfer(); transfer.items.add(new File([bytes], 'screenshot.png', {type:'image/png'}));
        document.querySelector('#prompt').dispatchEvent(new ClipboardEvent('paste', {clipboardData:transfer, bubbles:true, cancelable:true}));
        await new Promise(resolve => setTimeout(resolve, 150));
        const count = document.querySelectorAll('#attachments img').length;
        document.querySelector('#attachments button')?.click();
        return {count, remaining:document.querySelectorAll('#attachments img').length};
      })()`);
      if (pasteResult.count !== 1 || pasteResult.remaining !== 0) throw new Error('Screenshot paste/remove failed');
      const jumpResult = await panel.webContents.executeJavaScript(`(async () => {
        const messages = document.querySelector('#messages');
        const spacer = document.createElement('div'); spacer.style.height = '2000px'; messages.append(spacer);
        messages.scrollTop = 0;
        await new Promise(resolve => setTimeout(resolve, 100));
        const visible = !document.querySelector('#jump-latest').hidden;
        document.querySelector('#jump-latest').click();
        const atBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight <= 1;
        const hidden = document.querySelector('#jump-latest').hidden;
        spacer.remove();
        return { visible, atBottom, hidden };
      })()`);
      if (!jumpResult.visible || !jumpResult.atBottom || !jumpResult.hidden) throw new Error('Jump to latest failed');
      panel.webContents.send('claude-event', { type: 'permission', data: { id: 'test-question', tool: 'AskUserQuestion', input: { questions: [{ question: 'Choose features', multiSelect: true, options: [{ label: 'First choice' }, { label: 'Second choice' }] }] } } });
      await new Promise(resolve => setTimeout(resolve, 100));
      const questionResult = await panel.webContents.executeJavaScript(`(() => {
        const choices = document.querySelectorAll('.question-options button');
        choices[0].click(); choices[1].click(); choices[0].click();
        const input = choices[0].closest('.permission-card').querySelector('textarea');
        const toggled = input.value === 'Second choice' && choices[0].getAttribute('aria-pressed') === 'false' && choices[1].getAttribute('aria-pressed') === 'true';
        const gap = getComputedStyle(choices[0].parentElement).gap;
        input.value = 'Custom answer'; input.dispatchEvent(new Event('input'));
        return toggled && gap === '8px' && choices[1].getAttribute('aria-pressed') === 'false';
      })()`);
      if (!questionResult) throw new Error('Question selection feedback failed');
      const markdownResult = await panel.webContents.executeJavaScript(`(() => {
        message({ id: 'markdown-test', role: 'Claude', text: '**Two** bugs.\\n\\n1. First\\n2. Second\\n\\nInline '+String.fromCharCode(96)+'self.text'+String.fromCharCode(96) }, false);
        const body = messageNodes.get('markdown-test');
        return body.querySelector('strong') && body.querySelector('.markdown strong').textContent === 'Two' && body.querySelectorAll('ol li').length === 2 && body.querySelector('code').textContent === 'self.text';
      })()`);
      if (!markdownResult) throw new Error('Markdown rendering failed');
      await panel.webContents.executeJavaScript(`(() => {
        showChatSearch(true);
        const input = document.querySelector('#chat-search-input');
        input.value = 'self.text'; input.dispatchEvent(new Event('input'));
        if (searchMatches.length !== 1 || searchMatches[0].toString() !== 'self.text') throw new Error('Code search failed');
        input.value = 'First'; input.dispatchEvent(new Event('input'));
        if (!searchMatches.length) throw new Error('Message search failed');
        selectSearchMatch(1);
        input.value = 'no-match-unique'; input.dispatchEvent(new Event('input'));
        if (searchMatches.length || !document.querySelector('#chat-search-next').disabled) throw new Error('Empty search failed');
        showChatSearch(false);
        if (CSS.highlights.get('search-results').size) throw new Error('Search highlights not cleared');
      })()`);
      await panel.webContents.executeJavaScript(`(async () => {
        const originalClaude = claude;
        let complete;
        try {
          claude = () => new Promise(resolve => { complete = resolve; });
          const prompt = document.querySelector('#prompt');
          prompt.value = 'First message';
          let sending = submit();
          if (prompt.value !== '') throw new Error('Composer did not clear immediately');
          prompt.value = 'Next draft'; complete({ ok: true }); await sending;
          if (prompt.value !== 'Next draft') throw new Error('Send cleared newer draft');
          sending = submit(); prompt.value = 'More typing'; complete(null); await sending;
          if (prompt.value !== 'Next draft\\n\\nMore typing') throw new Error('Failed send lost draft text');
          prompt.value = ''; resizePrompt();
        } finally { claude = originalClaude; }
      })()`);
      const historyPerformance = await panel.webContents.executeJavaScript(`(async () => {
        const start = performance.now();
        for (let i = 0; i < 500; i++) message({ id: 'history-' + i, role: i % 2 ? 'You' : 'Claude', text: 'Long conversation layout test. '.repeat(20) }, false);
        scrollToBottom();
        const loadMs = performance.now() - start;
        for (let i = 0; i < 100; i++) queueMessage({ id: 'stream-performance', role: 'Claude', text: 'Stream update ' + i });
        await new Promise(resolve => requestAnimationFrame(resolve));
        const body = messageNodes.get('stream-performance');
        if (!body || !body.textContent.includes('Stream update 99')) throw new Error('Batched stream lost final text');
        return { loadMs, historyMessages: 500 };
      })()`);
      const original = panel.getBounds();
      const assert = require('node:assert/strict');
      const modeDisplay = screen.getDisplayMatching(original);
      await panel.webContents.executeJavaScript(`window.hud.action('maximize')`);
      assert.deepEqual(panel.getBounds(), modeDisplay.workArea);
      await collapse(); assert.equal(panel.getBounds().width, compactSize.width);
      await openPanel(); assert.deepEqual(panel.getBounds(), modeDisplay.workArea);
      await panel.webContents.executeJavaScript(`window.hud.action('maximize')`);
      assert.deepEqual(panel.getBounds(), original);
      await panel.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F11', bubbles: true }))`);
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.deepEqual(panel.getBounds(), modeDisplay.bounds);
      await panel.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(expanded, true); assert.deepEqual(panel.getBounds(), original);
      const iconPosition = () => panel.webContents.executeJavaScript(`(() => { const r = document.querySelector('.brand-mark').getBoundingClientRect(); return {x:r.x,y:r.y}; })()`);
      const iconBefore = await iconPosition();
      const shrinking = collapse();
      await shrinking;
      if (!animationFrames.some(frame => frame.height < original.height && frame.height > compactSize.height)) throw new Error('No intermediate animation frame: ' + JSON.stringify({original, animationFrames}));
      if (!panel.isVisible() || panel.getBounds().height !== compactSize.height) throw new Error('Collapse failed');
      fs.writeFileSync(path.join(__dirname, 'artifacts', 'compact.png'), (await panel.webContents.capturePage()).toPNG());
      const iconAfter = await iconPosition();
      if (JSON.stringify(iconBefore) !== JSON.stringify(iconAfter)) throw new Error('Header icon moved');
      await openPanel();
      if (JSON.stringify(panel.getBounds()) !== JSON.stringify(original)) throw new Error('Expanded bounds were not restored: ' + JSON.stringify({original, actual: panel.getBounds(), expandedSize}));
      const closing = collapse(); await new Promise(resolve => setTimeout(resolve, 65));
      await openPanel(); await closing;
      if (JSON.stringify(panel.getBounds()) !== JSON.stringify(original)) throw new Error('Rapid toggle failed');
      await panel.webContents.executeJavaScript(`document.querySelector('#overlay-toggle').click()`);
      await new Promise(resolve => setTimeout(resolve, 700));
      if (expanded || panel.getBounds().height !== compactSize.height) throw new Error('Icon did not collapse chat');
      await panel.webContents.executeJavaScript(`document.querySelector('#overlay-toggle').click()`);
      await new Promise(resolve => setTimeout(resolve, 700));
      if (!expanded || JSON.stringify(panel.getBounds()) !== JSON.stringify(original)) throw new Error('Icon did not open chat');
      nativeDialogOpen = true; await collapseOnBlur();
      if (!expanded) throw new Error('Dialog incorrectly collapsed panel');
      nativeDialogOpen = false; await collapseOnBlur();
      if (expanded || panel.getBounds().height !== compactSize.height) throw new Error('Blur did not collapse panel');
      await openPanel();
      await panel.webContents.executeJavaScript(`document.querySelector('#prompt').value = 'Unsent draft'; attachments = [{ type: 'image/png', data: 'draft-image' }];`);
      panel.webContents.send('claude-event', { type: 'history', data: { title: 'Updated Desktop history', context: null, messages: [{ id: 'synced-history', role: 'Claude', text: 'New Desktop response' }] } });
      await new Promise(resolve => setTimeout(resolve, 100));
      const syncResult = await panel.webContents.executeJavaScript(`document.querySelector('#prompt').value === 'Unsent draft' && attachments[0]?.data === 'draft-image' && document.querySelector('#messages').textContent.includes('New Desktop response')`);
      if (!syncResult) throw new Error('History refresh lost composer draft or failed to render');
      fs.writeFileSync(path.join(__dirname, 'artifacts', 'smoke.json'), JSON.stringify({ passed: true, ...result, historyPerformance }, null, 2));
      app.exit(0);
    } catch (error) { console.error(error); app.exit(1); }
  }
});
ipcMain.handle('action', async (event, action, value) => {
  if (![panel, toast].some(w => w && w.webContents === event.sender)) return;
  if (action === 'open-link' && event.sender === panel?.webContents) {
    try {
      const url = new URL(value);
      if (!['https:', 'http:'].includes(url.protocol)) return { error: 'Unsupported link' };
      await shell.openExternal(url.href); return { ok: true };
    } catch { return { error: 'Could not open link' }; }
  }
  if (action === 'copy-code' && event.sender === panel?.webContents) {
    if (typeof value !== 'string' || value.length > 2 * 1024 * 1024) return { error: 'Code is too large to copy.' };
    if (smoke) smokeCopiedCode = value;
    else clipboard.writeText(value);
    return { ok: true };
  }
  if (action === 'capture-game' && event.sender === panel?.webContents) {
    if (capturing || transitioning || nativeDialogOpen) return { error: 'Wait a moment and try capturing again.' };
    capturing = true;
    try {
      panel.hide(); toast.hide();
      await new Promise(resolve => setTimeout(resolve, 200));
      return { image: await captureGame({ desktopCapturer, displays: screen.getAllDisplays() }) };
    } catch (error) { return { error: error.message }; }
    finally {
      if (!panel.isDestroyed()) { panel.show(); panel.focus(); }
      capturing = false;
    }
  }
  if (action === 'open') openPanel();
  if (action === 'collapse') collapse();
  if (action === 'toggle') toggle();
  if (action === 'maximize' && event.sender === panel?.webContents) setWindowMode(windowMode === 'normal' ? 'maximized' : 'normal');
  if (action === 'fullscreen' && event.sender === panel?.webContents) setWindowMode(windowMode === 'fullscreen' ? 'normal' : 'fullscreen');
  if (action === 'exit-fullscreen' && event.sender === panel?.webContents && windowMode === 'fullscreen') setWindowMode('normal');
  if (action === 'quit') app.quit();
  if (action === 'check-updates') return updates?.check();
  if (action === 'install-update') return updates?.install();
  if (action === 'opacity' && Number.isFinite(value)) { panel.setOpacity(Math.max(.8, Math.min(1, value))); if (!smoke) preferences.update({ opacity: value }); }
  if (action === 'sound' && typeof value === 'boolean' && !smoke) preferences.update({ sound: value });
  if (action === 'show-thinking' && typeof value === 'boolean' && !smoke) preferences.update({ showThinking: value });
  if (action === 'settings-view' && typeof value === 'boolean' && !smoke) preferences.update({ settingsOpen: value });
  if (action === 'shortcut') return bindShortcut(value);
  if (action === 'status' && ['Ready', 'Working', 'Finished'].includes(value)) { state = value; sendState(); }
  if (action === 'notify' && !expanded) {
    const bounds = panel.getBounds(), work = screen.getDisplayMatching(bounds).workArea;
    toast.setPosition(Math.max(work.x, Math.min(bounds.x, work.x + work.width - 340)), Math.min(bounds.y + compactSize.height + 10, work.y + work.height - 96));
    toast.showInactive(); clearTimeout(timer); timer = setTimeout(() => toast.hide(), 6500);
  }
});
ipcMain.handle('claude', async (event, action, value) => {
  if (event.sender !== panel?.webContents || !claude) return { error: 'Claude is not available.' };
  try {
    if (action === 'snapshot') return claude.snapshot();
    if (action === 'permission-mode') return claude.setPermissionMode(value);
    if (action === 'model') return claude.setModel(value);
    if (action === 'list-conversations') return { conversations: await claude.listConversations() };
    if (action === 'load-conversation') await claude.loadConversation(value);
    if (action === 'connect') return await claude.connect();
    if (action === 'project' || action === 'new-chat') throw new Error('Create and pin conversations in Claude Desktop, then select them here.');
    if (action === 'send') await claude.send(value);
    if (action === 'usage') return await claude.usage();
    if (action === 'compact') { void claude.compact().catch(error => claudeEvent('failure', { text: error.message })); }
    if (action === 'remove-queued') claude.removeQueued(value);
    if (action === 'edit-queued') claude.beginQueuedEdit(value);
    if (action === 'save-queued') await claude.finishQueuedEdit(value);
    if (action === 'send-queued-now') await claude.sendQueuedNow(value);
    if (action === 'stop') claude.stop();
    if (action === 'respond') claude.respond(value);
    return { ok: true };
  } catch (error) { return { error: error.message }; }
});
let quitting = false;
app.on('before-quit', event => {
  clearTimeout(savePositionTimer); saveWindow();
  if (claude?.busy) {
    event.preventDefault(); if (quitting) return;
    quitting = true; claude.stop();
    Promise.resolve(claude.running).finally(() => app.quit());
  }
});
app.on('will-quit', () => { updates?.dispose(); globalShortcut.unregisterAll(); clearTimeout(timer); clearInterval(transitionTimer); });
app.on('window-all-closed', () => app.quit());



