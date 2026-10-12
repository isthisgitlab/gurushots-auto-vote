import { contextBridge, ipcRenderer } from 'electron';
import { invokeChannels, aliases, sendMethods, eventMethods } from './ipc/manifest';
import { blockServiceWorkers, buildApi } from './preloadApi';

blockServiceWorkers();

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('api', buildApi(ipcRenderer, { invokeChannels, aliases, sendMethods, eventMethods }));
