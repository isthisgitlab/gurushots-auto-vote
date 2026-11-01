/**
 * The remote-access host: the desktop main window's renderer side of the pairing. While the
 * feature is enabled it joins the pairing room (through the injected transport factory — the
 * trystero adapter in production), answers paired phones' `hello` with the app version and a
 * snapshot, forwards their invokes through the allowlist dispatch to `window.api`, relays the
 * desktop's events and the autovote controller's state, and owns the desktop's one log
 * stream while at least one phone wants it.
 *
 * This is the only remote file allowed to touch `window.api` (it lives in `react/api/`). The
 * pairing key and link never reach this module — the caller hands it the room `key` only for
 * the transport factory — and nothing here ever logs the key, the link, or an invoke's
 * arguments.
 *
 * The one timer stays one: `autovote-command` runs on the caller's own controller, never on
 * a second one built here.
 */

import { useEffect } from 'react';
import { dispatchRemoteInvoke, REMOTE_REFUSAL_PREFIX } from '../../core/remote/dispatch';
import { classifyRemoteChannel } from '../../core/remote/allowlist';
import { parsePeerMessage, restoreInvokeArgs, MAX_PEER_FIELD_LENGTH } from '../../core/remote/protocol';
import { platformKind } from '../../core/platform/kind';
import { kebabToCamel, eventMethods } from '../../core/ipc/manifest';
import { createTrysteroTransport } from '../../core/remote/trystero';
import { rendererTranslator } from '../../core/translations/renderer';
import { deliverElectronNotification } from '../notifications/deadlineNotifier';
import * as ipc from './ipc';

import type { RemoteTransport, RemoteTransportFactory } from '../../core/remote/relays';
import type { AutovoteCommandName } from '../../core/remote/protocol';
import type { AutovoteState } from '../../core/autovote/state';
import type { AutovoteController } from '../../core/autovote/types';

/** At most this many phones are connected at once; the rest are told bye. */
export const MAX_REMOTE_PEERS = 3;

export type RemoteHostDeps = {
    /** Builds the room transport for a pairing key (the trystero adapter in production). */
    createTransport: RemoteTransportFactory;
    /** The desktop's window.api, as untyped callables; arguments are the handlers' to validate. */
    invoke: (channel: string, args: unknown[]) => Promise<unknown>;
    /** The autovote controller's current state, relayed on every change. */
    getAutovoteState: () => AutovoteState;
    /** Runs start/stop/rearm on the caller's own controller. */
    runAutovoteCommand: (command: AutovoteCommandName) => Promise<void>;
    /** The events forwarded to every validated phone: settings-changed and the update-* set. */
    onForwardedEvent: (channel: string, handler: (payload: unknown) => void) => () => void;
    /** The desktop's log feed; the host forwards it only to phones that asked for logs. */
    onLogMessage: (handler: (entry: unknown) => void) => () => void;
    /** Desktop notice when a new phone connects; the caller translates (the deadline notifier's delivery path). */
    notify: () => void;
    /** Best-effort renderer logging (the desktop's own Logs window shows these). */
    logDebug: (message: string) => void;
    /** The app version `hello` announces (package.json's version). */
    version: string;
};

export type RemoteHost = {
    /** Join the room of one pairing key. Answers false when the host is already running. */
    start: (key: string) => Promise<boolean>;
    /** Leave the room and forget every phone. */
    stop: () => Promise<void>;
    /** Whether the host is in the room. */
    isActive: () => boolean;
    /** How many phones are validated and connected. */
    connectedCount: () => number;
    /** Subscribe to connected-count changes (the header badge); answers the unsubscribe. */
    onCountChange: (listener: () => void) => () => void;
    /** Relay the controller's state; called by the owner on every state change. */
    pushAutovoteState: (state: AutovoteState) => void;
};

/** The events forwarded to every validated phone. */
const FORWARDED_EVENT_CHANNELS = new Set([
    'settings-changed',
    'update-checking',
    'update-available',
    'update-not-available',
    'update-download-progress',
    'update-downloaded',
    'update-error',
]);

const clippedId = (value: string): string => value.slice(0, MAX_PEER_FIELD_LENGTH);

/** The app version `hello` announces: package.json at bundle time (esbuild inlines the file). */
export const appVersion = (): string => {
    try {
        return (require('../../../../package.json') as typeof import('../../../../package.json')).version;
    } catch /* istanbul ignore next -- only where package.json is not loadable; the honest mismatch beats a wrong version */ {
        return '0.0.0';
    }
};

