import { kebabToCamel } from './ipc/manifest';

import type { IpcRenderer, IpcRendererEvent } from 'electron';

/**
 * What both sandboxed preloads (preload.ts, preloadLogs.ts) are built from: the
 * service-worker block and the window.api generator. Bundled into each preload file
 * by scripts/build-react.ts, so it stays dependency-free apart from the channel
 * manifest and type-only Electron imports.
 */

/** The `window.api` surface a preload exposes: the manifest lists, or a subset of them. */
type ApiSurface = {
    invokeChannels: readonly string[];
    aliases: Readonly<Record<string, string>>;
    sendMethods: Readonly<Record<string, string>>;
    eventMethods: Readonly<Record<string, string>>;
};

// Block service worker registration
const blockServiceWorkers = (): void => {
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
};

/**
 * The window.api surface is GENERATED from the shared channel manifest
 * (ipc/manifest.ts) so it can never silently drift from the Capacitor
 * bridge or the main-process handler set (tests/ipc/manifest.test.ts
 * enforces the latter). Adding a channel = one manifest entry.
 *
 * @param ipcRenderer - the preload's renderer-side IPC; never handed to the page
 * @param surface - the channels and methods to expose
 */
const buildApi = (
    ipcRenderer: Pick<IpcRenderer, 'invoke' | 'send' | 'on' | 'removeListener'>,
    surface: ApiSurface,
): Record<string, (...args: never[]) => unknown> => {
    const api: Record<string, (...args: never[]) => unknown> = {};

    // invoke methods: api.getSettings = (...) => ipcRenderer.invoke('get-settings', ...)
    for (const channel of surface.invokeChannels) {
        api[kebabToCamel(channel)] = (...args: unknown[]) => ipcRenderer.invoke(channel, ...args);
    }

    // Friendlier aliases over invoke channels (applyBoost / applyTurbo).
    for (const [method, channel] of Object.entries(surface.aliases)) {
        api[method] = (...args: unknown[]) => ipcRenderer.invoke(channel, ...args);
    }

    // Send-style window-control hints (login-success / logout).
    for (const [method, channel] of Object.entries(surface.sendMethods)) {
        api[method] = () => ipcRenderer.send(channel);
    }

    // Event listeners. Each returns an unsubscribe so React effects
    // (UpdateContext, useLogStream, settings sync) can drop the handler on
    // unmount; without it, every remount stacks another ipcRenderer listener.
    for (const [method, channel] of Object.entries(surface.eventMethods)) {
        api[method] = (callback: (...args: unknown[]) => void) => {
            const handler: (event: IpcRendererEvent, ...args: unknown[]) => void = (_event, ...args): void =>
                callback(...args);
            ipcRenderer.on(channel, handler);
            return () => ipcRenderer.removeListener(channel, handler);
        };
    }

    return api;
};

export { blockServiceWorkers, buildApi };
