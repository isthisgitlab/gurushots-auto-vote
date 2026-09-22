/**
 * UpdateProvider (IPC-driven update state machine) + UpdateDialog (its view).
 * Driven end-to-end through the window.api update events and actions.
 */

import { render, screen, fireEvent, act } from './helpers/test-utils';
import { render as bareRender } from '@testing-library/preact';
import { UpdateProvider, useUpdate } from '@/contexts/UpdateContext';
import { UpdateDialog } from '@/components/app/UpdateDialog';
import { mockApi } from './helpers/setup';

const INFO = { currentVersion: '1.0.0', latestVersion: '1.1.0', isPrerelease: false, releaseNotes: 'Fixes' };

describe('UpdateProvider + UpdateDialog', () => {
    let events;
    let ctx;

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

    const emit = async (name, payload) => {
        await act(async () => {
            events[name](payload);
        });
    };

    // Click, then drain the handler's IPC await chain.
    const clickAndSettle = async (el) => {
        await act(async () => {
            fireEvent.click(el);
            for (let i = 0; i < 10; i++) await Promise.resolve();
        });
    };

    beforeEach(() => {
        window.api = mockApi;
        events = {};
        for (const name of ['onUpdateAvailable', 'onDownloadProgress', 'onUpdateDownloaded', 'onUpdateError']) {
            mockApi[name].mockImplementation((cb) => {
                events[name] = cb;
                return jest.fn();
            });
        }
        mockApi.canAutoUpdate.mockResolvedValue({ canAutoUpdate: true });
        mockApi.getReleasesUrl.mockResolvedValue({ url: 'https://example.test/releases' });
        mockApi.downloadUpdate.mockResolvedValue({ success: true });
        mockApi.installUpdate.mockResolvedValue(undefined);
        mockApi.skipUpdateVersion.mockResolvedValue(undefined);
        mockApi.openExternalUrl.mockResolvedValue(undefined);
    });

    it('useUpdate throws outside an UpdateProvider', () => {
        const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
        expect(() => bareRender(<Capture />)).toThrow('useUpdate must be used within an UpdateProvider');
        spy.mockRestore();
    });

    it('renders nothing until an update is announced', () => {
        const { container } = renderDialog();
        expect(container.textContent).toBe('');
        expect(ctx.state).toBe('idle');
    });

    it('unsubscribes every listener on unmount', () => {
        const { unmount } = renderDialog();
        const unsubs = ['onUpdateAvailable', 'onDownloadProgress', 'onUpdateDownloaded', 'onUpdateError'].map(
            (n) => mockApi[n].mock.results[0].value,
        );
        unmount();
        unsubs.forEach((fn) => expect(fn).toHaveBeenCalledTimes(1));
    });

    it('tolerates listeners that return no unsubscribe function', () => {
        for (const name of ['onUpdateAvailable', 'onDownloadProgress', 'onUpdateDownloaded', 'onUpdateError']) {
            mockApi[name].mockReturnValue(undefined);
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
        expect(screen.getByText('Pre-release')).toBeTruthy();
        expect(screen.getByText('Fixes')).toBeTruthy();
    });

    it('omits the pre-release badge and notes when absent', async () => {
        renderDialog();
        await emit('onUpdateAvailable', { ...INFO, releaseNotes: '' });
        expect(screen.queryByText('Pre-release')).toBeNull();
        expect(screen.queryByText('app.releaseNotes:')).toBeNull();
    });

    it('renders the available frame without details when no info is attached', async () => {
        renderDialog();
        await emit('onUpdateAvailable', null);
        expect(screen.getByText('app.updateAvailable')).toBeTruthy();
        expect(screen.queryByText('app.currentVersion:')).toBeNull();
    });

    it('"Remind later" hides the dialog; backdrop click hides it too, inner clicks do not', async () => {
        const { container } = renderDialog();
        await emit('onUpdateAvailable', INFO);
        fireEvent.click(screen.getByText('app.remindLater'));
        expect(container.textContent).toBe('');

        await emit('onUpdateAvailable', INFO);
        fireEvent.click(container.querySelector('.modal-box'));
        expect(screen.getByText('app.updateAvailable')).toBeTruthy();
        fireEvent.click(container.firstChild);
        expect(container.textContent).toBe('');
    });

    it('"Skip version" skips and hides; a failing skip is logged and the dialog stays', async () => {
        const { container } = renderDialog();
        await emit('onUpdateAvailable', INFO);
        await clickAndSettle(screen.getByText('app.skipVersion'));
        expect(mockApi.skipUpdateVersion).toHaveBeenCalled();
        expect(container.textContent).toBe('');

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
            transferred: 1024 * 1024,
            total: 2 * 1024 * 1024,
            bytesPerSecond: 0,
        });
        expect(screen.getByText('50%')).toBeTruthy();
        expect(screen.queryByText(/MB/)).toBeNull();

        await emit('onDownloadProgress', {
            percent: 75,
            transferred: 1536 * 1024,
            total: 2 * 1024 * 1024,
            bytesPerSecond: 2048,
        });
        expect(screen.getByText(/1\.5 MB \/ 2 MB/)).toBeTruthy();
        expect(screen.getByText(/2 KB/)).toBeTruthy();

        // Backdrop click is ignored while downloading.
        fireEvent.click(document.querySelector('.fixed'));
        expect(screen.getByText('app.downloadingUpdate')).toBeTruthy();

        await emit('onUpdateDownloaded');
        expect(screen.getByText('app.updateReady')).toBeTruthy();
        expect(screen.getByText('app.updateReadyToInstall')).toBeTruthy();
        fireEvent.click(document.querySelector('.fixed'));
        expect(screen.getByText('app.updateReady')).toBeTruthy();

        await clickAndSettle(screen.getByText('app.restartNow'));
        expect(mockApi.installUpdate).toHaveBeenCalled();

        fireEvent.click(screen.getByText('app.restartLater'));
        expect(screen.queryByText('app.updateReady')).toBeNull();
    });

    it('formats a zero byte count', async () => {
        renderDialog();
        await emit('onUpdateAvailable', INFO);
        await clickAndSettle(screen.getByText('app.download'));
        await emit('onDownloadProgress', { percent: 1, transferred: 0, total: 0, bytesPerSecond: 10 });
        expect(screen.getByText(/0 Bytes \/ 0 Bytes/)).toBeTruthy();
    });

    it('"Cancel" while downloading hides the dialog', async () => {
        const { container } = renderDialog();
        await emit('onUpdateAvailable', INFO);
        await clickAndSettle(screen.getByText('app.download'));
        fireEvent.click(screen.getByText('app.cancel'));
        expect(container.textContent).toBe('');
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
        mockApi.canAutoUpdate.mockResolvedValue({ canAutoUpdate: false });
        const { container } = renderDialog();
        await emit('onUpdateAvailable', INFO);
        await clickAndSettle(screen.getByText('app.download'));
        expect(mockApi.openExternalUrl).toHaveBeenCalledWith('https://example.test/releases');
        expect(mockApi.downloadUpdate).not.toHaveBeenCalled();
        expect(container.textContent).toBe('');
    });

    it('shows a download failure with a browser fallback', async () => {
        mockApi.downloadUpdate.mockResolvedValue({ success: false, error: 'checksum mismatch' });
        const { container } = renderDialog();
        await emit('onUpdateAvailable', INFO);
        await clickAndSettle(screen.getByText('app.download'));
        expect(screen.getByText('app.updateError')).toBeTruthy();
        expect(screen.getByText('checksum mismatch')).toBeTruthy();

        await clickAndSettle(screen.getByText('app.downloadInBrowser'));
        expect(mockApi.openExternalUrl).toHaveBeenCalledWith('https://example.test/releases');
        expect(container.textContent).toBe('');
    });

    it.each([
        [new Error('offline'), 'offline'],
        [{}, 'Download failed'],
    ])('a thrown download error (%p) is shown as "%s"', async (thrown, message) => {
        mockApi.canAutoUpdate.mockRejectedValue(thrown);
        renderDialog();
        await emit('onUpdateAvailable', INFO);
        await clickAndSettle(screen.getByText('app.download'));
        expect(screen.getByText(message)).toBeTruthy();
        expect(ctx.error.canFallbackToBrowser).toBe(true);
    });

    it.each([
        [new Error('locked'), 'locked'],
        [{}, 'Installation failed'],
    ])('a failed install (%p) shows "%s" without the browser fallback', async (thrown, message) => {
        mockApi.installUpdate.mockRejectedValue(thrown);
        renderDialog();
        await emit('onUpdateAvailable', INFO);
        await emit('onUpdateDownloaded');
        await clickAndSettle(screen.getByText('app.restartNow'));
        expect(screen.getByText(message)).toBeTruthy();
        expect(screen.queryByText('app.downloadInBrowser')).toBeNull();
    });

    it('maps update-error events, defaulting the message and the fallback flag', async () => {
        renderDialog();
        await emit('onUpdateAvailable', INFO);
        await emit('onUpdateError', {});
        expect(screen.getByText('Download failed')).toBeTruthy();
        expect(screen.getByText('app.downloadInBrowser')).toBeTruthy();

        await emit('onUpdateError', { message: 'sig invalid', canFallbackToBrowser: false });
        expect(screen.getByText('sig invalid')).toBeTruthy();
        expect(screen.queryByText('app.downloadInBrowser')).toBeNull();

        // Error state closes via "Close" and via the backdrop.
        fireEvent.click(screen.getByText('app.close'));
        expect(screen.queryByText('app.updateError')).toBeNull();
    });

    it('closes the error dialog from the backdrop', async () => {
        const { container } = renderDialog();
        await emit('onUpdateAvailable', INFO);
        await emit('onUpdateError', { message: 'x' });
        fireEvent.click(container.firstChild);
        expect(container.textContent).toBe('');
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