export const createRemoteHost = (deps: RemoteHostDeps): RemoteHost => {
    let transport: RemoteTransport | null = null;
    const unsubs: Array<() => void> = [];
    /** The peers that said hello with a matching version — the only ones anything is sent to. */
    const peers = new Set<string>();
    /** The subset of peers that want the log stream. */
    const logPeers = new Set<string>();
    const countListeners = new Set<() => void>();

    const notifyCount = (): void => {
        for (const listener of countListeners) listener();
    };

    const sendTo = async (peerId: string, message: unknown): Promise<void> => {
        if (transport === null) return;
        try {
            // oxlint-disable-next-line frame-guard/no-unfiltered-frame-send -- a peer-connection message over the pairing transport, never a frame send
            await transport.send(message, peerId);
        } catch {
            // A send to a phone that went away mid-flight fails; its leave has been or will be
            // announced separately, so the failure itself is nothing to log.
        }
    };

    const dropPeer = (peerId: string): void => {
        if (!peers.delete(peerId)) return;
        logPeers.delete(peerId);
        if (logPeers.size === 0) void deps.invoke('stop-log-stream', []);
        deps.logDebug(`Remote peer left: ${clippedId(peerId)}`);
        notifyCount();
    };

    const sendSnapshot = async (peerId: string): Promise<void> => {
        await sendTo(peerId, { t: 'hello', version: deps.version, host: true });
        const settings = await deps.invoke('get-settings', []);
        await sendTo(peerId, { t: 'event', channel: 'settings-changed', payload: settings });
        await sendTo(peerId, { t: 'autovote-state', state: deps.getAutovoteState() });
    };

    const answerLogStreamChannel = async (peerId: string, id: number, wants: boolean): Promise<void> => {
        // The log stream is the host's own: it counts the phones that want it and runs the
        // desktop's one stream from the first phone's start until the last one stops. A repeat
        // of the phone's current want is answered without touching the stream.
        const before = logPeers.has(peerId);
        if (wants !== before) {
            if (wants) logPeers.add(peerId);
            else logPeers.delete(peerId);
            const firstWanted = wants && logPeers.size === 1;
            const lastStopped = !wants && logPeers.size === 0;
            if (firstWanted || lastStopped) {
                await deps.invoke(wants ? 'start-log-stream' : 'stop-log-stream', []);
                deps.logDebug(`Phones receiving the log stream: ${logPeers.size}`);
            }
        }
        await sendTo(peerId, { t: 'result', id, ok: true, result: { success: true } });
    };

    const answerInvoke = async (peerId: string, id: number, channel: string, args: unknown[]): Promise<void> => {
        const classified = classifyRemoteChannel(channel);
        if (classified.kind === 'host') {
            await answerLogStreamChannel(peerId, id, channel === 'start-log-stream');
            return;
        }
        const outcome = await dispatchRemoteInvoke(channel, args, {
            invoke: deps.invoke,
            isAutovoteRunning: () => deps.getAutovoteState().running,
        });
        if (outcome.kind === 'refused') {
            deps.logDebug(`Remote invoke refused: ${clippedId(channel)}`);
            await sendTo(peerId, { t: 'result', id, ok: false, error: outcome.error });
            return;
        }
        await sendTo(peerId, { t: 'result', id, ok: true, result: outcome.result });
    };

    const handleMessage = (peerId: string, raw: unknown): void => {
        const message = parsePeerMessage(raw);
        if (message === null) return;
        switch (message.t) {
            case 'hello': {
                if (message.version !== deps.version) {
                    // The version mismatch is told, not served: the phone says to update.
                    void sendTo(peerId, { t: 'hello', version: deps.version, host: true });
                    return;
                }
                if (!peers.has(peerId) && peers.size >= MAX_REMOTE_PEERS) {
                    deps.logDebug(`Remote peer refused: at most ${MAX_REMOTE_PEERS} phones can be connected`);
                    void sendTo(peerId, { t: 'bye' });
                    return;
                }
                const isNew = !peers.has(peerId);
                peers.add(peerId);
                if (isNew) {
                    deps.logDebug(`Remote peer connected: ${clippedId(peerId)}`);
                    notifyCount();
                    deps.notify();
                }
                void sendSnapshot(peerId);
                return;
            }
            case 'invoke': {
                if (!peers.has(peerId)) {
                    void sendTo(peerId, {
                        t: 'result',
                        id: message.id,
                        ok: false,
                        error: `${REMOTE_REFUSAL_PREFIX}: say hello first.`,
                    });
                    return;
                }
                // The channel name only, never the arguments: an invoke's arguments can name
                // anything, and the log is not the place for them.
                deps.logDebug(`Remote invoke: ${clippedId(message.channel)}`);
                void answerInvoke(peerId, message.id, message.channel, restoreInvokeArgs(message));
                return;
            }
            case 'autovote-command': {
                if (!peers.has(peerId)) return;
                deps.logDebug(`Remote auto-vote command: ${message.command}`);
                void deps.runAutovoteCommand(message.command);
                return;
            }
            case 'bye': {
                dropPeer(peerId);
                return;
            }
            /* istanbul ignore next -- parsePeerMessage only returns the seven shapes, each with its case */
            default:
                return;
        }
    };

    return {
        start: async (key) => {
            if (transport !== null) return false;
            const next = await deps.createTransport({ key });
            transport = next;
            unsubs.push(
                next.onMessage(handleMessage),
                next.onPeerJoin((peerId) => {
                    // Nothing is sent before the phone's hello; the join is only logged.
                    deps.logDebug(`Remote peer seen: ${clippedId(peerId)}`);
                }),
                next.onPeerLeave(dropPeer),
            );
            for (const channel of FORWARDED_EVENT_CHANNELS) {
                unsubs.push(
                    deps.onForwardedEvent(channel, (payload) => {
                        for (const peerId of peers) void sendTo(peerId, { t: 'event', channel, payload });
                    }),
                );
            }
            unsubs.push(
                deps.onLogMessage((entry) => {
                    for (const peerId of logPeers)
                        void sendTo(peerId, { t: 'event', channel: 'log-message', payload: entry });
                }),
            );
            const onUnload = (): void => {
                void next.leave();
            };
            globalThis.addEventListener('pagehide', onUnload);
            unsubs.push(() => globalThis.removeEventListener('pagehide', onUnload));
            deps.logDebug('Remote access host started');
            return true;
        },
        stop: async () => {
            if (transport === null) return;
            const leaving = transport;
            transport = null;
            for (const unsub of unsubs.splice(0)) unsub();
            peers.clear();
            logPeers.clear();
            notifyCount();
            deps.logDebug('Remote access host stopped');
            await leaving.leave();
        },
        isActive: () => transport !== null,
        connectedCount: () => peers.size,
        onCountChange: (listener) => {
            countListeners.add(listener);
            return () => countListeners.delete(listener);
        },
        pushAutovoteState: (state) => {
            if (transport === null || peers.size === 0) return;
            for (const peerId of peers) void sendTo(peerId, { t: 'autovote-state', state });
        },
    };
};

