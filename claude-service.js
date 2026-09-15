const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');

class ClaudeService {
  constructor({ storage, emit, queryFactory }) {
    this.storage = storage; this.emit = emit; this.queryFactory = queryFactory;
    this.data = { project: null, sessions: {} }; this.pending = new Map(); this.busy = false;
    this.connection = { ready: false, detail: 'Checking Claude Code…' };
    try { if (fs.existsSync(storage)) this.data = JSON.parse(fs.readFileSync(storage, 'utf8')); } catch { this.connection.detail = 'Saved conversation could not be loaded.'; }
    if (!this.data.sessions || typeof this.data.sessions !== 'object') this.data = { project: null, sessions: {} };
  }
  snapshot() { return { permissionMode: this.data.permissionMode || 'default', project: this.data.project, title: this.session()?.title, messages: this.session()?.messages || [], connection: this.connection, busy: this.busy }; }
  setPermissionMode(mode) {
    if (this.busy) throw new Error('Stop the current task before changing permission mode.');
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
    if (this.busy) throw new Error('Stop the current task before loading a conversation.');
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Select a valid conversation.');
    const { getSessionInfo, getSessionMessages } = await import('@anthropic-ai/claude-agent-sdk');
    const info = await getSessionInfo(id);
    if (!info?.cwd || !fs.existsSync(info.cwd)) throw new Error('The conversation’s project folder is no longer available.');
    const history = await getSessionMessages(id);
    const messages = history.filter(item => !item.parent_tool_use_id && ['user', 'assistant'].includes(item.type)).flatMap(item => {
      const content = item.message?.content;
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(block => block.type === 'text').map(block => block.text).join('\n') : '';
      return text ? [{ id: item.uuid, role: item.type === 'user' ? 'You' : 'Claude', text, time: null }] : [];
    });
    if (this.busy) throw new Error('Stop the current task before loading a conversation.');
    const project = fs.realpathSync(info.cwd);
    this.data.project = project;
    this.data.sessions[project] = { sessionId: id, title: info.customTitle || info.summary, messages };
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
    if (this.busy) throw new Error('Stop the current task before switching addons.');
    if (!fs.statSync(project).isDirectory()) throw new Error('Select an addon folder.');
    this.data.project = fs.realpathSync(project);
    this.data.sessions[this.data.project] ||= { messages: [], sessionId: null };
    this.save(); this.emit('snapshot', this.snapshot());
  }
  newChat() {
    if (this.busy) throw new Error('Stop the current task before starting a new chat.');
    if (!this.session()) return;
    this.data.sessions[this.data.project] = { messages: [], sessionId: null };
    this.save(); this.emit('snapshot', this.snapshot());
  }
  add(role, text, id = randomUUID()) {
    const item = { id, role, text, time: Date.now() };
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
    for (const request of [...this.pending.values()]) request.finish({ behavior: 'deny', message: 'Task stopped by user.' });
    this.controller?.abort();
  }
  async send(text) {
    if (this.busy) throw new Error('Claude is already working.');
    if (!this.connection.ready) throw new Error(this.connection.detail);
    if (!this.session()) throw new Error('Choose your addon folder first.');
    if (typeof text !== 'string' || !text.trim() || text.length > 12000) throw new Error('Enter a message up to 12,000 characters.');
    this.busy = true; this.controller = new AbortController();
    this.add('You', text.trim());
    try { this.save(); } catch (error) { this.busy = false; this.controller = null; throw error; }
    this.emit('busy', true);
    this.running = this.run(text.trim());
  }
  async run(prompt) {
    let stream, current, finalReceived = false;
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
      stream = query({ prompt, options });
      for await (const event of stream) {
        if (event.session_id) this.session().sessionId = event.session_id;
        if (event.type === 'stream_event') {
          const part = event.event;
          if (part.type === 'message_start') current = null;
          if (part.type === 'content_block_delta' && part.delta.type === 'text_delta') {
            current ||= this.add('Claude', ''); current.text += part.delta.text;
            this.emit('message', { ...current });
          }
        }
        if (event.type === 'assistant') {
          const text = event.message.content.filter(x => x.type === 'text').map(x => x.text).join('\n');
          if (text) { if (current) { current.text = text; this.emit('message', { ...current }); } else this.add('Claude', text); }
          current = null;
          for (const block of event.message.content) if (block.type === 'tool_use') this.emit('activity', `${block.name}${block.input?.file_path ? ': ' + path.basename(block.input.file_path) : ''}`);
        }
        if (event.type === 'result') {
          finalReceived = true;
          if (event.is_error || event.subtype !== 'success') throw new Error(event.errors?.join('\n') || event.result || 'Claude could not finish this task.');
          this.emit('complete', { text: event.result || 'Claude finished.' });
        }
      }
      if (!finalReceived && !this.controller.signal.aborted) throw new Error('Claude disconnected before finishing. You can retry your message.');
    } catch (error) {
      const stopped = this.controller.signal.aborted;
      this.add('System', stopped ? 'Task stopped. Changes already made remain in your addon folder.' : `Claude error: ${error.message}`);
      this.emit(stopped ? 'stopped' : 'failure', { text: stopped ? 'Task stopped' : error.message });
    } finally {
      try { stream?.close?.(); } catch { /* The process may already have exited. */ }
      for (const request of [...this.pending.values()]) request.finish({ behavior: 'deny', message: 'Task ended.' });
      this.busy = false; this.controller = null;
      try { this.save(); } catch (error) { this.emit('failure', { text: `Could not save conversation: ${error.message}` }); }
      this.emit('busy', false);
    }
  }
}
module.exports = { ClaudeService };

