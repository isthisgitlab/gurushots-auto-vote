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
import {
    isWithinPeerMessageLimit,
    parsePeerMessage,
    restoreInvokeArgs,
    MAX_PEER_FIELD_LENGTH,
    PAGE_VERSION,
    PROTOCOL_VERSION,
    REMOTE_RESULT_TOO_LARGE,
} from '../../core/remote/protocol';
import { platformKind } from '../../core/platform/kind';
import { aliases, kebabToCamel, eventMethods } from '../../core/ipc/manifest';
import { errorMessage } from '../../core/errorMessage';
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
    /** Best-effort renderer logging at INFO (the desktop's own Logs window and log files show these). */
    logInfo: (message: string) => void;
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
export const appVersion = (): string => PAGE_VERSION;

/** A short, single-line error text for a phone: bounded to what a `result` message accepts. */
const shortError = (error: unknown): string => {
    const text = (errorMessage(error) ?? '').replace(/\s+/g, ' ').trim();
    return (text.length > 0 ? text : 'The computer could not run this.').slice(0, MAX_PEER_FIELD_LENGTH);
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

    /** Ends the desktop's one log stream. A failure is nobody's to answer: the stream ends with the window anyway. */
    const releaseLogStream = async (): Promise<void> => {
        try {
            await deps.invoke('stop-log-stream', []);
        } catch {
            // see above
        }
    };

    const dropPeer = (peerId: string): void => {
        if (!peers.delete(peerId)) return;
        if (logPeers.delete(peerId) && logPeers.size === 0) void releaseLogStream();
        deps.logInfo(`Remote peer left: ${clippedId(peerId)}`);
        notifyCount();
    };

    /** The host's own `hello`: its version and protocol, nothing else. */
    const sendHostHello = (peerId: string): Promise<void> =>
        sendTo(peerId, { t: 'hello', version: deps.version, protocolVersion: PROTOCOL_VERSION, host: true });

    const sendSnapshot = async (peerId: string): Promise<void> => {
        await sendHostHello(peerId);
        try {
            const settings = await deps.invoke('get-settings', []);
            await sendTo(peerId, { t: 'event', channel: 'settings-changed', payload: settings });
        } catch {
            // The phone reads the settings itself through its own invokes, each answered or failed on its own.
            deps.logInfo('Remote invoke failed: get-settings');
        }
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
                deps.logInfo(`Phones receiving the log stream: ${logPeers.size}`);
            }
        }
        await sendTo(peerId, { t: 'result', id, ok: true, result: { success: true } });
    };

    const answerHostChannel = async (peerId: string, id: number, channel: string): Promise<void> => {
        if (channel === 'cleanup-stale-metadata') {
            // Answered with success and nothing is done: the phone never triggers a cleanup here.
            await sendTo(peerId, { t: 'result', id, ok: true, result: { success: true } });
            return;
        }
        await answerLogStreamChannel(peerId, id, channel === 'start-log-stream');
    };

    /** Sends one invoke's answer; a result too large for a peer to accept becomes a failure the phone can see. */
    const sendResult = async (peerId: string, id: number, channel: string, result: unknown): Promise<void> => {
        const answer = { t: 'result', id, ok: true, result };
        if (isWithinPeerMessageLimit(answer)) {
            await sendTo(peerId, answer);
            return;
        }
        deps.logInfo(`Remote invoke failed: ${clippedId(channel)}`);
        await sendTo(peerId, { t: 'result', id, ok: false, error: REMOTE_RESULT_TOO_LARGE });
    };

    const answerInvoke = async (peerId: string, id: number, channel: string, args: unknown[]): Promise<void> => {
        try {
            if (classifyRemoteChannel(channel).kind === 'host') {
                await answerHostChannel(peerId, id, channel);
                return;
            }
            const outcome = await dispatchRemoteInvoke(channel, args, { invoke: deps.invoke });
            if (outcome.kind === 'refused') {
                deps.logInfo(`Remote invoke refused: ${clippedId(channel)}`);
                await sendTo(peerId, { t: 'result', id, ok: false, error: outcome.error });
                return;
            }
            await sendResult(peerId, id, channel, outcome.result);
        } catch (error) {
            // Every failure answers the phone: an unanswered invoke would hang there until the connection drops.
            deps.logInfo(`Remote invoke failed: ${clippedId(channel)}`);
            await sendTo(peerId, { t: 'result', id, ok: false, error: shortError(error) });
        }
    };

    /** Runs a phone's start/stop/rearm; a failure is logged, the controller's own state tells the phone. */
    const runCommand = async (command: AutovoteCommandName): Promise<void> => {
        try {
            await deps.runAutovoteCommand(command);
        } catch {
            deps.logInfo(`Remote auto-vote command failed: ${command}`);
        }
    };

    const handleMessage = (peerId: string, raw: unknown): void => {
        const message = parsePeerMessage(raw);
        if (message === null) return;
        switch (message.t) {
            case 'hello': {
                if (
                    message.role === 'loader' ||
                    message.version !== deps.version ||
                    message.protocolVersion !== PROTOCOL_VERSION
                ) {
                    // The loader only asks the version, and a mismatch is told, not served: neither gets a
                    // snapshot, a peer slot, a count or a desktop notice.
                    void sendHostHello(peerId);
                    return;
                }
                if (!peers.has(peerId) && peers.size >= MAX_REMOTE_PEERS) {
                    deps.logInfo(`Remote peer refused: at most ${MAX_REMOTE_PEERS} phones can be connected`);
                    void sendTo(peerId, { t: 'bye', reason: 'full' });
                    return;
                }
                const isNew = !peers.has(peerId);
                peers.add(peerId);
                if (isNew) {
                    deps.logInfo(`Remote peer connected: ${clippedId(peerId)}`);
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
                deps.logInfo(`Remote invoke: ${clippedId(message.channel)}`);
                void answerInvoke(peerId, message.id, message.channel, restoreInvokeArgs(message));
                return;
            }
            case 'autovote-command': {
                if (!peers.has(peerId)) return;
                deps.logInfo(`Remote auto-vote command: ${message.command}`);
                void runCommand(message.command);
                return;
            }
            case 'bye': {
                dropPeer(peerId);
                return;
            }
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
                    deps.logInfo(`Remote peer seen: ${clippedId(peerId)}`);
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
            deps.logInfo('Remote access host started');
            return true;
        },
        stop: async () => {
            if (transport === null) return;
            const leaving = transport;
            transport = null;
            for (const unsub of unsubs.splice(0)) unsub();
            const heldLogStream = logPeers.size > 0;
            peers.clear();
            logPeers.clear();
            notifyCount();
            deps.logInfo('Remote access host stopped');
            if (heldLogStream) void releaseLogStream();
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
        /** Bumped by every sync that changes the room, so a join still in flight can tell it was overtaken. */
        let generation = 0;
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
            if (key !== null && host !== null && key === currentKey) return;
            const mine = ++generation;
            await takeDown();
            if (key === null || disposed || mine !== generation) return;
            currentKey = key;
            const joined = createRemoteHost({
                createTransport: (options) => createTrysteroTransport(options),
                invoke: callWindowApi,
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
                logInfo: (message) => void ipc.logRemoteInfo(message),
                version: appVersion(),
            });
            // The instance is kept locally: a cleanup that ran while the room was being joined
            // has already nulled `host`, and this join must still be taken down.
            host = joined;
            await joined.start(key);
            if (disposed || mine !== generation) {
                // Switched off, re-keyed or unmounted while the room was being joined: the join that just
                // completed must not stay in the room. A newer sync owns the registration, so only an
                // unmount clears it.
                if (disposed) setActiveRemoteHost(null);
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
