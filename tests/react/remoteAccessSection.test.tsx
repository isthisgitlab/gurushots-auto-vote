/**
 * The Settings → Remote access section: the toggle writes through
 * set-remote-access and announces the change, the QR code and link stay
 * behind a Show button (the QR alt text names no link), and Reset pairing
 * rotates the key and re-announces.
 */

import { act, screen } from '@testing-library/preact';
import { fireEvent, render } from './helpers/test-utils';
import { SettingsNavProvider } from '@/contexts/SettingsNavContext';
import { RemoteAccessSection } from '@/components/app/RemoteAccessSection';
import { useSettingsNavState } from '@/contexts/SettingsNavContext';

const ANSWERS: { current: { success: boolean; enabled: boolean; link: string; qrDataUrl: string } | undefined } = {
    current: undefined,
};
const calls: Array<{ api: string; args: unknown[] }> = [];

// The shared render helper mounts AutovoteProvider; with the pairing enabled, the provider
// starts the real host. Give the trystero adapter an in-memory transport instead.
jest.mock('../../src/ts/core/remote/trystero', () => ({
    createTrysteroTransport: jest.fn(async () => ({
        send: async () => undefined,
        onMessage: () => () => undefined,
        onPeerJoin: () => () => undefined,
        onPeerLeave: () => () => undefined,
        onJoinError: () => () => undefined,
        leave: async () => undefined,
    })),
    isConnectionFailureJoinError: () => false,
}));

jest.mock('@/api/ipc', () => ({
    __esModule: true,
    ...jest.requireActual<typeof import('@/api/ipc')>('@/api/ipc'),
    callOrNull: async (call: () => unknown) => call(),
    getRemoteAccess: (...args: unknown[]) => {
        calls.push({ api: 'getRemoteAccess', args });
        return ANSWERS.current;
    },
    setRemoteAccess: (...args: unknown[]) => {
        calls.push({ api: 'setRemoteAccess', args });
        return { success: true };
    },
    resetRemotePairing: (...args: unknown[]) => {
        calls.push({ api: 'resetRemotePairing', args });
        return { success: true };
    },
}));

/** The section filters through the settings nav; a provider with an empty query shows everything. */
const NavHarness = ({ children }: { children: React.ReactNode }) => {
    const nav = useSettingsNavState(
        ['application'],
        () => true,
        () => false,
    );
    return <SettingsNavProvider value={nav}>{children}</SettingsNavProvider>;
};

const events: string[] = [];

