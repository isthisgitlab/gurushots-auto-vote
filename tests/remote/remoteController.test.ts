/**
 * The phone's remote autovote controller: the state is only ever the relayed
 * one, the commands go to the desktop as messages, a new cycle refetches the
 * challenge list, and maybeResume does nothing — the phone never runs its own
 * voting loop.
 */

import { createRemoteAutovoteController } from '../../src/ts/core/autovote/remote';
import { createHybridTransport } from '../../src/ts/core/remote/hybridTransport';
import { TransportStub } from '../helpers/remoteTransport';
import { initialState } from '../../src/ts/core/autovote/state';
import { setRemoteConnectionState, setRemoteHostPeerId } from '../../src/ts/core/remote/connectionState';

import type { AutovoteState } from '../../src/ts/core/autovote/state';

const stateOf = (overrides: Partial<AutovoteState> = {}): AutovoteState => ({ ...initialState, ...overrides });

describe('createRemoteAutovoteController', () => {
    let phone: TransportStub;
    let refreshes: number;
    let controller: ReturnType<typeof createRemoteAutovoteController>;

    beforeEach(() => {
        setRemoteConnectionState('connected');
        setRemoteHostPeerId('host');
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
        setRemoteConnectionState('connecting');
        setRemoteHostPeerId(null);
    });

    test.each(['connecting', 'offline', 'network', 'update', 'update-this', 'full', 'no-key'] as const)(
        'start, stop and rearm while %s send nothing and say the phone is not connected',
        async (connection) => {
            setRemoteConnectionState(connection);
            for (const method of ['start', 'stop', 'rearmSchedule'] as const) {
                controller.dispose();
                controller = createRemoteAutovoteController({
                    transport: phone,
                    getOnChallengesRefresh: () => undefined,
                });
                await controller[method]();
                expect(controller.getState()).toMatchObject({
                    status: 'Error',
                    statusClass: 'badge-error',
                    error: 'Not connected to your computer. It reconnects by itself when the app is open on your computer.',
                });
                controller.dispose();
            }
            expect(phone.sent).toHaveLength(0);
        },
    );

    test('the not-connected error notifies the listeners and the next relayed state replaces it', async () => {
        setRemoteConnectionState('offline');
        const seen: string[] = [];
        controller.subscribe(() => seen.push(controller.getState().status));
        await controller.start();
        expect(seen).toEqual(['Error']);
        phone.receiveFromPeer({ t: 'autovote-state', state: stateOf({ running: true, status: 'Running' }) }, 'host');
        expect(controller.getState().error).toBeNull();
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

    test('start sends the command to the desktop the phone is connected to', async () => {
        await controller.start();
        expect(phone.sent).toEqual([{ message: { t: 'autovote-command', command: 'start' }, target: 'host' }]);
    });

    test('a send that fails says the phone is not connected instead of rejecting', async () => {
        phone.failNextSendOnce();
        await expect(controller.start()).resolves.toBeUndefined();
        expect(controller.getState()).toMatchObject({
            status: 'Error',
            statusClass: 'badge-error',
            error: 'Not connected to your computer. It reconnects by itself when the app is open on your computer.',
        });
    });

    describe('over the hybrid transport, which takes no send without a target', () => {
        let hostDirect: TransportStub;
        let hostRelay: TransportStub;
        let phoneDirect: TransportStub;
        let phoneRelay: TransportStub;
        let received: Array<{ via: string; peerId: string; message: unknown }>;

        beforeEach(() => {
            jest.useFakeTimers();
            [hostDirect, phoneDirect] = TransportStub.pair('host', 'phone');
            [hostRelay, phoneRelay] = TransportStub.pair('host', 'phone');
            received = [];
            hostDirect.onMessage((peerId, message) => received.push({ via: 'direct', peerId, message }));
            hostRelay.onMessage((peerId, message) => received.push({ via: 'relay', peerId, message }));
            controller.dispose();
            controller = createRemoteAutovoteController({
                transport: createHybridTransport({
                    direct: phoneDirect,
                    relay: phoneRelay,
                    role: 'phone',
                }),
                getOnChallengesRefresh: () => undefined,
            });
        });

        afterEach(() => jest.useRealTimers());

        test('Start reaches the desktop over the direct path', async () => {
            phoneDirect.emitJoin('host');
            await controller.start();
            expect(received).toEqual([
                { via: 'direct', peerId: 'phone', message: { t: 'autovote-command', command: 'start' } },
            ]);
            expect(controller.getState()).toEqual(initialState);
        });

        test('Start reaches the desktop over the relay path', async () => {
            phoneRelay.emitJoin('host');
            await controller.start();
            expect(received).toEqual([
                { via: 'relay', peerId: 'phone', message: { t: 'autovote-command', command: 'start' } },
            ]);
            expect(controller.getState()).toEqual(initialState);
        });

        test('Start while the transport has no path to the desktop shows the not-connected error', async () => {
            await controller.start();
            expect(received).toEqual([]);
            expect(controller.getState().error).toContain('Not connected to your computer');
        });
    });

    test('the relayed state becomes the controller state and notifies the listeners', () => {
        const seen: AutovoteState[] = [];
        controller.subscribe(() => seen.push(controller.getState()));
        phone.receiveFromPeer({ t: 'autovote-state', state: stateOf({ running: true, cycles: 1 }) }, 'host');
        expect(controller.getState().running).toBe(true);
        expect(seen).toHaveLength(1);
    });

    test('an autovote-state from a fellow phone changes nothing: only the host relays state', () => {
        phone.receiveFromPeer({ t: 'autovote-state', state: stateOf({ running: true, cycles: 1 }) }, 'fellow');
        expect(controller.getState()).toEqual(initialState);
        expect(refreshes).toBe(0);
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

    describe('the desktop run and count a state carries', () => {
        const stamped = (state: AutovoteState, hostRun: string, n: number) => ({
            t: 'autovote-state',
            state,
            hostRun,
            n,
        });

        test('a state with a lower count of the same run than one applied is stale and ignored; a higher one is applied', () => {
            phone.receiveFromPeer(stamped(stateOf({ cycles: 1 }), 'run-a', 5), 'host');
            expect(controller.getState().cycles).toBe(1);
            phone.receiveFromPeer(stamped(stateOf({ cycles: 0, running: true }), 'run-a', 4), 'host');
            expect(controller.getState()).toMatchObject({ cycles: 1, running: false });
            expect(refreshes).toBe(1);
            phone.receiveFromPeer(stamped(stateOf({ cycles: 2 }), 'run-a', 6), 'host');
            expect(controller.getState().cycles).toBe(2);
            // The same count again (a duplicate) is the same state: applied, nothing changes.
            phone.receiveFromPeer(stamped(stateOf({ cycles: 2 }), 'run-a', 6), 'host');
            expect(controller.getState().cycles).toBe(2);
        });

        test('a new run is always applied, even with a count that starts again at 0', () => {
            phone.receiveFromPeer(stamped(stateOf({ cycles: 4 }), 'run-a', 50), 'host');
            phone.receiveFromPeer(stamped(stateOf({ cycles: 1, running: true }), 'run-b', 0), 'host');
            expect(controller.getState()).toMatchObject({ cycles: 1, running: true });
            // And the comparison starts again with the new run.
            phone.receiveFromPeer(stamped(stateOf({ cycles: 9 }), 'run-b', 3), 'host');
            phone.receiveFromPeer(stamped(stateOf({ cycles: 8 }), 'run-b', 2), 'host');
            expect(controller.getState().cycles).toBe(9);
        });

        test('a state with no stamp (an older desktop) is applied as it comes, and so is a stamped one after it', () => {
            phone.receiveFromPeer(stamped(stateOf({ cycles: 1 }), 'run-a', 5), 'host');
            phone.receiveFromPeer({ t: 'autovote-state', state: stateOf({ cycles: 2 }) }, 'host');
            phone.receiveFromPeer({ t: 'autovote-state', state: stateOf({ cycles: 3 }) }, 'host');
            expect(controller.getState().cycles).toBe(3);
            phone.receiveFromPeer(stamped(stateOf({ cycles: 4 }), 'run-a', 1), 'host');
            expect(controller.getState().cycles).toBe(4);
        });
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
