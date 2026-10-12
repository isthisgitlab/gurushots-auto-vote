/**
 * The settings modal's About and data section: the third-party licenses dialog (text read on open into a focusable,
 * named, scrollable region) and "Delete all local data" (a confirm that lists what is lost, starts on Cancel and words
 * every outcome).
 */

import { act, fireEvent, render, screen, waitFor, within } from './helpers/test-utils';
import { AboutDataSection } from '@/components/app/AboutDataSection';
import { invalid } from '../helpers/invalid';
import type { RendererGlobals } from '../../src/ts/types/capacitor';

const open = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
const dialog = () => screen.getByRole('dialog');

afterEach(() => {
    delete (globalThis as RendererGlobals).Capacitor;
});

describe('third-party licenses', () => {
    test('opens a dialog that reads the notices, shown in a named, focusable, scrollable region', async () => {
        jest.mocked(window.api.getThirdPartyNotices).mockResolvedValue({ success: true, text: 'MIT License\n…' });
        render(<AboutDataSection />);
        expect(window.api.getThirdPartyNotices).not.toHaveBeenCalled();

        open('about.licensesButton');
        expect(within(dialog()).getByRole('status').textContent).toBe('common.loading');
        const region = await screen.findByRole('region', { name: 'about.licensesTextLabel' });
        expect(region.tagName).toBe('PRE');
        expect(region.getAttribute('tabindex')).toBe('0');
        expect(region.textContent).toBe('MIT License\n…');
        expect(window.api.getThirdPartyNotices).toHaveBeenCalledTimes(1);
    });

    test('closing the dialog removes it', async () => {
        jest.mocked(window.api.getThirdPartyNotices).mockResolvedValue({ success: true, text: 'text' });
        render(<AboutDataSection />);
        open('about.licensesButton');
        await screen.findByRole('region', { name: 'about.licensesTextLabel' });
        fireEvent.click(screen.getByRole('button', { name: 'common.closeModal' }));
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    test.each([
        ['a refused read', { success: false, error: 'The third-party notices could not be read' }],
        ['no answer', undefined],
    ])('%s shows a translated, announced error and Try again reads once more', async (_name, answer) => {
        jest.mocked(window.api.getThirdPartyNotices).mockResolvedValueOnce(invalid(answer));
        jest.mocked(window.api.getThirdPartyNotices).mockResolvedValueOnce({ success: true, text: 'second try' });
        render(<AboutDataSection />);
        open('about.licensesButton');

        const alert = await screen.findByRole('alert');
        expect(alert.textContent).toContain('about.licensesLoadError');
        expect(alert.textContent).not.toContain('could not be read');
        expect(window.api.logWarning).toHaveBeenCalledWith(expect.stringContaining('Third-party notices unavailable'));

        fireEvent.click(within(alert).getByRole('button', { name: 'about.licensesRetry' }));
        expect((await screen.findByRole('region', { name: 'about.licensesTextLabel' })).textContent).toBe('second try');
    });

    test('a read that throws is an error too, with its message logged', async () => {
        jest.mocked(window.api.getThirdPartyNotices).mockRejectedValue(new Error('bridge down'));
        render(<AboutDataSection />);
        open('about.licensesButton');
        await screen.findByRole('alert');
        expect(window.api.logWarning).toHaveBeenCalledWith('Third-party notices unavailable: bridge down');
    });

    test('a read that throws something without a message is logged as it came', async () => {
        jest.mocked(window.api.getThirdPartyNotices).mockRejectedValue(invalid(null));
        render(<AboutDataSection />);
        open('about.licensesButton');
        await screen.findByRole('alert');
        expect(window.api.logWarning).toHaveBeenCalledWith('Third-party notices unavailable: null');
    });

    test('a read that fails after the dialog closed is ignored too', async () => {
        let reject: (reason: Error) => void = () => {};
        jest.mocked(window.api.getThirdPartyNotices).mockReturnValue(
            new Promise((_done, fail) => {
                reject = fail;
            }),
        );
        render(<AboutDataSection />);
        open('about.licensesButton');
        fireEvent.click(screen.getByRole('button', { name: 'common.closeModal' }));
        await act(async () => reject(new Error('late failure')));
        expect(window.api.logWarning).not.toHaveBeenCalled();
    });

    test('a read that finishes after the dialog closed is ignored', async () => {
        let resolve: (value: { success: true; text: string }) => void = () => {};
        jest.mocked(window.api.getThirdPartyNotices).mockReturnValue(
            new Promise((done) => {
                resolve = done;
            }),
        );
        render(<AboutDataSection />);
        open('about.licensesButton');
        fireEvent.click(screen.getByRole('button', { name: 'common.closeModal' }));
        await act(async () => resolve({ success: true, text: 'late' }));
        expect(screen.queryByText('late')).toBeNull();
    });
});

describe('Delete all local data', () => {
    const openDelete = () => open('about.deleteButton');
    const confirm = () => fireEvent.click(within(dialog()).getByRole('button', { name: 'about.deleteConfirm' }));

    test('lists what is lost, has no close button, and Cancel is the first control and takes focus', () => {
        render(<AboutDataSection />);
        openDelete();
        const modal = within(dialog());
        for (const key of ['Login', 'Settings', 'Profiles', 'Scenarios', 'Stats', 'Logs']) {
            expect(modal.getByText(`about.delete${key}`)).toBeTruthy();
        }
        expect(modal.queryByText('about.deleteBackground')).toBeNull();
        expect(modal.queryByRole('button', { name: 'common.closeModal' })).toBeNull();

        const buttons = modal.getAllByRole('button');
        expect(buttons.map((b) => b.textContent)).toEqual(['app.cancel', 'about.deleteConfirm']);
        expect(document.activeElement).toBe(buttons[0]);
        expect(window.api.wipeLocalData).not.toHaveBeenCalled();
    });

    test('on Android the background service state is listed too', () => {
        (globalThis as RendererGlobals).Capacitor = { isNativePlatform: () => true };
        render(<AboutDataSection />);
        openDelete();
        expect(within(dialog()).getByText('about.deleteBackground')).toBeTruthy();
    });

    test('Cancel closes without deleting', () => {
        render(<AboutDataSection />);
        openDelete();
        fireEvent.click(within(dialog()).getByRole('button', { name: 'app.cancel' }));
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(window.api.wipeLocalData).not.toHaveBeenCalled();
    });

    test('deleting is busy and not dismissable while it runs, then says it is done', async () => {
        let finish: (value: { success: true }) => void = () => {};
        jest.mocked(window.api.wipeLocalData).mockReturnValue(
            new Promise((done) => {
                finish = done;
            }),
        );
        render(<AboutDataSection />);
        openDelete();
        confirm();

        const busy = await within(dialog()).findByRole('button', { name: 'about.deleteConfirm' });
        expect(busy.getAttribute('aria-busy')).toBe('true');
        expect((busy as HTMLButtonElement).disabled).toBe(true);
        expect((within(dialog()).getByRole('button', { name: 'app.cancel' }) as HTMLButtonElement).disabled).toBe(true);
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(screen.getByRole('dialog')).toBeTruthy();

        await act(async () => finish({ success: true }));
        expect(within(dialog()).getByRole('status').textContent).toBe('about.deleteDone');
        // Nothing left to confirm: only a way to close.
        expect(within(dialog()).queryByRole('button', { name: 'about.deleteConfirm' })).toBeNull();
        fireEvent.click(within(dialog()).getByRole('button', { name: 'common.closeModal' }));
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    test('a refusal because a voting pass is running says to stop auto-vote and try again', async () => {
        jest.mocked(window.api.wipeLocalData).mockResolvedValue({ success: false, error: 'busy' });
        render(<AboutDataSection />);
        openDelete();
        confirm();
        const alert = await within(dialog()).findByRole('alert');
        expect(alert.textContent).toBe('about.deleteBusy');
        // Still offered: stop the vote, then try again.
        expect(within(dialog()).getByRole('button', { name: 'about.deleteConfirm' })).toBeTruthy();
        expect(window.api.logError).not.toHaveBeenCalled();
    });

    test.each([
        ['a partial failure', { success: false, error: 'Could not delete: /data/settings.json (EBUSY)' }],
        ['no answer', undefined],
    ])('%s is worded for the user and the detail is logged', async (_name, answer) => {
        jest.mocked(window.api.wipeLocalData).mockResolvedValue(invalid(answer));
        render(<AboutDataSection />);
        openDelete();
        confirm();
        const alert = await within(dialog()).findByRole('alert');
        expect(alert.textContent).toBe('about.deleteFailed');
        expect(window.api.logError).toHaveBeenCalledWith(expect.stringContaining('Deleting the local data failed'));
    });

    test('a call that throws reads the same, with its message logged, and a later attempt clears the error', async () => {
        jest.mocked(window.api.wipeLocalData).mockRejectedValueOnce(new Error('ipc closed'));
        jest.mocked(window.api.wipeLocalData).mockResolvedValueOnce({ success: true });
        render(<AboutDataSection />);
        openDelete();
        confirm();
        expect((await within(dialog()).findByRole('alert')).textContent).toBe('about.deleteFailed');
        expect(window.api.logError).toHaveBeenCalledWith('Deleting the local data threw: ipc closed');

        confirm();
        await waitFor(() => expect(within(dialog()).getByRole('status').textContent).toBe('about.deleteDone'));
        expect(within(dialog()).queryByRole('alert')).toBeNull();
    });

    test('a throw without a message is logged as it came', async () => {
        jest.mocked(window.api.wipeLocalData).mockRejectedValue(invalid(undefined));
        render(<AboutDataSection />);
        openDelete();
        confirm();
        await within(dialog()).findByRole('alert');
        expect(window.api.logError).toHaveBeenCalledWith('Deleting the local data threw: undefined');
    });

    test('closing after an error clears it for the next time', async () => {
        jest.mocked(window.api.wipeLocalData).mockResolvedValue({ success: false, error: 'busy' });
        render(<AboutDataSection />);
        openDelete();
        confirm();
        await within(dialog()).findByRole('alert');
        fireEvent.click(within(dialog()).getByRole('button', { name: 'app.cancel' }));

        openDelete();
        expect(within(dialog()).queryByRole('alert')).toBeNull();
    });
});