describe('RemoteAccessSection', () => {
    window.addEventListener('remote-access:changed', () => events.push('changed'));

    beforeEach(() => {
        calls.length = 0;
        events.length = 0;
        ANSWERS.current = {
            success: true,
            enabled: false,
            link: 'https://isthisgitlab.github.io/gurushots-auto-vote/remote/#k=secret',
            qrDataUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
        };
    });

    test('the toggle is off while disabled, and turning it on announces the pairing change', async () => {
        render(
            <NavHarness>
                <RemoteAccessSection showAll />
            </NavHarness>,
        );
        await act(async () => Promise.resolve());
        const toggle = screen.getByLabelText('app.remoteToggleLabel') as HTMLInputElement;
        expect(toggle.checked).toBe(false);

        await act(async () => {
            fireEvent.click(toggle);
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(calls.some(({ api, args }) => api === 'setRemoteAccess' && args[0] === true)).toBe(true);
        expect(events).toEqual(['changed']);
    });

    test('the QR code and link stay behind a Show button, and the alt text names no link', async () => {
        ANSWERS.current = { ...ANSWERS.current!, enabled: true };
        render(
            <NavHarness>
                <RemoteAccessSection showAll />
            </NavHarness>,
        );
        await act(async () => Promise.resolve());
        expect(screen.queryByRole('img')).toBeNull();
        expect(screen.queryByText(/isthisgitlab\.github\.io/)).toBeNull();

        fireEvent.click(screen.getByRole('button', { name: 'app.remoteShow' }));
        const qr = screen.getByRole('img');
        expect(qr.getAttribute('src')).toContain('data:image/svg+xml');
        expect(qr.getAttribute('alt')).not.toContain('secret');
        expect(screen.getByText(/isthisgitlab\.github\.io/)).toBeDefined();
    });

    test('Reset pairing rotates the key and re-announces', async () => {
        ANSWERS.current = { ...ANSWERS.current!, enabled: true };
        render(
            <NavHarness>
                <RemoteAccessSection showAll />
            </NavHarness>,
        );
        await act(async () => Promise.resolve());
        fireEvent.click(screen.getByRole('button', { name: 'app.remoteShow' }));
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'app.remoteResetPairing' }));
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(calls.some(({ api }) => api === 'resetRemotePairing')).toBe(true);
        expect(events).toEqual(['changed']);
        // The reveal is closed again after a reset.
        expect(screen.queryByRole('img')).toBeNull();
    });

    test('Copy link writes the clipboard and flips the label; a refused clipboard keeps the link readable', async () => {
        ANSWERS.current = { ...ANSWERS.current!, enabled: true };
        const writeText = jest.fn(async () => undefined);
        const clipboard = Object.getOwnPropertyDescriptor(globalThis.navigator, 'clipboard');
        Object.defineProperty(globalThis.navigator, 'clipboard', { value: { writeText }, configurable: true });
        let view: { unmount: () => void } | null = null;
        try {
            view = render(
                <NavHarness>
                    <RemoteAccessSection showAll />
                </NavHarness>,
            );
            await act(async () => Promise.resolve());
            fireEvent.click(screen.getByRole('button', { name: 'app.remoteShow' }));
            fireEvent.click(screen.getByRole('button', { name: 'app.remoteCopyLink' }));
            await act(async () => Promise.resolve());
            expect(writeText).toHaveBeenCalledWith(
                'https://isthisgitlab.github.io/gurushots-auto-vote/remote/#k=secret',
            );
            expect(screen.getByRole('button', { name: 'app.remoteLinkCopied' })).toBeDefined();
        } finally {
            view?.unmount();
            if (clipboard === undefined) delete (globalThis.navigator as { clipboard?: unknown }).clipboard;
            else Object.defineProperty(globalThis.navigator, 'clipboard', clipboard);
        }

        // A browser without the clipboard: the link stays on screen, nothing throws.
        const hadClipboard = Object.getOwnPropertyDescriptor(globalThis.navigator, 'clipboard');
        if (hadClipboard !== undefined) delete (globalThis.navigator as { clipboard?: unknown }).clipboard;
        try {
            render(
                <NavHarness>
                    <RemoteAccessSection showAll />
                </NavHarness>,
            );
            await act(async () => Promise.resolve());
            fireEvent.click(screen.getByRole('button', { name: 'app.remoteShow' }));
            fireEvent.click(screen.getByRole('button', { name: 'app.remoteCopyLink' }));
            await act(async () => Promise.resolve());
            expect(screen.getByText(/isthisgitlab\.github\.io/)).toBeDefined();
        } finally {
            if (hadClipboard !== undefined) Object.defineProperty(globalThis.navigator, 'clipboard', hadClipboard);
        }
    });

    test('the section hides on a filter miss like the hand-written cells do', async () => {
        const HiddenHarness = ({ children }: { children: React.ReactNode }) => {
            const nav = useSettingsNavState(
                ['application'],
                () => false,
                () => false,
            );
            act(() => nav.setQuery('zzz-no-match'));
            return <SettingsNavProvider value={nav}>{children}</SettingsNavProvider>;
        };
        render(
            <HiddenHarness>
                <RemoteAccessSection />
            </HiddenHarness>,
        );
        await act(async () => Promise.resolve());
        expect(document.querySelector('#remote-access-toggle')?.closest('div.hidden')).not.toBeNull();
    });

    test('Hide closes the reveal without touching the pairing', async () => {
        ANSWERS.current = { ...ANSWERS.current!, enabled: true };
        render(
            <NavHarness>
                <RemoteAccessSection showAll />
            </NavHarness>,
        );
        await act(async () => Promise.resolve());
        fireEvent.click(screen.getByRole('button', { name: 'app.remoteShow' }));
        fireEvent.click(screen.getByRole('button', { name: 'app.remoteHide' }));
        expect(screen.queryByRole('img')).toBeNull();
        expect(screen.getByRole('button', { name: 'app.remoteShow' })).toBeDefined();
    });

    test('a failed read leaves the section off and the toggle idle', async () => {
        ANSWERS.current = undefined;
        render(
            <NavHarness>
                <RemoteAccessSection showAll />
            </NavHarness>,
        );
        await act(async () => Promise.resolve());
        const toggle = screen.getByLabelText('app.remoteToggleLabel') as HTMLInputElement;
        expect(toggle.checked).toBe(false);
        expect(toggle.disabled).toBe(true);
    });
});
