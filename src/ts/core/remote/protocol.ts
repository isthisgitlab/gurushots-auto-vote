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

import * as pkg from '../../../../package.json';

import type { AutovoteState } from '../autovote/state';

/** The app version this build carries; `hello` announces it and the phone page compares the desktop's against it. */
export const PAGE_VERSION: string = pkg.version;

/** The protocol shape version. A peer whose PROTOCOL_VERSION differs is not spoken to. */
export const PROTOCOL_VERSION = 1 as const;

/** Longest serialized message a peer may send; anything over it is dropped unlooked at. */
export const MAX_PEER_MESSAGE_BYTES = 2 * 1024 * 1024;

/** The error a host answers when an invoke's result is over MAX_PEER_MESSAGE_BYTES; the phone shows its own translated text for it. */
export const REMOTE_RESULT_TOO_LARGE = 'The result is too large to send to the phone.';

/** The error a host answers when an invoke's result cannot be serialized at all; the phone shows its own translated text for it. */
export const REMOTE_RESULT_UNSENDABLE = "The computer's answer could not be sent.";

/** Longest one string field of a message may be (versions, channel names, error texts). */
export const MAX_PEER_FIELD_LENGTH = 512;

export type AutovoteCommandName = 'start' | 'stop' | 'rearm';

/** Both directions: announces the sender's app version and its protocol shape version. The
 * phone speaks first; only the desktop's reply carries `host: true`, which is how a phone
 * tells it from a fellow phone. A peer whose `protocolVersion` differs from ours is told to
 * update, the same as an app-version mismatch. */
export type HelloMessage = {
    t: 'hello';
    version: string;
    protocolVersion: number;
    host: boolean;
    /** `'loader'` marks the /remote/ loader, which only asks the desktop's version: it takes no peer slot and no snapshot. */
    role?: 'loader';
};
/** Phone → host: one window.api invoke. `undefinedAt` restores JSON-lost `undefined` arguments (see bridge/web.ts). */
export type InvokeMessage = { t: 'invoke'; id: number; channel: string; args: unknown[]; undefinedAt?: number[] };
/** Host → phone: the answer to one invoke. `ok: false` carries the handler's error text; `reason` marks the send failure that kept the answer from the phone. */
export type ResultMessage =
    | { t: 'result'; id: number; ok: true; result?: unknown }
    | { t: 'result'; id: number; ok: false; error: string; reason?: 'too-large' | 'unsendable' };
/** Host → phone: one window.api event (settings-changed, update-*, log-message). */
export type EventMessage = { t: 'event'; channel: string; payload: unknown };
/** Host → phone: the desktop controller's state, on every change. */
export type AutovoteStateMessage = { t: 'autovote-state'; state: AutovoteState };
/** Phone → host: start/stop/rearm the desktop's own controller. */
export type AutovoteCommandMessage = { t: 'autovote-command'; command: AutovoteCommandName };
/** Both directions: the sender leaves (a refused peer, the host shutting down). `reason: 'full'` is the
 * host turning a phone away because the peer limit is reached — not an offline desktop. */
export type ByeMessage = { t: 'bye'; reason?: 'full' };

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

/**
 * A release version as the `hello` carries it (`1.2.3`, `1.2.3-beta.4`): the only shape the loader
 * builds a page path from, so nothing a peer sends can name another place on the site.
 */
const RELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/;

/** Whether `version` is a release version, safe to put into a page path. */
export const isReleaseVersion = (version: string): boolean => RELEASE_VERSION_PATTERN.test(version);

/**
 * Orders two release versions: the number core first, then a pre-release below its release and
 * pre-releases among themselves by their dotted identifiers (numbers as numbers).
 */
export const compareReleaseVersions = (a: string, b: string): -1 | 0 | 1 => {
    const split = (version: string): { core: number[]; pre: string[] | null } => {
        const [core, ...pre] = version.split('-');
        return { core: core.split('.').map(Number), pre: pre.length === 0 ? null : pre.join('-').split('.') };
    };
    const left = split(a);
    const right = split(b);
    for (let i = 0; i < 3; i++) {
        if (left.core[i] !== right.core[i]) return left.core[i] < right.core[i] ? -1 : 1;
    }
    if (left.pre === null || right.pre === null) {
        return left.pre === right.pre ? 0 : left.pre === null ? 1 : -1;
    }
    for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
        const x = left.pre[i];
        const y = right.pre[i];
        if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
        if (x === y) continue;
        const bothNumeric = /^\d+$/.test(x) && /^\d+$/.test(y);
        if (bothNumeric) return Number(x) < Number(y) ? -1 : 1;
        return x < y ? -1 : 1;
    }
    return 0;
};

/** Why a message can or cannot travel to a peer: it fits, it is over the byte limit, or JSON cannot serialize it at all. */
export type PeerSendability = 'within' | 'too-large' | 'unserializable';

export const checkPeerMessageLimit = (message: unknown): PeerSendability => {
    let serialized: string;
    try {
        serialized = JSON.stringify(message) ?? '';
    } catch {
        return 'unserializable';
    }
    return serialized.length <= MAX_PEER_MESSAGE_BYTES ? 'within' : 'too-large';
};

/** Whether a message fits the size a peer accepts; a payload JSON cannot serialize does not fit. */
export const isWithinPeerMessageLimit = (message: unknown): boolean => checkPeerMessageLimit(message) === 'within';

/** Whether a raw payload is one of the protocol messages, within the size and field bounds. */
export const parsePeerMessage = (raw: unknown): PeerMessage | null => {
    if (!isPlainObject(raw)) return null;
    if (!isWithinPeerMessageLimit(raw)) return null;
    switch (raw.t) {
        case 'hello': {
            if (raw.role !== undefined && raw.role !== 'loader') return null;
            if (
                typeof raw.host !== 'boolean' ||
                !isBoundedString(raw.version) ||
                !isInteger(raw.protocolVersion) ||
                raw.protocolVersion < 1
            ) {
                return null;
            }
            const hello: HelloMessage = {
                t: 'hello',
                version: raw.version,
                protocolVersion: raw.protocolVersion,
                host: raw.host,
            };
            return raw.role === undefined ? hello : { ...hello, role: raw.role };
        }
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
            // `reason` is the send-failure marker: absent, 'too-large' or 'unsendable' — anything else is
            // not one of the shapes.
            if (raw.reason !== undefined && raw.reason !== 'too-large' && raw.reason !== 'unsendable') return null;
            return isBoundedString(raw.error)
                ? raw.reason === undefined
                    ? { t: 'result', id: raw.id, ok: false, error: raw.error }
                    : { t: 'result', id: raw.id, ok: false, error: raw.error, reason: raw.reason }
                : null;
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
            if (raw.reason === undefined) return { t: 'bye' };
            return raw.reason === 'full' ? { t: 'bye', reason: 'full' } : null;
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
