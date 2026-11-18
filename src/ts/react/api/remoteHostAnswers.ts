/**
 * The host's answers to a paired phone: the `hello` and the snapshot that open
 * a connection, the invoke dispatch through the allowlist, the host channels
 * (the log-stream bookkeeping and the no-op cleanup), and the auto-vote
 * commands the phone runs on the caller's controller.
 */

import { dispatchRemoteInvoke } from '../../core/remote/dispatch';
import { classifyRemoteChannel, classifyRemoteCommand } from '../../core/remote/allowlist';
import { errorMessage } from '../../core/errorMessage';
import {
    checkPeerMessageLimit,
    LINK_VERSION,
    MAX_PEER_FIELD_LENGTH,
    PROTOCOL_VERSION,
    REMOTE_RESULT_TOO_LARGE,
    REMOTE_RESULT_UNSENDABLE,
} from '../../core/remote/protocol';

import type { AutovoteCommandMessage, CommandAck, ControlReport } from '../../core/remote/protocol';
import type { RemoteInvokeRequest } from '../../core/remote/dispatch';
import type { HostContext } from './remoteHostPeers';
import { MAX_COMMAND_IDS, clippedId, sendTo, stampedAutovoteState } from './remoteHostPeers';

/** A short, single-line error text for a phone: bounded to what a `result` message accepts. */
const shortError = (error: unknown): string => {
    const text = (errorMessage(error) ?? '').replace(/\s+/g, ' ').trim();
    return (text.length > 0 ? text : 'The computer could not run this.').slice(0, MAX_PEER_FIELD_LENGTH);
};

/** The host's own `hello`: its app version, the protocol version and its link version, nothing else. */
export const sendHostHello = (ctx: HostContext, peerId: string): Promise<void> =>
    sendTo(ctx, peerId, {
        t: 'hello',
        version: ctx.deps.version,
        protocolVersion: PROTOCOL_VERSION,
        linkVersion: LINK_VERSION,
        host: true,
    });

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
    control?: ControlReport,
): Promise<void> => {
    const answer = { t: 'result', id, ok: true, result, ...(control === undefined ? {} : { control }) };
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
    request: RemoteInvokeRequest,
): Promise<void> => {
    try {
        if (classifyRemoteChannel(channel).kind === 'host') {
            await answerHostChannel(ctx, peerId, id, channel);
            return;
        }
        const outcome = await dispatchRemoteInvoke(channel, args, { invoke: ctx.deps.invoke }, request);
        if (outcome.kind === 'refused') {
            ctx.deps.logInfo(`Remote invoke refused: ${clippedId(channel)}`);
            await sendTo(ctx, peerId, { t: 'result', id, ok: false, error: outcome.error });
            return;
        }
        await sendResult(ctx, peerId, id, channel, outcome.result, outcome.control);
    } catch (error) {
        // Every failure answers the phone: an unanswered invoke would hang there until the connection drops.
        ctx.deps.logInfo(`Remote invoke failed: ${clippedId(channel)}`);
        await sendTo(ctx, peerId, { t: 'result', id, ok: false, error: shortError(error) });
    }
};

/** Remembers a Start or re-arm identity; the oldest is forgotten past MAX_COMMAND_IDS. */
const rememberCommand = (ctx: HostContext, requestId: string): void => {
    ctx.commandIds.add(requestId);
    for (const old of ctx.commandIds) {
        if (ctx.commandIds.size <= MAX_COMMAND_IDS) break;
        ctx.commandIds.delete(old);
    }
};

/**
 * Runs a phone's start/stop/rearm and answers that phone with the controller's state stamped as the acknowledgment of its
 * identity. A Stop is the priority operation: it goes straight to the controller (which cancels and records the fence), with no
 * identity check and no control inbox, so nothing that is busy, full or unreadable can hold it back. A Start or re-arm is run
 * once per identity, and not at all when a Stop has moved the epoch since the state the phone saw: a delayed or repeated
 * Start never runs after a Stop. A failure is logged; the state and the ack tell the phone.
 */
export const runCommand = async (ctx: HostContext, peerId: string, message: AutovoteCommandMessage): Promise<void> => {
    const { command, requestId, expectedStopEpoch } = message;
    const answer = (outcome: CommandAck['outcome']): Promise<void> =>
        sendTo(ctx, peerId, stampedAutovoteState(ctx.deps.getAutovoteState(), { requestId, command, outcome }));
    if (classifyRemoteCommand(command) === 'effect') {
        if (ctx.commandIds.has(requestId)) return answer('duplicate');
        rememberCommand(ctx, requestId);
        const epoch = ctx.deps.getAutovoteState().stopEpoch;
        if (expectedStopEpoch !== undefined && epoch !== null && epoch !== expectedStopEpoch) {
            return answer('stop-epoch-moved');
        }
    }
    try {
        await ctx.deps.runAutovoteCommand(command);
    } catch {
        ctx.deps.logInfo(`Remote auto-vote command failed: ${command}`);
        return answer('failed');
    }
    return answer('ran');
};
