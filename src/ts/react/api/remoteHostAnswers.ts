/**
 * The host's answers to a paired phone: the `hello` and the snapshot that open
 * a connection, the invoke dispatch through the allowlist, the host channels
 * (the log-stream bookkeeping and the no-op cleanup), and the auto-vote
 * commands the phone runs on the caller's controller.
 */

import { dispatchRemoteInvoke } from '../../core/remote/dispatch';
import { classifyRemoteChannel } from '../../core/remote/allowlist';
import { errorMessage } from '../../core/errorMessage';
import {
    checkPeerMessageLimit,
    MAX_PEER_FIELD_LENGTH,
    PROTOCOL_VERSION,
    REMOTE_RESULT_TOO_LARGE,
    REMOTE_RESULT_UNSENDABLE,
} from '../../core/remote/protocol';

import type { AutovoteCommandName } from '../../core/remote/protocol';
import type { HostContext } from './remoteHostPeers';
import { clippedId, sendTo, stampedAutovoteState } from './remoteHostPeers';

/** A short, single-line error text for a phone: bounded to what a `result` message accepts. */
const shortError = (error: unknown): string => {
    const text = (errorMessage(error) ?? '').replace(/\s+/g, ' ').trim();
    return (text.length > 0 ? text : 'The computer could not run this.').slice(0, MAX_PEER_FIELD_LENGTH);
};

/** The host's own `hello`: its version and protocol, nothing else. */
export const sendHostHello = (ctx: HostContext, peerId: string): Promise<void> =>
    sendTo(ctx, peerId, { t: 'hello', version: ctx.deps.version, protocolVersion: PROTOCOL_VERSION, host: true });

export const sendSnapshot = async (ctx: HostContext, peerId: string): Promise<void> => {
    await sendHostHello(ctx, peerId);
    try {
        const settings = await ctx.deps.invoke('get-settings', []);
        await sendTo(ctx, peerId, { t: 'event', channel: 'settings-changed', payload: settings });
    } catch {
        // The phone reads the settings itself through its own invokes, each answered or failed on its own.
        ctx.deps.logInfo('Remote invoke failed: get-settings');
    }
    await sendTo(ctx, peerId, stampedAutovoteState(ctx.deps.getAutovoteState()));
};

export const answerLogStreamChannel = async (
    ctx: HostContext,
    peerId: string,
    id: number,
    wants: boolean,
): Promise<void> => {
    // The log stream is the host's own: it counts the phones that want it and runs the
    // desktop's one stream from the first phone's start until the last one stops. A repeat
    // of the phone's current want is answered without touching the stream.
    const before = ctx.logPeers.has(peerId);
    if (wants !== before) {
        if (wants) ctx.logPeers.add(peerId);
        else ctx.logPeers.delete(peerId);
        const firstWanted = wants && ctx.logPeers.size === 1;
        const lastStopped = !wants && ctx.logPeers.size === 0;
        if (firstWanted || lastStopped) {
            await ctx.deps.invoke(wants ? 'start-log-stream' : 'stop-log-stream', []);
            ctx.deps.logInfo(`Phones receiving the log stream: ${ctx.logPeers.size}`);
        }
    }
    await sendTo(ctx, peerId, { t: 'result', id, ok: true, result: { success: true } });
};

export const answerHostChannel = async (
    ctx: HostContext,
    peerId: string,
    id: number,
    channel: string,
): Promise<void> => {
    if (channel === 'cleanup-stale-metadata') {
        // Answered with success and nothing is done: the phone never triggers a cleanup here.
        await sendTo(ctx, peerId, { t: 'result', id, ok: true, result: { success: true } });
        return;
    }
    await answerLogStreamChannel(ctx, peerId, id, channel === 'start-log-stream');
};

/** Sends one invoke's answer. A result the phone cannot receive (over the message limit, or not
 * serializable at all) becomes a marked failure the phone maps by channel kind. */
export const sendResult = async (
    ctx: HostContext,
    peerId: string,
    id: number,
    channel: string,
    result: unknown,
): Promise<void> => {
    const answer = { t: 'result', id, ok: true, result };
    const limit = checkPeerMessageLimit(answer);
    if (limit === 'within') {
        await sendTo(ctx, peerId, answer);
        return;
    }
    ctx.deps.logInfo(`Remote invoke failed: ${clippedId(channel)}`);
    await sendTo(
        ctx,
        peerId,
        limit === 'unserializable'
            ? { t: 'result', id, ok: false, error: REMOTE_RESULT_UNSENDABLE, reason: 'unsendable' }
            : { t: 'result', id, ok: false, error: REMOTE_RESULT_TOO_LARGE, reason: 'too-large' },
    );
};

export const answerInvoke = async (
    ctx: HostContext,
    peerId: string,
    id: number,
    channel: string,
    args: unknown[],
): Promise<void> => {
    try {
        if (classifyRemoteChannel(channel).kind === 'host') {
            await answerHostChannel(ctx, peerId, id, channel);
            return;
        }
        const outcome = await dispatchRemoteInvoke(channel, args, { invoke: ctx.deps.invoke });
        if (outcome.kind === 'refused') {
            ctx.deps.logInfo(`Remote invoke refused: ${clippedId(channel)}`);
            await sendTo(ctx, peerId, { t: 'result', id, ok: false, error: outcome.error });
            return;
        }
        await sendResult(ctx, peerId, id, channel, outcome.result);
    } catch (error) {
        // Every failure answers the phone: an unanswered invoke would hang there until the connection drops.
        ctx.deps.logInfo(`Remote invoke failed: ${clippedId(channel)}`);
        await sendTo(ctx, peerId, { t: 'result', id, ok: false, error: shortError(error) });
    }
};

/** Runs a phone's start/stop/rearm; a failure is logged, the controller's own state tells the phone. */
export const runCommand = async (ctx: HostContext, command: AutovoteCommandName): Promise<void> => {
    try {
        await ctx.deps.runAutovoteCommand(command);
    } catch {
        ctx.deps.logInfo(`Remote auto-vote command failed: ${command}`);
    }
};
