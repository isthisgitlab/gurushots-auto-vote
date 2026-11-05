/**
 * The Settings → Remote access section: the toggle writes through
 * set-remote-access and announces the change, the QR code and link stay
 * behind a Show button (the QR alt text names no link), and Reset pairing
 * rotates the key and re-announces.
 */

import { act, screen, within } from '@testing-library/preact';
import { fireEvent, render } from './helpers/test-utils';
import { SettingsNavProvider } from '@/contexts/SettingsNavContext';
import { RemoteAccessSection } from '@/components/app/RemoteAccessSection';
import { useSettingsNavState } from '@/contexts/SettingsNavContext';

const ANSWERS: { current: { success: boolean; enabled: boolean; link: string; qrDataUrl: string } | undefined } = {
    current: undefined,
};
const calls: Array<{ api: string; args: unknown[] }> = [];
/** What the write channels answer; a function throws or rejects, anything else is the answer. */
const WRITE_ANSWERS: { set: unknown; reset: unknown } = { set: { success: true }, reset: { success: true } };
const answerWrite = (answer: unknown): unknown => {
    if (answer instanceof Error) throw answer;
    return answer;
};

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
    // The real one: a throw or a rejection becomes null.
    callOrNull: async (call: () => unknown) => {
        try {
            return await call();
        } catch {
            return null;
        }
    },
    getRemoteAccess: (...args: unknown[]) => {
        calls.push({ api: 'getRemoteAccess', args });
        return ANSWERS.current;
    },
    setRemoteAccess: (...args: unknown[]) => {
        calls.push({ api: 'setRemoteAccess', args });
        return answerWrite(WRITE_ANSWERS.set);
    },
    resetRemotePairing: (...args: unknown[]) => {
        calls.push({ api: 'resetRemotePairing', args });
        return answerWrite(WRITE_ANSWERS.reset);
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
        WRITE_ANSWERS.set = { success: true };
        WRITE_ANSWERS.reset = { success: true };
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
            for (let i = 0; i < 6; i++) await Promise.resolve();
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
        expect(
            screen.queryByText(/^https:\/\/isthisgitlab\.github\.io\/gurushots-auto-vote\/remote\/#k=\S+$/),
        ).toBeNull();

        fireEvent.click(screen.getByRole('button', { name: 'app.remoteShow' }));
        const qr = screen.getByRole('img');
        expect(qr.getAttribute('src')).toContain('data:image/svg+xml');
        expect(qr.getAttribute('alt')).not.toContain('secret');
        expect(
            screen.getByText(/^https:\/\/isthisgitlab\.github\.io\/gurushots-auto-vote\/remote\/#k=\S+$/),
        ).toBeDefined();
    });

    const renderEnabled = async (): Promise<void> => {
        ANSWERS.current = { ...ANSWERS.current!, enabled: true };
        render(
            <NavHarness>
                <RemoteAccessSection showAll />
            </NavHarness>,
        );
        await act(async () => Promise.resolve());
    };
    const settle = async (): Promise<void> => {
        await act(async () => {
            for (let i = 0; i < 6; i++) await Promise.resolve();
        });
    };
    const resetCalls = () => calls.filter(({ api }) => api === 'resetRemotePairing');

    test('Reset pairing asks first; Cancel changes nothing', async () => {
        await renderEnabled();
        fireEvent.click(screen.getByRole('button', { name: 'app.remoteShow' }));
        fireEvent.click(screen.getByRole('button', { name: 'app.remoteResetPairing' }));
        await settle();
        const dialog = screen.getByRole('dialog');
        expect(within(dialog).getByText('app.remoteResetConfirm')).toBeDefined();
        expect(resetCalls()).toHaveLength(0);

        fireEvent.click(within(dialog).getByRole('button', { name: 'app.cancel' }));
        await settle();
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(resetCalls()).toHaveLength(0);
        expect(events).toEqual([]);
        // The code is still on screen: nothing was reset.
        expect(screen.getByRole('img')).toBeDefined();
    });

    test('confirming Reset pairing rotates the key, re-announces, hides the code and forgets the copy', async () => {
        const writeText = jest.fn(async () => undefined);
        const clipboard = Object.getOwnPropertyDescriptor(globalThis.navigator, 'clipboard');
        Object.defineProperty(globalThis.navigator, 'clipboard', { value: { writeText }, configurable: true });
        try {
            await renderEnabled();
            fireEvent.click(screen.getByRole('button', { name: 'app.remoteShow' }));
            fireEvent.click(screen.getByRole('button', { name: 'app.remoteCopyLink' }));
            await settle();
            expect(screen.getByRole('button', { name: 'app.remoteLinkCopied' })).toBeDefined();

            fireEvent.click(screen.getByRole('button', { name: 'app.remoteResetPairing' }));
            await settle();
            fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'app.remoteResetPairing' }));
            await settle();

            expect(resetCalls()).toHaveLength(1);
            expect(events).toEqual(['changed']);
            expect(screen.queryByRole('dialog')).toBeNull();
            // The reveal is closed again after a reset, and "Link copied" does not survive into the next reveal.
            expect(screen.queryByRole('img')).toBeNull();
            fireEvent.click(screen.getByRole('button', { name: 'app.remoteShow' }));
            expect(screen.getByRole('button', { name: 'app.remoteCopyLink' })).toBeDefined();
            expect(screen.queryByRole('button', { name: 'app.remoteLinkCopied' })).toBeNull();
        } finally {
            if (clipboard === undefined) delete (globalThis.navigator as { clipboard?: unknown }).clipboard;
            else Object.defineProperty(globalThis.navigator, 'clipboard', clipboard);
        }
    });

    test('Reset pairing is offered while remote access is off', async () => {
        render(
            <NavHarness>
                <RemoteAccessSection showAll />
            </NavHarness>,
        );
        await act(async () => Promise.resolve());
        expect(screen.queryByRole('button', { name: 'app.remoteShow' })).toBeNull();
        const reset = screen.getByRole('button', { name: 'app.remoteResetPairing' }) as HTMLButtonElement;
        expect(reset.disabled).toBe(false);
        fireEvent.click(reset);
        await settle();
        fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'app.remoteResetPairing' }));
        await settle();
        expect(resetCalls()).toHaveLength(1);
        expect(events).toEqual(['changed']);
    });

    test.each([
        ['answers success:false', { success: false }],
        ['answers nothing', undefined],
        ['rejects', new Error('ipc gone')],
    ])('a reset that %s says so in the dialog and announces nothing', async (_label, answer) => {
        WRITE_ANSWERS.reset = answer;
        await renderEnabled();
        fireEvent.click(screen.getByRole('button', { name: 'app.remoteShow' }));
        fireEvent.click(screen.getByRole('button', { name: 'app.remoteResetPairing' }));
        await settle();
        fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'app.remoteResetPairing' }));
        await settle();

        const dialog = screen.getByRole('dialog');
        expect(within(dialog).getByRole('alert').textContent).toBe('app.remoteResetFailed');
        expect(events).toEqual([]);
        // Nothing was reset: the code is still behind the dialog.
        expect(screen.getByRole('img')).toBeDefined();
    });

    test.each([
        ['answers success:false', { success: false }],
        ['answers nothing', undefined],
        ['rejects', new Error('ipc gone')],
    ])(
        'a switch that %s shows an alert, announces nothing and leaves the toggle on what is stored',
        async (_label, answer) => {
            WRITE_ANSWERS.set = answer;
            render(
                <NavHarness>
                    <RemoteAccessSection showAll />
                </NavHarness>,
            );
            await act(async () => Promise.resolve());
            const toggle = screen.getByLabelText('app.remoteToggleLabel') as HTMLInputElement;
            fireEvent.click(toggle);
            await settle();

            expect(screen.getByRole('alert').textContent).toBe('app.remoteChangeFailed');
            expect(events).toEqual([]);
            expect((screen.getByLabelText('app.remoteToggleLabel') as HTMLInputElement).checked).toBe(false);

            // The next successful switch clears the alert.
            WRITE_ANSWERS.set = { success: true };
            fireEvent.click(screen.getByLabelText('app.remoteToggleLabel'));
            await settle();
            expect(screen.queryByRole('alert')).toBeNull();
            expect(events).toEqual(['changed']);
        },
    );

    test('switching access off hides the code and forgets that the link was copied', async () => {
        const writeText = jest.fn(async () => undefined);
        const clipboard = Object.getOwnPropertyDescriptor(globalThis.navigator, 'clipboard');
        Object.defineProperty(globalThis.navigator, 'clipboard', { value: { writeText }, configurable: true });
        try {
            await renderEnabled();
            fireEvent.click(screen.getByRole('button', { name: 'app.remoteShow' }));
            fireEvent.click(screen.getByRole('button', { name: 'app.remoteCopyLink' }));
            await settle();

            // Off, then on again: the reveal starts closed and the copy label starts fresh.
            ANSWERS.current = { ...ANSWERS.current!, enabled: false };
            fireEvent.click(screen.getByLabelText('app.remoteToggleLabel'));
            await settle();
            expect(screen.queryByRole('img')).toBeNull();
            ANSWERS.current = { ...ANSWERS.current!, enabled: true };
            fireEvent.click(screen.getByLabelText('app.remoteToggleLabel'));
            await settle();
            expect(screen.queryByRole('img')).toBeNull();
            fireEvent.click(screen.getByRole('button', { name: 'app.remoteShow' }));
            expect(screen.queryByRole('button', { name: 'app.remoteLinkCopied' })).toBeNull();
        } finally {
            if (clipboard === undefined) delete (globalThis.navigator as { clipboard?: unknown }).clipboard;
            else Object.defineProperty(globalThis.navigator, 'clipboard', clipboard);
        }
    });

    test('Hide forgets that the link was copied', async () => {
        const writeText = jest.fn(async () => undefined);
        const clipboard = Object.getOwnPropertyDescriptor(globalThis.navigator, 'clipboard');
        Object.defineProperty(globalThis.navigator, 'clipboard', { value: { writeText }, configurable: true });
        try {
            await renderEnabled();
            fireEvent.click(screen.getByRole('button', { name: 'app.remoteShow' }));
            fireEvent.click(screen.getByRole('button', { name: 'app.remoteCopyLink' }));
            await settle();
            fireEvent.click(screen.getByRole('button', { name: 'app.remoteHide' }));
            fireEvent.click(screen.getByRole('button', { name: 'app.remoteShow' }));
            expect(screen.getByRole('button', { name: 'app.remoteCopyLink' })).toBeDefined();
        } finally {
            if (clipboard === undefined) delete (globalThis.navigator as { clipboard?: unknown }).clipboard;
            else Object.defineProperty(globalThis.navigator, 'clipboard', clipboard);
        }
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
            expect(
                screen.getByText(/^https:\/\/isthisgitlab\.github\.io\/gurushots-auto-vote\/remote\/#k=\S+$/),
            ).toBeDefined();
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
