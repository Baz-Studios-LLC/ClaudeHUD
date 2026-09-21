const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ClaudeService } = require('./claude-service');
function fixture(queryFactory) {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'claudehud-test-'));
  const events = [];
  const service = new ClaudeService({ storage: path.join(root, 'state.json'), emit: (type, data) => events.push({ type, data }), queryFactory });
  service.connection = { ready: true }; service.selectProject(root); return { service, events, root };
}
async function idle(service) { for (let i = 0; i < 100 && service.busy; i++) await new Promise(r => setTimeout(r, 10)); assert.equal(service.busy, false); }
test('Desktop pins control selection and follow changing CLI IDs without creating threads', async () => {
  const calls = [];
  const { service, root } = fixture(({ options }) => (async function* () {
    calls.push(options); yield { type: 'system', session_id: options.resume };
    yield { type: 'result', subtype: 'success', result: 'Done' };
  })());
  try {
    const oldId = '11111111-1111-4111-8111-111111111111', nextId = '22222222-2222-4222-8222-222222222222';
    let pins = [{ id: 'local_33333333-3333-4333-8333-333333333333', cliId: oldId, title: 'Pinned Desktop title', project: root, priorIds: [] }];
    service.pinnedProvider = () => pins;
    service.sessionReader = {
      getSessionInfo: async id => ({ sessionId: id, cwd: root, summary: 'Code title' }),
      getSessionMessages: async id => [{ type: 'user', uuid: id, message: { content: `Current history ${id}` } }]
    };
    assert.equal(service.snapshot().messages.length, 0);
    await assert.rejects(service.loadConversation(oldId), /Only pinned/);
    await service.loadConversation(pins[0].id);
    assert.equal(service.session().desktopSessionId, pins[0].id);
    assert.equal(service.session().title, 'Pinned Desktop title');
    pins[0].cliId = nextId;
    await service.send('Continue'); await idle(service);
    assert.equal(calls[0].resume, nextId); assert.equal(calls[0].forkSession, false);
    assert.equal(service.session().sessionId, nextId);
    assert.throws(() => service.newChat(), /Create and pin/);
    assert.throws(() => service.selectProject(root), /pinned/);
    pins = [];
    assert.equal(service.snapshot().messages.length, 0);
    await assert.rejects(service.send('No longer pinned'), /Select a pinned/);
    assert.equal(calls.length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('Desktop metadata reader excludes unpinned and archived entries', () => {
  const { readDesktopPins } = require('./desktop-pins');
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'hud-pins-'));
  try {
    const folder = path.join(root, 'account', 'org'); fs.mkdirSync(folder, { recursive: true });
    for (let i = 1; i <= 3; i++) {
      const id = `${i}1111111-1111-4111-8111-111111111111`;
      fs.writeFileSync(path.join(folder, `local_${id}.json`), JSON.stringify({ sessionId: `local_${id}`, cliSessionId: id, cwd: root, title: `Thread ${i}`, isStarred: i !== 2, isArchived: i === 3 }));
    }
    assert.deepEqual(readDesktopPins(root).map(pin => pin.title), ['Thread 1']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('resume refreshes external history before sending, retains queue and blocks unreadable history', async () => {
  let started = 0;
  const { service, events, root } = fixture(() => (async function* () {
    started++;
    assert.ok(service.session().messages.some(item => item.text === 'New Desktop discussion'));
    yield { type: 'result', subtype: 'success', result: 'Done' };
  })());
  try {
    service.session().sessionId = 'saved-session';
    service.session().messages = [{ id: 'old', role: 'You', text: 'Old cache' }];
    service.sessionReader = {
      getSessionInfo: async id => ({ sessionId: id, summary: 'Desktop title' }),
      getSessionMessages: async () => [{ uuid: 'new', type: 'user', message: { content: 'New Desktop discussion' } }]
    };
    service.session().queued = [{ id: 'q', text: 'Queued', images: [] }];
    await service.refreshHistory();
    assert.equal(service.queue()[0].id, 'q'); service.session().queued = [];
    assert.equal(service.session().title, 'Desktop title');
    assert.ok(events.some(event => event.type === 'history'));
    await service.send('Follow up'); await idle(service); assert.equal(started, 1);
    const count = service.session().messages.length;
    service.sessionReader.getSessionMessages = async () => [];
    await assert.rejects(service.send('Do not send'), /empty history/);
    assert.equal(service.session().messages.length, count); assert.equal(started, 1); assert.equal(service.busy, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('legacy screenshots migrate losslessly and preserve the original backup', () => {
  const { service, root } = fixture(() => {});
  try {
    const image = { type: 'image/png', data: Buffer.alloc(1024 * 1024, 7).toString('base64') };
    service.session().messages = Array.from({ length: 12 }, (_, i) => ({ id: String(i), role: 'You', text: 'Screenshot', images: [image] }));
    service.session().queued = [{ id: 'queued', text: 'Later', images: [image] }];
    fs.writeFileSync(service.storage, JSON.stringify(service.data));
    const originalSize = fs.statSync(service.storage).size;
    const restored = new ClaudeService({ storage: service.storage, emit() {} });
    assert.equal(restored.storageError, undefined);
    assert.equal(fs.statSync(service.storage + '.legacy-backup').size, originalSize);
    assert.ok(fs.statSync(service.storage).size < 10000);
    assert.equal(fs.readdirSync(restored.attachments.directory).length, 1);
    assert.deepEqual(restored.attachments.hydrate(restored.session().messages[0].images[0]), image);
    assert.deepEqual(restored.attachments.hydrate(restored.queue()[0].images[0]), image);
    assert.ok(JSON.stringify(restored.snapshot()).length < 10000);
    assert.throws(() => restored.attachments.path('../secret'), /Invalid/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('failed persistence never emits or retains a sent message', async () => {
  const { service, events, root } = fixture(() => { throw new Error('Should not start'); });
  try {
    service.save = () => { throw new Error('Disk full'); };
    await assert.rejects(service.send('Retry this'), /Disk full/);
    assert.equal(service.session().messages.length, 0);
    assert.equal(events.filter(event => event.type === 'message').length, 0);
    assert.equal(service.busy, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('quota lookup reports percentages and scoped models, caches, and closes idle query', async () => {
  let closed = 0, calls = 0;
  const { service, root } = fixture(() => {
    const stream = (async function* () {})();
    stream.close = () => { closed++; };
    stream.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET = async () => { calls++; return { subscription_type: 'team', rate_limits: { five_hour: { utilization: 20 }, seven_day: { utilization: 10 }, model_scoped: [{ display_name: 'Fable', utilization: 12 }] } }; };
    return stream;
  });
  try {
    const result = await service.usage(); await service.usage();
    assert.deepEqual(result.rows.map(row => row.used), [20, 10, 12]);
    assert.equal(result.rows[2].label, 'Weekly · Fable'); assert.equal(calls, 1); assert.equal(closed, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('compaction writes notes first, resumes session, and requires a compact boundary', async () => {
  const prompts = []; let boundary = true;
  const { service, events, root } = fixture(({ prompt, options }) => (async function* () {
    prompts.push(prompt); assert.equal(options.resume, 'test-session');
    if (prompt.startsWith('/compact') && boundary) yield { type: 'system', subtype: 'compact_boundary' };
    yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Handoff notes.' }] } };
    yield { type: 'result', subtype: 'success', result: 'Done' };
  })());
  try {
    service.session().sessionId = 'test-session';
    await service.compact();
    assert.match(prompts[0], /handoff notes/); assert.match(prompts[1], /^\/compact /);
    assert.equal(events.filter(event => event.type === 'complete').length, 1);
    assert.equal(service.maintaining, false);
    boundary = false; await service.compact();
    assert.ok(events.some(event => event.type === 'failure' && /did not confirm/.test(event.data.text)));
    assert.equal(events.filter(event => event.type === 'complete').length, 1);
    service.busy = true; await assert.rejects(service.compact(), /Finish the current task/); service.busy = false;
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('thinking summaries stream, reconcile without duplicates, and survive restart', async () => {
  let options;
  const { service, events, root } = fixture(args => {
    options = args.options;
    return (async function* () {
      yield { type: 'stream_event', event: { type: 'message_start' } };
      yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'Checking the layout.' } } };
      yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Fixed.' } } };
      yield { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'Checking the layout.', signature: 'not-for-display' }, { type: 'redacted_thinking', data: 'not-for-display' }, { type: 'text', text: 'Fixed.' }] } };
      yield { type: 'result', subtype: 'success', result: 'Fixed.' };
    })();
  });
  service.showThinking = () => true;
  await service.send('Fix the layout'); await idle(service);
  assert.deepEqual(options.thinking, { type: 'enabled', display: 'summarized' });
  const messages = service.session().messages.filter(item => item.role === 'Claude');
  assert.equal(messages.length, 1); assert.equal(messages[0].text, 'Fixed.');
  assert.equal(messages[0].thinking, 'Checking the layout.');
  assert.ok(events.some(event => event.type === 'message' && event.data.thinking === 'Checking the layout.'));
  assert.ok(!JSON.stringify(messages).includes('not-for-display'));
  const restored = new ClaudeService({ storage: service.storage, emit() {} });
  assert.equal(restored.session().messages[1].thinking, 'Checking the layout.');
  service.showThinking = () => false;
  await service.send('Again'); await idle(service); assert.equal(options.thinking, undefined);
  fs.rmSync(root, { recursive: true, force: true });
});
function queuedFixture() {
  const calls = [], releases = [];
  const fixtureResult = fixture(({ prompt, options }) => (async function* () {
    calls.push({ prompt, options });
    yield { type: 'system', session_id: 'queued-session' };
    await new Promise((resolve, reject) => {
      releases.push(resolve);
      if (options.abortController.signal.aborted) reject(new Error('aborted'));
      else options.abortController.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    yield { type: 'result', subtype: 'success', result: 'Done' };
  })());
  return { ...fixtureResult, calls, releases };
}
async function waitFor(predicate) {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(predicate());
}
test('editing holds queued messages, preserves order, and persists saved text', async () => {
  const { service, calls, releases, root } = queuedFixture();
  try {
    await service.send('First'); await waitFor(() => releases.length === 1);
    await service.send('Original'); await service.send('Third');
    const id = service.queue()[0].id;
    service.beginQueuedEdit(id);
    releases[0](); await idle(service);
    assert.equal(calls.length, 1);
    await assert.rejects(service.finishQueuedEdit({ id, text: '' }), /Enter a message/);
    assert.equal(service.queue()[0].text, 'Original');
    await service.finishQueuedEdit({ id, text: 'Edited' }); await waitFor(() => releases.length === 2);
    assert.equal(calls[1].prompt, 'Edited');
    const restored = new ClaudeService({ storage: service.storage, emit() {} });
    assert.ok(restored.session().messages.some(item => item.text === 'Edited'));
    assert.equal(service.queue()[0].text, 'Third');
    service.beginQueuedEdit(service.queue()[0].id);
    await service.finishQueuedEdit({ id: service.queue()[0].id, cancel: true });
    assert.equal(service.queue()[0].text, 'Third');
    await assert.rejects(service.finishQueuedEdit({ id, text: 'Stale' }), /no longer/);
    service.stop(); await idle(service);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('queued messages preserve order, persist, and do not interrupt active work', async () => {
  const { service, calls, releases, root } = queuedFixture();
  await service.send('First'); await waitFor(() => releases.length === 1);
  await service.send('Second'); await service.send('Third');
  assert.equal(calls.length, 1); assert.equal(calls[0].options.abortController.signal.aborted, false);
  const restored = new ClaudeService({ storage: service.storage, emit() {} });
  assert.deepEqual(restored.snapshot().queued.map(item => item.text), ['Second', 'Third']);
  assert.equal(restored.busy, false);
  releases[0](); await waitFor(() => releases.length === 2);
  assert.equal(calls[1].prompt, 'Second'); assert.equal(calls[1].options.resume, 'queued-session');
  releases[1](); await waitFor(() => releases.length === 3);
  assert.equal(calls[2].prompt, 'Third'); releases[2](); await idle(service);
  assert.equal(service.queue().length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});
test('Send now interrupts once, prioritizes the chosen message, and keeps others queued', async () => {
  const { service, calls, releases, root } = queuedFixture();
  await service.send('First'); await waitFor(() => releases.length === 1);
  await service.send('Second'); await service.send('Urgent');
  const urgent = service.queue()[1].id;
  await service.sendQueuedNow(urgent); await waitFor(() => releases.length === 2);
  assert.equal(calls[0].options.abortController.signal.aborted, true);
  assert.equal(calls[1].prompt, 'Urgent');
  assert.deepEqual(service.queue().map(item => item.text), ['Second']);
  service.stop(); await idle(service);
  assert.equal(calls.length, 2);
  assert.equal(service.queue().length, 1);
  service.removeQueued(service.queue()[0].id); assert.equal(service.queue().length, 0);
  await assert.rejects(service.sendQueuedNow(urgent), /no longer queued/);
  fs.rmSync(root, { recursive: true, force: true });
});
test('failures pause queued screenshots and switching folders keeps queues separate', async () => {
  let fail;
  const { service, root } = fixture(() => (async function* () {
    await new Promise(resolve => { fail = resolve; }); throw new Error('Offline');
  })());
  await service.send('First'); await waitFor(() => !!fail);
  const image = { type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==' };
  await service.send({ text: 'Look', images: [image] });
  fail(); await idle(service);
  assert.deepEqual(service.queue()[0].images.map(item => service.attachments.hydrate(item)), [image]);
  const other = path.join(root, 'other'); fs.mkdirSync(other);
  service.selectProject(other); assert.equal(service.queue().length, 0);
  service.selectProject(root); assert.equal(service.queue()[0].text, 'Look');
  fs.rmSync(root, { recursive: true, force: true });
});
test('model selection persists, applies to resumed turns, and reports the actual model', async () => {
  const options = [];
  const { service, root, events } = fixture(args => {
    options.push(args.options);
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'model-session', model: 'claude-opus-4-6' };
      yield { type: 'result', subtype: 'success', result: 'OK' };
    })();
  });
  try {
    assert.equal(service.snapshot().model, 'default');
    service.setModel('claude-opus-5');
    await service.send('First'); await idle(service);
    assert.equal(options[0].model, 'claude-opus-5');
    assert.equal(service.snapshot().activeModel, 'claude-opus-4-6');
    assert.ok(events.some(event => event.type === 'model' && event.data.activeModel === 'claude-opus-4-6'));
    const restored = new ClaudeService({ storage: service.storage, emit() {} });
    assert.equal(restored.snapshot().model, 'claude-opus-5');
    assert.equal(restored.snapshot().activeModel, 'claude-opus-4-6');
    service.setModel('claude-sonnet-5');
    assert.equal(service.snapshot().activeModel, null);
    await service.send('Second'); await idle(service);
    assert.equal(options[1].model, 'claude-sonnet-5');
    assert.equal(options[1].resume, 'model-session');
    service.setModel('default');
    await service.send('Third'); await idle(service);
    assert.equal(Object.hasOwn(options[2], 'model'), false);
    service.setModel('claude-fable-5-1');
    await service.send('Fourth'); await idle(service);
    assert.equal(options[3].model, 'claude-fable-5-1');
    assert.equal(new ClaudeService({ storage: service.storage, emit() {} }).snapshot().model, 'claude-fable-5-1');
    service.busy = true;
    assert.throws(() => service.setModel('claude-haiku-4-5'), /Stop/);
    service.busy = false;
    assert.throws(() => service.setModel('invalid'), /Unknown/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('streams once, resumes correct session, and restores saved project history', async () => {
  const options = [];
  const { service, root } = fixture(({ options: opts }) => {
    options.push(opts);
    return (async function* () {
      yield { type: 'system', session_id: 'session-a' };
      yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } } };
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } };
      yield { type: 'result', subtype: 'success', result: 'Hello' };
    })();
  });
  await service.send('Hi'); await idle(service); await service.send('Again'); await idle(service);
  assert.equal(service.session().messages.length, 4); assert.equal(options[1].resume, 'session-a');
  const restored = new ClaudeService({ storage: path.join(root, 'state.json'), emit() {} });
  assert.equal(restored.session().messages.length, 4); assert.equal(restored.snapshot().project, root);
});
test('permission prompts wait, deny, allow original input, and reject stale replies', async () => {
  const { service, events } = fixture(); const signal = new AbortController().signal;
  let waiting = service.permission('Write', { file_path: 'addon.lua', content: 'hi' }, { signal });
  const first = events.at(-1).data; service.respond({ id: first.id, allow: false });
  assert.equal((await waiting).behavior, 'deny'); assert.throws(() => service.respond({ id: first.id, allow: true }));
  waiting = service.permission('Write', { content: 'exact' }, { signal });
  service.respond({ id: events.at(-1).data.id, allow: true }); assert.deepEqual((await waiting).updatedInput, { content: 'exact' });
});
test('question answers and Stop resolve outstanding requests', async () => {
  const { service, events } = fixture();
  const waiting = service.permission('AskUserQuestion', { questions: [{ question: 'Which addon?' }] }, { signal: new AbortController().signal });
  const id = events.at(-1).data.id;
  assert.throws(() => service.respond({ id, allow: true, answers: {} }));
  service.respond({ id, allow: true, answers: { 'Which addon?': 'TestAddon' } });
  assert.equal((await waiting).updatedInput.answers['Which addon?'], 'TestAddon');
  const pending = service.permission('Bash', { command: 'test' }, { signal: new AbortController().signal }); service.stop();
  assert.equal((await pending).behavior, 'deny'); assert.equal(service.pending.size, 0);
});
test('busy tasks cannot switch folders and failures become visible', async () => {
  const { service, root, events } = fixture(() => (async function* () { await new Promise(resolve => setTimeout(resolve, 30)); throw new Error('Connection lost'); })());
  await service.send('Hi'); assert.throws(() => service.selectProject(root)); await idle(service);
  assert.ok(events.some(e => e.type === 'failure' && e.data.text.includes('Connection lost')));
});
test('permission modes persist and only Manual forces approvals', async () => {
  for (const mode of ['default', 'auto', 'acceptEdits', 'plan', 'bypassPermissions']) {
    let options;
    const { service, root } = fixture(args => {
      options = args.options;
      return (async function* () { yield { type: 'result', subtype: 'success', result: 'OK' }; })();
    });
    service.setPermissionMode(mode); await service.send('Test'); await idle(service);
    assert.equal(options.permissionMode, mode);
    assert.equal(options.allowDangerouslySkipPermissions, mode === 'bypassPermissions');
    const hook = await options.hooks.PreToolUse[0].hooks[0]({ tool_name: 'Write' });
    assert.equal(hook.hookSpecificOutput?.permissionDecision, mode === 'default' ? 'ask' : undefined);
    const restored = new ClaudeService({ storage: path.join(root, 'state.json'), emit() {} });
    assert.equal(restored.snapshot().permissionMode, mode);
    service.busy = true; assert.throws(() => service.setPermissionMode('default'));
    service.busy = false; assert.throws(() => service.setPermissionMode('invalid'));
  }
});
test('screenshots are sent as image blocks and saved even without text', async () => {
  const image = { type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==' };
  let received;
  const { service, root } = fixture(({ prompt }) => (async function* () {
    for await (const item of prompt) received = item;
    yield { type: 'result', subtype: 'success', result: 'Image received' };
  })());
  await service.send({ text: '', images: [image] }); await idle(service);
  assert.equal(received.message.content[0].type, 'image');
  assert.deepEqual(received.message.content[0].source, { type: 'base64', media_type: image.type, data: image.data });
  const restored = new ClaudeService({ storage: path.join(root, 'state.json'), emit() {} });
  assert.deepEqual(restored.session().messages[0].images.map(item => restored.attachments.hydrate(item)), [image]);
  await service.send({ text: 'Queued screenshot', images: restored.session().messages[0].images }, true); await idle(service);
  assert.deepEqual(received.message.content[0].source, { type: 'base64', media_type: image.type, data: image.data });
  await assert.rejects(service.send({ text: 'bad', images: [{ type: 'image/png', data: 'bm90IGFuIGltYWdl' }] }));
  await assert.rejects(service.send({ text: '', images: Array(5).fill(image) }));
  assert.equal(service.busy, false);
});

test('image transport accepts files over the old 5 MB cap and rejects files over 30 MB', async () => {
  // A signature-bearing payload tests transport limits; the mocked SDK does not decode it.
  const bytes = Buffer.alloc(6 * 1024 * 1024);
  Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);
  const image = { type: 'image/png', data: bytes.toString('base64') };
  let received;
  const { service, root } = fixture(({ prompt }) => (async function* () {
    for await (const item of prompt) received = item;
    yield { type: 'result', subtype: 'success', result: 'Received' };
  })());
  try {
    await service.send({ text: 'Screenshot', images: [image] }); await idle(service);
    assert.equal(received.message.content[0].source.data, image.data);
    const count = service.session().messages.length;
    const oversized = { type: 'image/png', data: Buffer.alloc(30 * 1024 * 1024 + 1).toString('base64') };
    await assert.rejects(service.send({ text: '', images: [oversized] }), /30 MB/);
    assert.equal(service.session().messages.length, count);
    assert.equal(service.busy, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
