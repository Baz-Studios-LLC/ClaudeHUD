const fs = require('node:fs');
const path = require('node:path');
const { ClaudeService } = require('./claude-service');
const folder = path.join(__dirname, 'artifacts', 'connection-check');
fs.mkdirSync(folder, { recursive: true });
let failed = false;
let allowWrite = false, approvals = 0;
const service = new ClaudeService({ storage: path.join(folder, 'state.json'), emit(type, data) {
  if (['complete', 'failure', 'permission'].includes(type)) console.log(type, JSON.stringify(data));
  if (type === 'permission') {
    approvals++;
    const allowed = allowWrite && data.tool === 'Write' && path.resolve(data.input.file_path) === path.join(folder, 'approved-check.txt');
    service.respond({ id: data.id, allow: allowed });
  }
  if (type === 'failure') failed = true;
} });
(async () => {
  await service.connect(); console.log('Connection:', service.connection);
  service.selectProject(folder); service.newChat();
  await service.send('Reply with exactly: ClaudeHUD is connected. Do not use tools.');
  const timeout = setTimeout(() => service.stop(), 90000);
  while (service.busy) await new Promise(resolve => setTimeout(resolve, 200));
  clearTimeout(timeout);
  if (failed || !service.session().messages.some(m => m.role === 'Claude' && m.text.includes('ClaudeHUD is connected'))) process.exitCode = 1;
  if (process.exitCode) return;
  allowWrite = true;
  await service.send('Connection test: use the Write tool to create approved-check.txt in the current directory containing exactly permission-check-ok. Do not use any other tools.');
  const writeTimeout = setTimeout(() => service.stop(), 90000);
  while (service.busy) await new Promise(resolve => setTimeout(resolve, 200));
  clearTimeout(writeTimeout);
  if (failed || approvals < 1 || fs.readFileSync(path.join(folder, 'approved-check.txt'), 'utf8').trim() !== 'permission-check-ok') throw new Error('Live approval check failed');
  allowWrite = false; const previousApprovals = approvals;
  await service.send('Connection test: attempt to use Write to create denied-check.txt. If permission is denied, stop and acknowledge it; do not try another method.');
  const denyTimeout = setTimeout(() => service.stop(), 90000);
  while (service.busy) await new Promise(resolve => setTimeout(resolve, 200));
  clearTimeout(denyTimeout);
  if (failed || approvals <= previousApprovals || fs.existsSync(path.join(folder, 'denied-check.txt'))) throw new Error('Live denial check failed');
  console.log('PASS: live response, session resume, approved write, denied write.');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
