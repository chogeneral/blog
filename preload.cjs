const { contextBridge, ipcRenderer } = require('electron');

// 화면(renderer)에서 쓸 수 있는 기능만 열어 줍니다.
contextBridge.exposeInMainWorld('api', {
  onBoot: (handler) => ipcRenderer.on('boot', (event, data) => handler(data)),
  onCliInput: (handler) => ipcRenderer.on('cli:input', (event, data) => handler(data)),
  onLog: (handler) => ipcRenderer.on('log', (event, message) => handler(message)),
  onProgress: (handler) => ipcRenderer.on('progress', (event, data) => handler(data)),
  envStatus: () => ipcRenderer.invoke('env:status'),
  research: (keyword) => ipcRenderer.invoke('research:keyword', keyword),
  createDraft: (payload) => ipcRenderer.invoke('draft:create', payload),
  fetchImage: (payload) => ipcRenderer.invoke('image:fetch', payload),
  saveImage: (payload) => ipcRenderer.invoke('image:save', payload),
  buildBlocks: (payload) => ipcRenderer.invoke('draft:blocks', payload),
  saveDraft: (payload) => ipcRenderer.invoke('draft:save', payload),
  writeToNaver: (payload) => ipcRenderer.invoke('naver:write', payload),
  closeBrowser: () => ipcRenderer.invoke('browser:close'),
  openFolder: (which) => ipcRenderer.invoke('open:folder', which),
  openEnv: () => ipcRenderer.invoke('env:open'),
  openExternal: (url) => ipcRenderer.invoke('open:external', url),
  alert: (message) => ipcRenderer.invoke('dialog:message', message),
  selftestDone: (payload) => ipcRenderer.invoke('selftest:done', payload),
});
