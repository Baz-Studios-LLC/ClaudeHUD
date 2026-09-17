const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { latestContext, withContextLimit } = require('./context-usage');

class ClaudeService {
  constructor({ storage, emit, queryFactory, showThinking = () => false }) {
    this.showThinking = showThinking;
    this.storage = storage; this.emit = emit; this.queryFactory = queryFactory;
    this.data = { project: null, sessions: {} }; this.pending = new Map(); this.busy = false;
    this.connection = { ready: false, detail: 'Checking Claude Code…' };
    try { if (fs.existsSync(storage)) this.data = JSON.parse(fs.readFileSync(storage, 'utf8')); } catch { this.connection.detail = 'Saved conversation could not be loaded.'; }
    if (!this.data.sessions || typeof this.data.sessions !== 'object') this.data = { project: null, sessions: {} };
  }
  modelState() { return { model: this.data.model || 'default', activeModel: this.session()?.activeModel || null }; }
  queue() { return this.session()?.queued || []; }
  queueChanged() { this.emit('queue', this.queue()); }
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
    if (this.busy || this.promoting || !this.queue().length) return;
    const item = this.queue().shift();
    try { await this.send(item, true); }
    catch (error) { this.queue().unshift(item); this.save(); this.emit('failure', { text: error.message }); }
    this.queueChanged();
  }
  setModel(model) {
    if (this.busy || this.promoting) throw new Error('Stop the current task before changing model.');
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
  snapshot() { return { ...this.modelState(), queued: this.queue(), context: this.session()?.context || null, permissionMode: this.data.permissionMode || 'default', project: this.data.project, title: this.session()?.title, messages: this.session()?.messages || [], connection: this.connection, busy: this.busy || !!this.promoting }; }
  setPermissionMode(mode) {
    if (this.busy || this.promoting) throw new Error('Stop the current task before changing permission mode.');
    if (!['default', 'auto', 'acceptEdits', 'plan', 'bypassPermissions'].includes(mode)) throw new Error('Unknown permission mode.');
    this.data.permissionMode = mode; this.save();
    return { mode };
  }
  async listConversations() {
    const { listSessions } = await import('@anthropic-ai/claude-agent-sdk');
    const sessions = await listSessions({ limit: 200 });
    return sessions.filter(item => item.cwd).map(item => ({ id: item.sessionId, title: item.customTitle || item.summary || 'Untitled conversation', project: item.cwd, modified: item.lastModified }));
  }
  async loadConversation(id) {
    if (this.busy || this.promoting) throw new Error('Stop the current task before loading a conversation.');
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Select a valid conversation.');
    const { getSessionInfo, getSessionMessages } = await import('@anthropic-ai/claude-agent-sdk');
    const info = await getSessionInfo(id);
    if (!info?.cwd || !fs.existsSync(info.cwd)) throw new Error('The conversation’s project folder is no longer available.');
    const history = await getSessionMessages(id);
    const messages = history.filter(item => !item.parent_tool_use_id && ['user', 'assistant'].includes(item.type)).flatMap(item => {
      const content = item.message?.content;
      const thinking = item.type === 'assistant' && Array.isArray(content) ? content.filter(block => block.type === 'thinking' && typeof block.thinking === 'string').map(block => block.thinking).join('\n\n') : '';
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(block => block.type === 'text').map(block => block.text).join('\n') : '';
      const images = Array.isArray(content) ? content.filter(block => block.type === 'image' && block.source?.type === 'base64' && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(block.source.media_type)).map(block => ({ type: block.source.media_type, data: block.source.data })) : [];
      return text || images.length || thinking ? [{ id: item.uuid, role: item.type === 'user' ? 'You' : 'Claude', text, images, thinking, time: null }] : [];
    });
    if (this.busy || this.promoting) throw new Error('Stop the current task before loading a conversation.');
    const project = fs.realpathSync(info.cwd);
    this.data.project = project;
    let context = this.data.sessions[project]?.sessionId === id ? this.data.sessions[project].context : null;
    for (const item of history) if (item.type === 'assistant' && !item.parent_tool_use_id) context = latestContext(item.message, context);
    this.data.sessions[project] = { sessionId: id, title: info.customTitle || info.summary, messages, context };
    this.save(); this.emit('snapshot', this.snapshot());
  }
  session() { return this.data.sessions[this.data.project]; }
  save() {
    fs.mkdirSync(path.dirname(this.storage), { recursive: true });
    fs.writeFileSync(this.storage + '.tmp', JSON.stringify(this.data));
    fs.renameSync(this.storage + '.tmp', this.storage);
  }
  async connect() {
    this.executable = path.join(os.homedir(), '.local', 'bin', 'claude.exe');
    try {
      if (!fs.existsSync(this.executable)) this.executable = 'claude';
      const { stdout } = await promisify(execFile)(this.executable, ['auth', 'status'], { windowsHide: true, timeout: 15000 });
      const auth = JSON.parse(stdout);
      this.connection = { ready: !!auth.loggedIn, detail: auth.loggedIn ? 'Claude Code connected' : 'Run claude auth login in a terminal, then reconnect.' };
    } catch { this.connection = { ready: false, detail: 'Could not connect. Install Claude Code and run claude auth login, then reconnect.' }; }
    this.emit('snapshot', this.snapshot()); return this.connection;
  }
  selectProject(project) {
    if (this.busy || this.promoting) throw new Error('Stop the current task before switching addons.');
    if (!fs.statSync(project).isDirectory()) throw new Error('Select an addon folder.');
    this.data.project = fs.realpathSync(project);
    this.data.sessions[this.data.project] ||= { messages: [], sessionId: null };
    this.save(); this.emit('snapshot', this.snapshot());
  }
  newChat() {
    if (this.busy || this.promoting) throw new Error('Stop the current task before starting a new chat.');
    if (!this.session()) return;
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
    const images = typeof payload === 'string' ? [] : payload?.images || [];
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
    if (!fromQueue && (this.busy || this.promoting || this.queue().length)) {
      const queue = this.session().queued ||= [];
      if (queue.length >= 10) throw new Error('The queue is full. Remove a queued message or wait for Claude.');
      const item = { id: randomUUID(), text: text.trim(), images: validated };
      queue.push(item);
      try { this.save(); } catch (error) { queue.pop(); throw error; }
      this.queueChanged(); return { queued: true };
    }
    this.busy = true; this.controller = new AbortController();
    this.add('You', text.trim(), randomUUID(), validated);
    try { this.save(); } catch (error) { this.busy = false; this.controller = null; throw error; }
    this.emit('busy', true);
    const content = validated.map(image => ({ type: 'image', source: { type: 'base64', media_type: image.type, data: image.data } }));
    if (text.trim()) content.push({ type: 'text', text: text.trim() });
    const prompt = validated.length ? (async function* () { yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: '' }; })() : text.trim();
    this.running = this.run(prompt);
  }
  async run(prompt) {
    let stream, current, finalReceived = false, succeeded = false;
    try {
      const query = this.queryFactory || (await import('@anthropic-ai/claude-agent-sdk')).query;
      const options = {
        cwd: this.data.project, pathToClaudeCodeExecutable: this.executable,
        abortController: this.controller, includePartialMessages: true,
        permissionMode: this.data.permissionMode || 'default',
        allowDangerouslySkipPermissions: this.data.permissionMode === 'bypassPermissions',
        settingSources: ['project'], strictMcpConfig: true, mcpServers: {},
        tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'AskUserQuestion', 'ExitPlanMode'],
        systemPrompt: { type: 'preset', preset: 'claude_code', append: 'You are working through ClaudeHUD, a compact overlay used while playing World of Warcraft. Help develop addons in the selected workspace. Keep progress updates concise. Summarize changed files and any required in-game /reload at completion.' },
        canUseTool: this.permission.bind(this),
        hooks: { PreToolUse: [{ hooks: [async input => (this.data.permissionMode || 'default') === 'default' && ['Write', 'Edit', 'Bash'].includes(input.tool_name) ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'Confirm this action in ClaudeHUD.' } } : {}] }] },
        spawnClaudeCodeProcess: opts => spawn(opts.command, opts.args, { cwd: opts.cwd, env: opts.env, signal: opts.signal, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      };
      if (this.session().sessionId) options.resume = this.session().sessionId;
      if (this.data.model && this.data.model !== 'default') options.model = this.data.model;
      if (this.showThinking()) options.thinking = { type: 'enabled', display: 'summarized' };
      stream = query({ prompt, options });
      for await (const event of stream) {
        if (event.session_id) this.session().sessionId = event.session_id;
        if (event.type === 'system' && event.subtype === 'init') this.reportModel(event.model);
        if (event.type === 'system' && event.subtype === 'compact_boundary') {
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
          if (!this.queue().length) this.emit('complete', { text: event.result || 'Claude finished.' });
        }
      }
      if (!finalReceived && !this.controller.signal.aborted) throw new Error('Claude disconnected before finishing. You can retry your message.');
    } catch (error) {
      succeeded = false;
      const stopped = this.controller.signal.aborted;
      this.add('System', stopped ? 'Task stopped. Changes already made remain in your addon folder.' : `Claude error: ${error.message}`);
      this.emit(stopped ? 'stopped' : 'failure', { text: stopped ? 'Task stopped' : error.message });
    } finally {
      const continueQueue = succeeded && !this.controller.signal.aborted && !this.promoting;
      try { stream?.close?.(); } catch { /* The process may already have exited. */ }
      for (const request of [...this.pending.values()]) request.finish({ behavior: 'deny', message: 'Task ended.' });
      this.busy = false; this.controller = null;
      try { this.save(); } catch (error) { this.emit('failure', { text: `Could not save conversation: ${error.message}` }); }
      this.emit('busy', false);
      if (continueQueue) await this.drainQueue();
    }
  }
}
module.exports = { ClaudeService };

