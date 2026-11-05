/**
 * Navbar — the in-app Logs button is Capacitor-gated: shown only on a native
 * (Android) platform, since Electron opens the Logs window from its menu. The
 * test mock's t() returns the key, so the button's title is 'logs.title'.
 */
import { render as rawRender } from '@testing-library/preact';
import { fireEvent, render, screen } from './helpers/test-utils';
import { resetPlatformKind } from '../helpers/platformKind';
import { markPlatformKind } from '../../src/ts/core/platform/kind';
import { LINK_VERSION, PROTOCOL_VERSION } from '../../src/ts/core/remote/protocol';
import { setRemoteConnectionState } from '../../src/ts/core/remote/connectionState';
import { Navbar } from '@/components/layout/Navbar';
import { TranslationProvider } from '@/contexts/TranslationContext';
import { AutovoteProvider } from '@/contexts/AutovoteContext';
import { TransportStub } from '../helpers/remoteTransport';

import type { ComponentChildren } from 'preact';
import type { RemoteTransport } from '../../src/ts/core/remote/relays';

describe('Navbar', () => {
    afterEach(resetPlatformKind);

    test('the desktop badge says how many connected phones are reached over the relays', async () => {
        const { act } = await import('@testing-library/preact');
        const { createRemoteHost, setActiveRemoteHost } = await import('../../src/ts/react/api/remoteHost');
        const { TransportStub } = await import('../helpers/remoteTransport');
        const { initialState } = await import('../../src/ts/core/autovote/state');

        const transport = new TransportStub('badge-host');
        const relayPeers = new Set(['relayed']);
        Object.assign(transport, { peerPath: (peerId: string) => (relayPeers.has(peerId) ? 'relay' : 'direct') });
        const host = createRemoteHost({
            createTransport: async () => transport,
            invoke: async () => ({ app: {} }),
            getAutovoteState: () => initialState,
            runAutovoteCommand: (): Promise<void> => Promise.resolve(),
            onForwardedEvent: () => (): void => undefined,
            onLogMessage: () => () => undefined,
            notify: () => undefined,
            logInfo: () => undefined,
            version: '1.14.2',
        });
        await host.start('k');
        setActiveRemoteHost(host);
        const view = render(
            <Navbar isMock={false} onLogsClick={() => {}} onSettingsClick={() => {}} onLogout={() => {}} />,
        );
        const hello = {
            t: 'hello',
            version: '1.14.2',
            protocolVersion: PROTOCOL_VERSION,
            linkVersion: LINK_VERSION,
            host: false,
        };
        const settle = async (): Promise<void> => {
            await act(async () => {
                for (let i = 0; i < 10; i++) await Promise.resolve();
            });
        };

        act(() => {
            transport.emitJoin('direct-phone');
            transport.receiveFromPeer(hello, 'direct-phone');
        });
        await settle();
        expect(screen.getByText('app.remoteConnectedCount')).toBeDefined(); // nobody on the relays yet

        act(() => {
            transport.emitJoin('relayed');
            transport.receiveFromPeer(hello, 'relayed');
        });
        await settle();
        expect(screen.getByText('app.remoteConnectedCountRelay')).toBeDefined();
        expect(screen.queryByText('app.remoteConnectedCount')).toBeNull();

        await host.stop();
        setActiveRemoteHost(null);
        view.unmount();
    });

    test('the desktop badge appears only while a phone is connected', async () => {
        const { act } = await import('@testing-library/preact');
        const { createRemoteHost, setActiveRemoteHost } = await import('../../src/ts/react/api/remoteHost');
        const { TransportStub } = await import('../helpers/remoteTransport');
        const { initialState } = await import('../../src/ts/core/autovote/state');

        const transport = new TransportStub('badge-host');
        const host = createRemoteHost({
            createTransport: async () => transport,
            invoke: async () => ({ app: {} }),
            getAutovoteState: () => initialState,
            runAutovoteCommand: (): Promise<void> => Promise.resolve(),
            onForwardedEvent: () => (): void => undefined,
            onLogMessage: () => () => undefined,
            notify: () => undefined,
            logInfo: () => undefined,
            version: '1.14.2',
        });
        await host.start('k');
        setActiveRemoteHost(host);
        const view = render(
            <Navbar isMock={false} onLogsClick={() => {}} onSettingsClick={() => {}} onLogout={() => {}} />,
        );
        expect(screen.queryByText('app.remoteConnectedCount')).toBeNull();

        act(() => {
            transport.emitJoin('p1');
            transport.receiveFromPeer(
                {
                    t: 'hello',
                    version: '1.14.2',
                    protocolVersion: PROTOCOL_VERSION,
                    linkVersion: LINK_VERSION,
                    host: false,
                },
                'p1',
            );
        });
        await act(async () => {
            for (let i = 0; i < 10; i++) await Promise.resolve();
        });
        expect(screen.getByText('app.remoteConnectedCount')).toBeDefined();

        act(() => {
            transport.emitLeave('p1');
        });
        await act(async () => {
            for (let i = 0; i < 10; i++) await Promise.resolve();
        });
        expect(screen.queryByText('app.remoteConnectedCount')).toBeNull();

        await host.stop();
        setActiveRemoteHost(null);
        view.unmount();
    });

    test.each([
        ['web', false],
        ['capacitor', false],
        ['electron', false],
        ['remote', true],
    ] as const)('the phone connection badge on the %s kind is present: %s', (kind, present) => {
        setRemoteConnectionState('connecting');
        markPlatformKind(kind);
        // The remote kind's provider builds its controller over the pairing transport.
        const wrapper = ({ children }: { children?: ComponentChildren }) => (
            <TranslationProvider>
                <AutovoteProvider remoteTransport={TransportStub.pair()[1] as RemoteTransport}>
                    {children}
                </AutovoteProvider>
            </TranslationProvider>
        );
        const navbar = <Navbar isMock={false} onLogsClick={() => {}} onSettingsClick={() => {}} onLogout={() => {}} />;
        // The shared render fixes its wrapper; the remote kind brings its own provider with the pairing transport.
        if (kind === 'remote') rawRender(navbar, { wrapper });
        else render(navbar);
        // "Connecting to your computer…" would otherwise sit in the header of a browser tab or the Android app.
        expect(screen.queryByText('app.remoteConnecting') !== null).toBe(present);
    });

    test('hides the Logs button off Capacitor', () => {
        render(<Navbar isMock={false} onLogsClick={() => {}} onSettingsClick={() => {}} onLogout={() => {}} />);
        expect(screen.queryByTitle('logs.title')).toBeNull();
        // Settings + logout are always present.
        expect(screen.getByTitle('app.settings')).toBeTruthy();
    });

    test('shows the Logs button on Capacitor and calls onLogsClick', () => {
        markPlatformKind('capacitor');
        const onLogsClick = jest.fn();
        render(<Navbar isMock={false} onLogsClick={onLogsClick} onSettingsClick={() => {}} onLogout={() => {}} />);
        const logsBtn = screen.getByTitle('logs.title');
        expect(logsBtn).toBeTruthy();
        fireEvent.click(logsBtn);
        expect(onLogsClick).toHaveBeenCalledTimes(1);
    });

    test('logout is reversible, so it is styled like the settings button, not as a destructive one', () => {
        render(<Navbar isMock={false} onLogsClick={() => {}} onSettingsClick={() => {}} onLogout={() => {}} />);
        const logout = screen.getByRole('button', { name: 'app.logout' });
        expect(logout.className).toBe(screen.getByRole('button', { name: 'app.settings' }).className);
        expect(logout.className).not.toContain('btn-error');
    });

    test('the icon-only buttons carry accessible names', () => {
        markPlatformKind('capacitor');
        render(<Navbar isMock={false} onLogsClick={() => {}} onSettingsClick={() => {}} onLogout={() => {}} />);
        for (const name of ['logs.title', 'app.settings', 'app.logout']) {
            expect(screen.getByRole('button', { name })).toBeTruthy();
        }
    });

    test('the donate button is a primary button whose click opens the donation page', () => {
        render(<Navbar isMock={false} onLogsClick={() => {}} onSettingsClick={() => {}} onLogout={() => {}} />);
        const donate = screen.getByRole('button', { name: 'app.donate' });
        expect(donate.className).toContain('btn-primary');
        fireEvent.click(donate);
        expect(window.api.openExternalUrl).toHaveBeenCalledWith('https://donatr.ee/isthisgitlab/');
        expect(window.api.openExternalUrl).toHaveBeenCalledTimes(1);
    });
});
