// Block service worker registration
(() => {
    const C = globalThis.ServiceWorkerContainer;
    if (C?.prototype?.register) {
        Object.defineProperty(C.prototype, 'register', {
            value: function () {
                return Promise.reject(new DOMException('Service workers disabled by Electron host', 'NotAllowedError'));
            },
            writable: false,
            configurable: false,
        });
    }
})();

const { contextBridge, ipcRenderer } = require('electron');
const { invokeChannels, aliases, sendMethods, eventMethods, kebabToCamel } = require('./ipc/manifest');

// The window.api surface is GENERATED from the shared channel manifest
// (ipc/manifest.js) so it can never silently drift from the Capacitor
// bridge or the main-process handler set (tests/ipc/manifest.test.js
// enforces the latter). Adding a channel = one manifest entry.
const api = {};

// invoke methods: api.getSettings = (...) => ipcRenderer.invoke('get-settings', ...)
for (const channel of invokeChannels) {
    api[kebabToCamel(channel)] = (...args) => ipcRenderer.invoke(channel, ...args);
}

// Friendlier aliases over invoke channels (applyBoost / applyTurbo).
for (const [method, channel] of Object.entries(aliases)) {
    api[method] = (...args) => ipcRenderer.invoke(channel, ...args);
}

// Send-style window-control hints (login-success / logout).
for (const [method, channel] of Object.entries(sendMethods)) {
    api[method] = () => ipcRenderer.send(channel);
}

// Event listeners. Each returns an unsubscribe so React effects
// (UpdateContext, useLogStream, settings sync) can drop the handler on
// unmount; without it, every remount stacks another ipcRenderer listener.
for (const [method, channel] of Object.entries(eventMethods)) {
    api[method] = (callback) => {
        const handler = (_event, ...args) => callback(...args);
        ipcRenderer.on(channel, handler);
        return () => ipcRenderer.removeListener(channel, handler);
    };
}

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('api', api);
