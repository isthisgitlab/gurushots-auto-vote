/**
 * Web bridge — window.api in a browser tab behind the web shell. Invokes are
 * fetch POSTs (undefined arguments encoded by position), events come from one
 * shared EventSource, login/logout swap mounts locally, and the window
 * controls act in the browser. fetch, EventSource, open and location are
 * stubbed on globalThis.
 */

import type * as bridgeModule from '../../src/ts/bridge/web';
import type * as manifestModule from '../../src/ts/ipc/manifest';
import type { WindowApi } from '../../src/ts/types/ipc';
import { invalid } from '../helpers/invalid';

type FetchReply = { ok: boolean; status: number; json: () => Promise<unknown> };

class FakeEventSource {
    static instances: FakeEventSource[] = [];
    readonly url: string;
    readonly listeners = new Map<string, (event: { data: string }) => void>();
    constructor(url: string) {
        this.url = url;
        FakeEventSource.instances.push(this);
    }
    addEventListener(channel: string, fn: (event: { data: string }) => void) {
        this.listeners.set(channel, fn);
    }
    fire(channel: string, payload: unknown) {
        this.listeners.get(channel)!({ data: JSON.stringify(payload) });
    }
}

const g = globalThis as typeof globalThis & { api?: object };
const saved = { fetch: g.fetch, EventSource: g.EventSource, location: g.location, open: g.open };

const mockFetch = jest.fn<Promise<FetchReply>, [string, RequestInit]>();
const mockOpen = jest.fn();
const mockReload = jest.fn();

const reply = (status: number, body: unknown): FetchReply => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
});

let bridge: typeof bridgeModule;
let api: WindowApi;

beforeEach(() => {
    FakeEventSource.instances = [];
    mockFetch.mockReset().mockResolvedValue(reply(200, { result: { success: true } }));
    mockOpen.mockReset();
    mockReload.mockReset();
    g.fetch = invalid(mockFetch);
    g.EventSource = invalid(FakeEventSource);
    g.location = invalid({ reload: mockReload });
    g.open = mockOpen;
    jest.resetModules();
    bridge = require('../../src/ts/bridge/web') as typeof bridgeModule;
    api = bridge.installWebBridge();
});

afterEach(() => {
    Object.assign(g, saved);
    delete g.api;
});

const sentBody = (call = 0): unknown => JSON.parse(mockFetch.mock.calls[call][1].body as string);

describe('web bridge — invoke', () => {
    test('installs window.api and posts each invoke to its channel', async () => {
        expect(g.api).toBe(api);
        mockFetch.mockResolvedValueOnce(reply(200, { result: 'dark' }));

        await expect(api.getSetting('theme')).resolves.toBe('dark');
        expect(mockFetch).toHaveBeenCalledWith('/api/invoke/get-setting', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ args: ['theme'], undefinedAt: [] }),
        });
    });

    test('undefined arguments travel as null plus their positions', async () => {
        await api.getEffectiveSetting('boostTime', invalid(undefined));
        expect(sentBody()).toEqual({ args: ['boostTime', null], undefinedAt: [1] });
    });

    test('aliases post to their target channel', async () => {
        await api.applyTurbo('c1', 'e1');
        expect(mockFetch.mock.calls[0][0]).toBe('/api/invoke/apply-turbo-to-entry');
    });

    test('a failed request rejects with the server error, or the status without one', async () => {
        mockFetch.mockResolvedValueOnce(reply(500, { success: false, error: 'vote exploded' }));
        await expect(api.guiVote()).rejects.toThrow('vote exploded');
        mockFetch.mockResolvedValueOnce(reply(404, {}));
        await expect(api.guiVote()).rejects.toThrow('Request failed (404)');
    });

    test('every invoke channel is served by the server except the browser ones', async () => {
        const { invokeChannels, kebabToCamel } = require('../../src/ts/ipc/manifest') as typeof manifestModule;
        const methods = invalid<Record<string, (...args: unknown[]) => Promise<unknown>>>(api);
        for (const channel of invokeChannels) {
            if (bridge.BROWSER_CHANNELS.has(channel)) continue;
            mockFetch.mockClear();
            await methods[kebabToCamel(channel)]();
            expect(mockFetch.mock.calls[0][0]).toBe(`/api/invoke/${channel}`);
        }
    });
});

describe('web bridge — events', () => {
    test('one EventSource feeds every subscriber of a channel until it unsubscribes', () => {
        const a = jest.fn();
        const b = jest.fn();
        const logs = jest.fn();
        const offA = api.onSettingsChanged(a);
        api.onSettingsChanged(b);
        api.onLogMessage(logs);
        expect(FakeEventSource.instances).toHaveLength(1);
        const [source] = FakeEventSource.instances;
        expect(source.url).toBe('/api/events');

        source.fire('settings-changed', { theme: 'dark' });
        expect(a).toHaveBeenCalledWith({ theme: 'dark' });
        expect(b).toHaveBeenCalledWith({ theme: 'dark' });
        expect(logs).not.toHaveBeenCalled();

        offA();
        source.fire('settings-changed', { theme: 'light' });
        expect(a).toHaveBeenCalledTimes(1);
        expect(b).toHaveBeenCalledTimes(2);
    });
});

describe('web bridge — login / logout', () => {
    test('login emits a local event; unsubscribed listeners stop hearing it', () => {
        api.login(); // nobody listening yet
        const heard = jest.fn();
        const off = bridge.onShellEvent('login-success', heard);
        bridge.onShellEvent('login-success', jest.fn());
        api.login();
        expect(heard).toHaveBeenCalledTimes(1);
        off();
        api.login();
        expect(heard).toHaveBeenCalledTimes(1);
        expect(mockFetch).not.toHaveBeenCalled();
    });

    test('logout clears the token on the server, then emits even if that fails', async () => {
        const heard = jest.fn();
        bridge.onShellEvent('logout', heard);
        await api.logout();
        expect(mockFetch.mock.calls[0][0]).toBe('/api/logout');
        expect(heard).toHaveBeenCalledTimes(1);

        mockFetch.mockRejectedValueOnce(new Error('offline'));
        await expect(api.logout()).rejects.toThrow('offline');
        expect(heard).toHaveBeenCalledTimes(2);
    });
});

describe('web bridge — browser window controls', () => {
    test('openExternalUrl opens https URLs in a new tab and refuses anything else', async () => {
        await expect(api.openExternalUrl('https://gurushots.com')).resolves.toEqual({ success: true });
        expect(mockOpen).toHaveBeenCalledWith('https://gurushots.com', '_blank', 'noopener');

        await expect(api.openExternalUrl('javascript:alert(1)')).resolves.toEqual({
            success: false,
            error: 'Only https:// URLs can be opened',
        });
        expect(mockOpen).toHaveBeenCalledTimes(1);
    });

    test('reloadWindow reloads the page; refreshMenu is a no-op', async () => {
        await expect(api.reloadWindow()).resolves.toEqual({ success: true });
        expect(mockReload).toHaveBeenCalled();
        await expect(api.refreshMenu()).resolves.toEqual({ success: true });
        expect(mockFetch).not.toHaveBeenCalled();
    });
});
