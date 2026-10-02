/**
 * Web bridge — populates window.api in an ordinary browser tab, served by the
 * web shell (web/server.ts). The surface is generated from the channel
 * manifest, like preload.ts on Electron:
 *
 *   - invoke methods POST to /api/invoke/<channel>; a handler that throws
 *     rejects the call, as ipcRenderer.invoke does;
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
import { isSafeExternalUrl } from '../format/urlSafe';

import type { WindowApi } from '../types/ipc';

type Listener = (payload: unknown) => void;

// Invoke channels the browser answers itself: the server has no window to
// open, reload or put a menu on. Every other invoke channel is served by
// web/server.ts.
const BROWSER_CHANNELS: ReadonlySet<string> = new Set(['open-external-url', 'reload-window', 'refresh-menu']);

const post = async (url: string, args: unknown[]) => {
    // JSON has no undefined: send each one as null plus its position so the
    // server restores it and a handler's default parameter still applies.
    const undefinedAt = args.flatMap((arg, index) => (arg === undefined ? [index] : []));
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ args, undefinedAt }),
    });
    const body = (await response.json()) as { result?: unknown; error?: string };
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
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
    events ??= new EventSource('/api/events');
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
        try {
            await post('/api/logout', []);
        } finally {
            emitShellEvent(sendMethods.logout);
        }
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
