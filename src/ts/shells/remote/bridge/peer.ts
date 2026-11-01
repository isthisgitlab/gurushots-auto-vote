/**
 * Remote peer bridge — populates window.api in the phone's browser tab over the pairing
 * connection, generated from the channel manifest like bridge/web.ts:
 *
 *   - invoke methods send an `invoke` message to the desktop host and settle when its
 *     `result` arrives; the desktop enforces the remote allowlist;
 *   - open-external-url / reload-window / refresh-menu act in the phone (like
 *     BROWSER_CHANNELS in bridge/web.ts — the desktop window is not the phone's);
 *   - event methods subscribe to a local pub/sub fed by the host's `event` messages;
 *   - the connection state (connecting / connected / offline / try Wi-Fi / update) is
 *     exposed for the page's header badge.
 *
 * The desktop host is told from a fellow phone by its `hello`: only the host's hello carries
 * `host: true`. When the connection is lost, in-flight invokes are settled once — a spend
 * channel answers "unclear — check before retrying" (the `postOnce` rule: the desktop may
 * have run it), every other channel reports a failure — and the pending set is emptied, so
 * nothing is ever replayed after a reconnect.
 *
 * Loaded only by the remote renderer entries, so it stays free of Node-side modules.
 */

import { invokeChannels, aliases, eventMethods, kebabToCamel } from '../../../core/ipc/manifest';
import { markPlatformKind } from '../../../core/platform/kind';
import { parsePeerMessage, PROTOCOL_VERSION } from '../../../core/remote/protocol';

import type { HelloMessage } from '../../../core/remote/protocol';
import { SPEND_REMOTE_CHANNELS } from '../../../core/remote/allowlist';
import { setRemoteConnectionState } from '../../../core/remote/connectionState';
import { isConnectionFailureJoinError } from '../../../core/remote/trystero';
import { isSafeExternalUrl } from '../../../core/format/urlSafe';
import { rendererTranslator } from '../../../core/translations/renderer';
import * as pkg from '../../../../../package.json';

import type { RemoteTransport } from '../../../core/remote/relays';

/** The app version this page was built from; the host's `hello` version is compared against it. */
const PAGE_VERSION: string = pkg.version;

type PendingInvoke = {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
    spend: boolean;
};

// Invoke channels the phone answers itself: the desktop window is not the phone's.
const LOCAL_CHANNELS: ReadonlySet<string> = new Set(['open-external-url', 'reload-window', 'refresh-menu']);

export { LOCAL_CHANNELS };

type Listener = (payload: unknown) => void;

/**
 * Installs the bridge: marks the platform kind (synchronously, before anything mounts),
 * generates the window.api surface, and drives the connection state machine (the state lives
 * in core/remote/connectionState.ts, where the page's React reads it).
 */
