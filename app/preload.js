'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Safe bridge between the renderer UI and the main process.
contextBridge.exposeInMainWorld('api', {
  // --- parsing / actions (request → response) ---
  parseEpisode: (url) => ipcRenderer.invoke('parse-episode', url),
  parseAnime: (url) => ipcRenderer.invoke('parse-anime', url),
  enqueue: (items) => ipcRenderer.invoke('enqueue', items),
  libraryList: () => ipcRenderer.invoke('library-list'),
  openFile: (fileRel) => ipcRenderer.invoke('open-file', fileRel),
  deleteEpisode: (payload) => ipcRenderer.invoke('delete-episode', payload),
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  loginStatus: () => ipcRenderer.invoke('login-status'),
  queueState: () => ipcRenderer.invoke('queue-state'),
  setConcurrency: (n) => ipcRenderer.invoke('set-concurrency', n),

  // --- queue controls ---
  pause: (id) => ipcRenderer.invoke('dl-pause', id),
  resume: (id) => ipcRenderer.invoke('dl-resume', id),
  cancel: (id) => ipcRenderer.invoke('dl-cancel', id),
  cancelAll: () => ipcRenderer.invoke('dl-cancel-all'),
  resumeAll: () => ipcRenderer.invoke('dl-resume-all'),

  // --- watch tracking ---
  watchState: () => ipcRenderer.invoke('watch-state'),
  watchProgress: (p) => ipcRenderer.invoke('watch-progress', p),
  markWatched: (p) => ipcRenderer.invoke('mark-watched', p),

  // --- events (main → renderer) ---
  onQueue: (cb) => ipcRenderer.on('dl-queue', (_e, d) => cb(d)),
  onProgress: (cb) => ipcRenderer.on('dl-progress', (_e, d) => cb(d)),
  onDone: (cb) => ipcRenderer.on('dl-done', (_e, d) => cb(d)),
  onError: (cb) => ipcRenderer.on('dl-error', (_e, d) => cb(d)),
  onLogin: (cb) => ipcRenderer.on('login-changed', (_e, d) => cb(d)),
  onWatchChanged: (cb) => ipcRenderer.on('watch-changed', () => cb()),
});
