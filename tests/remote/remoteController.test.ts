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

/** A request identity the way the phone draws one: 32 hex characters. */
const ID = /^[0-9a-f]{32}$/;

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

    /** A state the way the desktop sends it: stamped with its run and count. */
    const stamped = (state: AutovoteState, hostRun: string, n: number) => ({
        t: 'autovote-state',
        state,
        hostRun,
        n,
    });

    test('the not-connected error notifies the listeners and the next relayed state replaces it', async () => {
        setRemoteConnectionState('offline');
        const seen: string[] = [];
        controller.subscribe(() => seen.push(controller.getState().status));
        await controller.start();
        expect(seen).toEqual(['Error']);
        phone.receiveFromPeer(stamped(stateOf({ running: true, status: 'Running' }), 'run-a', 1), 'host');
        expect(controller.getState().error).toBeNull();
    });

    test('start and stop send autovote-command and never run anything locally', async () => {
        await controller.start();
        await controller.stop();
        await controller.rearmSchedule();
        const commands = phone.sent.map(({ message }) => message as { t: string; command?: string });
        expect(commands).toEqual([
            { t: 'autovote-command', command: 'start', requestId: expect.stringMatching(ID) },
            { t: 'autovote-command', command: 'stop', requestId: expect.stringMatching(ID) },
            { t: 'autovote-command', command: 'rearm', requestId: expect.stringMatching(ID) },
        ]);
        // Three commands, three identities.
        expect(new Set(commands.map((command) => (command as { requestId?: string }).requestId)).size).toBe(3);
        // The state is the desktop's relay, apart from the Stop the desktop has not answered yet.
        expect(controller.getState()).toEqual({ ...initialState, lastStop: { outcome: 'requested', durable: false } });
    });

    test('start sends the command to the desktop the phone is connected to', async () => {
        await controller.start();
        expect(phone.sent).toEqual([
            {
                message: { t: 'autovote-command', command: 'start', requestId: expect.stringMatching(ID) },
                target: 'host',
            },
        ]);
    });

    test('a command with no host peer known goes to the transport with no target', async () => {
        setRemoteHostPeerId(null);
        await controller.start();
        expect(phone.sent).toEqual([
            {
                message: { t: 'autovote-command', command: 'start', requestId: expect.stringMatching(ID) },
                target: undefined,
            },
        ]);
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
                {
                    via: 'direct',
                    peerId: 'phone',
                    message: { t: 'autovote-command', command: 'start', requestId: expect.stringMatching(ID) },
                },
            ]);
            expect(controller.getState()).toEqual(initialState);
        });

        test('Start reaches the desktop over the relay path', async () => {
            phoneRelay.emitJoin('host');
            await controller.start();
            expect(received).toEqual([
                {
                    via: 'relay',
                    peerId: 'phone',
                    message: { t: 'autovote-command', command: 'start', requestId: expect.stringMatching(ID) },
                },
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
        phone.receiveFromPeer(stamped(stateOf({ running: true, cycles: 1 }), 'run-a', 1), 'host');
        expect(controller.getState().running).toBe(true);
        expect(seen).toHaveLength(1);
    });

    test('an unsubscribed listener hears nothing more', () => {
        const seen: AutovoteState[] = [];
        const unsubscribe = controller.subscribe(() => seen.push(controller.getState()));
        phone.receiveFromPeer(stamped(stateOf({ cycles: 1 }), 'run-a', 1), 'host');
        unsubscribe();
        phone.receiveFromPeer(stamped(stateOf({ cycles: 2 }), 'run-a', 2), 'host');
        expect(seen).toHaveLength(1);
    });

    test('an autovote-state from a fellow phone changes nothing: only the host relays state', () => {
        phone.receiveFromPeer(stamped(stateOf({ running: true, cycles: 1 }), 'run-a', 1), 'fellow');
        expect(controller.getState()).toEqual(initialState);
        expect(refreshes).toBe(0);
    });

    test('a relayed cycle change triggers the challenge refresh', () => {
        phone.receiveFromPeer(stamped(stateOf({ running: true, cycles: 1 }), 'run-a', 1), 'host');
        expect(refreshes).toBe(1);
        // The same cycle again is not a new one.
        phone.receiveFromPeer(stamped(stateOf({ running: true, cycles: 1 }), 'run-a', 1), 'host');
        expect(refreshes).toBe(1);
        phone.receiveFromPeer(stamped(stateOf({ running: true, cycles: 2 }), 'run-a', 2), 'host');
        expect(refreshes).toBe(2);
    });

    test('a cycle that does not change (lastRun updates) does not refresh', () => {
        phone.receiveFromPeer(stamped(stateOf({ cycles: 1 }), 'run-a', 1), 'host');
        expect(refreshes).toBe(1);
        // The same cycle again — only its lastRun moved — is not a new one.
        phone.receiveFromPeer(stamped(stateOf({ cycles: 1, lastRun: 'now' }), 'run-a', 2), 'host');
        expect(refreshes).toBe(1);
    });

    describe('the desktop run and count a state carries', () => {
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

        test('a state with no stamp is dropped: nothing is applied and nothing notifies', () => {
            const seen: AutovoteState[] = [];
            controller.subscribe(() => seen.push(controller.getState()));
            phone.receiveFromPeer({ t: 'autovote-state', state: stateOf({ cycles: 2 }) }, 'host');
            phone.receiveFromPeer({ t: 'autovote-state', state: stateOf({ cycles: 3 }), hostRun: 'run-a' }, 'host');
            expect(controller.getState()).toEqual(initialState);
            expect(seen).toEqual([]);
            expect(refreshes).toBe(0);
        });
    });

    describe('a Stop is pending until the desktop answers it', () => {
        const stoppedAt = (epoch: number, overrides: Partial<AutovoteState> = {}) =>
            stateOf({
                executionMode: 'stopped',
                stopEpoch: epoch,
                lastStop: { outcome: 'stopped', durable: true, epoch, withdrawal: 'withdrawn' },
                ...overrides,
            });
        const sentStopId = (): string =>
            (
                phone.sent
                    .map(({ message }) => message as { command?: string; requestId?: string })
                    .find((message) => message.command === 'stop') as { requestId: string }
            ).requestId;

        test('it reads requested from the send, whatever the desktop is told, and never as stopped', async () => {
            await controller.stop();
            expect(controller.getState().lastStop).toEqual({ outcome: 'requested', durable: false });
            // A state that does not answer it (no acknowledgment, no higher epoch) leaves it pending.
            phone.receiveFromPeer(
                stamped(stateOf({ running: true, executionMode: 'voting', stopEpoch: null }), 'run-a', 1),
                'host',
            );
            expect(controller.getState()).toMatchObject({ running: true, lastStop: { outcome: 'requested' } });
        });

        test('the desktop acknowledging that identity ends it with what the desktop did', async () => {
            await controller.stop();
            const ack = { requestId: sentStopId(), command: 'stop', outcome: 'ran' };
            const local = stateOf({
                executionMode: 'stopped',
                lastStop: { outcome: 'stopped-locally', durable: false, reason: 'not-saved', withdrawal: 'none' },
            });
            phone.receiveFromPeer({ ...stamped(local, 'run-a', 1), ack }, 'host');
            // Local cancellation only: the fence was not saved, and the phone says exactly that.
            expect(controller.getState().lastStop).toEqual(local.lastStop);
            // The next state no longer carries the pending Stop.
            phone.receiveFromPeer(stamped(stateOf({ running: true }), 'run-a', 2), 'host');
            expect(controller.getState().lastStop).toBeNull();
        });

        test('a fresh stopped state with a higher epoch ends it without an acknowledgment', async () => {
            phone.receiveFromPeer(
                stamped(stoppedAt(2, { executionMode: 'voting', running: true }), 'run-a', 1),
                'host',
            );
            await controller.stop();
            // Stopped, but at the epoch the phone already knew: not an answer.
            phone.receiveFromPeer(stamped(stoppedAt(2), 'run-a', 2), 'host');
            expect(controller.getState().lastStop).toEqual({ outcome: 'requested', durable: false });
            phone.receiveFromPeer(stamped(stoppedAt(3), 'run-a', 3), 'host');
            expect(controller.getState().lastStop).toMatchObject({ outcome: 'stopped', durable: true, epoch: 3 });
        });

        test('with no epoch known, a stopped state at any epoch answers it', async () => {
            await controller.stop();
            phone.receiveFromPeer(stamped(stoppedAt(1), 'run-a', 1), 'host');
            expect(controller.getState().lastStop).toMatchObject({ outcome: 'stopped', epoch: 1 });
        });

        test('a lost connection leaves it pending; it is not sent again', async () => {
            await controller.stop();
            setRemoteConnectionState('offline');
            await controller.stop();
            expect(phone.sent).toHaveLength(1);
            expect(controller.getState().lastStop).toEqual({ outcome: 'requested', durable: false });
            expect(controller.getState().error).toContain('Not connected');
        });

        test('a send that failed leaves it pending too: the desktop may have received it', async () => {
            phone.failNextSendOnce();
            await controller.stop();
            expect(controller.getState()).toMatchObject({ lastStop: { outcome: 'requested' }, status: 'Error' });
        });

        test('a Start or re-arm carries the Stop epoch of the state the phone saw; a Stop carries none', async () => {
            phone.receiveFromPeer(stamped(stoppedAt(4), 'run-a', 1), 'host');
            await controller.start();
            await controller.rearmSchedule();
            await controller.stop();
            const sent = phone.sent.map(({ message }) => message as { command: string; expectedStopEpoch?: number });
            expect(sent.map((message) => [message.command, message.expectedStopEpoch])).toEqual([
                ['start', 4],
                ['rearm', 4],
                ['stop', undefined],
            ]);
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
        phone.receiveFromPeer(stamped(stateOf({ cycles: 1 }), 'run-a', 1), 'host');
        await controller.start();
        expect(controller.getState()).toEqual(initialState);
        expect(phone.sent).toHaveLength(0);
    });

    describe('a Run or Resume the desktop has not answered', () => {
        const stampedAt = (state: AutovoteState, n: number, ack?: object) => ({
            t: 'autovote-state',
            state,
            hostRun: 'run-a',
            n,
            ...(ack === undefined ? {} : { ack }),
        });
        const sentStartId = (): string =>
            (
                phone.sent
                    .map(({ message }) => message as { command?: string; requestId?: string })
                    .find((message) => message.command === 'start') as { requestId: string }
            ).requestId;

        test("is pending from the send, tells the listeners, and the state itself is still the desktop's", async () => {
            expect(controller.getStartPending?.()).toBe(false);
            const seen: boolean[] = [];
            controller.subscribe(() => seen.push(controller.getStartPending?.() ?? false));
            await controller.start();
            expect(controller.getStartPending?.()).toBe(true);
            expect(seen).toEqual([true]);
            // Nothing the desktop has not said: the mode is what it was.
            expect(controller.getState()).toMatchObject({ executionMode: 'stopped', running: false });
        });

        test('a state that still shows stopped, with no refusal and no acknowledgment, leaves it pending', async () => {
            await controller.start();
            phone.receiveFromPeer(stampedAt(stateOf(), 1), 'host');
            expect(controller.getStartPending?.()).toBe(true);
        });

        test.each([
            ['voting', { executionMode: 'voting' as const, running: true }],
            ['armed', { executionMode: 'armed' as const }],
        ])('a state that shows %s ends it', async (_mode, over) => {
            await controller.start();
            phone.receiveFromPeer(stampedAt(stateOf(over), 1), 'host');
            expect(controller.getStartPending?.()).toBe(false);
        });

        test('a refusal carried by the acknowledgment of that identity ends it', async () => {
            await controller.start();
            phone.receiveFromPeer(
                stampedAt(stateOf({ startRefusal: 'stop-epoch-moved' }), 1, {
                    requestId: sentStartId(),
                    command: 'start',
                    outcome: 'ran',
                }),
                'host',
            );
            expect(controller.getStartPending?.()).toBe(false);
        });

        test('a refusal left over from an earlier attempt does not end a newer pending Run', async () => {
            await controller.start();
            // The host answers the first Run: refused.
            phone.receiveFromPeer(
                stampedAt(stateOf({ startRefusal: 'stop-epoch-moved' }), 1, {
                    requestId: sentStartId(),
                    command: 'start',
                    outcome: 'ran',
                }),
                'host',
            );
            expect(controller.getStartPending?.()).toBe(false);
            // A second Run goes out; before the host answers it, an unrelated push still carries the old refusal.
            await controller.start();
            expect(controller.getStartPending?.()).toBe(true);
            phone.receiveFromPeer(stampedAt(stateOf({ startRefusal: 'stop-epoch-moved' }), 2), 'host');
            expect(controller.getStartPending?.()).toBe(true);
            // Its own answer still ends it.
            const secondId = (
                phone.sent
                    .map(({ message }) => message as { command?: string; requestId?: string })
                    .filter((message) => message.command === 'start')
                    .at(-1) as { requestId: string }
            ).requestId;
            phone.receiveFromPeer(
                stampedAt(stateOf({ startRefusal: 'stop-epoch-moved' }), 3, {
                    requestId: secondId,
                    command: 'start',
                    outcome: 'ran',
                }),
                'host',
            );
            expect(controller.getStartPending?.()).toBe(false);
        });

        test('the acknowledgment of that identity ends it, and one of another identity does not', async () => {
            await controller.start();
            const other = { requestId: 'f'.repeat(32), command: 'start', outcome: 'ran' };
            phone.receiveFromPeer(stampedAt(stateOf(), 1, other), 'host');
            expect(controller.getStartPending?.()).toBe(true);
            phone.receiveFromPeer(
                stampedAt(stateOf(), 2, { requestId: sentStartId(), command: 'start', outcome: 'failed' }),
                'host',
            );
            expect(controller.getStartPending?.()).toBe(false);
        });

        test('a Run that could not be sent is not pending', async () => {
            phone.failNextSendOnce();
            await controller.start();
            expect(controller.getStartPending?.()).toBe(false);
            expect(controller.getState().status).toBe('Error');
        });

        test('a Run while not connected is never pending', async () => {
            setRemoteConnectionState('offline');
            await controller.start();
            expect(controller.getStartPending?.()).toBe(false);
        });

        test('a Stop is not a Run: it leaves this flag alone', async () => {
            await controller.stop();
            expect(controller.getStartPending?.()).toBe(false);
        });

        test('the confirmed Stop clears the Run it superseded, so a fresh Run is possible', async () => {
            await controller.start();
            await controller.stop();
            const stopId = (
                phone.sent
                    .map(({ message }) => message as { command?: string; requestId?: string })
                    .find((message) => message.command === 'stop') as { requestId: string }
            ).requestId;
            expect(controller.getStartPending?.()).toBe(true);
            // The host acknowledges the Stop: the Run sent before it will not run.
            phone.receiveFromPeer(
                stampedAt(stateOf({ executionMode: 'stopped', stopEpoch: 4 }), 1, {
                    requestId: stopId,
                    command: 'stop',
                    outcome: 'ran',
                }),
                'host',
            );
            expect(controller.getStartPending?.()).toBe(false);
            // A fresh Run goes out as a new command.
            await controller.start();
            expect(
                phone.sent.filter(({ message }) => (message as { command?: string }).command === 'start'),
            ).toHaveLength(2);
        });

        test('a fresh stopped state with a higher epoch clears the superseded Run as well', async () => {
            await controller.start();
            await controller.stop();
            expect(controller.getStartPending?.()).toBe(true);
            phone.receiveFromPeer(stampedAt(stateOf({ executionMode: 'stopped', stopEpoch: 4 }), 1), 'host');
            expect(controller.getStartPending?.()).toBe(false);
        });

        test('a Run sent after the Stop is kept when the Stop is confirmed', async () => {
            await controller.stop();
            await controller.start();
            const stopId = (
                phone.sent
                    .map(({ message }) => message as { command?: string; requestId?: string })
                    .find((message) => message.command === 'stop') as { requestId: string }
            ).requestId;
            phone.receiveFromPeer(
                stampedAt(stateOf({ executionMode: 'stopped', stopEpoch: 4 }), 1, {
                    requestId: stopId,
                    command: 'stop',
                    outcome: 'ran',
                }),
                'host',
            );
            // The newer Run still waits for its own answer.
            expect(controller.getStartPending?.()).toBe(true);
        });

        test('a Stop that is not confirmed leaves the pending Run intact', async () => {
            // The phone first knows an epoch (4): a stopped state at that same epoch is not a fresh Stop.
            phone.receiveFromPeer(stampedAt(stateOf({ executionMode: 'stopped', stopEpoch: 4 }), 1), 'host');
            await controller.start();
            await controller.stop();
            phone.receiveFromPeer(stampedAt(stateOf({ executionMode: 'stopped', stopEpoch: 4 }), 2), 'host');
            // Neither the Stop's acknowledgment nor a fresh stopped epoch: the Run keeps waiting, the Stop stays requested.
            expect(controller.getStartPending?.()).toBe(true);
            expect(controller.getState().lastStop).toEqual({ outcome: 'requested', durable: false });
        });
    });
});
