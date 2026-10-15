/**
 * The settings modal's About and data section: the third-party licenses dialog (text read on open into a focusable,
 * named, scrollable region) and "Delete all local data" (a confirm that lists what is lost, starts on Cancel and words
 * every outcome).
 */

import { act, fireEvent, render, screen, waitFor, within } from './helpers/test-utils';
import { AboutDataSection } from '@/components/app/AboutDataSection';
import { mockTranslator, defaultTranslate } from './helpers/setup';
import { invalid } from '../helpers/invalid';
import { about as englishAbout } from '../../src/ts/translations/english';
import { about as latvianAbout } from '../../src/ts/translations/latvian';
import type { RendererGlobals } from '../../src/ts/types/capacitor';

const open = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
const dialog = () => screen.getByRole('dialog');

afterEach(() => {
    delete (globalThis as RendererGlobals).Capacitor;
    delete (globalThis as { webShell?: true }).webShell;
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
        // While the busy check and the delete run, the dialog says what it is doing.
        expect(within(dialog()).getByText('about.deleteChecking')).toBeTruthy();
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(screen.getByRole('dialog')).toBeTruthy();

        await act(async () => finish({ success: true }));
        expect(within(dialog()).queryByText('about.deleteChecking')).toBeNull();
        expect(within(dialog()).getByRole('status').textContent).toBe('about.deleteDone');
        // Nothing left to confirm: only a way to close.
        expect(within(dialog()).queryByRole('button', { name: 'about.deleteConfirm' })).toBeNull();
        // The visible button says Close (not the aria-only "close modal" label).
        fireEvent.click(within(dialog()).getByRole('button', { name: 'app.close' }));
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    test('in the web shell the delete text says the server stops and must be started again', async () => {
        (globalThis as { webShell?: true }).webShell = true;
        jest.mocked(window.api.wipeLocalData).mockResolvedValue({ success: true });
        render(<AboutDataSection />);
        openDelete();
        expect(within(dialog()).getByText('about.deleteAfterWeb')).toBeTruthy();
        expect(within(dialog()).queryByText('about.deleteAfter')).toBeNull();
        confirm();
        await waitFor(() => expect(within(dialog()).getByRole('status').textContent).toBe('about.deleteDoneWeb'));
    });

    test.each([
        ['busy-pass', 'about.deleteBusyPass'],
        ['busy-cli', 'about.deleteBusyCli'],
        ['busy-app', 'about.deleteBusyApp'],
    ])('a refusal with %s says what is in the way and the step that clears it', async (code, key) => {
        jest.mocked(window.api.wipeLocalData).mockResolvedValue({ success: false, error: code });
        render(<AboutDataSection />);
        openDelete();
        confirm();
        const alert = await within(dialog()).findByRole('alert');
        expect(alert.textContent).toBe(key);
        // Still offered: clear what is in the way, then try again; the other button now closes.
        expect(within(dialog()).getByRole('button', { name: 'about.deleteConfirm' })).toBeTruthy();
        expect(within(dialog()).getByRole('button', { name: 'app.close' })).toBeTruthy();
        expect(within(dialog()).queryByRole('button', { name: 'app.cancel' })).toBeNull();
        expect(window.api.logError).not.toHaveBeenCalled();
    });

    test('a code that is not a refusal this build knows (even an object key) is the generic failure', async () => {
        jest.mocked(window.api.wipeLocalData).mockResolvedValue({ success: false, error: 'constructor' });
        render(<AboutDataSection />);
        openDelete();
        confirm();
        expect((await within(dialog()).findByRole('alert')).textContent).toBe('about.deleteFailed');
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

    test('a failure that emptied the caches shows why first and reloads the window only when the dialog is closed', async () => {
        jest.mocked(window.api.wipeLocalData).mockResolvedValue({
            success: false,
            error: 'the background service data',
            reload: true,
        });
        render(<AboutDataSection />);
        openDelete();
        confirm();

        const alert = await within(dialog()).findByRole('alert');
        expect(alert.textContent).toBe('about.deleteFailedAndroid about.deleteRestartsOnClose');
        expect(within(alert).getByText('about.deleteRestartsOnClose')).toBeTruthy();
        expect(window.api.reloadWindow).not.toHaveBeenCalled();

        fireEvent.click(within(dialog()).getByRole('button', { name: 'app.close' }));
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(window.api.reloadWindow).toHaveBeenCalledTimes(1);
    });

    test('a failure that asks for no reload, and a later success after one that did, never reload', async () => {
        jest.mocked(window.api.wipeLocalData).mockResolvedValueOnce({ success: false, error: 'EBUSY' });
        jest.mocked(window.api.wipeLocalData).mockResolvedValueOnce({ success: false, error: 'x', reload: true });
        jest.mocked(window.api.wipeLocalData).mockResolvedValueOnce({ success: true });
        render(<AboutDataSection />);
        openDelete();
        confirm();
        await within(dialog()).findByRole('alert');
        fireEvent.click(within(dialog()).getByRole('button', { name: 'app.close' }));
        expect(window.api.reloadWindow).not.toHaveBeenCalled();

        openDelete();
        confirm();
        await within(dialog()).findByRole('alert');
        confirm();
        await waitFor(() => expect(within(dialog()).getByRole('status').textContent).toBe('about.deleteDone'));
        expect(within(dialog()).queryByText('about.deleteRestartsOnClose')).toBeNull();
        fireEvent.click(within(dialog()).getByRole('button', { name: 'app.close' }));
        expect(window.api.reloadWindow).not.toHaveBeenCalled();
    });

    test('a failure that emptied the caches still reloads on Close after a retry that was refused as busy', async () => {
        jest.mocked(window.api.wipeLocalData).mockResolvedValueOnce({ success: false, error: 'x', reload: true });
        jest.mocked(window.api.wipeLocalData).mockResolvedValueOnce({ success: false, error: 'busy-pass' });
        render(<AboutDataSection />);
        openDelete();
        confirm();
        await within(dialog()).findByRole('alert');
        confirm();
        await waitFor(() => expect(within(dialog()).getByRole('alert').textContent).toContain('about.deleteBusyPass'));
        expect(within(within(dialog()).getByRole('alert')).getByText('about.deleteRestartsOnClose')).toBeTruthy();
        expect(window.api.reloadWindow).not.toHaveBeenCalled();

        fireEvent.click(within(dialog()).getByRole('button', { name: 'app.close' }));
        expect(window.api.reloadWindow).toHaveBeenCalledTimes(1);
    });

    test('a native failure on Android (the window will reload) says what Closing does', async () => {
        jest.mocked(window.api.wipeLocalData).mockResolvedValue({ success: false, error: 'x', reload: true });
        (globalThis as RendererGlobals).Capacitor = { isNativePlatform: () => true };
        render(<AboutDataSection />);
        openDelete();
        confirm();
        const alert = await within(dialog()).findByRole('alert');
        expect(alert.textContent).toBe('about.deleteFailedAndroid about.deleteRestartsOnClose');
        expect(within(alert).getByText('about.deleteRestartsOnClose')).toBeTruthy();
    });

    test('on Android a failure that asks for no reload, or a call that throws, uses the plain text', async () => {
        jest.mocked(window.api.wipeLocalData).mockResolvedValueOnce({ success: false, error: 'preferences failed' });
        jest.mocked(window.api.wipeLocalData).mockRejectedValueOnce(new Error('ipc closed'));
        (globalThis as RendererGlobals).Capacitor = { isNativePlatform: () => true };
        render(<AboutDataSection />);
        openDelete();
        confirm();
        expect((await within(dialog()).findByRole('alert')).textContent).toBe('about.deleteFailed');
        expect(within(dialog()).queryByText('about.deleteRestartsOnClose')).toBeNull();

        confirm();
        await waitFor(() => expect(within(dialog()).getByRole('alert').textContent).toBe('about.deleteFailed'));
        expect(window.api.reloadWindow).not.toHaveBeenCalled();
    });

    test('a call that throws after an attempt that emptied the caches still says the window restarts', async () => {
        jest.mocked(window.api.wipeLocalData).mockResolvedValueOnce({ success: false, error: 'x', reload: true });
        jest.mocked(window.api.wipeLocalData).mockRejectedValueOnce(new Error('ipc closed'));
        render(<AboutDataSection />);
        openDelete();
        confirm();
        await within(dialog()).findByRole('alert');

        confirm();
        await waitFor(() =>
            expect(within(dialog()).getByRole('alert').textContent).toBe(
                'about.deleteFailedAndroid about.deleteRestartsOnClose',
            ),
        );
        fireEvent.click(within(dialog()).getByRole('button', { name: 'app.close' }));
        expect(window.api.reloadWindow).toHaveBeenCalledTimes(1);
    });

    test('closing after an error clears it for the next time', async () => {
        jest.mocked(window.api.wipeLocalData).mockResolvedValue({ success: false, error: 'busy-pass' });
        render(<AboutDataSection />);
        openDelete();
        confirm();
        await within(dialog()).findByRole('alert');
        fireEvent.click(within(dialog()).getByRole('button', { name: 'app.close' }));

        openDelete();
        expect(within(dialog()).queryByRole('alert')).toBeNull();
        expect(within(dialog()).getByRole('button', { name: 'app.cancel' })).toBeTruthy();
    });
});

describe('the Android delete failure text', () => {
    // The restart is announced once, by about.deleteRestartsOnClose; the failure text itself says nothing about it.
    const ENGLISH_RESTART = /restart|relaunch|reopen|\b(?:start|launch|open)\b[^.;]*\bagain\b/i;
    const LATVIAN_RESTART =
        /palai|restart|pārstart|atsāk|startē|no jauna|(?:sā[kc]|atv[eē]r|ieslē)\S*\s+(?:\S+\s+){0,3}(?:vēlreiz|atkal|no jauna)|(?:vēlreiz|atkal)\s+(?:\S+\s+){0,3}(?:sā[kc]|atv[eē]r|ieslē)/i;

    test('does not mention a restart in either language', () => {
        expect(englishAbout.deleteFailedAndroid).not.toMatch(ENGLISH_RESTART);
        expect(latvianAbout.deleteFailedAndroid).not.toMatch(LATVIAN_RESTART);
    });

    test('the guard matches the texts that do announce the restart, so a broken pattern fails', () => {
        for (const key of ['deleteRestartsOnClose', 'deleteDone'] as const) {
            expect(englishAbout[key]).toMatch(ENGLISH_RESTART);
            expect(latvianAbout[key]).toMatch(LATVIAN_RESTART);
        }
        for (const example of [
            'Restart it.',
            'Relaunch the app.',
            'Reopen it.',
            'Start the app again.',
            'Launch it again.',
            'Open the app again.',
        ]) {
            expect(example).toMatch(ENGLISH_RESTART);
        }
        for (const example of [
            'Palaid lietotni.',
            'Restart lietotni.',
            'Pārstartē lietotni.',
            'Atsāknē lietotni.',
            'Startē lietotni.',
            'Lietotne sāksies no jauna.',
            'Atver lietotni atkal.',
            'Lūdzu atver lietotni vēlreiz.',
            'Atver lietotni pēc tam vēlreiz.',
            'Lietotne sāksies atkal.',
            'Lietotne atvērsies vēlreiz.',
            'Lietotne atkal sāksies.',
            'Pēc tam atkal atver lietotni.',
            'Lietotne vēlreiz atvērsies.',
            'Lietotne atsāksies.',
        ]) {
            expect(example).toMatch(LATVIAN_RESTART);
        }
    });

    test('the guard does not treat a bare retry as restart wording', () => {
        expect('Mēģini atkal tūlīt.').not.toMatch(LATVIAN_RESTART);
        expect('Mēģini vēlreiz tūlīt.').not.toMatch(LATVIAN_RESTART);
    });
});

describe('the import report in About and data', () => {
    const answer = (result: unknown) => jest.mocked(window.api.getImportReport).mockResolvedValue(invalid(result));

    test('lists the references that were kept and still do not apply, read-only, when they were acknowledged too', async () => {
        answer({
            success: true,
            report: {
                at: '2026-10-16T09:00:00.000Z',
                refsBlocked: ['rules[2].profile: "Night owl"', 'challenges.123.values.scenario: "Plan B"'],
                acknowledged: true,
            },
        });
        render(<AboutDataSection />);

        expect(await screen.findByRole('heading', { name: 'about.importTitle' })).toBeTruthy();
        expect(screen.getByText('about.importSome')).toBeTruthy();
        expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
            'rules[2].profile: "Night owl"',
            'challenges.123.values.scenario: "Plan B"',
        ]);
        expect(screen.getByText('about.importAt')).toBeTruthy();
        expect(screen.queryByText('about.importNone')).toBeNull();
    });

    test('says when it ran, in the date format of the page language', async () => {
        mockTranslator.t.mockImplementation((text) => (text === 'about.importAt' ? 'On {date}' : text));
        answer({ success: true, report: { at: '2026-10-16T12:00:00.000Z', refsBlocked: [], acknowledged: true } });
        render(<AboutDataSection />);

        expect(await screen.findByText('On 16/10/2026')).toBeTruthy();
        mockTranslator.t.mockImplementation(defaultTranslate);
    });

    test('a date that cannot be read is shown as stored', async () => {
        mockTranslator.t.mockImplementation((text) => (text === 'about.importAt' ? 'On {date}' : text));
        answer({ success: true, report: { at: 'sometime', refsBlocked: [], acknowledged: true } });
        render(<AboutDataSection />);

        expect(await screen.findByText('On sometime')).toBeTruthy();
        mockTranslator.t.mockImplementation(defaultTranslate);
    });

    test('says nothing needed attention when the list is empty', async () => {
        answer({ success: true, report: { at: '2026-10-16T09:00:00.000Z', refsBlocked: [], acknowledged: false } });
        render(<AboutDataSection />);

        expect(await screen.findByText('about.importNone')).toBeTruthy();
        expect(screen.queryByText('about.importSome')).toBeNull();
        expect(screen.queryAllByRole('listitem')).toHaveLength(0);
    });

    test.each([
        ['settings that were not imported', { success: true, report: null }],
        ['a refused read', { success: false, error: 'x' }],
        ['no answer', undefined],
    ])('%s shows no block', async (_name, result) => {
        answer(result);
        render(<AboutDataSection />);

        await waitFor(() => expect(window.api.getImportReport).toHaveBeenCalledTimes(1));
        expect(screen.queryByText('about.importTitle')).toBeNull();
    });
});

describe('the import report texts', () => {
    test('are in both languages, name no value and do not talk about what the keys used to be', () => {
        for (const text of [englishAbout, latvianAbout]) {
            for (const key of ['importTitle', 'importAt', 'importNone', 'importSome'] as const) {
                expect(text[key].trim()).not.toBe('');
                expect(text[key]).not.toMatch(/formerly|legacy|renamed|previously called|agrāk|bijušais/i);
            }
        }
        expect(englishAbout.importAt).toContain('{date}');
        expect(latvianAbout.importAt).toContain('{date}');
    });
});
