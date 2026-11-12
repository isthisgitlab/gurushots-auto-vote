/**
 * The Android app's "Control my computer" entry: nothing renders where the Capacitor entry did
 * not install it; a pasted link goes to the installed `enter`, a refused one shows its message
 * (the bad-link text for a bad link, the generic one for any other refusal), and the settings
 * filter hides it like a section. The test mock's t() returns the key.
 */

import { act, screen } from '@testing-library/preact';
import { fireEvent, render } from './helpers/test-utils';
import { SettingsNavProvider } from '@/contexts/SettingsNavContext';
import { RemoteControlEntry, remoteControlTexts } from '@/components/app/RemoteControlEntry';
import { installPhoneRemoteMode } from '../../src/ts/core/remote/phoneMode';

import type { RemoteModeEntry } from '../../src/ts/core/remote/phoneMode';

const flush = () =>
    act(async () => {
        for (let i = 0; i < 10; i++) await Promise.resolve();
    });

const open = () => fireEvent.click(screen.getByText('app.remoteControlEntry'));
const paste = (value: string) =>
    fireEvent.input(screen.getByLabelText('app.remoteControlLinkLabel'), { target: { value } });

describe('RemoteControlEntry', () => {
    let enter: jest.Mock<Promise<RemoteModeEntry>, [string]>;

    beforeEach(() => {
        enter = jest.fn<Promise<RemoteModeEntry>, [string]>(async () => ({ success: true }));
        installPhoneRemoteMode({ enter });
    });

    afterAll(() => installPhoneRemoteMode({}));

    test('renders nothing where no shell installed the entry', () => {
        installPhoneRemoteMode({});
        const { container } = render(<RemoteControlEntry />);
        expect(container.textContent).toBe('');
    });

    test('a pasted link goes to enter, and a success closes the dialog', async () => {
        render(<RemoteControlEntry />);
        open();
        expect(screen.getByText('app.remoteControlTitle')).toBeDefined();
        paste('  https://example.test/remote/#k=abc ');
        fireEvent.click(screen.getByText('app.remoteControlConnect'));
        await flush();
        expect(enter).toHaveBeenCalledWith('  https://example.test/remote/#k=abc ');
        expect(screen.queryByText('app.remoteControlTitle')).toBeNull();
    });

    test('Connect stays off until something is pasted', () => {
        render(<RemoteControlEntry />);
        open();
        const connect = screen.getByText('app.remoteControlConnect') as HTMLButtonElement;
        expect(connect.disabled).toBe(true);
        paste('   ');
        expect(connect.disabled).toBe(true);
        paste('x');
        expect(connect.disabled).toBe(false);
    });

    test('a bad link says so; typing again clears the message', async () => {
        enter.mockResolvedValue({ success: false, error: 'bad-link' });
        render(<RemoteControlEntry />);
        open();
        paste('nonsense');
        fireEvent.submit(screen.getByLabelText('app.remoteControlLinkLabel').closest('form')!);
        await flush();
        expect(screen.getByRole('alert').textContent).toBe('errors.remoteBadLink');
        expect(screen.getByText('app.remoteControlTitle')).toBeDefined();
        paste('nonsense2');
        expect(screen.queryByRole('alert')).toBeNull();
        // Typing with no message showing changes nothing.
        paste('nonsense3');
        expect(screen.queryByRole('alert')).toBeNull();
    });

    test.each(['service-stop', 'settings', 'storage'] as const)(
        'a %s refusal shows the generic message',
        async (error) => {
            enter.mockResolvedValue({ success: false, error });
            render(<RemoteControlEntry />);
            open();
            paste('https://example.test/remote/#k=abc');
            fireEvent.click(screen.getByText('app.remoteControlConnect'));
            await flush();
            expect(screen.getByRole('alert').textContent).toBe('errors.remoteEnterFailed');
        },
    );

    test('Escape closes the dialog', () => {
        render(<RemoteControlEntry />);
        open();
        fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
        expect(screen.queryByText('app.remoteControlTitle')).toBeNull();
    });

    test('Cancel closes the dialog, and reopening starts with no old message', async () => {
        enter.mockResolvedValue({ success: false, error: 'bad-link' });
        render(<RemoteControlEntry />);
        open();
        paste('nonsense');
        fireEvent.click(screen.getByText('app.remoteControlConnect'));
        await flush();
        fireEvent.click(screen.getByText('app.cancel'));
        expect(screen.queryByText('app.remoteControlTitle')).toBeNull();
        open();
        expect(screen.queryByRole('alert')).toBeNull();
    });

    test('the settings filter hides the entry when the query matches none of its texts, and shows it when showAll', () => {
        const nav = (query: string) => ({
            query,
            namesOnly: false,
            isShown: () => true,
            active: 'application' as const,
            selectionSeq: 0,
            select: () => undefined,
            setQuery: () => undefined,
            reveal: () => undefined,
            reset: () => undefined,
        });
        const { container, rerender } = render(
            <SettingsNavProvider value={nav('zzz-no-match')}>
                <RemoteControlEntry />
            </SettingsNavProvider>,
        );
        expect(container.firstElementChild?.className).toContain('hidden');
        rerender(
            <SettingsNavProvider value={nav('zzz-no-match')}>
                <RemoteControlEntry showAll />
            </SettingsNavProvider>,
        );
        expect(container.firstElementChild?.className).not.toContain('hidden');
        rerender(
            <SettingsNavProvider value={nav('remoteControlEntry')}>
                <RemoteControlEntry />
            </SettingsNavProvider>,
        );
        expect(container.firstElementChild?.className).not.toContain('hidden');
    });

    test('its searchable texts are the entry, the dialog and the hint', () => {
        const texts = remoteControlTexts((key) => key);
        expect(texts.names).toEqual(['app.remoteControlEntry', 'app.remoteControlConnect']);
        expect(texts.descriptions).toEqual([
            'app.remoteControlEntryDesc',
            'app.remoteControlHint',
            'app.remoteControlLinkLabel',
        ]);
    });
});
