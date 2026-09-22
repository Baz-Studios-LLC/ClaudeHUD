function createUpdater({ app, updater, emit, isBusy, platform = process.platform, openReleases }) {
  if (app.isPackaged && platform === 'darwin') {
    const state = { phase: 'manual', version: app.getVersion(), detail: 'Mac updates are manual for now. Check for updates opens GitHub downloads.' };
    return { snapshot: () => state, start: () => emit(state), check: async () => { await openReleases?.(); return state; }, install: () => ({ error: 'Download the latest Mac release from GitHub.' }), dispose() {} };
  }
  let state = { phase: app.isPackaged ? 'idle' : 'development', version: app.getVersion(), detail: app.isPackaged ? 'Ready to check for updates.' : 'Updates are available in the installed app.' };
  let checking = false, installing = false, interval, startup;
  const publish = (phase, detail, extra = {}) => { state = { ...state, ...extra, phase, detail }; emit(state); };
  if (app.isPackaged) {
    updater.autoDownload = true; updater.autoInstallOnAppQuit = false;
    updater.on('checking-for-update', () => publish('checking', 'Checking for updates…'));
    updater.on('update-available', info => publish('downloading', `Downloading ${info.version}…`, { nextVersion: info.version }));
    updater.on('download-progress', info => publish('downloading', `Downloading update · ${Math.round(info.percent)}%`));
    updater.on('update-not-available', () => publish('idle', 'You’re up to date.'));
    updater.on('update-downloaded', info => publish('ready', `Version ${info.version} is ready. Restart when convenient.`, { nextVersion: info.version }));
    updater.on('error', error => publish('error', `Update check failed: ${error.message}`));
  }
  async function check() {
    if (!app.isPackaged || checking || ['ready', 'downloading'].includes(state.phase)) return state;
    checking = true;
    try { await updater.checkForUpdates(); } catch (error) { publish('error', `Update check failed: ${error.message}`); }
    finally { checking = false; }
    return state;
  }
  return {
    snapshot: () => state, check,
    start() { emit(state); if (app.isPackaged) { startup = setTimeout(check, 10000); interval = setInterval(check, 4 * 60 * 60 * 1000); } },
    install() {
      if (isBusy()) return { error: 'Wait for Claude to finish, or stop the current task before restarting.' };
      if (state.phase !== 'ready') return { error: 'No downloaded update is ready.' };
      if (!installing) { installing = true; updater.quitAndInstall(true, true); }
      return { ok: true };
    },
    dispose() { clearTimeout(startup); clearInterval(interval); }
  };
}
module.exports = { createUpdater };
