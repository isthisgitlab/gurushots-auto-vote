/**
 * The phone ⇄ desktop protocol: the message shapes, the version handshake and
 * the validation every inbound message passes before dispatch. Dependency-free,
 * so the desktop host (react/api) and the phone's peer bridge (shells/remote)
 * share it.
 *
 * Every message is one JSON object with a `t` tag. `parsePeerMessage` is the
 * only way a raw transport payload becomes a message: it rejects anything that
 * is not one of the shapes below, bounds the size, and answers null — the
 * caller drops an unparsable message, it never throws.
 */

import { isPlainObject } from '../plainObject';
import { isInteger } from '../numbers';

import type { AutovoteState } from '../autovote/state';

/** The protocol shape version. A peer whose PROTOCOL_VERSION differs is not spoken to. */
export const PROTOCOL_VERSION = 1 as const;

/** Longest serialized message a peer may send; anything over it is dropped unlooked at. */
export const MAX_PEER_MESSAGE_BYTES = 2 * 1024 * 1024;

/** Longest one string field of a message may be (versions, channel names, error texts). */
export const MAX_PEER_FIELD_LENGTH = 512;

export type AutovoteCommandName = 'start' | 'stop' | 'rearm';

/** Both directions: announces the sender's app version and its protocol shape version. The
 * phone speaks first; only the desktop's reply carries `host: true`, which is how a phone
 * tells it from a fellow phone. A peer whose `protocolVersion` differs from ours is told to
 * update, the same as an app-version mismatch. */
export type HelloMessage = { t: 'hello'; version: string; protocolVersion: number; host: boolean };
/** Phone → host: one window.api invoke. `undefinedAt` restores JSON-lost `undefined` arguments (see bridge/web.ts). */
export type InvokeMessage = { t: 'invoke'; id: number; channel: string; args: unknown[]; undefinedAt?: number[] };
/** Host → phone: the answer to one invoke. `ok: false` carries the handler's error text. */
export type ResultMessage = { t: 'result'; id: number; ok: boolean; result?: unknown; error?: string };
/** Host → phone: one window.api event (settings-changed, update-*, log-message). */
export type EventMessage = { t: 'event'; channel: string; payload: unknown };
/** Host → phone: the desktop controller's state, on every change. */
export type AutovoteStateMessage = { t: 'autovote-state'; state: AutovoteState };
/** Phone → host: start/stop/rearm the desktop's own controller. */
export type AutovoteCommandMessage = { t: 'autovote-command'; command: AutovoteCommandName };
/** Both directions: the sender leaves (a refused peer, the host shutting down). */
export type ByeMessage = { t: 'bye' };

export type PeerMessage =
    | HelloMessage
    | InvokeMessage
    | ResultMessage
    | EventMessage
    | AutovoteStateMessage
    | AutovoteCommandMessage
    | ByeMessage;

const isBoundedString = (value: unknown): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= MAX_PEER_FIELD_LENGTH;

const isIndexList = (value: unknown): value is number[] =>
    Array.isArray(value) && value.every((index) => isInteger(index) && index >= 0);

/** The state a `autovote-state` message carries: a plain object with the reducer's fields. */
const isAutovoteState = (value: unknown): value is AutovoteState =>
    isPlainObject(value) &&
    typeof value.running === 'boolean' &&
    isInteger(value.cycles) &&
    (value.lastRun === null || typeof value.lastRun === 'string') &&
    (value.nextRunAt === null || isInteger(value.nextRunAt)) &&
    (value.pendingStartAt === null || isInteger(value.pendingStartAt)) &&
    (value.status === 'Stopped' || value.status === 'Running' || value.status === 'Error') &&
    (value.statusClass === 'badge-neutral' ||
        value.statusClass === 'badge-success' ||
        value.statusClass === 'badge-error') &&
    (value.error === null || typeof value.error === 'string');

/** Whether a raw payload is one of the protocol messages, within the size and field bounds. */
export const parsePeerMessage = (raw: unknown): PeerMessage | null => {
    if (!isPlainObject(raw)) return null;
    let size: number;
    try {
        size = JSON.stringify(raw)?.length ?? 0;
    } catch {
        return null;
    }
    if (size > MAX_PEER_MESSAGE_BYTES) return null;
    switch (raw.t) {
        case 'hello':
            return typeof raw.host === 'boolean' &&
                isBoundedString(raw.version) &&
                isInteger(raw.protocolVersion) &&
                raw.protocolVersion >= 1
                ? { t: 'hello', version: raw.version, protocolVersion: raw.protocolVersion, host: raw.host }
                : null;
        case 'invoke':
            if (!isInteger(raw.id) || raw.id < 0 || !isBoundedString(raw.channel) || !Array.isArray(raw.args)) {
                return null;
            }
            if (raw.undefinedAt !== undefined && !isIndexList(raw.undefinedAt)) return null;
            return raw.undefinedAt === undefined
                ? { t: 'invoke', id: raw.id, channel: raw.channel, args: raw.args }
                : { t: 'invoke', id: raw.id, channel: raw.channel, args: raw.args, undefinedAt: raw.undefinedAt };
        case 'result':
            if (!isInteger(raw.id) || raw.id < 0 || typeof raw.ok !== 'boolean') return null;
            if (raw.ok) return { t: 'result', id: raw.id, ok: true, result: raw.result };
            return isBoundedString(raw.error) ? { t: 'result', id: raw.id, ok: false, error: raw.error } : null;
        case 'event':
            return isBoundedString(raw.channel) && 'payload' in raw
                ? { t: 'event', channel: raw.channel, payload: raw.payload }
                : null;
        case 'autovote-state':
            return isAutovoteState(raw.state) ? { t: 'autovote-state', state: raw.state } : null;
        case 'autovote-command':
            return raw.command === 'start' || raw.command === 'stop' || raw.command === 'rearm'
                ? { t: 'autovote-command', command: raw.command }
                : null;
        case 'bye':
            return { t: 'bye' };
        default:
            return null;
    }
};

/**
 * Whether a join failure is the "the peers saw each other but WebRTC could not establish a direct
 * connection" case is classified in exactly one place, the trystero adapter (core/remote/trystero.ts,
 * `isConnectionFailureJoinError`) — the error texts are that library's.
 */

/** Restores the top-level `undefined` arguments a JSON trip turned into null (see bridge/web.ts). */
export const restoreInvokeArgs = (message: InvokeMessage): unknown[] => {
    if (message.undefinedAt === undefined) return message.args;
    const restored = [...message.args];
    for (const index of message.undefinedAt) {
        if (index >= 0 && index < restored.length) restored[index] = undefined;
    }
    return restored;
};
