const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { latestContext, withContextLimit } = require('./context-usage');
const { AttachmentStore } = require('./attachment-store');

class ClaudeService {
  constructor({ storage, emit, queryFactory, sessionReader, pinnedProvider, showThinking = () => false }) {
    this.pinnedProvider = pinnedProvider || null;
    this.sessionReader = sessionReader;
    this.showThinking = showThinking;
    this.storage = storage; this.emit = emit; this.queryFactory = queryFactory;
    this.attachments = new AttachmentStore(storage);
    this.data = { project: null, sessions: {} }; this.pending = new Map(); this.busy = false;
    this.connection = { ready: false, detail: 'Checking Claude Code…' };
    try { if (fs.existsSync(storage)) this.data = JSON.parse(fs.readFileSync(storage, 'utf8')); } catch { this.storageError = 'Saved conversation could not be loaded. Existing history has been left untouched.'; this.connection.detail = this.storageError; }
    if (!this.data.sessions || typeof this.data.sessions !== 'object') this.data = { project: null, sessions: {} };
    if (!this.storageError) {
      try { if (this.externalizeImages()) this.save(); }
      catch (error) { this.storageError = `Could not migrate saved screenshots: ${error.message}`; this.connection.detail = this.storageError; }
    }
  }
  modelState() { return { model: this.data.model || 'default', activeModel: this.session()?.activeModel || null }; }
  async usage() {
    if (this.usagePending) return this.usagePending;
    if (this.usageCache && Date.now() - this.usageCache.fetchedAt < 60000) return this.usageCache;
    this.usagePending = this.fetchUsage();
    try { return await this.usagePending; } finally { this.usagePending = null; }
  }
  async fetchUsage() {
    if (!this.connection.ready) throw new Error('Reconnect Claude to check usage.');
    let stream = this.activeQuery, release, timer, draining;
    const owned = !stream;
    try {
      if (owned) {
        const query = this.queryFactory || (await import('@anthropic-ai/claude-agent-sdk')).query;
        const wait = new Promise(resolve => { release = resolve; });
        stream = query({ prompt: (async function* () { await wait; })(), options: {
          cwd: this.data.project || os.homedir(), pathToClaudeCodeExecutable: this.executable,
          persistSession: false, tools: [], settingSources: [], strictMcpConfig: true, mcpServers: {},
          spawnClaudeCodeProcess: opts => spawn(opts.command, opts.args, { cwd: opts.cwd, env: opts.env, signal: opts.signal, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
        } });
        draining = (async () => { for await (const event of stream) { /* No model prompt is sent. */ } })().catch(() => {});
      }
      const method = stream.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
      if (!method) throw new Error('Update Claude Code to view account usage.');
      const report = await Promise.race([method.call(stream, { skipBehaviors: true }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Usage lookup timed out. Try again.')), 15000); })]);
      const limits = report.rate_limits, rows = [];
      const add = (label, value) => { if (value && Number.isFinite(value.utilization)) rows.push({ label, used: value.utilization, resetsAt: value.resets_at }); };
      add('5-hour limit', limits?.five_hour); add('Weekly · all models', limits?.seven_day);
      if (limits?.model_scoped?.length) for (const row of limits.model_scoped) add(`Weekly · ${row.display_name}`, row);
      else { add('Weekly · Opus', limits?.seven_day_opus); add('Weekly · Sonnet', limits?.seven_day_sonnet); }
      this.usageCache = { rows, plan: report.subscription_type, fetchedAt: Date.now() };
      return this.usageCache;
    } finally { clearTimeout(timer); if (owned) { release?.(); stream?.close?.(); } }
  }
  async compact() {
    if (this.busy || this.promoting || this.maintaining || this.queue().length) throw new Error('Finish the current task and queued messages before compacting.');
    if (!this.session()?.sessionId) throw new Error('Start a conversation before compacting.');
    this.maintaining = true;
    let success = false;
    const token = this.stopToken;
    try {
      await this.send('Prepare detailed handoff notes in your response before this conversation is compacted. Preserve the goal, user preferences, decisions, changed files, tests and results, unresolved problems, and exact next steps. Distinguish completed work from proposed work. Do not edit files or start new work.', true);
      if (!await this.running || token !== this.stopToken) return;
      await this.send('/compact Preserve the detailed handoff notes, user requirements, decisions, changed files, test results, outstanding problems, and next steps.', true);
      success = await this.running;
      if (success) this.emit('complete', { text: 'Handoff notes prepared and conversation compacted.' });
    } finally {
      this.maintaining = false; this.emit('busy', false);
      if (success && token === this.stopToken) await this.drainQueue();
    }
  }
  queue() { return this.session()?.queued || []; }
  queueChanged() { this.emit('queue', this.queue()); }
  beginQueuedEdit(id) {
    if (this.editingQueued && this.editingQueued !== id) throw new Error('Save or cancel your current edit first.');
    if (this.promoting || !this.queue().some(item => item.id === id)) throw new Error('That message is no longer available to edit.');
    this.editingQueued = id;
  }
  async finishQueuedEdit({ id, text, cancel = false }) {
    const item = this.queue().find(item => item.id === id);
    if (!item || this.editingQueued !== id) throw new Error('That message is no longer being edited.');
    if (!cancel) {
      if (typeof text !== 'string' || text.length > 12000 || (!text.trim() && !item.images?.length)) throw new Error('Enter a message (up to 12,000 characters).');
      const previous = item.text; item.text = text.trim();
      try { this.save(); } catch (error) { item.text = previous; throw error; }
    }
    this.editingQueued = null; this.queueChanged();
    await this.drainQueue();
  }
  removeQueued(id) {
    if (this.promoting) throw new Error('Wait for the message to start.');
    const queue = this.queue(), index = queue.findIndex(item => item.id === id);
    if (index < 0) throw new Error('That message is no longer queued.');
    queue.splice(index, 1); this.save(); this.queueChanged();
  }
  async sendQueuedNow(id) {
    if (this.promoting) throw new Error('A message is already being sent.');
    if (!this.queue().some(item => item.id === id)) throw new Error('That message is no longer queued.');
    this.promoting = true;
    this.stop();
    const token = this.stopToken;
    try {
      await this.running;
      if (token !== this.stopToken) return;
      const index = this.queue().findIndex(item => item.id === id);
      if (index < 0) return;
      const [item] = this.queue().splice(index, 1); this.queue().unshift(item);
      this.promoting = false;
      await this.drainQueue();
    } finally { this.promoting = false; }
  }
  async drainQueue() {
    if (this.busy || this.promoting || !this.queue().length || this.queue()[0].id === this.editingQueued) return;
    const item = this.queue().shift();
    try { await this.send(item, true); }
    catch (error) { this.queue().unshift(item); this.save(); this.emit('failure', { text: error.message }); }
    this.queueChanged();
  }
  setModel(model) {
    if (this.busy || this.promoting || this.syncing) throw new Error('Stop the current task before changing model.');
    if (!['default', 'claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'].includes(model)) throw new Error('Unknown model.');
    this.data.model = model;
    for (const session of Object.values(this.data.sessions)) session.activeModel = null;
    this.save();
    this.emit('model', this.modelState());
    return this.modelState();
  }
  reportModel(model) {
    if (typeof model !== 'string' || !model || model === '<synthetic>') return;
    this.session().activeModel = model;
    this.emit('model', this.modelState());
  }
  selectedPin() {
    const session = this.session();
    return this.pinnedProvider?.().find(pin => session?.desktopSessionId ? pin.id === session.desktopSessionId : pin.cliId === session?.sessionId || pin.priorIds.includes(session?.sessionId));
  }
  snapshot() {
    let visible = true;
    if (this.pinnedProvider) { try { const pin = this.selectedPin(); visible = !!pin && pin.cliId === this.session()?.sessionId; } catch { visible = false; } }
    return { ...this.modelState(), queued: visible ? this.queue() : [], context: visible ? this.session()?.context || null : null, permissionMode: this.data.permissionMode || 'default', project: visible ? this.data.project : null, title: visible ? this.session()?.title : null, messages: visible ? this.session()?.messages || [] : [], connection: this.connection, busy: this.busy || !!this.promoting };
  }
  setPermissionMode(mode) {
    if (this.busy || this.promoting || this.syncing) throw new Error('Stop the current task before changing permission mode.');
    if (!['default', 'auto', 'acceptEdits', 'plan', 'bypassPermissions'].includes(mode)) throw new Error('Unknown permission mode.');
    this.data.permissionMode = mode; this.save();
    return { mode };
  }
  async listConversations() {
    if (this.pinnedProvider) return this.pinnedProvider();
    const { listSessions } = await import('@anthropic-ai/claude-agent-sdk');
    const sessions = await listSessions({ limit: 200 });
    return sessions.filter(item => item.cwd).map(item => ({ id: item.sessionId, title: item.customTitle || item.summary || 'Untitled conversation', project: item.cwd, modified: item.lastModified }));
  }
  async refreshHistory() {
    const session = this.session();
    const pin = this.pinnedProvider ? this.selectedPin() : null;
    if (this.pinnedProvider && !pin) throw new Error('Select a pinned Claude Desktop conversation in Settings.');
    const project = pin?.project || this.data.project, id = pin?.cliId || session?.sessionId;
    if (!id || (this.queryFactory && !this.sessionReader)) return;
    if (this.syncing) throw new Error('Conversation history is still syncing. Try again in a moment.');
    this.syncing = true;
    try {
      const reader = this.sessionReader || await import('@anthropic-ai/claude-agent-sdk');
      const info = await reader.getSessionInfo(id, { dir: project });
      if (!info) throw new Error('The saved Claude Code thread could not be found. Load the correct conversation in Settings.');
      const history = await reader.getSessionMessages(id, { dir: project });
      if (!history.length) throw new Error('Claude Code returned an empty history. Sending has been stopped to protect this conversation.');
      if (this.session() !== session) throw new Error('The conversation changed while syncing. Please send again.');
      if (pin && !this.pinnedProvider().some(current => current.id === pin.id && current.cliId === id)) throw new Error('Desktop changed this thread while syncing. Please try again.');
      const messages = this.historyMessages(history);
      let context = null;
      for (const item of history) if (item.type === 'assistant' && !item.parent_tool_use_id) context = latestContext(item.message, context);
      const previous = { ...session };
      if (fs.existsSync(this.storage) && !fs.existsSync(this.storage + '.sync-backup')) fs.copyFileSync(this.storage, this.storage + '.sync-backup');
      if (project !== this.data.project && fs.realpathSync(project) !== fs.realpathSync(this.data.project)) throw new Error('Desktop changed the project folder. Reselect the pinned conversation.');
      Object.assign(session, { messages, context, sessionId: id, ...(pin ? { desktopSessionId: pin.id } : {}), title: pin?.title || info.customTitle || info.summary || session.title });
      try { this.save(); } catch (error) { Object.assign(session, previous); throw error; }
      this.emit('history', this.snapshot());
    } finally { this.syncing = false; }
  }
  historyMessages(history) {
    return history.filter(item => !item.parent_tool_use_id && ['user', 'assistant'].includes(item.type)).flatMap(item => {
      const content = item.message?.content;
      const thinking = item.type === 'assistant' && Array.isArray(content) ? content.filter(block => block.type === 'thinking' && typeof block.thinking === 'string').map(block => block.thinking).join('\n\n') : '';
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(block => block.type === 'text').map(block => block.text).join('\n') : '';
      const images = Array.isArray(content) ? content.filter(block => block.type === 'image' && block.source?.type === 'base64' && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(block.source.media_type)).map(block => ({ type: block.source.media_type, data: block.source.data })) : [];
      return text || images.length || thinking ? [{ id: item.uuid, role: item.type === 'user' ? 'You' : 'Claude', text, images, thinking, time: item.timestamp || null }] : [];
    });
  }
  async loadConversation(id) {
    if (this.busy || this.promoting || this.syncing) throw new Error('Stop the current task before loading a conversation.');
    const pin = this.pinnedProvider ? this.pinnedProvider().find(item => item.id === id) : null;
    if (this.pinnedProvider && !pin) throw new Error('Only pinned Claude Desktop conversations can be opened.');
    if (pin) id = pin.cliId;
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Select a valid conversation.');
    const { getSessionInfo, getSessionMessages } = this.sessionReader || await import('@anthropic-ai/claude-agent-sdk');
    const info = await getSessionInfo(id, pin ? { dir: pin.project } : undefined);
    if (!info?.cwd || !fs.existsSync(info.cwd)) throw new Error('The conversation’s project folder is no longer available.');
    const history = await getSessionMessages(id, pin ? { dir: pin.project } : undefined);
    if (pin && !history.length) throw new Error('The pinned conversation history is unavailable.');
    if (pin && !this.pinnedProvider().some(item => item.id === pin.id && item.cliId === id)) throw new Error('Desktop changed the selected thread. Please select it again.');
    const messages = this.historyMessages(history);
    if (this.busy || this.promoting || this.syncing) throw new Error('Stop the current task before loading a conversation.');
    const project = fs.realpathSync(info.cwd);
    this.editingQueued = null;
    this.data.project = project;
    let context = this.data.sessions[project]?.sessionId === id ? this.data.sessions[project].context : null;
    for (const item of history) if (item.type === 'assistant' && !item.parent_tool_use_id) context = latestContext(item.message, context);
    this.data.sessions[project] = { sessionId: id, ...(pin ? { desktopSessionId: pin.id } : {}), title: pin?.title || info.customTitle || info.summary, messages, context, queued: this.data.sessions[project]?.sessionId === id ? this.data.sessions[project].queued || [] : [] };
    if (pin && this.authReady) this.connection = { ready: true, detail: 'Claude Code connected' };
    this.save(); this.emit('snapshot', this.snapshot());
  }
  session() { return this.data.sessions[this.data.project]; }
  externalizeImages() {
    let changed = false;
    for (const session of Object.values(this.data.sessions)) {
      for (const item of [...(session.messages || []), ...(session.queued || [])]) {
        if (item.images?.some(image => image.data)) {
          item.images = item.images.map(image => this.attachments.store(image)); changed = true;
        }
      }
    }
    if (changed && fs.existsSync(this.storage) && !fs.existsSync(this.storage + '.legacy-backup')) fs.copyFileSync(this.storage, this.storage + '.legacy-backup');
    return changed;
  }
  save() {
    if (this.storageError) throw new Error(this.storageError);
    fs.mkdirSync(path.dirname(this.storage), { recursive: true });
    this.externalizeImages();
    fs.writeFileSync(this.storage + '.tmp', JSON.stringify(this.data));
    fs.renameSync(this.storage + '.tmp', this.storage);
  }
  async connect() {
    if (this.storageError) { this.connection = { ready: false, detail: this.storageError }; this.emit('snapshot', this.snapshot()); return this.connection; }
    this.executable = require('./platform-paths').claudeExecutable();
    try {
      if (!fs.existsSync(this.executable)) this.executable = 'claude';
      const { stdout } = await promisify(execFile)(this.executable, ['auth', 'status'], { windowsHide: true, timeout: 15000 });
      const auth = JSON.parse(stdout);
      this.authReady = !!auth.loggedIn;
      this.connection = { ready: !!auth.loggedIn, detail: auth.loggedIn ? 'Claude Code connected' : 'Run claude auth login in a terminal, then reconnect.' };
    } catch { this.connection = { ready: false, detail: 'Could not connect. Install Claude Code and run claude auth login, then reconnect.' }; }
    if (this.connection.ready) {
      try { await this.refreshHistory(); }
      catch (error) { this.connection = { ready: false, detail: `Could not sync conversation: ${error.message}` }; }
    }
    this.emit('snapshot', this.snapshot()); return this.connection;
  }
  selectProject(project) {
    if (this.pinnedProvider) throw new Error('Choose a pinned conversation instead of a folder.');
    if (this.busy || this.promoting || this.syncing) throw new Error('Stop the current task before switching addons.');
    if (!fs.statSync(project).isDirectory()) throw new Error('Select an addon folder.');
    this.editingQueued = null;
    this.data.project = fs.realpathSync(project);
    this.data.sessions[this.data.project] ||= { messages: [], sessionId: null };
    this.save(); this.emit('snapshot', this.snapshot());
  }
  newChat() {
    if (this.pinnedProvider) throw new Error('Create and pin conversations in Claude Desktop.');
    if (this.busy || this.promoting || this.syncing) throw new Error('Stop the current task before starting a new chat.');
    if (!this.session()) return;
    this.editingQueued = null;
    this.data.sessions[this.data.project] = { messages: [], sessionId: null };
    this.save(); this.emit('snapshot', this.snapshot());
  }
  add(role, text, id = randomUUID(), images = []) {
    const item = { id, role, text, time: Date.now(), ...(images.length ? { images } : {}) };
    this.session().messages.push(item); this.emit('message', item); return item;
  }
  async permission(tool, input, { signal }) {
    if (signal.aborted || this.controller?.signal.aborted) return { behavior: 'deny', message: 'Task stopped.' };
    const id = randomUUID();
    return new Promise(resolve => {
      const finish = result => { signal.removeEventListener('abort', abort); this.pending.delete(id); this.emit('permission-resolved', { id }); resolve(result); };
      const abort = () => finish({ behavior: 'deny', message: 'Task stopped.' });
      this.pending.set(id, { tool, input, finish }); signal.addEventListener('abort', abort, { once: true });
      this.emit('permission', { id, tool, input });
    });
  }
  respond({ id, allow, answers }) {
    const request = this.pending.get(id); if (!request) throw new Error('This request is no longer waiting.');
    let input = request.input;
    if (allow && request.tool === 'AskUserQuestion') {
      if (!answers || !request.input.questions.every(q => typeof answers[q.question] === 'string' && answers[q.question].trim())) throw new Error('Answer each question first.');
      input = { ...input, answers };
    }
    request.finish(allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'The user declined this action in ClaudeHUD.' });
  }
  stop() {
    this.stopToken = (this.stopToken || 0) + 1;
    for (const request of [...this.pending.values()]) request.finish({ behavior: 'deny', message: 'Task stopped by user.' });
    this.controller?.abort();
  }
  async send(payload, fromQueue = false) {
    const text = typeof payload === 'string' ? payload : payload?.text;
    let images = typeof payload === 'string' ? [] : payload?.images || [];
    if (fromQueue && Array.isArray(images)) images = images.map(image => this.attachments.hydrate(image));
    if (!this.connection.ready) throw new Error(this.connection.detail);
    if (!this.session()) throw new Error('Choose your addon folder first.');
    if (typeof text !== 'string' || text.length > 12000 || !Array.isArray(images) || images.length > 4 || (!text.trim() && !images.length)) throw new Error('Add a message or up to four screenshots. Text is limited to 12,000 characters.');
    const validated = images.map(image => {
      if (!image || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image.type) || typeof image.data !== 'string' || image.data.length > 40 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) throw new Error('Unsupported image attachment. Paste PNG, JPEG, WebP, or GIF (up to 30 MB each).');
      const bytes = Buffer.from(image.data, 'base64');
      // Claude Code prepares large images for the API; this is our input file limit.
      if (!bytes.length || bytes.length > 30 * 1024 * 1024) throw new Error('Each image must be 30 MB or smaller.');
      const valid = image.type === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : image.type === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 : image.type === 'image/gif' ? /^GIF8[79]a/.test(bytes.toString('ascii', 0, 6)) : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
      if (!valid) throw new Error('The pasted image is not a valid supported image file.');
      return { type: image.type, data: image.data };
    });
    if (!fromQueue && (this.busy || this.promoting || this.maintaining || this.queue().length)) {
      const queue = this.session().queued ||= [];
      if (queue.length >= 10) throw new Error('The queue is full. Remove a queued message or wait for Claude.');
      const item = { id: randomUUID(), text: text.trim(), images: validated.map(image => this.attachments.store(image)) };
      queue.push(item);
      try { this.save(); } catch (error) { queue.pop(); throw error; }
      this.queueChanged(); return { queued: true };
    }
    const item = { id: randomUUID(), role: 'You', text: text.trim(), time: Date.now(), images: validated.map(image => this.attachments.store(image)) };
    this.busy = true; this.controller = new AbortController();
    try {
      await this.refreshHistory();
      if (this.controller.signal.aborted) throw new Error('Message stopped before sending.');
    } catch (error) { this.busy = false; this.controller = null; this.emit('busy', false); throw error; }
    this.session().messages.push(item);
    try { this.save(); } catch (error) { this.session().messages.pop(); this.busy = false; this.controller = null; throw error; }
    this.emit('message', item);
    this.emit('busy', true);
    const content = validated.map(image => ({ type: 'image', source: { type: 'base64', media_type: image.type, data: image.data } }));
    if (text.trim()) content.push({ type: 'text', text: text.trim() });
    const prompt = validated.length ? (async function* () { yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: '' }; })() : text.trim();
    this.running = this.run(prompt);
  }
  async run(prompt) {
    let stream, current, finalReceived = false, succeeded = false, compacted = false;
    try {
      const query = this.queryFactory || (await import('@anthropic-ai/claude-agent-sdk')).query;
      const options = {
        forkSession: false,
        cwd: this.data.project, pathToClaudeCodeExecutable: this.executable,
        abortController: this.controller, includePartialMessages: true,
        permissionMode: this.data.permissionMode || 'default',
        allowDangerouslySkipPermissions: this.data.permissionMode === 'bypassPermissions',
        settingSources: ['project'], strictMcpConfig: true, mcpServers: {},
        tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'WebFetch', 'WebSearch', 'AskUserQuestion', 'ExitPlanMode'],
        systemPrompt: { type: 'preset', preset: 'claude_code', append: 'You are working through ClaudeHUD, a compact overlay used while playing World of Warcraft. Help develop addons in the selected workspace. Keep progress updates concise. Summarize changed files and any required in-game /reload at completion.' },
        canUseTool: this.permission.bind(this),
        hooks: { PreToolUse: [{ hooks: [async input => (this.data.permissionMode || 'default') === 'default' && ['Write', 'Edit', 'Bash'].includes(input.tool_name) ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'Confirm this action in ClaudeHUD.' } } : {}] }] },
        spawnClaudeCodeProcess: opts => spawn(opts.command, opts.args, { cwd: opts.cwd, env: opts.env, signal: opts.signal, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      };
      if (this.session().sessionId) options.resume = this.session().sessionId;
      if (this.data.model && this.data.model !== 'default') options.model = this.data.model;
      if (this.showThinking()) options.thinking = { type: 'enabled', display: 'summarized' };
      stream = query({ prompt, options });
      this.activeQuery = stream;
      for await (const event of stream) {
        if (this.pinnedProvider && event.session_id && event.session_id !== options.resume) throw new Error('Claude Code returned a different session. Stopped to avoid continuing a fork.');
        if (event.session_id) this.session().sessionId = event.session_id;
        if (event.type === 'system' && event.subtype === 'init') this.reportModel(event.model);
        if (event.type === 'system' && event.subtype === 'compact_boundary') {
          compacted = true;
          this.session().context = null; this.emit('context', null);
        }
        if (event.type === 'stream_event') {
          const part = event.event;
          if (part.type === 'message_start') current = null;
          if (!event.parent_tool_use_id && part.type === 'content_block_delta' && part.delta.type === 'thinking_delta' && part.delta.thinking) {
            current ||= this.add('Claude', ''); current.thinking = (current.thinking || '') + part.delta.thinking;
            this.emit('message', { ...current });
          }
          if (part.type === 'content_block_delta' && part.delta.type === 'text_delta' && part.delta.text) {
            current ||= this.add('Claude', ''); current.text += part.delta.text;
            this.emit('message', { ...current });
          }
        }
        if (event.type === 'assistant') {
          if (!event.parent_tool_use_id) {
            this.reportModel(event.message.model);
            this.session().context = latestContext(event.message, this.session().context);
            this.emit('context', this.session().context);
          }
          const text = event.message.content.filter(x => x.type === 'text').map(x => x.text).join('\n');
          const thinking = !event.parent_tool_use_id ? event.message.content.filter(x => x.type === 'thinking' && typeof x.thinking === 'string').map(x => x.thinking).join('\n\n') : '';
          if (text || thinking || current) {
            current ||= this.add('Claude', text);
            current.text = text;
            if (thinking) current.thinking = thinking;
            this.emit('message', { ...current });
          }
          current = null;
          for (const block of event.message.content) if (block.type === 'tool_use') this.emit('activity', `${block.name}${block.input?.file_path ? ': ' + path.basename(block.input.file_path) : ''}`);
        }
        if (event.type === 'result') {
          this.session().context = withContextLimit(this.session().context, event.modelUsage);
          this.emit('context', this.session().context);
          finalReceived = true;
          if (event.is_error || event.subtype !== 'success') throw new Error(event.errors?.join('\n') || event.result || 'Claude could not finish this task.');
          succeeded = true;
          if (!this.queue().length && !this.maintaining) this.emit('complete', { text: event.result || 'Claude finished.' });
        }
      }
      if (!finalReceived && !this.controller.signal.aborted) throw new Error('Claude disconnected before finishing. You can retry your message.');
      if (typeof prompt === 'string' && prompt.startsWith('/compact ') && !compacted && !this.controller.signal.aborted) throw new Error('Claude Code did not confirm compaction. Your notes are preserved; the context was not cleared.');
    } catch (error) {
      succeeded = false;
      const stopped = this.controller.signal.aborted;
      this.add('System', stopped ? 'Task stopped. Changes already made remain in your addon folder.' : `Claude error: ${error.message}`);
      this.emit(stopped ? 'stopped' : 'failure', { text: stopped ? 'Task stopped' : error.message });
    } finally {
      const continueQueue = succeeded && !this.controller.signal.aborted && !this.promoting && !this.maintaining;
      this.activeQuery = null;
      try { stream?.close?.(); } catch { /* The process may already have exited. */ }
      for (const request of [...this.pending.values()]) request.finish({ behavior: 'deny', message: 'Task ended.' });
      this.busy = false; this.controller = null;
      try { this.save(); } catch (error) { this.emit('failure', { text: `Could not save conversation: ${error.message}` }); }
      this.emit('busy', !!this.maintaining);
      if (continueQueue) await this.drainQueue();
    }
    return succeeded;
  }
}
module.exports = { ClaudeService };

