/**
 * The remote protocol: every message shape validates, anything malformed or
 * oversized answers null (it never throws), and the join-error classifier
 * names exactly the three trystero failure causes.
 */

import {
    MAX_PEER_MESSAGE_BYTES,
    PROTOCOL_VERSION,
    parsePeerMessage,
    restoreInvokeArgs,
} from '../../src/ts/core/remote/protocol';

import type {
    AutovoteCommandMessage,
    AutovoteStateMessage,
    ByeMessage,
    EventMessage,
    HelloMessage,
    InvokeMessage,
    ResultMessage,
} from '../../src/ts/core/remote/protocol';
import {
    isConnectionFailureJoinError,
    RTC_ICE_SERVERS,
    TRYSTERO_ACTION_NAMESPACE,
    roomIdForKey,
} from '../../src/ts/core/remote/trystero';
import { NOSTR_RELAY_URLS, STUN_SERVER_URLS, TRYSTERO_APP_ID } from '../../src/ts/core/remote/relays';
import { invalid } from '../helpers/invalid';

import type { AutovoteState } from '../../src/ts/core/autovote/state';

const state = {
    running: true,
    cycles: 3,
    lastRun: '12:00:00',
    nextRunAt: 1,
    pendingStartAt: null,
    status: 'Running',
    statusClass: 'badge-success',
    error: null,
} satisfies AutovoteState;

describe('parsePeerMessage', () => {
    test('the protocol version is 1', () => {
        expect(PROTOCOL_VERSION).toBe(1);
    });

    test('accepts every message shape', () => {
        const hello: HelloMessage = { t: 'hello', version: '1.2.3', host: true };
        expect(parsePeerMessage(hello)).toEqual({ t: 'hello', version: '1.2.3', host: true });
        const invoke: InvokeMessage = { t: 'invoke', id: 0, channel: 'get-settings', args: [1, null] };
        expect(parsePeerMessage(invoke)).toEqual({
            t: 'invoke',
            id: 0,
            channel: 'get-settings',
            args: [1, null],
        });
        expect(
            parsePeerMessage({ t: 'invoke', id: 2, channel: 'set-setting', args: ['k', null], undefinedAt: [1] }),
        ).toEqual({ t: 'invoke', id: 2, channel: 'set-setting', args: ['k', null], undefinedAt: [1] });
        const result: ResultMessage = { t: 'result', id: 7, ok: true, result: { success: true } };
        expect(parsePeerMessage(result)).toEqual({
            t: 'result',
            id: 7,
            ok: true,
            result: { success: true },
        });
        expect(parsePeerMessage({ t: 'result', id: 7, ok: false, error: 'refused' })).toEqual({
            t: 'result',
            id: 7,
            ok: false,
            error: 'refused',
        });
        const event: EventMessage = { t: 'event', channel: 'settings-changed', payload: { a: 1 } };
        expect(parsePeerMessage(event)).toEqual({
            t: 'event',
            channel: 'settings-changed',
            payload: { a: 1 },
        });
        const autovoteState: AutovoteStateMessage = { t: 'autovote-state', state };
        expect(parsePeerMessage(autovoteState)).toEqual({ t: 'autovote-state', state });
        // The other reaches of the state checker's chains: Stopped/badge-neutral and an
        // error string, with no next run pending.
        const stopped: AutovoteStateMessage = {
            t: 'autovote-state',
            state: {
                running: false,
                cycles: 0,
                lastRun: null,
                nextRunAt: null,
                pendingStartAt: null,
                status: 'Stopped',
                statusClass: 'badge-neutral',
                error: 'boom',
            },
        };
        expect(parsePeerMessage(stopped)).toEqual(stopped);
        const errored: AutovoteStateMessage = {
            t: 'autovote-state',
            state: {
                running: true,
                cycles: 1,
                lastRun: null,
                nextRunAt: 5,
                pendingStartAt: 6,
                status: 'Error',
                statusClass: 'badge-error',
                error: 'kaboom',
            },
        };
        expect(parsePeerMessage(errored)).toEqual(errored);
        const command: AutovoteCommandMessage = { t: 'autovote-command', command: 'rearm' };
        expect(parsePeerMessage(command)).toEqual({
            t: 'autovote-command',
            command: 'rearm',
        });
        const bye: ByeMessage = { t: 'bye' };
        expect(parsePeerMessage(bye)).toEqual({ t: 'bye' });
    });

    test.each([
        ['not an object', 'hello'],
        ['no tag', { version: '1.2.3' }],
        ['unknown tag', { t: 'steal', key: 'k' }],
        ['hello: version not a string', { t: 'hello', version: 4, host: true }],
        ['hello: empty version', { t: 'hello', version: '', host: false }],
        ['hello: host flag missing', { t: 'hello', version: '1.2.3' }],
        ['invoke: id not an integer', { t: 'invoke', id: 1.5, channel: 'a', args: [] }],
        ['invoke: negative id', { t: 'invoke', id: -1, channel: 'a', args: [] }],
        ['invoke: channel not a string', { t: 'invoke', id: 1, channel: 3, args: [] }],
        ['invoke: args not an array', { t: 'invoke', id: 1, channel: 'a', args: 'x' }],
        ['invoke: undefinedAt not indexes', { t: 'invoke', id: 1, channel: 'a', args: [], undefinedAt: [-1] }],
        ['result: ok not a boolean', { t: 'result', id: 1, ok: 'yes' }],
        ['result: failure without an error', { t: 'result', id: 1, ok: false }],
        ['event: payload missing', { t: 'event', channel: 'settings-changed' }],
        ['autovote-state: state of the wrong kind', { t: 'autovote-state', state: { running: 'yes' } }],
        ['autovote-state: state not an object', { t: 'autovote-state', state: 'nope' }],
        ['autovote-state: state null', { t: 'autovote-state', state: null }],
        ['autovote-command: unknown command', { t: 'autovote-command', command: 'restart' }],
    ])('refuses %s', (_label, raw) => {
        expect(parsePeerMessage(invalid(raw))).toBeNull();
    });

    test('a message over the size bound is refused', () => {
        const bloated = { t: 'event', channel: 'settings-changed', payload: 'x'.repeat(MAX_PEER_MESSAGE_BYTES + 1) };
        expect(parsePeerMessage(bloated)).toBeNull();
        expect(parsePeerMessage({ t: 'event', channel: 'a', payload: 'x'.repeat(1024) })).not.toBeNull();
    });

    test('a payload that cannot be serialized is refused, not thrown on', () => {
        expect(parsePeerMessage({ t: 'event', channel: 'a', payload: BigInt(4) })).toBeNull();
    });

    test('a payload that serializes to nothing is judged by its fields, at size zero', () => {
        // The transport delivers JSON.parse output, so a toJSON stub cannot arrive over the
        // wire; an in-memory caller passing one is measured as size zero and read as usual.
        const toJSONless = { t: 'hello', version: '1.2.3', host: true, toJSON: () => undefined };
        expect(parsePeerMessage(toJSONless)).toEqual({ t: 'hello', version: '1.2.3', host: true });
    });

    test('a result failure whose error text is over the field bound is refused', () => {
        expect(parsePeerMessage({ t: 'result', id: 1, ok: false, error: 'x'.repeat(600) })).toBeNull();
    });

    test('restoreInvokeArgs puts the JSON-lost undefined arguments back', () => {
        const message: InvokeMessage = {
            t: 'invoke',
            id: 1,
            channel: 'set-setting',
            args: ['mock', null],
            undefinedAt: [1],
        };
        expect(restoreInvokeArgs(message)).toEqual(['mock', undefined]);
        expect(restoreInvokeArgs({ t: 'invoke', id: 1, channel: 'a', args: ['x'] } satisfies InvokeMessage)).toEqual([
            'x',
        ]);
        // An index out of range changes nothing.
        expect(
            restoreInvokeArgs({
                t: 'invoke',
                id: 1,
                channel: 'a',
                args: ['x'],
                undefinedAt: [5],
            } satisfies InvokeMessage),
        ).toEqual(['x']);
    });
});

