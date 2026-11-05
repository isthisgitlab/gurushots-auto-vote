/**
 * A list channel an older desktop refuses: the real peer bridge answers the page's own allowlisted channel with
 * the "update the app on your computer" text, and the real active-challenges hook settles on it, with an empty
 * list and no error, instead of crashing or waiting forever.
 */

import { renderHook, waitFor } from '@testing-library/preact';
import { installPeerBridge } from '../../src/ts/shells/remote/bridge/peer';
import { APP_VERSION, LINK_VERSION, PROTOCOL_VERSION } from '../../src/ts/core/remote/protocol';
import { setRemoteConnectionState } from '../../src/ts/core/remote/connectionState';
import { useActiveChallenges } from '@/api/useActiveChallenges';
import { TransportStub } from '../helpers/remoteTransport';

type SentInvoke = { t: 'invoke'; id: number; channel: string };

const invokesOf = (phone: TransportStub): SentInvoke[] =>
    phone.sent.map(({ message }) => message as { t: string }).filter((m): m is SentInvoke => m.t === 'invoke');

describe('a list channel the desktop refuses', () => {
    let phone: TransportStub;
    let host: TransportStub;

    beforeEach(() => {
        setRemoteConnectionState('connecting');
        [host, phone] = TransportStub.pair('host', 'phone');
        installPeerBridge(phone, 'https://site.test/remote/index.html#k=the-key');
        phone.emitJoin('host');
        phone.receiveFromPeer(
            {
                t: 'hello',
                version: APP_VERSION,
                protocolVersion: PROTOCOL_VERSION,
                linkVersion: LINK_VERSION,
                host: true,
            },
            'host',
        );
    });

    afterEach(() => {
        host.receiveFromPeer({ t: 'bye' }, 'phone');
        delete (globalThis as { api?: unknown }).api;
        delete (globalThis as { __autovotePlatformKind?: string }).__autovotePlatformKind;
        setRemoteConnectionState('connecting');
    });

    test('shows the update text from the bridge and leaves the hook settled with an empty list', async () => {
        const { result } = renderHook(() => useActiveChallenges());
        // The hook reads the settings, then the challenges: answer the first, refuse the second.
        await waitFor(() => expect(invokesOf(phone).map((invoke) => invoke.channel)).toContain('get-settings'));
        const settingsInvoke = invokesOf(phone).find((invoke) => invoke.channel === 'get-settings');
        phone.receiveFromPeer({ t: 'result', id: settingsInvoke?.id, ok: true, result: { hasToken: true } }, 'host');
        await waitFor(() =>
            expect(invokesOf(phone).map((invoke) => invoke.channel)).toContain('get-active-challenges'),
        );
        const listInvoke = invokesOf(phone).find((invoke) => invoke.channel === 'get-active-challenges');
        phone.receiveFromPeer(
            { t: 'result', id: listInvoke?.id, ok: false, error: 'Refused remotely: not part of the remote surface.' },
            'host',
        );

        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.data).toEqual([]);
        expect(result.current.error).toBeNull();
    });

    test('the same refusal reaches the caller as the update text', async () => {
        const api = (globalThis as { api?: { getActiveChallenges: () => Promise<unknown> } }).api;
        const pending = api?.getActiveChallenges();
        const listInvoke = invokesOf(phone).find((invoke) => invoke.channel === 'get-active-challenges');
        phone.receiveFromPeer(
            { t: 'result', id: listInvoke?.id, ok: false, error: 'Refused remotely: not part of the remote surface.' },
            'host',
        );
        // The happy-dom project's translator answers the key; tests/remote/peerBridge.test.ts pins the English text.
        await expect(pending).resolves.toEqual({ success: false, error: 'errors.remoteUpdateComputer' });
    });
});
