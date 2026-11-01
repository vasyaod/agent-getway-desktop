// The start page's bridge to the main process. It exists ONLY on the app's own start page
// (file:); the gateway's pages load with this preload too, but get nothing, and main.js
// refuses IPC from any other frame anyway.
const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('getway', {
    status: () => ipcRenderer.invoke('getway:status'),
    signIn: () => ipcRenderer.invoke('getway:sign-in'),
    cancel: () => ipcRenderer.invoke('getway:cancel'),
    retry: () => ipcRenderer.invoke('getway:retry'),
    onStatus: (fn) => ipcRenderer.on('getway:status', (_e, s) => fn(s)),
  });
}
