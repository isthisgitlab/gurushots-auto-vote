/**
 * The room's message switch: what a phone's raw message means, and the guards
 * around each kind — a `hello` of another link version is told ours without a
 * snapshot, the room caps its phones, an invoke from an unvalidated peer is
 * refused, and a `bye` drops the peer.
 */

import { REMOTE_SAY_HELLO_FIRST } from '../../core/remote/dispatch';
import { LINK_VERSION, parsePeerMessage, restoreInvokeArgs } from '../../core/remote/protocol';

import { MAX_REMOTE_PEERS } from './remoteHostCreate';
import type { HostContext } from './remoteHostPeers';
import { clippedId, dropPeer, notifyCount, sendTo } from './remoteHostPeers';
import { answerInvoke, runCommand, sendHostHello, sendSnapshot } from './remoteHostAnswers';

export const handleMessage = (ctx: HostContext, peerId: string, raw: unknown): void => {
    const message = parsePeerMessage(raw);
    if (message === null) return;
    switch (message.t) {
        case 'hello': {
            if (message.role === 'loader' || message.linkVersion !== LINK_VERSION) {
                // The loader only asks the version, and a phone of another link version (or a legacy one,
                // which sends none) is told, not served: neither gets a snapshot, a peer slot, a count or a
                // desktop notice. The app version is not compared: the link version is the contract.
                void sendHostHello(ctx, peerId);
                return;
            }
            if (!ctx.peers.has(peerId) && ctx.peers.size >= MAX_REMOTE_PEERS) {
                ctx.deps.logInfo(`Remote peer refused: at most ${MAX_REMOTE_PEERS} phones can be connected`);
                void sendTo(ctx, peerId, { t: 'bye', reason: 'full' });
                return;
            }
            const isNew = !ctx.peers.has(peerId);
            ctx.peers.add(peerId);
            if (isNew) {
                ctx.deps.logInfo(`Remote peer connected: ${clippedId(peerId)}`);
                notifyCount(ctx);
                if (!ctx.notified.has(peerId)) {
                    ctx.notified.add(peerId);
                    ctx.deps.notify();
                }
            }
            void sendSnapshot(ctx, peerId);
            return;
        }
        case 'invoke': {
            if (!ctx.peers.has(peerId)) {
                void sendTo(ctx, peerId, {
                    t: 'result',
                    id: message.id,
                    ok: false,
                    error: REMOTE_SAY_HELLO_FIRST,
                });
                return;
            }
            // The channel name only, never the arguments: an invoke's arguments can name
            // anything, and the log is not the place for them.
            ctx.deps.logInfo(`Remote invoke: ${clippedId(message.channel)}`);
            void answerInvoke(ctx, peerId, message.id, message.channel, restoreInvokeArgs(message));
            return;
        }
        case 'autovote-command': {
            if (!ctx.peers.has(peerId)) return;
            ctx.deps.logInfo(`Remote auto-vote command: ${message.command}`);
            void runCommand(ctx, message.command);
            return;
        }
        case 'bye': {
            dropPeer(ctx, peerId);
            return;
        }
    }
};
