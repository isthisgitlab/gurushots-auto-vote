/**
 * Electron preload (src/js/preload.ts): the service-worker register() block
 * and the window.api surface generated from ipc/manifest.ts.
 */

import type * as electronModule from 'electron';
import { invalid } from '../helpers/invalid';

jest.mock('electron', () => ({
    contextBridge: { exposeInMainWorld: jest.fn() },
    ipcRenderer: { invoke: jest.fn(), send: jest.fn(), on: jest.fn(), removeListener: jest.fn() },
}));

import manifest = require('../../src/js/ipc/manifest');

/** One generated window.api method, as the tests call it (by computed name). */
type ApiMethod = (...args: unknown[]) => unknown;

let electron: jest.MaybeMockedDeep<typeof electronModule>;

function loadPreload(): Record<string, ApiMethod> {
    jest.resetModules();
    electron = jest.mocked(require('electron') as typeof electronModule);
    require('../../src/js/preload');
    const [name, api] = electron.contextBridge.exposeInMainWorld.mock.calls[0] as [string, Record<string, ApiMethod>];
    expect(name).toBe('api');
    return api;
}

afterEach(() => {
    delete invalid<{ ServiceWorkerContainer?: unknown }>(globalThis).ServiceWorkerContainer;
});

describe('service worker block', () => {
    it('replaces ServiceWorkerContainer.prototype.register with a locked rejecting stub', async () => {
        const original = jest.fn();
        globalThis.ServiceWorkerContainer = invalid(class {});
        globalThis.ServiceWorkerContainer.prototype.register = original;

        loadPreload();

        const proto = globalThis.ServiceWorkerContainer.prototype;
        expect(proto.register).not.toBe(original);
        await expect(proto.register('/sw.js')).rejects.toMatchObject({
            name: 'NotAllowedError',
            message: 'Service workers disabled by Electron host',
        });
        const desc = Object.getOwnPropertyDescriptor(proto, 'register');
        expect(desc!.writable).toBe(false);
        expect(desc!.configurable).toBe(false);
        expect(original).not.toHaveBeenCalled();
    });

    it('is a no-op when the environment has no ServiceWorkerContainer', () => {
        expect(globalThis.ServiceWorkerContainer).toBeUndefined();
        expect(() => loadPreload()).not.toThrow();
    });
});

describe('window.api surface', () => {
    it('exposes one camelCase invoke method per manifest channel, forwarding all args', () => {
        const api = loadPreload();
        for (const channel of manifest.invokeChannels) {
            const method = manifest.kebabToCamel(channel);
            expect(typeof api[method]).toBe('function');
        }
        const channel = manifest.invokeChannels[0];
        electron.ipcRenderer.invoke.mockReturnValueOnce(invalid('result'));
        expect(api[manifest.kebabToCamel(channel)]('a', 2)).toBe('result');
        expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(channel, 'a', 2);
    });

    it('routes aliases to their invoke channel', () => {
        const api = loadPreload();
        const entries = Object.entries(manifest.aliases);
        expect(entries.length).toBeGreaterThan(0);
        for (const [method, channel] of entries) {
            api[method]({ id: 1 });
            expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith(channel, { id: 1 });
        }
    });

    it('send methods fire ipcRenderer.send with no payload', () => {
        const api = loadPreload();
        const entries = Object.entries(manifest.sendMethods);
        expect(entries.length).toBeGreaterThan(0);
        for (const [method, channel] of entries) {
            api[method]('ignored');
            expect(electron.ipcRenderer.send).toHaveBeenLastCalledWith(channel);
        }
    });

    it('event methods subscribe, strip the IPC event, and return a working unsubscribe', () => {
        const api = loadPreload();
        const [method, channel] = Object.entries(manifest.eventMethods)[0];
        const callback = jest.fn();

        const unsubscribe = invalid<() => void>(api[method](callback));

        const [onChannel, handler] = electron.ipcRenderer.on.mock.calls[0];
        expect(onChannel).toBe(channel);
        handler(invalid({ sender: 'evt' }), 'x', 42);
        expect(callback).toHaveBeenCalledWith('x', 42);

        unsubscribe();
        expect(electron.ipcRenderer.removeListener).toHaveBeenCalledWith(channel, handler);
    });
});
