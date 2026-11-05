/**
 * The peer bridge's invoke pipeline: every generated window.api invoke becomes one
 * `invoke` message to the desktop host and settles when its `result` arrives. Spends
 * go by the `postOnce` rule — a lost spend answers "unclear — check before retrying",
 * never a plain failure — and a spend issued before the desktop answered fails at once
 * (it was never sent, so nothing can have run). Loaded only by the remote renderer
 * entries, so it stays free of Node-side modules.
 */

import { SPEND_REMOTE_CHANNELS } from '../../../core/remote/allowlist';
import { rendererTranslator } from '../../../core/translations/renderer';

import type { PeerBridgeContext } from './context';

/** The pipeline the bridge's other pieces drive: sends, the held flush and the loss answers. */
export type InvokePipeline = {
    sendInvoke: (channel: string, args: unknown[]) => Promise<unknown>;
    /** Sends every invoke held before the desktop answered; the host hello runs it once, on connect. */
    flushHeld: (to: string) => void;
    /** The full-bye path: fails every held invoke plainly and empties the queue. */
    failHeldAsLost: () => void;
    /** A lost spend may have run on the desktop: unclear, never a plain failure. */
    lostSpendAnswer: () => { success: false; error: string };
    lostFailure: () => Error;
};

export const createInvokePipeline = (ctx: PeerBridgeContext): InvokePipeline => {
    const { transport, pending, heldSends } = ctx;
    let nextId = 0;

    const lostSpendAnswer = (): { success: false; error: string } => ({
        success: false,
        error: rendererTranslator.t('errors.remoteSpendUnclear'),
    });
    const lostFailure = (): Error => new Error(rendererTranslator.t('errors.remoteConnectionLost'));

    const flushHeld = (to: string): void => {
        // oxlint-disable-next-line frame-guard/no-unfiltered-frame-send -- a peer-connection message over the pairing transport, never a frame send
        for (const held of heldSends.splice(0)) void transport.send(held.message, to);
    };

    /** The desktop is full: nothing was ever sent on a held invoke, so each one fails plainly —
     * a held invoke is never a spend, so no unclear answer is due — instead of hanging forever. */
    const failHeldAsLost = (): void => {
        for (const [, invoke] of pending) invoke.reject(lostFailure());
        pending.clear();
        heldSends.length = 0;
    };

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
            pending.set(id, { resolve, reject, spend, channel, sentArgs: payload });
            const { hostPeerId } = ctx;
            if (hostPeerId === null) {
                if (spend || ctx.everConnected) {
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

    return { sendInvoke, flushHeld, failHeldAsLost, lostSpendAnswer, lostFailure };
};
