/**
 * Web bridge — populates window.api in an ordinary browser tab, served by the
 * web shell (web/server.ts). The surface is generated from the channel
 * manifest, like preload.ts on Electron:
 *
 *   - invoke methods POST to /api/invoke/<channel>; a handler that throws
 *     rejects the call, as ipcRenderer.invoke does;
 *   - every request carries the per-run token from the launch URL's fragment,
 *     kept for the tab in sessionStorage (so a reload keeps working) and taken
 *     out of the address bar: a header on POSTs, a query parameter on the
 *     event stream (EventSource sets no headers);
 *   - event methods subscribe to one shared EventSource on /api/events;
 *   - login / logout are local mount swaps (pages/Web.tsx listens through
 *     onShellEvent); logout clears the token on the server first.
 *
 * open-external-url, reload-window and refresh-menu act in the browser — the
 * server has no window to open, reload or put a menu on.
 *
 * Loaded only by the web renderer entry, so it stays free of Node-side
 * modules (logger, settings): everything it needs is the dependency-free
 * manifest and the URL check.
 */

import { invokeChannels, aliases, sendMethods, eventMethods, kebabToCamel } from '../ipc/manifest';
import { LOGOUT_NOT_SAVED } from '../ipc/logoutCode';
import { isSafeExternalUrl } from '../format/urlSafe';
import { isPlainObject } from '../plainObject';
import { markWebShell } from './webShellFlag';

import type { WindowApi } from '../types/ipc';

type Listener = (payload: unknown) => void;

// Invoke channels the browser answers itself: the server has no window to
// open, reload or put a menu on. Every other invoke channel is served by
// web/server.ts.
const BROWSER_CHANNELS: ReadonlySet<string> = new Set(['open-external-url', 'reload-window', 'refresh-menu']);

const TOKEN_HEADER = 'x-web-shell-token';

const TOKEN_STORAGE_KEY = 'web-shell-token';

// What the server answers a request without this run's token (web/server.ts).
const TOKEN_REFUSED = 'web-shell-token';

// The token is kept in the tab's own sessionStorage: it survives a reload of the tab, is not shared with other tabs and
// is gone when the tab closes. A browser that refuses the access (blocked site data) leaves it in memory only.
const keptToken = (): string => {
    try {
        return globalThis.sessionStorage?.getItem(TOKEN_STORAGE_KEY) ?? '';
    } catch {
        return '';
    }
};
const keepToken = (token: string) => {
    try {
        globalThis.sessionStorage?.setItem(TOKEN_STORAGE_KEY, token);
    } catch {
        // memory only
    }
};
// Drops what the tab kept: a token the server refused is of no use to a reload. A logout keeps it: the tab stays
// open on the same run, and a reload after the next login needs it.
const forgetToken = () => {
    try {
        globalThis.sessionStorage?.removeItem(TOKEN_STORAGE_KEY);
    } catch {
        // nothing kept to drop
    }
};

// The per-run token the server printed in the launch URL (`#t=<token>`). Taken from the fragment when the page was
// opened with one (and kept for the tab), otherwise from what the tab kept, then taken out of the address bar so it
// is not left in the page's URL, history entry or a bookmark.
let shellToken = '';
const takeShellToken = () => {
    const given = new URLSearchParams(globalThis.location.hash.slice(1)).get('t');
    if (given) keepToken(given);
    shellToken = given || keptToken();
    globalThis.history.replaceState(null, '', globalThis.location.pathname + globalThis.location.search);
};

const post = async (url: string, args: unknown[]) => {
    // JSON has no undefined: send each one as null plus its position so the
    // server restores it and a handler's default parameter still applies.
    const undefinedAt = args.flatMap((arg, index) => (arg === undefined ? [index] : []));
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [TOKEN_HEADER]: shellToken },
        body: JSON.stringify({ args, undefinedAt }),
    });
    const body = (await response.json()) as { result?: unknown; error?: string };
    if (!response.ok) {
        if (body.error === TOKEN_REFUSED) forgetToken();
        throw new Error(body.error || `Request failed (${response.status})`);
    }
    return body.result;
};

const invoke = (channel: string, args: unknown[]) => post(`/api/invoke/${channel}`, args);

// Local mount-swap events (login-success / logout).
const shellListeners = new Map<string, Set<Listener>>();
const onShellEvent = (channel: string, fn: Listener) => {
    const set = shellListeners.get(channel) ?? new Set<Listener>();
    shellListeners.set(channel, set.add(fn));
    return () => set.delete(fn);
};
const emitShellEvent = (channel: string) => {
    for (const fn of shellListeners.get(channel) ?? []) fn(undefined);
};

// One EventSource for every server event, opened on the first subscription;
// one DOM listener per channel fans out to that channel's subscribers.
let events: EventSource | null = null;
const serverListeners = new Map<string, Set<Listener>>();
const subscribeServer = (channel: string, fn: Listener) => {
    events ??= new EventSource(`/api/events?t=${encodeURIComponent(shellToken)}`);
    let set = serverListeners.get(channel);
    if (!set) {
        const subscribers = new Set<Listener>();
        serverListeners.set(channel, subscribers);
        events.addEventListener(channel, (event) => {
            const payload: unknown = JSON.parse((event as MessageEvent<string>).data);
            for (const listener of subscribers) listener(payload);
        });
        set = subscribers;
    }
    set.add(fn);
    return () => set.delete(fn);
};

const installWebBridge = (): WindowApi => {
    takeShellToken();
    markWebShell();
    const api: Record<string, (...args: never[]) => unknown> = {};

    for (const channel of invokeChannels.filter((name) => !BROWSER_CHANNELS.has(name))) {
        api[kebabToCamel(channel)] = (...args: unknown[]) => invoke(channel, args);
    }
    for (const [method, channel] of Object.entries(aliases)) {
        api[method] = (...args: unknown[]) => invoke(channel, args);
    }
    for (const [method, channel] of Object.entries(eventMethods)) {
        api[method] = (callback: Listener) => subscribeServer(channel, callback);
    }

    api.login = () => emitShellEvent(sendMethods.login);
    api.logout = async () => {
        let refused = false;
        try {
            const answer = await post('/api/logout', []);
            refused = isPlainObject(answer) && answer.success === false;
        } finally {
            // A logout the settings refused did not log anyone out: the screen stays, and the caller tells the user.
            if (!refused) emitShellEvent(sendMethods.logout);
        }
        if (refused) throw new Error(LOGOUT_NOT_SAVED);
    };

    api.openExternalUrl = (url: unknown) => {
        // Same https-only gate as the Electron and Capacitor shells (format/urlSafe).
        if (!isSafeExternalUrl(url)) {
            return Promise.resolve({ success: false, error: 'Only https:// URLs can be opened' });
        }
        // isSafeExternalUrl only passes a string.
        globalThis.open(url as string, '_blank', 'noopener');
        return Promise.resolve({ success: true });
    };
    api.reloadWindow = () => {
        globalThis.location.reload();
        return Promise.resolve({ success: true });
    };
    api.refreshMenu = () => Promise.resolve({ success: true }); // no application menu in a browser

    // Assembled by channel name from the manifest, so the checker cannot
    // follow it to WindowApi; the server answers with the handlers WindowApi
    // is derived from.
    (globalThis as typeof globalThis & { api?: object }).api = api;
    return api as WindowApi;
};

export { installWebBridge, onShellEvent, BROWSER_CHANNELS };
