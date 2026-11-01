/**
 * The phone's remote autovote controller: the state is only ever the relayed
 * one, the commands go to the desktop as messages, a new cycle refetches the
 * challenge list, and maybeResume does nothing — the phone never runs its own
 * voting loop.
 */

import { createRemoteAutovoteController } from '../../src/ts/core/autovote/remote';
import { TransportStub } from '../helpers/remoteTransport';
import { initialState } from '../../src/ts/core/autovote/state';

import type { AutovoteState } from '../../src/ts/core/autovote/state';

const stateOf = (overrides: Partial<AutovoteState> = {}): AutovoteState => ({ ...initialState, ...overrides });

describe('createRemoteAutovoteController', () => {
    let phone: TransportStub;
    let refreshes: number;
    let controller: ReturnType<typeof createRemoteAutovoteController>;

    beforeEach(() => {
        [, phone] = TransportStub.pair();
        refreshes = 0;
        controller = createRemoteAutovoteController({
            transport: phone,
            getOnChallengesRefresh: () => () => {
                refreshes += 1;
            },
        });
    });

    afterEach(() => {
        controller.dispose();
    });

    test('start and stop send autovote-command and never run anything locally', async () => {
        await controller.start();
        await controller.stop();
        await controller.rearmSchedule();
        const commands = phone.sent.map(({ message }) => message as { t: string; command?: string });
        expect(commands).toEqual([
            { t: 'autovote-command', command: 'start' },
            { t: 'autovote-command', command: 'stop' },
            { t: 'autovote-command', command: 'rearm' },
        ]);
        // The state is untouched: the desktop's relay is the only input.
        expect(controller.getState()).toEqual(initialState);
    });

    test('the relayed state becomes the controller state and notifies the listeners', () => {
        const seen: AutovoteState[] = [];
        controller.subscribe(() => seen.push(controller.getState()));
        phone.receiveFromPeer({ t: 'autovote-state', state: stateOf({ running: true, cycles: 1 }) }, 'host');
        expect(controller.getState().running).toBe(true);
        expect(seen).toHaveLength(1);
    });

    test('a relayed cycle change triggers the challenge refresh', () => {
        phone.receiveFromPeer({ t: 'autovote-state', state: stateOf({ running: true, cycles: 1 }) }, 'host');
        expect(refreshes).toBe(1);
        // The same cycle again is not a new one.
        phone.receiveFromPeer({ t: 'autovote-state', state: stateOf({ running: true, cycles: 1 }) }, 'host');
        expect(refreshes).toBe(1);
        phone.receiveFromPeer({ t: 'autovote-state', state: stateOf({ running: true, cycles: 2 }) }, 'host');
        expect(refreshes).toBe(2);
    });

    test('a cycle that does not change (lastRun updates) does not refresh', () => {
        phone.receiveFromPeer({ t: 'autovote-state', state: stateOf({ cycles: 1 }) }, 'host');
        expect(refreshes).toBe(1);
        // The same cycle again — only its lastRun moved — is not a new one.
        phone.receiveFromPeer({ t: 'autovote-state', state: stateOf({ cycles: 1, lastRun: 'now' }) }, 'host');
        expect(refreshes).toBe(1);
    });

    test('maybeResume resolves and changes nothing', async () => {
        await expect(controller.maybeResume()).resolves.toBeUndefined();
        expect(phone.sent).toHaveLength(0);
        expect(controller.getState()).toEqual(initialState);
    });

    test('messages that are not autovote-state are ignored', () => {
        phone.receiveFromPeer({ t: 'event', channel: 'settings-changed', payload: {} }, 'host');
        phone.receiveFromPeer({ t: 'nonsense' }, 'host');
        expect(controller.getState()).toEqual(initialState);
        expect(refreshes).toBe(0);
    });

    test('dispose stops listening; commands are no longer sent', async () => {
        controller.dispose();
        phone.receiveFromPeer({ t: 'autovote-state', state: stateOf({ cycles: 1 }) }, 'host');
        await controller.start();
        expect(controller.getState()).toEqual(initialState);
        expect(phone.sent).toHaveLength(0);
    });
});
