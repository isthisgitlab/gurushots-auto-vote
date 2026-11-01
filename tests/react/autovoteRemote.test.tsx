/**
 * AutovoteProvider on the `remote` kind: it builds the relayed remote
 * controller — never the desktop's local one — the start/stop/rearm controls
 * go to the desktop as autovote-command messages, a relayed cycle change
 * fires the provider's onChallengesRefresh, and mounting without the
 * pairing transport fails closed.
 */

import { render, act } from '@testing-library/preact';
import { AutovoteProvider, useAutovote } from '@/contexts/AutovoteContext';
import { TransportStub } from '../helpers/remoteTransport';
import { markPlatformKind } from '../../src/ts/core/platform/kind';
import { resetPlatformKind } from '../helpers/platformKind';

import type { RemoteTransport } from '../../src/ts/core/remote/relays';

const captured: { local: number; remote: number } = { local: 0, remote: 0 };

jest.mock('../../src/ts/core/autovote/controller', () => {
    const actual = jest.requireActual<typeof import('../../src/ts/core/autovote/controller')>(
        '../../src/ts/core/autovote/controller',
    );
    return {
        ...actual,
        createAutovoteController: (...args: Parameters<typeof actual.createAutovoteController>) => {
            captured.local += 1;
            return actual.createAutovoteController(...args);
        },
    };
});
jest.mock('../../src/ts/core/autovote/remote', () => {
    const actual = jest.requireActual<typeof import('../../src/ts/core/autovote/remote')>(
        '../../src/ts/core/autovote/remote',
    );
    return {
        ...actual,
        createRemoteAutovoteController: (...args: Parameters<typeof actual.createRemoteAutovoteController>) => {
            captured.remote += 1;
            return actual.createRemoteAutovoteController(...args);
        },
    };
});

/** Reads the controller's state through the context and exposes the controls to the test. */
let latest: ReturnType<typeof useAutovote> | null = null;
const Probe = (): null => {
    latest = useAutovote();
    return null;
};

describe('AutovoteProvider on the remote kind', () => {
    let phone: TransportStub;

    beforeEach(() => {
        captured.local = 0;
        captured.remote = 0;
        latest = null;
        phone = TransportStub.pair('host', 'phone')[1];
        markPlatformKind('remote');
    });

    afterEach(() => {
        resetPlatformKind();
    });

    test('it builds the remote controller, never the local one', () => {
        render(
            <AutovoteProvider remoteTransport={phone as RemoteTransport}>
                <Probe />
            </AutovoteProvider>,
        );
        expect(captured.remote).toBe(1);
        expect(captured.local).toBe(0);
        expect(latest?.running).toBe(false);
    });

    test('it fails closed without the pairing transport', () => {
        expect(() =>
            render(
                <AutovoteProvider>
                    <Probe />
                </AutovoteProvider>,
            ),
        ).toThrow('pairing transport');
        expect(captured.local).toBe(0);
    });

    test('start, stop and rearm reach the desktop as autovote-command messages', async () => {
        render(
            <AutovoteProvider remoteTransport={phone as RemoteTransport}>
                <Probe />
            </AutovoteProvider>,
        );
        await act(() => latest!.start());
        await act(() => latest!.stop());
        await act(() => latest!.rearmSchedule());
        const commands = phone.sent.map(({ message }) => message as { t: string; command?: string });
        expect(commands).toEqual([
            { t: 'autovote-command', command: 'start' },
            { t: 'autovote-command', command: 'stop' },
            { t: 'autovote-command', command: 'rearm' },
        ]);
    });

    test('a relayed cycle change fires the provider onChallengesRefresh, and the state follows the relay', async () => {
        let refreshes = 0;
        render(
            <AutovoteProvider
                remoteTransport={phone as RemoteTransport}
                onChallengesRefresh={() => {
                    refreshes += 1;
                }}
            >
                <Probe />
            </AutovoteProvider>,
        );
        const state = {
            running: true,
            cycles: 1,
            lastRun: null,
            nextRunAt: null,
            pendingStartAt: null,
            status: 'Running' as const,
            statusClass: 'badge-success' as const,
            error: null,
        };
        await act(async () => {
            phone.receiveFromPeer({ t: 'autovote-state', state }, 'host');
            await Promise.resolve();
        });
        expect(refreshes).toBe(1);
        expect(latest?.running).toBe(true);
        expect(latest?.cycles).toBe(1);
    });
});
