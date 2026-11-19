/**
 * Link version 3, frozen: the message envelopes of the phone ⇄ desktop protocol, with their closed unions
 * (`ResultMessage.reason`, `ByeMessage.reason`, the `autovote-command` names).
 *
 * A new value in one of these closed unions would reach an older peer that does not know it, so it needs a new
 * LINK_VERSION and a new `contract/v<N>/` (see protocol.ts for the rule); a new optional field does not.
 * `tests/remote/contractV3.test.ts` checks the living types against this file.
 *
 * `hello.linkVersion`, `autovote-state`'s `hostRun`/`n` and `autovote-command`'s `requestId` are required.
 */

import type { AutovoteStateV3 } from './shapesConfig';

export type HelloMessageV3 = {
    t: 'hello';
    version: string;
    protocolVersion: number;
    linkVersion: number;
    host: boolean;
};

export type InvokeMessageV3 = {
    t: 'invoke';
    id: number;
    channel: string;
    args: unknown[];
    undefinedAt?: number[];
    requestId?: string;
    expectedRevision?: number;
};

export type ControlReportV3 = { requestId: string; target: string; revision: number };

export type ResultMessageV3 =
    | { t: 'result'; id: number; ok: true; result?: unknown; control?: ControlReportV3 }
    | {
          t: 'result';
          id: number;
          ok: false;
          error: string;
          reason?: 'too-large' | 'unsendable';
          control?: ControlReportV3;
      };

export type EventMessageV3 = { t: 'event'; channel: string; payload: unknown };

export type CommandAckV3 = {
    requestId: string;
    command: 'start' | 'stop' | 'rearm';
    outcome: 'ran' | 'failed' | 'duplicate' | 'stop-epoch-moved';
};

export type AutovoteStateMessageV3 = {
    t: 'autovote-state';
    state: AutovoteStateV3;
    hostRun: string;
    n: number;
    ack?: CommandAckV3;
};

export type AutovoteCommandMessageV3 = {
    t: 'autovote-command';
    command: 'start' | 'stop' | 'rearm';
    requestId: string;
    expectedStopEpoch?: number;
};

export type ByeMessageV3 = { t: 'bye'; reason?: 'full' };

export type PeerMessageV3 =
    | HelloMessageV3
    | InvokeMessageV3
    | ResultMessageV3
    | EventMessageV3
    | AutovoteStateMessageV3
    | AutovoteCommandMessageV3
    | ByeMessageV3;
