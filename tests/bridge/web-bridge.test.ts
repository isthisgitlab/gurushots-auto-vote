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
const saved = {
    fetch: g.fetch,
    EventSource: g.EventSource,
    location: g.location,
    history: g.history,
    open: g.open,
};
const savedSessionStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');

/** The tab's sessionStorage, as a map the tests can read and prefill. */
const tabStore = new Map<string, string>();
const fakeSessionStorage = invalid({
    getItem: (key: string) => tabStore.get(key) ?? null,
    setItem: (key: string, value: string) => void tabStore.set(key, value),
});
const stubSessionStorage = (value: unknown) =>
    Object.defineProperty(globalThis, 'sessionStorage', { value, configurable: true, writable: true });

const mockFetch = jest.fn<Promise<FetchReply>, [string, RequestInit]>();
const mockOpen = jest.fn();
const mockReload = jest.fn();
const mockReplaceState = jest.fn();
const TOKEN = 'a1b2c3';

/** The page's location the bridge reads: the launch URL's fragment carries the token. */
const stubLocation = (hash: string) => {
    g.location = invalid({ reload: mockReload, hash, pathname: '/', search: '?lang=lv' });
};

const reply = (status: number, body: unknown): FetchReply => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
});

let bridge: typeof bridgeModule;
let api: WindowApi;

beforeEach(() => {
    tabStore.clear();
    stubSessionStorage(fakeSessionStorage);
    FakeEventSource.instances = [];
    mockFetch.mockReset().mockResolvedValue(reply(200, { result: { success: true } }));
    mockOpen.mockReset();
    mockReload.mockReset();
    mockReplaceState.mockReset();
    g.fetch = invalid(mockFetch);
    g.EventSource = invalid(FakeEventSource);
    stubLocation(`#t=${TOKEN}`);
    g.history = invalid({ replaceState: mockReplaceState });
    g.open = mockOpen;
    jest.resetModules();
    bridge = require('../../src/ts/bridge/web') as typeof bridgeModule;
    api = bridge.installWebBridge();
});

afterEach(() => {
    delete (g as { webShell?: true }).webShell;
    Object.assign(g, saved);
    if (savedSessionStorage) Object.defineProperty(globalThis, 'sessionStorage', savedSessionStorage);
    else Reflect.deleteProperty(globalThis, 'sessionStorage');
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
            headers: { 'Content-Type': 'application/json', 'x-web-shell-token': TOKEN },
            body: JSON.stringify({ args: ['theme'], undefinedAt: [] }),
        });
    });

    test('marks the page as the web shell', () => {
        expect((g as { webShell?: true }).webShell).toBe(true);
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

describe('web bridge — access token', () => {
    const reinstall = (hash: string) => {
        stubLocation(hash);
        mockReplaceState.mockReset();
        jest.resetModules();
        bridge = require('../../src/ts/bridge/web') as typeof bridgeModule;
        return bridge.installWebBridge();
    };
    const sentHeaders = () => mockFetch.mock.calls[0][1].headers as Record<string, string>;

    test('the launch URL fragment is read once and taken out of the address bar', () => {
        expect(mockReplaceState).toHaveBeenCalledTimes(1);
        expect(mockReplaceState).toHaveBeenCalledWith(null, '', '/?lang=lv');
    });

    test('every request sends it as a header, the event stream as a query parameter', async () => {
        await api.guiVote();
        await api.logout();
        expect(sentHeaders()['x-web-shell-token']).toBe(TOKEN);
        expect((mockFetch.mock.calls[1][1].headers as Record<string, string>)['x-web-shell-token']).toBe(TOKEN);

        const other = reinstall('#t=a%20b&x=1');
        other.onSettingsChanged(jest.fn());
        expect(FakeEventSource.instances[0].url).toBe('/api/events?t=a%20b');
    });

    test('a page opened without the fragment or a kept token sends an empty token', async () => {
        tabStore.clear();
        const bare = reinstall('');
        await bare.guiVote();
        expect(sentHeaders()['x-web-shell-token']).toBe('');
    });

    test('the token from the fragment is kept for the tab', () => {
        expect(tabStore.get('web-shell-token')).toBe(TOKEN);
    });

    test('a reload without the fragment (F5) uses the token the tab kept, and keeps the address bar clean', async () => {
        const reloaded = reinstall('');
        await reloaded.guiVote();
        expect(sentHeaders()['x-web-shell-token']).toBe(TOKEN);
        expect(mockReplaceState).toHaveBeenCalledWith(null, '', '/?lang=lv');
    });

    test('a new fragment replaces the token the tab kept', async () => {
        const fresh = reinstall('#t=newrun');
        await fresh.guiVote();
        expect(sentHeaders()['x-web-shell-token']).toBe('newrun');
        expect(tabStore.get('web-shell-token')).toBe('newrun');
    });

    test('a browser that refuses sessionStorage still works from the fragment, in memory only', async () => {
        const refuse = () => {
            throw new Error('denied');
        };
        stubSessionStorage(invalid({ getItem: refuse, setItem: refuse }));
        const guarded = reinstall(`#t=${TOKEN}`);
        await guarded.guiVote();
        expect(sentHeaders()['x-web-shell-token']).toBe(TOKEN);
        const bare = reinstall('');
        await bare.guiVote();
        expect(mockFetch.mock.calls.at(-1)![1].headers).toEqual(expect.objectContaining({ 'x-web-shell-token': '' }));
    });

    test('a runtime with no sessionStorage works the same', async () => {
        stubSessionStorage(undefined);
        const bare = reinstall(`#t=${TOKEN}`);
        await bare.guiVote();
        expect(sentHeaders()['x-web-shell-token']).toBe(TOKEN);
    });

    test('a reload only reloads the page: the tab keeps the token, so the address bar is not touched', async () => {
        mockReplaceState.mockClear();
        await api.reloadWindow();
        expect(mockReplaceState).not.toHaveBeenCalled();
        expect(mockReload).toHaveBeenCalledTimes(1);
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
        expect(source.url).toBe(`/api/events?t=${TOKEN}`);

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

    test('a logout the settings refused does not log out: no event, and the caller is told', async () => {
        const heard = jest.fn();
        bridge.onShellEvent('logout', heard);
        mockFetch.mockResolvedValueOnce(
            invalid({ ok: true, json: async () => ({ result: { success: false, error: 'logout-not-saved' } }) }),
        );

        await expect(api.logout()).rejects.toThrow('logout-not-saved');

        expect(heard).not.toHaveBeenCalled();
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