// The three causes with their exact strings from @trystero-p2p/core/dist/signal-handler.mjs
// (line 64 builds the SDP-exchange error, lines 317 and 399 the wrong-password ones) and
// handshake.mjs (line 92 the handshake timeout).
describe("the trystero adapter's pinned facts", () => {
    test('the room identity and namespace come from the shared constants', async () => {
        expect(TRYSTERO_APP_ID).toBe('com.isthisgitlab.gurushotsautovote');
        expect(TRYSTERO_ACTION_NAMESPACE).toBe('gs-remote');
        // SHA-256 of the key's UTF-8 bytes, hex: the key itself never rides the relays.
        const expected = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('k')))]
            .map((byte) => byte.toString(16).padStart(2, '0'))
            .join('');
        await expect(roomIdForKey('k')).resolves.toBe(expected);
        await expect(roomIdForKey('other')).not.toBe(expected);
    });

    test('the ICE servers are the pinned STUN list, in order', () => {
        expect(RTC_ICE_SERVERS).toEqual(STUN_SERVER_URLS.map((urls) => ({ urls })));
        expect(NOSTR_RELAY_URLS).toEqual([
            'wss://nos.lol',
            'wss://relay.primal.net',
            'wss://relay.snort.social',
            'wss://nostr.mom',
            'wss://offchain.pub',
        ]);
    });
});

describe('isConnectionFailureJoinError (the try-Wi-Fi classifier)', () => {
    test('the SDP-exchange connection failure is the try-Wi-Fi state', () => {
        expect(
            isConnectionFailureJoinError(
                'could not connect to peer 3b6a after exchanging SDP; configure TURN servers with turnConfig or rtcConfig.iceServers',
            ),
        ).toBe(true);
    });

    test('a wrong room password is not', () => {
        expect(isConnectionFailureJoinError('incorrect room password when decrypting offer')).toBe(false);
        expect(isConnectionFailureJoinError('incorrect room password when decrypting answer')).toBe(false);
    });

    test('a handshake failure or timeout is not', () => {
        expect(isConnectionFailureJoinError('handshake timed out after 14000ms')).toBe(false);
        expect(isConnectionFailureJoinError('peer disconnected during handshake')).toBe(false);
    });

    test('an error that merely mentions the words in another order is not', () => {
        expect(isConnectionFailureJoinError('after exchanging SDP it could not connect to peer x')).toBe(false);
    });
});
