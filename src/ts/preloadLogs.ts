import { contextBridge, ipcRenderer } from 'electron';
import { logsWindowInvokeChannels, logsWindowEventMethods } from './ipc/manifest';
import { blockServiceWorkers, buildApi } from './preloadApi';

blockServiceWorkers();

// The Logs window renders text derived from API responses, so its window.api is
// only the log feed and the language read (manifest: logsWindow*). The main
// process refuses every other channel from this window as well (registerHandlers.ts).
contextBridge.exposeInMainWorld(
    'api',
    buildApi(ipcRenderer, {
        invokeChannels: logsWindowInvokeChannels,
        aliases: {},
        sendMethods: {},
        eventMethods: logsWindowEventMethods,
    }),
);