const installPeerBridge = (transport: RemoteTransport): void => {
    markPlatformKind('remote');

    const pending = new Map<number, PendingInvoke>();
    const heldSends: Array<{ id: number; message: object }> = [];
    const listeners = new Map<string, Set<Listener>>();
    let nextId = 0;
    let hostPeerId: string | null = null;
    /** Whether the desktop has ever completed a hello in this page's life. Only before that
     * first connect may a non-spend invoke be held; after a loss nothing queues. */
    let everConnected = false;

    const dispatchEvent = (channel: string, payload: unknown): void => {
        for (const listener of listeners.get(channel) ?? []) listener(payload);
    };

    const lostSpendAnswer = (): { success: false; error: string } => ({
        success: false,
        error: rendererTranslator.t('errors.remoteSpendUnclear'),
    });
    const lostFailure = (): Error => new Error(rendererTranslator.t('errors.remoteConnectionLost'));

    /** Settle every pending invoke once. A spend may have run: unclear, never a failure. */
    const settlePendingForLostConnection = (): void => {
        hostPeerId = null;
        for (const [, invoke] of pending) {
            if (invoke.spend) invoke.resolve(lostSpendAnswer());
            else invoke.reject(lostFailure());
        }
        pending.clear();
        heldSends.length = 0;
        setRemoteConnectionState('offline');
    };

    const flushHeld = (to: string): void => {
        // oxlint-disable-next-line frame-guard/no-unfiltered-frame-send -- a peer-connection message over the pairing transport, never a frame send
        for (const held of heldSends.splice(0)) void transport.send(held.message, to);
    };

    transport.onMessage((peerId, raw) => {
        const message = parsePeerMessage(raw);
        if (message === null) return;
        switch (message.t) {
            case 'hello': {
                if (!message.host) return; // a fellow phone announcing itself, not the desktop
                if (message.version !== PAGE_VERSION || message.protocolVersion !== PROTOCOL_VERSION) {
                    setRemoteConnectionState('update');
                    return;
                }
                if (hostPeerId === null) {
                    hostPeerId = peerId;
                    everConnected = true;
                    setRemoteConnectionState('connected');
                    flushHeld(hostPeerId);
                }
                return;
            }
            case 'result': {
                const invoke = pending.get(message.id);
                if (!invoke) return;
                pending.delete(message.id);
                if (message.ok) invoke.resolve(message.result);
                else invoke.reject(new Error(message.error));
                return;
            }
            case 'event': {
                dispatchEvent(message.channel, message.payload);
                return;
            }
            case 'bye': {
                settlePendingForLostConnection();
                return;
            }
        }
    });

    // The phone's hello: its own app version, the protocol shape version, not the host.
    const announce: HelloMessage = {
        t: 'hello',
        version: PAGE_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        host: false,
    };
    transport.onPeerJoin((peerId) => {
        // oxlint-disable-next-line frame-guard/no-unfiltered-frame-send -- the phone announces itself to the peer over the pairing transport, never a frame send
        void transport.send(announce, peerId);
    });

    transport.onPeerLeave((peerId) => {
        if (hostPeerId !== null && peerId !== hostPeerId) return;
        settlePendingForLostConnection();
    });

    transport.onJoinError(({ error }) => {
        // Only the "peers saw each other but WebRTC could not connect" error is the try-Wi-Fi
        // state; a wrong password or a handshake failure looks like an offline-or-reset desktop.
        settlePendingForLostConnection();
        setRemoteConnectionState(isConnectionFailureJoinError(error) ? 'network' : 'offline');
    });

    const sendInvoke = (channel: string, args: unknown[]): Promise<unknown> => {
        const id = nextId++;
        const spend = SPEND_REMOTE_CHANNELS.has(channel);
        // JSON has no undefined: send each top-level one as null plus its position, exactly
        // like bridge/web.ts, so the host restores it and a handler's default still applies.
        const undefinedAt = args.flatMap((arg, index) => (arg === undefined ? [index] : []));
        const payload = args.map((arg) => (arg === undefined ? null : arg));
        const message =
            undefinedAt.length > 0
                ? { t: 'invoke', id, channel, args: payload, undefinedAt }
                : { t: 'invoke', id, channel, args: payload };
        return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject, spend });
            if (hostPeerId === null) {
                if (spend || everConnected) {
                    // A spend is never queued: it was not sent, so this is a plain failure,
                    // not an unclear one. After a loss nothing queues into the reconnect.
                    pending.delete(id);
                    reject(new Error(rendererTranslator.t('errors.remoteConnectionLost')));
                    return;
                }
                // The desktop has not said hello yet: hold the send, flush it on connect.
                heldSends.push({ id, message });
                return;
            }
            // oxlint-disable-next-line frame-guard/no-unfiltered-frame-send -- a peer-connection message over the pairing transport, never a frame send
            void transport.send(message, hostPeerId).catch(() => {
                const invoke = pending.get(id);
                if (!invoke) return;
                pending.delete(id);
                if (spend) invoke.resolve(lostSpendAnswer());
                else invoke.reject(lostFailure());
            });
        });
    };

    const api: Record<string, (...args: never[]) => unknown> = {};

    for (const channel of invokeChannels.filter((name) => !LOCAL_CHANNELS.has(name))) {
        api[kebabToCamel(channel)] = (...args: unknown[]) => sendInvoke(channel, args);
    }
    for (const [method, channel] of Object.entries(aliases)) {
        api[method] = (...args: unknown[]) => sendInvoke(channel, args);
    }
    for (const [method, channel] of Object.entries(eventMethods)) {
        api[method] = (callback: Listener) => {
            const set = listeners.get(channel) ?? new Set<Listener>();
            listeners.set(channel, set.add(callback));
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

export { installPeerBridge, PAGE_VERSION };
