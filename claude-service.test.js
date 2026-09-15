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
  assert.deepEqual(restored.session().messages[0].images, [image]);
  await assert.rejects(service.send({ text: 'bad', images: [{ type: 'image/png', data: 'bm90IGFuIGltYWdl' }] }));
  await assert.rejects(service.send({ text: '', images: Array(5).fill(image) }));
  assert.equal(service.busy, false);
});