/**
 * The connected-count of the running host, as an external store for the header badge. The
 * host instance registers itself below; without one (remote access off, or not the desktop)
 * the count answers zero and the badge hides.
 */
let activeHost: RemoteHost | null = null;
let activeHostUnsub: (() => void) | null = null;
const badgeListeners = new Set<() => void>();

const badgeNotify = (): void => {
    for (const listener of badgeListeners) listener();
};

/** Registers a host as the running one (or clears the registration with null). */
export const setActiveRemoteHost = (host: RemoteHost | null): void => {
    activeHostUnsub?.();
    activeHostUnsub = null;
    activeHost = host;
    if (host !== null) activeHostUnsub = host.onCountChange(badgeNotify);
    badgeNotify();
};

/** Subscribes to remote-host count changes for non-React consumers; answers the unsubscribe. */
export const subscribeRemoteConnectionCount = (listener: () => void): (() => void) => {
    badgeListeners.add(listener);
    return () => badgeListeners.delete(listener);
};

/** The connected-phone count the badge shows; 0 when no host runs. */
export const remoteConnectionCount = (): number => (activeHost === null ? 0 : activeHost.connectedCount());

/** Relays the controller's state to the paired phones through the running host, if any. */
export const pushAutovoteStateToActiveHost = (state: AutovoteState): void => {
    activeHost?.pushAutovoteState(state);
};

