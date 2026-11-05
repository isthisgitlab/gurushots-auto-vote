/**
 * A list channel an older desktop refuses: the real peer bridge answers the page's own allowlisted channel with
 * the "update the app on your computer" text, the real active-challenges hook settles on it as an error, and the
 * challenges section shows that text, instead of an empty list, a crash or a wait that never ends.
 */

import { render, screen, waitFor } from '@testing-library/preact';
import { TranslationProvider } from '@/contexts/TranslationContext';
import { ChallengesProvider, useChallenges } from '@/contexts/ChallengesContext';
import { ChallengesSection } from '@/components/app/ChallengesSection';
import { installPeerBridge } from '../../src/ts/shells/remote/bridge/peer';
import { APP_VERSION, LINK_VERSION, PROTOCOL_VERSION } from '../../src/ts/core/remote/protocol';
import { setRemoteConnectionState } from '../../src/ts/core/remote/connectionState';
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

    test('a refused list channel reaches the UI: the hook settles with the update text and the list shows it', async () => {
        let hookError: Error | null = null;
        let hookLoading = true;
        const Probe = () => {
            const { error, loading } = useChallenges();
            hookError = error;
            hookLoading = loading;
            return null;
        };
        render(
            <TranslationProvider>
                <ChallengesProvider autovoteRunning={false}>
                    <Probe />
                    <ChallengesSection
                        isLoggedIn
                        timezone="UTC"
                        autovoteRunning={false}
                        onChallengeSettingsClick={jest.fn()}
                    />
                </ChallengesProvider>
            </TranslationProvider>,
        );
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

        // The happy-dom project's translator answers the key; tests/remote/peerBridge.test.ts pins the English text.
        await waitFor(() => expect(hookLoading).toBe(false));
        expect((hookError as Error | null)?.message).toBe('errors.remoteUpdateComputer');
        expect(await screen.findByText('errors.remoteUpdateComputer')).toBeTruthy();
        expect(screen.queryByText('errors.fetchFailed')).toBeNull();
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
        await expect(pending).resolves.toEqual({
            success: false,
            error: 'errors.remoteUpdateComputer',
            errorKey: 'errors.remoteUpdateComputer',
        });
    });
});
