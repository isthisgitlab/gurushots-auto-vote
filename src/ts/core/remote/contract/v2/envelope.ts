/**
 * Link version 2, frozen: the message envelopes of the phone ⇄ desktop protocol, with their closed unions
 * (`ResultMessage.reason`, `ByeMessage.reason`, the `autovote-command` names).
 *
 * A new value in one of these closed unions would reach an older peer that does not know it, so it needs a new
 * LINK_VERSION and a new `contract/v<N>/` (see protocol.ts for the rule); a new optional field does not.
 * `tests/remote/contractV2.test.ts` checks the living types against this file.
 *
 * `hello.linkVersion` and `autovote-state`'s `hostRun`/`n` are required.
 */

import type { AutovoteStateV2 } from './shapesConfig';

export type HelloMessageV2 = {
    t: 'hello';
    version: string;
    protocolVersion: number;
    linkVersion: number;
    host: boolean;
};

export type InvokeMessageV2 = { t: 'invoke'; id: number; channel: string; args: unknown[]; undefinedAt?: number[] };

export type ResultMessageV2 =
    | { t: 'result'; id: number; ok: true; result?: unknown }
    | { t: 'result'; id: number; ok: false; error: string; reason?: 'too-large' | 'unsendable' };

export type EventMessageV2 = { t: 'event'; channel: string; payload: unknown };

export type AutovoteStateMessageV2 = { t: 'autovote-state'; state: AutovoteStateV2; hostRun: string; n: number };

export type AutovoteCommandMessageV2 = { t: 'autovote-command'; command: 'start' | 'stop' | 'rearm' };

export type ByeMessageV2 = { t: 'bye'; reason?: 'full' };

export type PeerMessageV2 =
    | HelloMessageV2
    | InvokeMessageV2
    | ResultMessageV2
    | EventMessageV2
    | AutovoteStateMessageV2
    | AutovoteCommandMessageV2
    | ByeMessageV2;
