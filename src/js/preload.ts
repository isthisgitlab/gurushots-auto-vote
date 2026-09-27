// Block service worker registration
(() => {
    // Absent in some hosts, whatever the DOM typings claim.
    const C = globalThis.ServiceWorkerContainer as typeof ServiceWorkerContainer | undefined;
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

import { contextBridge, ipcRenderer } from 'electron';
import { invokeChannels, aliases, sendMethods, eventMethods, kebabToCamel } from './ipc/manifest';
import type { IpcRendererEvent } from 'electron';

// The window.api surface is GENERATED from the shared channel manifest
// (ipc/manifest.ts) so it can never silently drift from the Capacitor
// bridge or the main-process handler set (tests/ipc/manifest.test.js
// enforces the latter). Adding a channel = one manifest entry.
const api: Record<string, (...args: never[]) => unknown> = {};

// invoke methods: api.getSettings = (...) => ipcRenderer.invoke('get-settings', ...)
for (const channel of invokeChannels) {
    api[kebabToCamel(channel)] = (...args: unknown[]) => ipcRenderer.invoke(channel, ...args);
}

// Friendlier aliases over invoke channels (applyBoost / applyTurbo).
for (const [method, channel] of Object.entries(aliases)) {
    api[method] = (...args: unknown[]) => ipcRenderer.invoke(channel, ...args);
}

// Send-style window-control hints (login-success / logout).
for (const [method, channel] of Object.entries(sendMethods)) {
    api[method] = () => ipcRenderer.send(channel);
}

// Event listeners. Each returns an unsubscribe so React effects
// (UpdateContext, useLogStream, settings sync) can drop the handler on
// unmount; without it, every remount stacks another ipcRenderer listener.
for (const [method, channel] of Object.entries(eventMethods)) {
    api[method] = (callback: (...args: unknown[]) => void) => {
        const handler: (event: IpcRendererEvent, ...args: unknown[]) => void = (_event, ...args): void =>
            callback(...args);
        ipcRenderer.on(channel, handler);
        return () => ipcRenderer.removeListener(channel, handler);
    };
}

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('api', api);
