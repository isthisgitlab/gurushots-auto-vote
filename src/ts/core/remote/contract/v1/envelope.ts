/**
 * Link version 1, frozen: the message envelopes of the phone ⇄ desktop protocol, with their closed unions
 * (`HelloMessage.role`, `ResultMessage.reason`, `ByeMessage.reason`, the `autovote-command` names).
 *
 * A new value in one of these closed unions would reach an older peer that does not know it, so it needs a new
 * LINK_VERSION and a new `contract/v<N>/` (see protocol.ts for the rule); a new optional field does not.
 * `tests/remote/contractV1.test.ts` checks the living types against this file.
 */

import type { AutovoteStateV1 } from './shapesConfig';

export type HelloMessageV1 = {
    t: 'hello';
    version: string;
    protocolVersion: number;
    linkVersion?: number;
    host: boolean;
    role?: 'loader';
};

export type InvokeMessageV1 = { t: 'invoke'; id: number; channel: string; args: unknown[]; undefinedAt?: number[] };

export type ResultMessageV1 =
    | { t: 'result'; id: number; ok: true; result?: unknown }
    | { t: 'result'; id: number; ok: false; error: string; reason?: 'too-large' | 'unsendable' };

export type EventMessageV1 = { t: 'event'; channel: string; payload: unknown };

export type AutovoteStateMessageV1 = { t: 'autovote-state'; state: AutovoteStateV1; hostRun?: string; n?: number };

export type AutovoteCommandMessageV1 = { t: 'autovote-command'; command: 'start' | 'stop' | 'rearm' };

export type ByeMessageV1 = { t: 'bye'; reason?: 'full' };

export type PeerMessageV1 =
    | HelloMessageV1
    | InvokeMessageV1
    | ResultMessageV1
    | EventMessageV1
    | AutovoteStateMessageV1
    | AutovoteCommandMessageV1
    | ByeMessageV1;
