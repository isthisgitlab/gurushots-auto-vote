/**
 * The peer bridge's window.api generation: one invoke method per manifest channel (minus
 * the local ones), the alias methods, the event subscriptions — and the handful of calls
 * the phone answers or acts on itself: open-external-url / reload-window / refresh-menu
 * act in the phone (like BROWSER_CHANNELS in bridge/web.ts — the desktop window is not
 * the phone's), and the log calls are answered here and never sent to the desktop. Loaded
 * only by the remote renderer entries, so it stays free of Node-side modules.
 */

import { invokeChannels, aliases, eventMethods, kebabToCamel } from '../../../core/ipc/manifest';
import { isSafeExternalUrl } from '../../../core/format/urlSafe';

import type { PeerBridgeContext, Listener } from './context';
import type { InvokePipeline } from './invokes';
import type { ViewPrefs } from './viewPrefs';

// Invoke channels the phone answers itself: the desktop window is not the phone's, and the phone writes
// no lines into the desktop's logs (the host is refusing them anyway).
const LOCAL_CHANNELS: ReadonlySet<string> = new Set([
    'open-external-url',
    'reload-window',
    'refresh-menu',
    'log-debug',
    'log-warning',
    'log-error',
    'log-api',
]);

export { LOCAL_CHANNELS };

export const installApiSurface = (
    ctx: PeerBridgeContext,
    sendInvoke: InvokePipeline['sendInvoke'],
    viewPrefs: ViewPrefs,
): void => {
    const api: Record<string, (...args: never[]) => unknown> = {};

    // The view-pref channels the phone answers itself (viewPrefs.route): theme, language and the
    // compact flags stay on this device — a phone write never reaches the desktop's config.json,
    // and a desktop change to them reaches the phone only as a seed. Every other channel and key
    // forwards unchanged.
    const invoke = (channel: string, args: unknown[]): Promise<unknown> =>
        viewPrefs.route(channel, args) ?? sendInvoke(channel, args);

    for (const channel of invokeChannels.filter((name) => !LOCAL_CHANNELS.has(name))) {
        api[kebabToCamel(channel)] = (...args: unknown[]) => invoke(channel, args);
    }
    // The log calls end here: a phone's lines would only be refused by the desktop.
    for (const channel of ['log-debug', 'log-warning', 'log-error', 'log-api']) {
        api[kebabToCamel(channel)] = () => Promise.resolve({ success: true });
    }
    for (const [method, channel] of Object.entries(aliases)) {
        api[method] = (...args: unknown[]) => sendInvoke(channel, args);
    }
    for (const [method, channel] of Object.entries(eventMethods)) {
        api[method] = (callback: Listener) => {
            const set = ctx.listeners.get(channel) ?? new Set<Listener>();
            ctx.listeners.set(channel, set.add(callback));
            return () => set.delete(callback);
        };
    }

    // The account lives on the desktop; the phone's window.api has no sign-in of its own.
    api.login = () => {
        throw new Error('Signing in happens on the computer.');
    };
    api.logout = () => Promise.reject(new Error('Logging out happens on the computer.'));

    api.openExternalUrl = (url: unknown) => {
        // Same https-only gate as the Electron and web shells (format/urlSafe).
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
    api.refreshMenu = () => Promise.resolve({ success: true }); // no application menu on the phone

    (globalThis as typeof globalThis & { api?: object }).api = api;
};
