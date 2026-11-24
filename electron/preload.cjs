const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('companion', {
  close: () => ipcRenderer.invoke('companion:close'),
  setCompact: (compact) => ipcRenderer.invoke('companion:set-compact', compact),
  setPetHover: (hovered) => ipcRenderer.send('pet:hover', hovered),
  getApiKey: () => ipcRenderer.invoke('voice:get-api-key'),
  createSessionToken: () => ipcRenderer.invoke('voice:get-api-key'),
  speakOfflineGreeting: () => ipcRenderer.invoke('voice:speak-offline-greeting'),
  webResearch: (query) => ipcRenderer.invoke('research:web', query),
  saveResearchReport: (researchId, title) => ipcRenderer.invoke('research:save-report', researchId, title),
  searchBookMyShow: (movie, city) => ipcRenderer.invoke('bookmyshow:search', movie, city),
  chooseFileFolder: () => ipcRenderer.invoke('files:choose-folder'),
  listApprovedFolders: () => ipcRenderer.invoke('files:list-folders'),
  inspectProject: (folderId) => ipcRenderer.invoke('project:inspect', folderId),
  listLocalFiles: (folderId) => ipcRenderer.invoke('files:list', folderId),
  searchLocalFiles: (folderId, query) => ipcRenderer.invoke('files:search', folderId, query),
  previewFileOrganization: (folderId) => ipcRenderer.invoke('files:organize-preview', folderId),
  applyFileOrganization: (previewId) => ipcRenderer.invoke('files:organize-apply', previewId),
  undoFileOrganization: (undoId) => ipcRenderer.invoke('files:organize-undo', undoId),
  prepareDownloadsOrganization: () => ipcRenderer.invoke('files:prepare-downloads-organization'),
  createDailyAutomation: (time, query) => ipcRenderer.invoke('automation:create-daily-research', time, query),
  listAutomations: () => ipcRenderer.invoke('automation:list'),
  cancelAutomation: (query) => ipcRenderer.invoke('automation:cancel', query),
  openExternalUrl: (url) => ipcRenderer.invoke('browser:open-external', url),
  remember: (text, category) => ipcRenderer.invoke('memory:remember', text, category),
  recallMemory: (query) => ipcRenderer.invoke('memory:recall', query),
  forgetMemory: (query) => ipcRenderer.invoke('memory:forget', query),
  addTodo: (text) => ipcRenderer.invoke('todo:add', text),
  listTodos: (includeCompleted) => ipcRenderer.invoke('todo:list', includeCompleted),
  completeTodo: (query) => ipcRenderer.invoke('todo:complete', query),
  removeTodo: (query) => ipcRenderer.invoke('todo:remove', query),
  saveSkill: (name, description, steps) => ipcRenderer.invoke('skill:save', name, description, steps),
  listSkills: () => ipcRenderer.invoke('skill:list'),
  getSkill: (name) => ipcRenderer.invoke('skill:get', name),
  desktopCommand: (action, target) => ipcRenderer.invoke('desktop:command', action, target),
  playYouTube: (query) => ipcRenderer.invoke('desktop:play-youtube', query),
  playSpotify: (query) => ipcRenderer.invoke('desktop:play-spotify', query),
  captureScreen: () => ipcRenderer.invoke('screen:capture'),
  inspectAccessibility: (windowHint) => ipcRenderer.invoke('screen:inspect-accessibility', windowHint),
  accessibilityAction: (windowHint, name, controlType, action) => ipcRenderer.invoke('screen:accessibility-action', windowHint, name, controlType, action),
  clickScreen: (x, y, button, clickCount) => ipcRenderer.invoke('desktop:click-screen', x, y, button, clickCount),
  typeText: (text, windowHint, controlName, controlType, recipient) => ipcRenderer.invoke('desktop:type-text', text, windowHint, controlName, controlType, recipient),
  pressKey: (key) => ipcRenderer.invoke('desktop:press-key', key),
  getComputerStatus: () => ipcRenderer.invoke('system:get-status'),
  readClipboard: () => ipcRenderer.invoke('system:read-clipboard'),
  createReminder: (minutes, message) => ipcRenderer.invoke('reminder:create', minutes, message),
  listReminders: () => ipcRenderer.invoke('reminder:list'),
  cancelReminder: (message) => ipcRenderer.invoke('reminder:cancel', message),
  setWhatsAppNotificationReading: (enabled) => ipcRenderer.invoke('notification:set-whatsapp-reading', enabled),
  onWhatsAppNotification: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('notification:whatsapp', handler)
    return () => ipcRenderer.removeListener('notification:whatsapp', handler)
  },
  onReminderDue: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('reminder:due', handler)
    return () => ipcRenderer.removeListener('reminder:due', handler)
  },
  onAutomationDue: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('automation:due', handler)
    return () => ipcRenderer.removeListener('automation:due', handler)
  },
  onSystemOverload: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('system:overload', handler)
    return () => ipcRenderer.removeListener('system:overload', handler)
  },
})
