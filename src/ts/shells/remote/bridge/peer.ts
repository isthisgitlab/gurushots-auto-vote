/**
 * Remote peer bridge — populates window.api in the phone's browser tab over the pairing
 * connection, generated from the channel manifest like bridge/web.ts:
 *
 *   - invoke methods send an `invoke` message to the desktop host and settle when its
 *     `result` arrives; the desktop enforces the remote allowlist;
 *   - open-external-url / reload-window / refresh-menu act in the phone (like
 *     BROWSER_CHANNELS in bridge/web.ts — the desktop window is not the phone's), and the
 *     log calls are answered here and never sent to the desktop;
 *   - event methods subscribe to a local pub/sub fed by the host's `event` messages;
 *   - the connection state (connecting / connected / offline / try Wi-Fi / update) is
 *     exposed for the page's header badge.
 *
 * The desktop host is told from a fellow phone by its `hello`: only the host's hello carries
 * `host: true`. Results, events and a leave count only from that peer, and a fellow phone's
 * leave or join failure never ends the session. When the connection is lost, in-flight invokes are settled once — a spend
 * channel answers "unclear — check before retrying" (the `postOnce` rule: the desktop may
 * have run it), every other channel reports a failure — and the pending set is emptied, so
 * nothing is ever replayed after a reconnect.
 *
 * Loaded only by the remote renderer entries, so it stays free of Node-side modules.
 */

import { invokeChannels, aliases, eventMethods, kebabToCamel } from '../../../core/ipc/manifest';
import { markPlatformKind } from '../../../core/platform/kind';
import {
    PAGE_VERSION,
    PROTOCOL_VERSION,
    REMOTE_RESULT_UNSENDABLE,
    parsePeerMessage,
} from '../../../core/remote/protocol';
import { SPEND_REMOTE_CHANNELS } from '../../../core/remote/allowlist';
import { REMOTE_REFUSAL_PREFIX } from '../../../core/remote/dispatch';
import {
    remoteConnectionState,
    setRemoteConnectionState,
    setRemoteHostPeerId,
} from '../../../core/remote/connectionState';
import { HOST_ANSWER_TIMEOUT_MS, createHelloRepeater } from '../../../core/remote/helloRepeat';
import { isConnectionFailureJoinError } from '../../../core/remote/trystero';
import { isSafeExternalUrl } from '../../../core/format/urlSafe';
import { rendererTranslator } from '../../../core/translations/renderer';

import type { HelloMessage } from '../../../core/remote/protocol';
import type { RemoteTransport } from '../../../core/remote/relays';

type PendingInvoke = {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
    spend: boolean;
};

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

type Listener = (payload: unknown) => void;

/**
 * Installs the bridge: marks the platform kind (synchronously, before anything mounts),
 * generates the window.api surface, and drives the connection state machine (the state lives
 * in core/remote/connectionState.ts, where the page's React reads it). `loaderTarget` is the
 * absolute loader address the page resolved from its own location — the one place a version
 * mismatch sends the tab to.
 */
