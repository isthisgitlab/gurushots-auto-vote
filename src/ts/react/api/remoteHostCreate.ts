/**
 * `createRemoteHost` — the desktop host one pairing room is built around. The
 * composer wires the shared room state (`HostContext`, remoteHostPeers.ts) to
 * the message switch (remoteHostMessages.ts) and the answers a validated
 * phone gets (remoteHostAnswers.ts), and owns the start/stop lifecycle: the
 * subscriptions a joined room holds, and the teardown that forgets the peers
 * and leaves.
 */

import { PAGE_VERSION } from '../../core/remote/protocol';

import type { RemoteTransportFactory } from '../../core/remote/relays';
import type { eventMethods } from '../../core/ipc/manifest';
import type { AutovoteCommandName } from '../../core/remote/protocol';
import type { AutovoteState } from '../../core/autovote/state';
import { clippedId, dropPeer, notifyCount, releaseLogStream, sendTo } from './remoteHostPeers';
import type { HostContext } from './remoteHostPeers';
import { handleMessage } from './remoteHostMessages';

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
    onForwardedEvent: (channel: ForwardedEventChannel, handler: (payload: unknown) => void) => () => void;
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
    /** How many of those are reached only over the relay fallback. */
    relayCount: () => number;
    /** Subscribe to connected-count changes (the header badge); answers the unsubscribe. */
    onCountChange: (listener: () => void) => () => void;
    /** Relay the controller's state; called by the owner on every state change. */
    pushAutovoteState: (state: AutovoteState) => void;
};

/** A manifest event channel (`eventMethods` maps the subscriber method names to these). */
type EventChannel = (typeof eventMethods)[keyof typeof eventMethods];

/** The events forwarded to every validated phone. */
const FORWARDED_EVENT_CHANNEL_NAMES = [
    'settings-changed',
    'update-checking',
    'update-available',
    'update-not-available',
    'update-download-progress',
    'update-downloaded',
    'update-error',
] as const satisfies readonly EventChannel[];

export type ForwardedEventChannel = (typeof FORWARDED_EVENT_CHANNEL_NAMES)[number];

const FORWARDED_EVENT_CHANNELS: ReadonlySet<ForwardedEventChannel> = new Set(FORWARDED_EVENT_CHANNEL_NAMES);

/** The app version `hello` announces: package.json at bundle time (esbuild inlines the file). */
export const appVersion = (): string => PAGE_VERSION;

export const createRemoteHost = (deps: RemoteHostDeps): RemoteHost => {
    const ctx: HostContext = {
        deps,
        transport: null,
        peers: new Set<string>(),
        notified: new Set<string>(),
        logPeers: new Set<string>(),
        countListeners: new Set<() => void>(),
    };
    const unsubs: Array<() => void> = [];

    return {
        start: async (key) => {
            if (ctx.transport !== null) return false;
            const next = await deps.createTransport({ key, role: 'host' });
            ctx.transport = next;
            unsubs.push(
                next.onMessage((peerId, raw) => handleMessage(ctx, peerId, raw)),
                next.onPeerJoin((peerId) => {
                    // Nothing is sent before the phone's hello; the join is only logged, with the path it came over.
                    deps.logInfo(`Remote peer seen: ${clippedId(peerId)} (${next.peerPath?.(peerId) ?? 'direct'})`);
                }),
                next.onPeerLeave((peerId) => dropPeer(ctx, peerId)),
            );
            for (const channel of FORWARDED_EVENT_CHANNELS) {
                unsubs.push(
                    deps.onForwardedEvent(channel, (payload) => {
                        for (const peerId of ctx.peers) void sendTo(ctx, peerId, { t: 'event', channel, payload });
                    }),
                );
            }
            unsubs.push(
                deps.onLogMessage((entry) => {
                    for (const peerId of ctx.logPeers)
                        void sendTo(ctx, peerId, { t: 'event', channel: 'log-message', payload: entry });
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
            if (ctx.transport === null) return;
            const leaving = ctx.transport;
            ctx.transport = null;
            for (const unsub of unsubs.splice(0)) unsub();
            const heldLogStream = ctx.logPeers.size > 0;
            ctx.peers.clear();
            ctx.notified.clear();
            ctx.logPeers.clear();
            notifyCount(ctx);
            deps.logInfo('Remote access host stopped');
            if (heldLogStream) void releaseLogStream(ctx);
            await leaving.leave();
        },
        isActive: () => ctx.transport !== null,
        connectedCount: () => ctx.peers.size,
        relayCount: () => [...ctx.peers].filter((peerId) => ctx.transport?.peerPath?.(peerId) === 'relay').length,
        onCountChange: (listener) => {
            ctx.countListeners.add(listener);
            return () => ctx.countListeners.delete(listener);
        },
        pushAutovoteState: (state) => {
            if (ctx.transport === null || ctx.peers.size === 0) return;
            for (const peerId of ctx.peers) void sendTo(ctx, peerId, { t: 'autovote-state', state });
        },
    };
};
