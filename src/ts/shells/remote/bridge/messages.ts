/**
 * The peer bridge's protocol switch: the messages the phone accepts from a peer over
 * the pairing transport. A fellow phone's non-host hello marks it as no candidate;
 * results, events and byes count only from the desktop. Loaded only by the remote
 * renderer entries, so it stays free of Node-side modules.
 */

import { LINK_VERSION, parsePeerMessage } from '../../../core/remote/protocol';
import { classifyRemoteChannel } from '../../../core/remote/allowlist';
import { REMOTE_REFUSAL_PREFIX, REMOTE_SAY_HELLO_FIRST, isAllowedWrite } from '../../../core/remote/dispatch';
import { setRemoteConnectionState, setRemoteHostPath, setRemoteHostPeerId } from '../../../core/remote/connectionState';
import { rendererTranslator } from '../../../core/translations/renderer';

import type { HelloRepeater } from '../../../core/remote/helloRepeat';
import type { ByeMessage, EventMessage, HelloMessage, ResultMessage } from '../../../core/remote/protocol';
import type { RemoteRefusalKey } from '../../../react/api/useActiveChallenges';
import type { PeerBridgeContext } from './context';
import type { InvokePipeline } from './invokes';
import type { ViewPrefs } from './viewPrefs';

/** What the message handlers share: the state, the hello repeat, the invoke pipeline and the loss settle. */
export type MessageWatch = {
    readonly ctx: PeerBridgeContext;
    readonly hello: HelloRepeater;
    readonly pipeline: InvokePipeline;
    /** Settles the pending invokes and reads offline — owned by connection.ts, driven by the bye path. */
    readonly settlePendingForLostConnection: () => void;
    /** Stops the attempted session and shows the existing incompatibility notice. */
    readonly stopForIncompatibility: (state: 'update' | 'update-this') => void;
    /** Settles what is in flight and asks the desktop at `peerId` to take this phone back — owned by connection.ts. */
    readonly reconnect: (peerId: string) => void;
    /** The phone-local view settings: a desktop settings-changed payload is seeded and overlaid through it. */
    readonly viewPrefs: ViewPrefs;
};

const dispatchEvent = (ctx: PeerBridgeContext, channel: string, payload: unknown): void => {
    for (const listener of ctx.listeners.get(channel) ?? []) listener(payload);
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
    if (message.linkVersion !== LINK_VERSION) {
        // Once a desktop is accepted, only that peer can stop this page; before one is, the first desktop's
        // hello decides.
        if (ctx.hostPeerId !== null && peerId !== ctx.hostPeerId) return;
        watch.stopForIncompatibility(message.linkVersion < LINK_VERSION ? 'update' : 'update-this');
        return;
    }
    if (ctx.hostPeerId === null) {
        ctx.hostPeerId = peerId;
        setRemoteHostPeerId(peerId);
        setRemoteHostPath(ctx.transport.peerPath?.(peerId) ?? 'direct');
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
    // A result for an invoke that is not pending is a late copy (the relay link's, after WebRTC's) or a stray: it changes nothing.
    const invoke = ctx.pending.get(message.id);
    if (!invoke) return;
    if (!message.ok && message.error === REMOTE_SAY_HELLO_FIRST) {
        // The desktop dropped this phone without the phone knowing (its bye was lost): the connection was lost, so
        // every invoke in flight is settled as for a lost connection — a spend may have run on the desktop
        // before the drop, and is unclear — and the phone says hello again to be taken back.
        watch.reconnect(peerId);
        return;
    }
    ctx.pending.delete(message.id);
    if (message.ok) invoke.resolve(message.result);
    else if (message.error.startsWith(REMOTE_REFUSAL_PREFIX)) {
        // A channel the desktop does not serve a phone: the answer a handler would give, in the
        // phone's language, not the protocol's text. When this page's own allowlist allows the channel and
        // its arguments, the desktop is the older side (it lacks the channel, or refused it in its day): the
        // phone says to update it. An argument the per-argument rules refuse (the auto-vote key) is refused
        // on every desktop, so an update would not help.
        const offered =
            classifyRemoteChannel(invoke.channel).kind === 'allowed' &&
            isAllowedWrite(invoke.channel, invoke.sentArgs) === true;
        // The key travels with the text, so a reader that shows it (the challenge list) can translate it afresh.
        const errorKey: RemoteRefusalKey = offered ? 'errors.remoteUpdateComputer' : 'errors.remoteRefused';
        invoke.resolve({ success: false, error: rendererTranslator.t(errorKey), errorKey });
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
    // The desktop's settings reach the phone's listeners with the phone's own four view keys in
    // place (viewPrefs.ts): a desktop change to any of them never changes the phone.
    const payload =
        message.channel === 'settings-changed' ? watch.viewPrefs.ingestSettings(message.payload) : message.payload;
    dispatchEvent(watch.ctx, message.channel, payload);
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
        if (watch.ctx.stopped) return;
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
