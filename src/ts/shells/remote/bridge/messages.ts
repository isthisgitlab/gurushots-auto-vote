/**
 * The peer bridge's protocol switch: the messages the phone accepts from a peer over
 * the pairing transport. A fellow phone's non-host hello marks it as no candidate;
 * results, events and byes count only from the desktop. Loaded only by the remote
 * renderer entries, so it stays free of Node-side modules.
 */

import { PAGE_VERSION, PROTOCOL_VERSION, parsePeerMessage } from '../../../core/remote/protocol';
import { REMOTE_REFUSAL_PREFIX } from '../../../core/remote/dispatch';
import { setRemoteConnectionState, setRemoteHostPeerId } from '../../../core/remote/connectionState';
import { rendererTranslator } from '../../../core/translations/renderer';

import type { HelloRepeater } from '../../../core/remote/helloRepeat';
import type { ByeMessage, EventMessage, HelloMessage, ResultMessage } from '../../../core/remote/protocol';
import type { PeerBridgeContext } from './context';
import type { InvokePipeline } from './invokes';

/** What the message handlers share: the state, the hello repeat, the invoke pipeline and the loss settle. */
export type MessageWatch = {
    readonly ctx: PeerBridgeContext;
    readonly hello: HelloRepeater;
    readonly pipeline: InvokePipeline;
    /** Settles the pending invokes and reads offline — owned by connection.ts, driven by the bye path. */
    readonly settlePendingForLostConnection: () => void;
    /** The absolute loader address a version mismatch sends the tab to. */
    readonly loaderTarget: string;
};

const dispatchEvent = (ctx: PeerBridgeContext, channel: string, payload: unknown): void => {
    for (const listener of ctx.listeners.get(channel) ?? []) listener(payload);
};

/** This page does not match the desktop's version: the loader the page named finds the one that does. */
const goToLoader = (loaderTarget: string): void => {
    globalThis.location.replace(loaderTarget);
};

const handleHello = (message: HelloMessage, peerId: string, watch: MessageWatch): void => {
    const { ctx, hello, pipeline } = watch;
    if (!message.host) {
        // A fellow phone is no candidate for the desktop, so its later failure says nothing
        // about this page's wait — and its connection failure is not the desktop's.
        ctx.phones.add(peerId);
        ctx.waiting.delete(peerId);
        return;
    }
    if (message.version !== PAGE_VERSION) {
        // The desktop runs another version: the stable loader finds the page that matches it
        // (or says which side to update), so no notice shows here.
        hello.stop();
        hello.clear();
        goToLoader(watch.loaderTarget);
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
    if (ctx.hostPeerId === null) {
        ctx.hostPeerId = peerId;
        setRemoteHostPeerId(peerId);
        ctx.everConnected = true;
        ctx.waiting.clear();
        ctx.phones.clear();
        hello.clear();
        hello.stop();
        setRemoteConnectionState('connected');
        pipeline.flushHeld(ctx.hostPeerId);
    }
};

const handleResult = (message: ResultMessage, peerId: string, watch: MessageWatch): void => {
    const { ctx, pipeline } = watch;
    if (peerId !== ctx.hostPeerId) return;
    const invoke = ctx.pending.get(message.id);
    if (!invoke) return;
    ctx.pending.delete(message.id);
    if (message.ok) invoke.resolve(message.result);
    else if (message.error.startsWith(REMOTE_REFUSAL_PREFIX)) {
        // A channel the desktop does not serve a phone: the answer a handler would give, in the
        // phone's language, not the protocol's text.
        invoke.resolve({ success: false, error: rendererTranslator.t('errors.remoteRefused') });
    } else if (message.reason === 'unsendable') {
        // The invoke ran; its answer just could not come back. A spend may have landed:
        // unclear, never a plain failure.
        if (invoke.spend) invoke.resolve(pipeline.lostSpendAnswer());
        else invoke.reject(new Error(rendererTranslator.t('errors.remoteAnswerUnsendable')));
    } else if (message.reason === 'too-large') {
        if (invoke.spend) invoke.resolve(pipeline.lostSpendAnswer());
        else invoke.reject(new Error(rendererTranslator.t('errors.remoteResultTooLarge')));
    } else invoke.reject(new Error(message.error));
};

const handleEvent = (message: EventMessage, peerId: string, watch: MessageWatch): void => {
    if (peerId !== watch.ctx.hostPeerId) return;
    dispatchEvent(watch.ctx, message.channel, message.payload);
};

const handleBye = (message: ByeMessage, peerId: string, watch: MessageWatch): void => {
    const { ctx, hello, pipeline } = watch;
    // Every bye counts only from the desktop: the known host, or — before it has answered —
    // a joined peer that may still be it. Any other peer's bye changes nothing.
    const fromTheDesktop = peerId === ctx.hostPeerId || (ctx.hostPeerId === null && ctx.waiting.has(peerId));
    if (!fromTheDesktop) return;
    if (ctx.hostPeerId === null && message.reason === 'full') {
        // The desktop already has the most phones it takes — it is there, not offline. Only the
        // desktop sends this, and it speaks before its hello is ever answered, so the sender is
        // not yet known as the host. A held invoke was never sent, so each one fails plainly —
        // a held invoke is never a spend, so no unclear answer is due — instead of hanging forever.
        hello.stop();
        hello.clear();
        pipeline.failHeldAsLost();
        setRemoteConnectionState('full');
        return;
    }
    watch.settlePendingForLostConnection();
};

export const watchPeerMessages = (watch: MessageWatch): void => {
    watch.ctx.transport.onMessage((peerId, raw) => {
        const message = parsePeerMessage(raw);
        if (message === null) return;
        switch (message.t) {
            case 'hello':
                handleHello(message, peerId, watch);
                return;
            case 'result':
                handleResult(message, peerId, watch);
                return;
            case 'event':
                handleEvent(message, peerId, watch);
                return;
            case 'bye':
                handleBye(message, peerId, watch);
                return;
        }
    });
};
