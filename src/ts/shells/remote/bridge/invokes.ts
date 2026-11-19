/**
 * The peer bridge's invoke pipeline: every generated window.api invoke becomes one
 * `invoke` message to the desktop host and settles when its `result` arrives. One
 * classification decides what a lost connection means (`classifyRemoteOperation`): a
 * read may wait for the desktop's hello; an effect or a spend never waits, is never
 * sent again, and — lost after the send — answers "unclear — check before retrying",
 * never a plain failure (the `postOnce` rule). One that is issued before the desktop
 * answered fails at once (it was never sent, so nothing can have run). A scenario
 * change also carries a request identity, which the desktop's control inbox answers
 * to after a reconnect. Loaded only by the remote renderer entries, so it stays free
 * of Node-side modules.
 */

import { classifyRemoteOperation, scenarioControlTarget } from '../../../core/remote/allowlist';
import { newRequestId } from '../../../core/remote/requestId';
import { rendererTranslator } from '../../../core/translations/renderer';

import type { PeerBridgeContext } from './context';

/** The pipeline the bridge's other pieces drive: sends, the held flush and the loss answers. */
export type InvokePipeline = {
    sendInvoke: (channel: string, args: unknown[]) => Promise<unknown>;
    /** Sends every invoke held before the desktop answered; the host hello runs it once, on connect. */
    flushHeld: (to: string) => void;
    /** The full-bye path: fails every held invoke plainly and empties the queue. */
    failHeldAsLost: () => void;
    /** A lost effect or spend may have run on the desktop: unclear, never a plain failure. Carries the identity of a scenario change. */
    lostEffectAnswer: (requestId?: string) => { success: false; error: string; unclear: true; requestId?: string };
    lostFailure: () => Error;
};

export const createInvokePipeline = (ctx: PeerBridgeContext): InvokePipeline => {
    const { transport, pending, heldSends } = ctx;
    let nextId = 0;

    const lostEffectAnswer = (requestId?: string) => ({
        success: false as const,
        error: rendererTranslator.t('errors.remoteSpendUnclear'),
        unclear: true as const,
        ...(requestId === undefined ? {} : { requestId }),
    });
    const lostFailure = (): Error => new Error(rendererTranslator.t('errors.remoteConnectionLost'));

    const flushHeld = (to: string): void => {
        // oxlint-disable-next-line frame-guard/no-unfiltered-frame-send -- a peer-connection message over the pairing transport, never a frame send
        for (const held of heldSends.splice(0)) void transport.send(held.message, to);
    };

    /** The desktop is full: nothing was ever sent on a held invoke, so each one fails plainly —
     * a held invoke is never an effect, so no unclear answer is due — instead of hanging forever. */
    const failHeldAsLost = (): void => {
        for (const [, invoke] of pending) invoke.reject(lostFailure());
        pending.clear();
        heldSends.length = 0;
    };

    const sendInvoke = (channel: string, args: unknown[]): Promise<unknown> => {
        if (ctx.stopped) return Promise.reject(lostFailure());
        const id = nextId++;
        const effect = classifyRemoteOperation(channel) !== 'read';
        const target = scenarioControlTarget(channel, args);
        const requestId = target === null ? undefined : newRequestId();
        const expectedRevision = target === null ? undefined : ctx.controlRevisions.get(target);
        // JSON has no undefined: send each top-level one as null plus its position, exactly
        // like bridge/web.ts, so the host restores it and a handler's default still applies.
        const undefinedAt = args.flatMap((arg, index) => (arg === undefined ? [index] : []));
        const payload = args.map((arg) => (arg === undefined ? null : arg));
        const message = {
            t: 'invoke',
            id,
            channel,
            args: payload,
            ...(undefinedAt.length > 0 ? { undefinedAt } : {}),
            ...(requestId === undefined ? {} : { requestId }),
            ...(expectedRevision === undefined ? {} : { expectedRevision }),
        };
        return new Promise((resolve, reject) => {
            pending.set(id, {
                resolve,
                reject,
                effect,
                channel,
                sentArgs: payload,
                ...(requestId === undefined || target === null ? {} : { requestId, target }),
            });
            const { hostPeerId } = ctx;
            if (hostPeerId === null) {
                if (effect || ctx.everConnected) {
                    // An effect is never queued: it was not sent, so this is a plain failure,
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
                if (effect) invoke.resolve(lostEffectAnswer(requestId));
                else invoke.reject(lostFailure());
            });
        });
    };

    return { sendInvoke, flushHeld, failHeldAsLost, lostEffectAnswer, lostFailure };
};
