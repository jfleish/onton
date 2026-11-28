const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ontonStudio', {
  adapterVersion: '1.0',
  getSnapshot: () => ipcRenderer.invoke('studio:get-snapshot'),
  chooseProject: () => ipcRenderer.invoke('studio:choose-project'),
  chooseGameplan: () => ipcRenderer.invoke('studio:choose-gameplan'),
  chooseBackend: () => ipcRenderer.invoke('studio:choose-backend'),
  openRecent: (projectRoot) => ipcRenderer.invoke('studio:open-recent', projectRoot),
  saveConfig: (patch) => ipcRenderer.invoke('studio:save-config', patch),
  saveGameplan: (document) => ipcRenderer.invoke('studio:save-gameplan', document),
  validateGameplan: (file) => ipcRenderer.invoke('studio:validate-gameplan', file),
  runReal: () => ipcRenderer.invoke('studio:run-real'),
  stopRun: () => ipcRenderer.invoke('studio:stop-run'),
  onEvent: (listener) => {
    const handler = (_event, value) => listener(value);
    ipcRenderer.on('studio:event', handler);
    return () => ipcRenderer.removeListener('studio:event', handler);
  }
});
