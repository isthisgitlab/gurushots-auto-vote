/**
 * `useDesktopRemoteHost` — the desktop's remote-access host hook, mounted by
 * AutovoteProvider on the electron kind. It builds the host's deps over this
 * window's bridge, joins the pairing room while the feature is enabled, and
 * re-syncs when the Settings section toggles it or resets the key (the
 * `remote-access:changed` window event). A window close or an app quit tears
 * the effect down, and the host leaves the room (`stop`); a renderer that dies
 * without running its cleanup takes the connections with it, which is the same
 * result.
 */

import { useEffect } from 'react';
import { platformKind } from '../../core/platform/kind';
import { aliases, kebabToCamel } from '../../core/ipc/manifest';
import { createTrysteroTransport } from '../../core/remote/trystero';
import { rendererTranslator } from '../../core/translations/renderer';
import { deliverElectronNotification } from '../notifications/deadlineNotifier';
import * as ipc from './ipc';
import { appVersion, createRemoteHost } from './remoteHostCreate';
import { setActiveRemoteHost } from './remoteHostBadge';

import type { AutovoteController } from '../../core/autovote/types';
import type { WindowApi } from '../../core/types/ipc';
import type { ForwardedEventChannel, RemoteHost, RemoteHostDeps } from './remoteHostCreate';

/**
 * A bridge event subscriber, derived from WindowApi (every event method there
 * shares one signature). The answer keeps `undefined`: a bridge answers its
 * event methods with the unsubscribe, while a host without the event — or a
 * test mock — may answer nothing.
 */
type BridgeEventSubscriber = (
    callback: Parameters<WindowApi['onSettingsChanged']>[0],
) => ReturnType<WindowApi['onSettingsChanged']> | undefined;

/** The manifest's event channel → the typed window.api subscriber (settings-changed → onSettingsChanged, …). */
const SUBSCRIBER_BY_EVENT_CHANNEL = {
    'settings-changed': ipc.onSettingsChanged,
    'update-checking': ipc.onUpdateChecking,
    'update-available': ipc.onUpdateAvailable,
    'update-not-available': ipc.onUpdateNotAvailable,
    'update-download-progress': ipc.onDownloadProgress,
    'update-downloaded': ipc.onUpdateDownloaded,
    'update-error': ipc.onUpdateError,
} as const satisfies Record<ForwardedEventChannel, BridgeEventSubscriber>;

/** Subscribes one handler through a typed bridge subscriber; a missing unsubscribe answer becomes a no-op. */
const subscribeEvent = (subscriber: BridgeEventSubscriber, handler: (payload: unknown) => void): (() => void) => {
    const unsubscribe = subscriber((...eventArgs: never[]) => handler(eventArgs[0]));
    return typeof unsubscribe === 'function' ? unsubscribe : () => undefined;
};

/** The window.api method that serves a manifest channel: an alias target keeps its own method name. */
const METHOD_BY_ALIAS_CHANNEL = new Map<string, string>(
    Object.entries(aliases).map(([method, channel]) => [channel, method]),
);
const methodForChannel = (channel: string): string => METHOD_BY_ALIAS_CHANNEL.get(channel) ?? kebabToCamel(channel);

/** The desktop's window.api, called by manifest channel. A channel without a method rejects. */
const callWindowApi = async (channel: string, args: unknown[]): Promise<unknown> => {
    const api: Record<string, ((...callArgs: never[]) => unknown) | undefined> = window.api;
    const method = api[methodForChannel(channel)];
    if (typeof method !== 'function') throw new Error(`No window.api method serves ${channel}`);
    return method.apply(window.api, args as never[]);
};

/** The pairing answer the sync reads: the bridge's answer, null for a failed query, undefined for a host without the channel — any of them may mean the feature is off here. */
type PairingAnswer = Awaited<ReturnType<typeof ipc.getRemoteAccess>> | null | undefined;

/** The pairing key the answer's link carries (`k` after the `#`), or null when the feature is off here, the answer is unusable, or the link names no key. */
const pairingKeyFrom = (answer: PairingAnswer): string | null => {
    if (answer === null || answer === undefined) return null;
    if (answer.success !== true || answer.enabled !== true || typeof answer.link !== 'string') return null;
    return new URLSearchParams(answer.link.slice(answer.link.indexOf('#') + 1)).get('k') ?? null;
};

/** The host's deps over this desktop: the trystero room, this window's bridge, the caller's controller, and the desktop's events, log feed and notices. */
const buildHostDeps = (controller: AutovoteController): RemoteHostDeps => ({
    createTransport: (options) => createTrysteroTransport(options),
    invoke: callWindowApi,
    getAutovoteState: () => controller.getState(),
    runAutovoteCommand: (command) =>
        command === 'start' ? controller.start() : command === 'stop' ? controller.stop() : controller.rearmSchedule(),
    onForwardedEvent: (channel, handler) => subscribeEvent(SUBSCRIBER_BY_EVENT_CHANNEL[channel], handler),
    onLogMessage: (handler) => subscribeEvent(ipc.onLogMessage, handler),
    notify: () =>
        deliverElectronNotification({
            title: rendererTranslator.t('app.title'),
            body: rendererTranslator.t('app.remoteConnectedNotice'),
        }),
    logInfo: (message) => void ipc.logRemoteInfo(message),
    version: appVersion(),
});

/** The effect's sync state: what a sync and a teardown read and hand to each other. */
type HookState = {
    /** Set on unmount; every in-flight step checks it before it acts. */
    disposed: boolean;
    /** The host while it owns the room (or is still joining it). */
    host: RemoteHost | null;
    /** The room key the current host joined with. */
    currentKey: string | null;
    /** Bumped by every sync that changes the room, so a join still in flight can tell it was overtaken. */
    generation: number;
};

const takeDown = async (state: HookState): Promise<void> => {
    if (state.host === null) return;
    const leaving = state.host;
    state.host = null;
    state.currentKey = null;
    setActiveRemoteHost(null);
    await leaving.stop();
};

const sync = async (state: HookState, controller: AutovoteController): Promise<void> => {
    const answer = await ipc.callOrNull(() => ipc.getRemoteAccess());
    const key = pairingKeyFrom(answer);
    if (state.disposed) return;
    if (key !== null && state.host !== null && key === state.currentKey) return;
    const mine = ++state.generation;
    await takeDown(state);
    if (key === null || state.disposed || mine !== state.generation) return;
    state.currentKey = key;
    const joined = createRemoteHost(buildHostDeps(controller));
    // The instance is kept locally: a cleanup that ran while the room was being joined
    // has already nulled `host`, and this join must still be taken down.
    state.host = joined;
    await joined.start(key);
    if (state.disposed || mine !== state.generation) {
        // Switched off, re-keyed or unmounted while the room was being joined: the join that just
        // completed must not stay in the room. A newer sync owns the registration, so only an
        // unmount clears it.
        if (state.disposed) setActiveRemoteHost(null);
        await joined.stop();
        return;
    }
    setActiveRemoteHost(joined);
};

export const useDesktopRemoteHost = (controller: AutovoteController): void => {
    useEffect(() => {
        if (platformKind() !== 'electron') return;
        const state: HookState = { disposed: false, host: null, currentKey: null, generation: 0 };
        const onPairingChange = (): void => {
            void sync(state, controller);
        };
        void sync(state, controller);
        window.addEventListener('remote-access:changed', onPairingChange);
        return () => {
            state.disposed = true;
            window.removeEventListener('remote-access:changed', onPairingChange);
            void takeDown(state);
        };
    }, [controller]);
};
