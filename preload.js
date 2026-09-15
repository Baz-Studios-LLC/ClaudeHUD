const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('hud', {
  action: (action, value) => ipcRenderer.invoke('action', action, value),
  claude: (action, value) => ipcRenderer.invoke('claude', action, value),
  onClaude: callback => ipcRenderer.on('claude-event', (_, value) => callback(value)),
  onNotice: callback => ipcRenderer.on('notice', (_, value) => callback(value)),
  onDemo: callback => ipcRenderer.on('demo-mode', callback),
  onStatus: callback => ipcRenderer.on('status', (_, status) => callback(status)),
  onUpdate: callback => ipcRenderer.on('update-status', (_, value) => callback(value)),
  onFocus: callback => ipcRenderer.on('focus-input', callback),
  onExpansion: callback => ipcRenderer.on('expansion', (_, value) => callback(value)),
  onSettings: callback => ipcRenderer.on('open-settings', callback),
  onShortcut: callback => ipcRenderer.on('shortcut-status', (_, value) => callback(value))
});
