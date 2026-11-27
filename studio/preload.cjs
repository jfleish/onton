const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ontonStudio', {
  adapterVersion: '1.0',
  getSnapshot: () => ipcRenderer.invoke('studio:get-snapshot'),
  runSimulation: () => ipcRenderer.invoke('studio:run-simulation'),
  stopRun: () => ipcRenderer.invoke('studio:stop-run'),
  onEvent: (listener) => {
    const handler = (_event, value) => listener(value);
    ipcRenderer.on('studio:event', handler);
    return () => ipcRenderer.removeListener('studio:event', handler);
  }
});
