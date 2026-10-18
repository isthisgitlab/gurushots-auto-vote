/**
 * UpdateProvider (IPC-driven update state machine) + UpdateDialog (its view).
 * Driven end-to-end through the window.api update events and actions.
 */

import { render, screen, fireEvent, act } from './helpers/test-utils';
import { render as bareRender } from '@testing-library/preact';
import { UpdateProvider, useUpdate } from '@/contexts/UpdateContext';
import { UpdateDialog } from '@/components/app/UpdateDialog';
import { mockApi } from './helpers/setup';
import { invalid } from '../helpers/invalid';

const INFO = { currentVersion: '1.0.0', latestVersion: '1.1.0', isPrerelease: false, releaseNotes: 'Fixes' };

describe('UpdateProvider + UpdateDialog', () => {
    let events: Record<string, (payload?: unknown) => void>;
    let ctx: ReturnType<typeof useUpdate>;

    function Capture() {
        ctx = useUpdate();
        return null;
    }

    const renderDialog = () =>
        render(
            <UpdateProvider>
                <Capture />
                <UpdateDialog />
            </UpdateProvider>,
        );

    const emit = async (name: string, payload?: unknown) => {
        await act(async () => {
            events[name](payload);
        });
    };

    // Click, then drain the handler's IPC await chain.
    const clickAndSettle = async (el: Element) => {
        await act(async () => {
            fireEvent.click(el);
            for (let i = 0; i < 10; i++) await Promise.resolve();
        });
    };

    beforeEach(() => {
        window.api = invalid(mockApi);
        events = {};
        for (const name of [
            'onUpdateAvailable',
            'onDownloadProgress',
            'onUpdateDownloaded',
            'onUpdateError',
        ] as const) {
            mockApi[name].mockImplementation((cb) => {
                events[name] = cb as (payload?: unknown) => void;
                return jest.fn();
            });
        }
        mockApi.canAutoUpdate.mockResolvedValue(invalid({ canAutoUpdate: true }));
        mockApi.getReleasesUrl.mockResolvedValue(invalid({ url: 'https://example.test/releases' }));
        mockApi.downloadUpdate.mockResolvedValue({ success: true });
        mockApi.installUpdate.mockResolvedValue({ success: true });
        mockApi.skipUpdateVersion.mockResolvedValue(invalid(undefined));
        mockApi.openExternalUrl.mockResolvedValue(invalid(undefined));
    });

    it('useUpdate throws outside an UpdateProvider', () => {
        const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
        expect(() => bareRender(<Capture />)).toThrow('useUpdate must be used within an UpdateProvider');
        spy.mockRestore();
    });

    it('renders nothing until an update is announced', () => {
        renderDialog();
        expect(document.body.textContent).toBe('');
        expect(ctx.state).toBe('idle');
    });

    it('unsubscribes every listener on unmount', () => {
        const { unmount } = renderDialog();
        const unsubs = (
            ['onUpdateAvailable', 'onDownloadProgress', 'onUpdateDownloaded', 'onUpdateError'] as const
        ).map((n) => mockApi[n].mock.results[0].value as jest.Mock<void, []>);
        unmount();
        unsubs.forEach((fn) => expect(fn).toHaveBeenCalledTimes(1));
    });

    it('tolerates listeners that return no unsubscribe function', () => {
        for (const name of [
            'onUpdateAvailable',
            'onDownloadProgress',
            'onUpdateDownloaded',
            'onUpdateError',
        ] as const) {
            mockApi[name].mockReturnValue(invalid(undefined));
        }
        const { unmount } = renderDialog();
        expect(() => unmount()).not.toThrow();
    });

    it('shows the available update with versions, pre-release badge and notes', async () => {
        renderDialog();
        await emit('onUpdateAvailable', { ...INFO, isPrerelease: true });

        expect(screen.getByText('app.updateAvailable')).toBeTruthy();
        expect(screen.getByText('1.0.0')).toBeTruthy();
        expect(screen.getByText('1.1.0')).toBeTruthy();
        expect(screen.getByText('app.prerelease')).toBeTruthy();
        expect(screen.getByText('Fixes')).toBeTruthy();
    });

    it('omits the pre-release badge, and says so when there are no notes', async () => {
        renderDialog();
        await emit('onUpdateAvailable', { ...INFO, releaseNotes: '' });
        expect(screen.queryByText('app.prerelease')).toBeNull();
        expect(screen.getByText('app.releaseNotes:')).toBeTruthy();
        expect(screen.getByText('app.noReleaseNotes')).toBeTruthy();
    });

    it('shows HTML release notes as plain text, lines kept', async () => {
        renderDialog();
        await emit('onUpdateAvailable', {
            ...INFO,
            releaseNotes: '<p>Fixes</p>\n<ul>\n<li class="x">One</li>\n<li>Two<br/>more</li>\n</ul>',
        });
        const notes = screen.getByText(/Fixes/);
        expect(notes.textContent).toBe('Fixes\n\n• One\n\n• Two\nmore');
        expect(notes.className).toContain('whitespace-pre-line');
        expect(notes.querySelector('p, ul, li')).toBeNull();
    });

    it('renders the available frame without details when no info is attached', async () => {
        renderDialog();
        await emit('onUpdateAvailable', null);
        expect(screen.getByText('app.updateAvailable')).toBeTruthy();
        expect(screen.queryByText('app.currentVersion:')).toBeNull();
    });

    it('"Remind later" hides the dialog; backdrop click and Escape hide it too, inner clicks do not', async () => {
        renderDialog();
        await emit('onUpdateAvailable', INFO);
        fireEvent.click(screen.getByText('app.remindLater'));
        expect(document.body.textContent).toBe('');

        await emit('onUpdateAvailable', INFO);
        expect(screen.getByRole('dialog', { name: 'app.updateAvailable' })).toBeTruthy();
        fireEvent.click(document.querySelector('.modal-box')!);
        expect(screen.getByText('app.updateAvailable')).toBeTruthy();
        fireEvent.click(document.querySelector('.modal-backdrop')!);
        expect(document.body.textContent).toBe('');

        await emit('onUpdateAvailable', INFO);
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(document.body.textContent).toBe('');
    });

    it('"Skip version" skips and hides; a failing skip is logged and the dialog stays', async () => {
        renderDialog();
        await emit('onUpdateAvailable', INFO);
        await clickAndSettle(screen.getByText('app.skipVersion'));
        expect(mockApi.skipUpdateVersion).toHaveBeenCalled();
        expect(document.body.textContent).toBe('');

        await emit('onUpdateAvailable', INFO);
        mockApi.skipUpdateVersion.mockRejectedValueOnce(new Error('io'));
        await clickAndSettle(screen.getByText('app.skipVersion'));
        expect(mockApi.logError).toHaveBeenCalledWith('Error skipping update version: io');
        expect(screen.getByText('app.updateAvailable')).toBeTruthy();

        mockApi.skipUpdateVersion.mockRejectedValueOnce('bare');
        await clickAndSettle(screen.getByText('app.skipVersion'));
        expect(mockApi.logError).toHaveBeenLastCalledWith('Error skipping update version: bare');
    });

    it('downloads, shows progress, then offers restart', async () => {
        renderDialog();
        await emit('onUpdateAvailable', INFO);
        await clickAndSettle(screen.getByText('app.download'));
        expect(mockApi.downloadUpdate).toHaveBeenCalled();
        expect(screen.getByText('app.downloadingUpdate')).toBeTruthy();
        expect(screen.getByText('0%')).toBeTruthy();

        await emit('onDownloadProgress', {
            percent: 50,
            transferred: 1_000_000,
            total: 2_000_000,
            bytesPerSecond: 0,
        });
        expect(screen.getByText('50%')).toBeTruthy();
        expect(screen.queryByText(/MB/)).toBeNull();

        await emit('onDownloadProgress', {
            percent: 75,
            transferred: 1_500_000,
            total: 2_000_000,
            bytesPerSecond: 2000,
        });
        expect(screen.getByText(/1\.5MB \/ 2MB/)).toBeTruthy();
        expect(screen.getByText(/2kB\/s/)).toBeTruthy();

        // Backdrop click and Escape are ignored while downloading.
        fireEvent.click(document.querySelector('.modal-backdrop')!);
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(screen.getByText('app.downloadingUpdate')).toBeTruthy();

        await emit('onUpdateDownloaded');
        expect(screen.getByText('app.updateReady')).toBeTruthy();
        expect(screen.getByText('app.updateReadyToInstall')).toBeTruthy();
        fireEvent.click(document.querySelector('.modal-backdrop')!);
        expect(screen.getByText('app.updateReady')).toBeTruthy();

        await clickAndSettle(screen.getByText('app.restartNow'));
        expect(mockApi.installUpdate).toHaveBeenCalled();

        fireEvent.click(screen.getByText('app.restartLater'));
        expect(screen.queryByText('app.updateReady')).toBeNull();
    });

    it('writes sizes in the UI language, from bytes up to gigabytes and no further', async () => {
        mockApi.getSetting.mockResolvedValueOnce('lv');
        renderDialog();
        await emit('onUpdateAvailable', INFO);
        await clickAndSettle(screen.getByText('app.download'));
        await emit('onDownloadProgress', {
            percent: 10,
            transferred: 512,
            total: 3.5e9,
            bytesPerSecond: 1.5e6,
        });
        expect(screen.getByText(/512 B \/ 3,5 GB \(1,5 MB\/s\)/)).toBeTruthy();

        await emit('onDownloadProgress', { percent: 10, transferred: 1, total: 2000e9, bytesPerSecond: 1 });
        expect(screen.getByText(/2000 GB/)).toBeTruthy();
    });

    it('formats a zero byte count', async () => {
        renderDialog();
        await emit('onUpdateAvailable', INFO);
        await clickAndSettle(screen.getByText('app.download'));
        await emit('onDownloadProgress', { percent: 1, transferred: 0, total: 0, bytesPerSecond: 10 });
        expect(screen.getByText(/0B \/ 0B/)).toBeTruthy();
    });

    it('shows an indeterminate, named progress bar until the download size is known', async () => {
        renderDialog();
        await emit('onUpdateAvailable', INFO);
        await clickAndSettle(screen.getByText('app.download'));
        const bar = document.querySelector('progress')!;
        expect(bar.hasAttribute('value')).toBe(false);
        expect(bar.getAttribute('aria-label')).toBe('app.downloadingUpdate');

        await emit('onDownloadProgress', { percent: 40, transferred: 40, total: 100, bytesPerSecond: 0 });
        expect(document.querySelector('progress')!.getAttribute('value')).toBe('40');
    });

    describe('a hidden dialog comes back for the events the user is waiting on', () => {
        const hideDuringDownload = async () => {
            renderDialog();
            await emit('onUpdateAvailable', INFO);
            await clickAndSettle(screen.getByText('app.download'));
            fireEvent.click(screen.getByText('app.hide'));
            expect(document.body.textContent).toBe('');
        };

        it('a finished download brings back "Restart now"', async () => {
            await hideDuringDownload();
            await emit('onUpdateDownloaded');
            expect(screen.getByText('app.updateReady')).toBeTruthy();
            expect(screen.getByText('app.restartNow')).toBeTruthy();
        });

        it('a failed download shows the failure', async () => {
            await hideDuringDownload();
            await emit('onUpdateError', { message: 'offline' });
            expect(screen.getByText('app.updateError')).toBeTruthy();
        });

        it.each([
            ['idle', async () => {}],
            [
                'available, with the dialog hidden',
                async () => {
                    await emit('onUpdateAvailable', INFO);
                    fireEvent.click(screen.getByText('app.remindLater'));
                },
            ],
            [
                'ready, with the dialog hidden',
                async () => {
                    await emit('onUpdateAvailable', INFO);
                    await clickAndSettle(screen.getByText('app.download'));
                    await emit('onUpdateDownloaded');
                    fireEvent.click(screen.getByText('app.restartLater'));
                },
            ],
        ])('a background check that fails while %s stays hidden', async (_state, arrange) => {
            renderDialog();
            await arrange();
            expect(document.body.textContent).toBe('');
            await emit('onUpdateError', { message: 'offline' });
            expect(document.body.textContent).toBe('');
            expect(ctx.state).toBe('error');
        });
    });

    it('"Hide" while downloading hides the dialog', async () => {
        renderDialog();
        await emit('onUpdateAvailable', INFO);
        await clickAndSettle(screen.getByText('app.download'));
        fireEvent.click(screen.getByText('app.hide'));
        expect(document.body.textContent).toBe('');
    });

    it('hides the progress block when the dialog is downloading without a progress payload', async () => {
        renderDialog();
        await emit('onUpdateAvailable', INFO);
        await clickAndSettle(screen.getByText('app.download'));
        await emit('onDownloadProgress', null);
        expect(screen.getByText('app.downloadingUpdate')).toBeTruthy();
        expect(document.querySelector('progress')).toBeNull();
    });

    it('falls back to the browser when auto-update is unavailable', async () => {
        mockApi.canAutoUpdate.mockResolvedValue(invalid({ canAutoUpdate: false }));
        renderDialog();
        await emit('onUpdateAvailable', INFO);
        await clickAndSettle(screen.getByText('app.download'));
        expect(mockApi.openExternalUrl).toHaveBeenCalledWith('https://example.test/releases');
        expect(mockApi.downloadUpdate).not.toHaveBeenCalled();
        expect(document.body.textContent).toBe('');
    });

    it('shows a download failure with a browser fallback', async () => {
        mockApi.downloadUpdate.mockResolvedValue({ success: false, error: 'checksum mismatch' });
        renderDialog();
        await emit('onUpdateAvailable', INFO);
        await clickAndSettle(screen.getByText('app.download'));
        expect(screen.getByText('app.updateError')).toBeTruthy();
        // The translated message is shown; the technical reason goes to the log.
        expect(screen.getByText('app.updateFailed')).toBeTruthy();
        expect(screen.queryByText('checksum mismatch')).toBeNull();
        expect(mockApi.logError).toHaveBeenCalledWith('Update failed: checksum mismatch');

        await clickAndSettle(screen.getByText('app.downloadInBrowser'));
        expect(mockApi.openExternalUrl).toHaveBeenCalledWith('https://example.test/releases');
        expect(document.body.textContent).toBe('');
    });

    it.each([
        [new Error('offline'), 'Update failed: offline'],
        ['bare', 'Update failed: bare'],
    ])('a thrown download error (%p) shows the update failure and logs "%s"', async (thrown, logged) => {
        mockApi.canAutoUpdate.mockRejectedValue(thrown);
        renderDialog();
        await emit('onUpdateAvailable', INFO);
        await clickAndSettle(screen.getByText('app.download'));
        expect(screen.getByText('app.updateFailed')).toBeTruthy();
        expect(screen.getByText('app.downloadInBrowser')).toBeTruthy();
        expect(mockApi.logError).toHaveBeenCalledWith(logged);
    });

    it.each([
        ['a rejected install', () => mockApi.installUpdate.mockRejectedValue(new Error('locked')), 'locked'],
        [
            'an install the handler refused',
            () => mockApi.installUpdate.mockResolvedValue({ success: false, error: 'AutoUpdater not initialized' }),
            'AutoUpdater not initialized',
        ],
    ])('%s shows the install failure without the browser fallback', async (_label, arrange, reason) => {
        arrange();
        renderDialog();
        await emit('onUpdateAvailable', INFO);
        await emit('onUpdateDownloaded');
        await clickAndSettle(screen.getByText('app.restartNow'));
        expect(screen.getByText('app.updateInstallFailed')).toBeTruthy();
        expect(screen.queryByText('app.downloadInBrowser')).toBeNull();
        expect(mockApi.logError).toHaveBeenCalledWith(`Update install failed: ${reason}`);
    });

    it('shows update-error events as the update failure and logs their reason', async () => {
        renderDialog();
        await emit('onUpdateAvailable', INFO);
        await emit('onUpdateError', { message: 'sig invalid' });
        expect(screen.getByText('app.updateFailed')).toBeTruthy();
        expect(screen.getByText('app.downloadInBrowser')).toBeTruthy();
        expect(mockApi.logError).toHaveBeenCalledWith('Update failed: sig invalid');

        // Error state closes via "Close" and via the backdrop.
        fireEvent.click(screen.getByText('app.close'));
        expect(screen.queryByText('app.updateError')).toBeNull();
    });

    it.each(['host', 'content-type', 'size', 'digest', 'digest-missing'])(
        'a download the Android updater refused (%s) says it was not verified and offers no browser download',
        async (code) => {
            mockApi.downloadUpdate.mockResolvedValue(
                invalid({ success: false, error: 'The download does not match; the release page was opened', code }),
            );
            renderDialog();
            await emit('onUpdateAvailable', INFO);
            await clickAndSettle(screen.getByText('app.download'));
            expect(screen.getByText('app.updateUnverified')).toBeTruthy();
            expect(screen.queryByText('app.downloadInBrowser')).toBeNull();
            expect(screen.getByText('app.close')).toBeTruthy();
            expect(mockApi.logError).toHaveBeenCalledWith(expect.stringContaining(`(${code})`));
        },
    );

    it('an Android install that failed after opening the release page says so, and does not offer the browser download again', async () => {
        mockApi.downloadUpdate.mockResolvedValue({
            success: false,
            error: 'network down; the release page was opened instead',
            code: 'release-page-opened',
        });
        renderDialog();
        await emit('onUpdateAvailable', INFO);
        await clickAndSettle(screen.getByText('app.download'));
        expect(screen.getByText('app.updateReleasePageOpened')).toBeTruthy();
        expect(screen.queryByText('app.updateFailed')).toBeNull();
        expect(screen.queryByText('app.downloadInBrowser')).toBeNull();
        expect(screen.getByText('app.close')).toBeTruthy();
        expect(mockApi.logError).toHaveBeenCalledWith(
            'Update failed: network down; the release page was opened instead (release-page-opened)',
        );
    });

    it('takes the release-page-opened code from an update-error event as well', async () => {
        renderDialog();
        await emit('onUpdateAvailable', INFO);
        await emit('onUpdateError', { message: 'x', code: 'release-page-opened' });
        expect(screen.getByText('app.updateReleasePageOpened')).toBeTruthy();
        expect(screen.queryByText('app.downloadInBrowser')).toBeNull();
    });

    it('takes the refusal code from an update-error event as well', async () => {
        renderDialog();
        await emit('onUpdateAvailable', INFO);
        await emit('onUpdateError', { message: 'x', code: 'digest' });
        expect(screen.getByText('app.updateUnverified')).toBeTruthy();
        expect(screen.queryByText('app.downloadInBrowser')).toBeNull();
    });

    it.each([
        ['an unknown code', { message: 'x', code: 'timeout' }],
        ['a code that is not text', { message: 'x', code: 7 }],
    ])('%s is an ordinary update failure with the browser download', async (_name, payload) => {
        renderDialog();
        await emit('onUpdateAvailable', INFO);
        await emit('onUpdateError', payload);
        expect(screen.getByText('app.updateFailed')).toBeTruthy();
        expect(screen.getByText('app.downloadInBrowser')).toBeTruthy();
    });

    it('closes the error dialog from the backdrop', async () => {
        renderDialog();
        await emit('onUpdateAvailable', INFO);
        await emit('onUpdateError', { message: 'x' });
        fireEvent.click(document.querySelector('.modal-backdrop')!);
        expect(document.body.textContent).toBe('');
    });

    it('opening the browser download logs a failure and keeps the dialog', async () => {
        renderDialog();
        await emit('onUpdateAvailable', INFO);
        await emit('onUpdateError', { message: 'x' });
        mockApi.getReleasesUrl.mockRejectedValueOnce(new Error('no url'));
        await clickAndSettle(screen.getByText('app.downloadInBrowser'));
        expect(mockApi.logError).toHaveBeenCalledWith('Error opening download URL: no url');
        expect(screen.getByText('app.updateError')).toBeTruthy();

        mockApi.getReleasesUrl.mockRejectedValueOnce('bare');
        await clickAndSettle(screen.getByText('app.downloadInBrowser'));
        expect(mockApi.logError).toHaveBeenLastCalledWith('Error opening download URL: bare');
    });
});