/** The manifest's event channel → window.api method map (settings-changed → onSettingsChanged, …). */
const METHOD_BY_EVENT_CHANNEL: Record<string, string> = Object.fromEntries(
    Object.entries(eventMethods).map(([method, channel]) => [channel, method]),
);

/**
 * The desktop's remote-access host, mounted by AutovoteProvider on the electron kind: joins
 * the pairing room while the feature is enabled, and re-syncs when the Settings section
 * toggles it or resets the key (the `remote-access:changed` window event). A window close or
 * an app quit tears the effect down, and the host leaves the room (`stop`); a renderer that
 * dies without running its cleanup takes the connections with it, which is the same result.
 */
export const useDesktopRemoteHost = (controller: AutovoteController): void => {
    useEffect(() => {
        if (platformKind() !== 'electron') return;
        let disposed = false;
        let host: RemoteHost | null = null;
        let currentKey: string | null = null;
        const takeDown = async (): Promise<void> => {
            if (host === null) return;
            const leaving = host;
            host = null;
            currentKey = null;
            setActiveRemoteHost(null);
            await leaving.stop();
        };
        const sync = async (): Promise<void> => {
            const answer = await ipc.callOrNull(() => ipc.getRemoteAccess());
            // `answer` may be null (the query failed) or undefined (a host without the channel);
            // both mean the feature is off here.
            const key =
                answer !== null &&
                answer !== undefined &&
                answer.success === true &&
                answer.enabled === true &&
                typeof answer.link === 'string'
                    ? (new URLSearchParams(answer.link.slice(answer.link.indexOf('#') + 1)).get('k') ?? null)
                    : null;
            if (disposed) return;
            if (key === null) {
                await takeDown();
                return;
            }
            if (host !== null && key === currentKey) return;
            await takeDown();
            currentKey = key;
            const joined = createRemoteHost({
                createTransport: (options) => createTrysteroTransport(options),
                invoke: (channel, args) =>
                    Promise.resolve(
                        (window.api as unknown as Record<string, (...callArgs: unknown[]) => unknown>)[
                            kebabToCamel(channel)
                        ](...args),
                    ),
                getAutovoteState: () => controller.getState(),
                runAutovoteCommand: (command) =>
                    command === 'start'
                        ? controller.start()
                        : command === 'stop'
                          ? controller.stop()
                          : controller.rearmSchedule(),
                onForwardedEvent: (channel, handler) => {
                    // A bridge always answers its event methods with the unsubscribe; a test
                    // mock may answer nothing, which is as good as nothing to unsubscribe.
                    const api = window.api as unknown as Record<
                        string,
                        (callback: (...eventArgs: never[]) => void) => (() => void) | undefined
                    >;
                    const unsubscribe = api[METHOD_BY_EVENT_CHANNEL[channel]]((...eventArgs: never[]) =>
                        handler(eventArgs[0]),
                    );
                    // eslint-disable-next-line no-console
                    console.log('PROBE400', channel, METHOD_BY_EVENT_CHANNEL[channel], typeof unsubscribe);
                    return typeof unsubscribe === 'function' ? unsubscribe : () => undefined;
                },
                onLogMessage: (handler) => {
                    const unsubscribe: unknown = (
                        window.api as unknown as {
                            onLogMessage: (cb: (entry: unknown) => void) => (() => void) | undefined;
                        }
                    ).onLogMessage(handler);
                    return (): void => {
                        (unsubscribe as (() => void) | undefined)?.();
                    };
                },
                notify: () =>
                    deliverElectronNotification({
                        title: rendererTranslator.t('app.title'),
                        body: rendererTranslator.t('app.remoteConnectedNotice'),
                    }),
                logDebug: (message) => void ipc.logRendererDebug(message),
                version: appVersion(),
            });
            // The instance is kept locally: a cleanup that ran while the room was being joined
            // has already nulled `host`, and this join must still be taken down.
            host = joined;
            await joined.start(key);
            if (disposed) {
                setActiveRemoteHost(null);
                await joined.stop();
                return;
            }
            setActiveRemoteHost(joined);
        };
        const onPairingChange = (): void => {
            void sync();
        };
        void sync();
        window.addEventListener('remote-access:changed', onPairingChange);
        return () => {
            disposed = true;
            window.removeEventListener('remote-access:changed', onPairingChange);
            void takeDown();
        };
    }, [controller]);
};