const installPeerBridge = (transport: RemoteTransport, loaderTarget: string): void => {
    markPlatformKind('remote');

    const pending = new Map<number, PendingInvoke>();
    const heldSends: Array<{ id: number; message: object }> = [];
    const listeners = new Map<string, Set<Listener>>();
    let nextId = 0;
    let hostPeerId: string | null = null;
    /** Whether the desktop has ever completed a hello in this page's life. Only before that
     * first connect may a non-spend invoke be held; after a loss nothing queues. */
    let everConnected = false;
    /** The peers seen and not yet known to be the desktop or gone: any of them may still answer. */
    const waiting = new Set<string>();

    // The phone's hello: its own app version, the protocol shape version, not the host. It repeats
    // until the desktop answers (core/remote/helloRepeat.ts: the first one can vanish on the relays).
    const announce: HelloMessage = {
        t: 'hello',
        version: PAGE_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        host: false,
    };
    const hello = createHelloRepeater({ transport, announce, active: () => hostPeerId === null });

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
        hello.stop();
        hostPeerId = null;
        setRemoteHostPeerId(null);
        for (const [, invoke] of pending) {
            if (invoke.spend) invoke.resolve(lostSpendAnswer());
            else invoke.reject(lostFailure());
        }
        pending.clear();
        heldSends.length = 0;
        setRemoteConnectionState('offline');
    };

    /**
     * Whether the loss of this peer (it left, or its connection failed) ends the session. The desktop's
     * own loss does; before the desktop has answered, the loss of a joined peer that has not announced
     * itself as a fellow phone does not unless it was the last candidate still pending — a join failure
     * only ever names a peer that never joined, so a candidate that failed was the page's last hope.
     */
    const endsSession = (peerId: string): boolean => {
        hello.leave(peerId);
        waiting.delete(peerId);
        return hostPeerId === null ? waiting.size === 0 : peerId === hostPeerId;
    };

    /** This page does not match the desktop's version: the loader the page named finds the one that does. */
    const goToLoader = (): void => {
        globalThis.location.replace(loaderTarget);
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
                if (!message.host) {
                    // A fellow phone is no candidate for the desktop, so its later failure says nothing about this page's wait.
                    waiting.delete(peerId);
                    return;
                }
                if (message.version !== PAGE_VERSION) {
                    // The desktop runs another version: the stable loader finds the page that matches it
                    // (or says which side to update), so no notice shows here.
                    hello.stop();
                    hello.clear();
                    goToLoader();
                    return;
                }
                if (message.protocolVersion !== PROTOCOL_VERSION) {
                    // The same version with another protocol shape (a build in development): terminal for this
                    // connection — the phone says to update and the hello repeat stops.
                    hello.stop();
                    hello.clear();
                    setRemoteConnectionState('update');
                    return;
                }
                if (hostPeerId === null) {
                    hostPeerId = peerId;
                    setRemoteHostPeerId(peerId);
                    everConnected = true;
                    waiting.clear();
                    hello.clear();
                    hello.stop();
                    setRemoteConnectionState('connected');
                    flushHeld(hostPeerId);
                }
                return;
            }
            case 'result': {
                if (peerId !== hostPeerId) return;
                const invoke = pending.get(message.id);
                if (!invoke) return;
                pending.delete(message.id);
                if (message.ok) invoke.resolve(message.result);
                else if (message.error.startsWith(REMOTE_REFUSAL_PREFIX)) {
                    // A channel the desktop does not serve a phone: the answer a handler would give, in the
                    // phone's language, not the protocol's text.
                    invoke.resolve({ success: false, error: rendererTranslator.t('errors.remoteRefused') });
                } else if (message.error === REMOTE_RESULT_UNSENDABLE) {
                    // The invoke ran; its answer just could not come back. A spend may have landed:
                    // unclear, never a plain failure.
                    if (invoke.spend) invoke.resolve(lostSpendAnswer());
                    else invoke.reject(new Error(rendererTranslator.t('errors.remoteAnswerUnsendable')));
                } else if (message.tooLarge === true) {
                    if (invoke.spend) invoke.resolve(lostSpendAnswer());
                    else invoke.reject(new Error(rendererTranslator.t('errors.remoteResultTooLarge')));
                } else invoke.reject(new Error(message.error));
                return;
            }
            case 'event': {
                if (peerId !== hostPeerId) return;
                dispatchEvent(message.channel, message.payload);
                return;
            }
            case 'bye': {
                // Every bye counts only from the desktop: the known host, or — before it has answered —
                // a joined peer that may still be it. Any other peer's bye changes nothing.
                const fromTheDesktop = peerId === hostPeerId || (hostPeerId === null && waiting.has(peerId));
                if (!fromTheDesktop) return;
                if (hostPeerId === null && message.reason === 'full') {
                    // The desktop already has the most phones it takes — it is there, not offline. Only the
                    // desktop sends this, and it speaks before its hello is ever answered, so the sender is
                    // not yet known as the host.
                    hello.stop();
                    hello.clear();
                    setRemoteConnectionState('full');
                    return;
                }
                settlePendingForLostConnection();
                return;
            }
        }
    });

    transport.onPeerJoin((peerId) => {
        waiting.add(peerId);
        hello.join(peerId);
    });
    transport.onPeerLeave((peerId) => {
        if (endsSession(peerId)) settlePendingForLostConnection();
    });

    transport.onJoinError(({ error, peerId }) => {
        // Only the "peers saw each other but WebRTC could not connect" error is the try-Wi-Fi
        // state; a wrong password or a handshake failure looks like an offline-or-reset desktop.
        if (!endsSession(peerId)) return;
        settlePendingForLostConnection();
        setRemoteConnectionState(isConnectionFailureJoinError(error) ? 'network' : 'offline');
    });

    // Nobody answered in time: the desktop is offline (or the link was reset). The hello repeat keeps
    // running, so a desktop that answers later still moves the page to connected.
    globalThis.setTimeout(() => {
        if (hostPeerId === null && remoteConnectionState() === 'connecting') setRemoteConnectionState('offline');
    }, HOST_ANSWER_TIMEOUT_MS);

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
    // The log calls end here: a phone's lines would only be refused by the desktop.
    for (const channel of ['log-debug', 'log-warning', 'log-error', 'log-api']) {
        api[kebabToCamel(channel)] = () => Promise.resolve({ success: true });
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

export { installPeerBridge };
