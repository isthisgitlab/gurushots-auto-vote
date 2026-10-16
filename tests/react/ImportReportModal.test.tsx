/**
 * The import report dialog: shown once when the import left references that still do not apply (their names, what that
 * means, what to do), acknowledged with OK; an import with nothing to report is acknowledged without a dialog; an
 * acknowledgement that cannot be saved says so and leaves the dialog open.
 */

import { act, fireEvent, render, screen, waitFor, within } from './helpers/test-utils';
import { ImportReportModal } from '@/components/app/ImportReportModal';
import { fireSettingsChanged, mockTranslator, defaultTranslate } from './helpers/setup';
import { IMPORT_REF_ENGLISH } from '../../src/ts/settings/importRefs';
import type { ImportRefText } from '../../src/ts/settings/importRefs';
import { invalid } from '../helpers/invalid';
import type { RendererGlobals } from '../../src/ts/types/capacitor';

const report = (refsBlocked: unknown[], acknowledged = false) => ({
    success: true as const,
    report: { at: '2026-10-16T09:00:00.000Z', refsBlocked, acknowledged },
});
const answer = (result: unknown) => jest.mocked(window.api.getImportReport).mockResolvedValue(invalid(result));

describe('ImportReportModal', () => {
    afterEach(() => {
        mockTranslator.t.mockImplementation(defaultTranslate);
    });

    test('words each reference as where it is stored in the app and what is wrong with it, and shows an old entry as it is', async () => {
        mockTranslator.t.mockImplementation((key) =>
            key.startsWith('notice.importRef') ? IMPORT_REF_ENGLISH[key.slice(7) as keyof ImportRefText] : key,
        );
        answer(
            report([
                { holder: { kind: 'rule', number: 3, title: 'Macro' }, refers: 'profile', name: 'Night' },
                { holder: { kind: 'challenge', id: '12', title: 'Sunset' }, refers: 'scenario', name: 'Plan B' },
                { holder: { kind: 'profile', name: 'Day' }, refers: 'scenario', name: 'Plan C', invalid: true },
                'rules[0].profile: "Gone"',
            ]),
        );
        render(<ImportReportModal />);

        const dialog = await screen.findByRole('dialog');
        expect(
            within(dialog)
                .getAllByRole('listitem')
                .map((item) => item.textContent),
        ).toEqual([
            'Rule 3 (Macro): the profile "Night" doesn\'t exist',
            'Challenge "Sunset" (12): the scenario "Plan B" doesn\'t exist',
            'Profile "Day": the scenario "Plan C" can\'t be used',
            'rules[0].profile: "Gone"',
        ]);
    });

    test('lists the references that were kept, in a named dialog with OK', async () => {
        answer(report(['rules[2].profile: "Night owl"', 'challenges.123.values.scenario: "Plan B"']));
        render(<ImportReportModal />);

        const dialog = await screen.findByRole('dialog', { name: 'notice.importReportTitle' });
        expect(within(dialog).getByText('notice.importReportIntro')).toBeTruthy();
        const items = within(dialog).getAllByRole('listitem');
        expect(items.map((item) => item.textContent)).toEqual([
            'rules[2].profile: "Night owl"',
            'challenges.123.values.scenario: "Plan B"',
        ]);
        expect(within(dialog).getByRole('button', { name: 'common.ok' })).toBeTruthy();
        expect(within(dialog).queryByRole('button', { name: 'common.closeModal' })).toBeNull();
        expect(window.api.acknowledgeImportReport).not.toHaveBeenCalled();
    });

    test('two entries that read alike are both listed, with no clash of keys', async () => {
        const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        const same = { holder: { kind: 'rule', number: 1 }, refers: 'profile', name: 'Gone' };
        answer(report([same, { ...same }, 'rules[0].profile: "Gone"', 'rules[0].profile: "Gone"']));
        render(<ImportReportModal />);

        const dialog = await screen.findByRole('dialog');

        expect(within(dialog).getAllByRole('listitem')).toHaveLength(4);
        expect(consoleError).not.toHaveBeenCalledWith(expect.stringContaining('same key'), expect.anything());
        expect(consoleError.mock.calls.flat().join(' ')).not.toContain('same key');
        consoleError.mockRestore();
    });

    test('on Android the dialog does not name a settings.json the user never sees', async () => {
        (globalThis as RendererGlobals).Capacitor = { isNativePlatform: () => true };
        answer(report(['rules[0].profile: "Gone"']));
        render(<ImportReportModal />);

        const dialog = await screen.findByRole('dialog');

        expect(within(dialog).getByText('notice.importReportIntroAndroid')).toBeTruthy();
        expect(within(dialog).queryByText('notice.importReportIntro')).toBeNull();
        delete (globalThis as RendererGlobals).Capacitor;
    });

    test('OK acknowledges it and the dialog goes', async () => {
        answer(report(['rules[0].profile: "Gone"']));
        jest.mocked(window.api.acknowledgeImportReport).mockResolvedValue({ success: true });
        render(<ImportReportModal />);
        await screen.findByRole('dialog');

        answer(report(['rules[0].profile: "Gone"'], true));
        fireEvent.click(screen.getByRole('button', { name: 'common.ok' }));

        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(window.api.acknowledgeImportReport).toHaveBeenCalledTimes(1);
    });

    test('OK is busy while it saves, and nothing can dismiss the dialog then', async () => {
        answer(report(['rules[0].profile: "Gone"']));
        let finish: (result: { success: true }) => void = () => {};
        jest.mocked(window.api.acknowledgeImportReport).mockReturnValue(
            new Promise((done) => {
                finish = done;
            }),
        );
        render(<ImportReportModal />);
        await screen.findByRole('dialog');

        fireEvent.click(screen.getByRole('button', { name: 'common.ok' }));

        const ok = await screen.findByRole('button', { name: 'common.ok' });
        expect(ok.getAttribute('aria-busy')).toBe('true');
        expect(ok).toHaveProperty('disabled', true);
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(window.api.acknowledgeImportReport).toHaveBeenCalledTimes(1);
        answer(report(['rules[0].profile: "Gone"'], true));
        await act(async () => finish({ success: true }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    test('Escape acknowledges, as OK does', async () => {
        answer(report(['rules[0].profile: "Gone"']));
        jest.mocked(window.api.acknowledgeImportReport).mockResolvedValue({ success: true });
        render(<ImportReportModal />);
        await screen.findByRole('dialog');

        fireEvent.keyDown(document, { key: 'Escape' });

        await waitFor(() => expect(window.api.acknowledgeImportReport).toHaveBeenCalledTimes(1));
    });

    test.each([
        ['a refusal', { success: false, error: 'settings-import-failed' }, 'settings-import-failed'],
        ['no answer', undefined, 'no answer'],
    ])('%s says it could not be saved, keeps the dialog open and logs why', async (_name, result, logged) => {
        answer(report(['rules[0].profile: "Gone"']));
        jest.mocked(window.api.acknowledgeImportReport).mockResolvedValue(invalid(result));
        render(<ImportReportModal />);
        await screen.findByRole('dialog');

        fireEvent.click(screen.getByRole('button', { name: 'common.ok' }));

        const alert = await screen.findByRole('alert');
        expect(alert.textContent).toBe('notice.importReportFailed');
        expect(screen.getByRole('dialog')).toBeTruthy();
        expect(window.api.logWarning).toHaveBeenCalledWith(expect.stringContaining(logged));
        // OK can be tried again, and a success takes the error away.
        jest.mocked(window.api.acknowledgeImportReport).mockResolvedValue({ success: true });
        answer(report(['rules[0].profile: "Gone"'], true));
        fireEvent.click(screen.getByRole('button', { name: 'common.ok' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    test('an acknowledgement that throws is a failure too, with its message logged', async () => {
        answer(report(['rules[0].profile: "Gone"']));
        jest.mocked(window.api.acknowledgeImportReport).mockRejectedValue(new Error('bridge down'));
        render(<ImportReportModal />);
        await screen.findByRole('dialog');

        fireEvent.click(screen.getByRole('button', { name: 'common.ok' }));

        await screen.findByRole('alert');
        expect(window.api.logError).toHaveBeenCalledWith('Acknowledging the import report threw: bridge down');
    });

    test('a throw without a message is logged as it came', async () => {
        answer(report(['rules[0].profile: "Gone"']));
        jest.mocked(window.api.acknowledgeImportReport).mockRejectedValue(invalid(null));
        render(<ImportReportModal />);
        await screen.findByRole('dialog');

        fireEvent.click(screen.getByRole('button', { name: 'common.ok' }));

        await screen.findByRole('alert');
        expect(window.api.logError).toHaveBeenCalledWith('Acknowledging the import report threw: null');
    });

    test('an import with nothing to report is acknowledged without showing anything', async () => {
        answer(report([]));
        jest.mocked(window.api.acknowledgeImportReport).mockResolvedValue({ success: true });
        const { container } = render(<ImportReportModal />);

        await waitFor(() => expect(window.api.acknowledgeImportReport).toHaveBeenCalledTimes(1));
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(container.textContent).toBe('');
        // Once: the next read finds it acknowledged.
        answer(report([], true));
        act(() => fireSettingsChanged());
        await waitFor(() => expect(window.api.getImportReport).toHaveBeenCalledTimes(3));
        expect(window.api.acknowledgeImportReport).toHaveBeenCalledTimes(1);
    });

    test('an empty report that cannot be acknowledged is logged, shows nothing and is tried again at the next start', async () => {
        answer(report([]));
        jest.mocked(window.api.acknowledgeImportReport).mockResolvedValue({ success: false, error: 'x' });
        render(<ImportReportModal />);

        await waitFor(() => expect(window.api.logWarning).toHaveBeenCalledWith(expect.stringContaining('failed: x')));
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(screen.queryByRole('alert')).toBeNull();
    });

    test.each([
        ['already acknowledged', report(['rules[0].profile: "Gone"'], true)],
        ['no import', { success: true, report: null }],
        ['a refused read', { success: false, error: 'x' }],
        ['no answer', undefined],
    ])('%s shows nothing and acknowledges nothing', async (_name, result) => {
        answer(result);
        const { container } = render(<ImportReportModal />);

        await waitFor(() => expect(window.api.getImportReport).toHaveBeenCalledTimes(1));
        expect(container.textContent).toBe('');
        expect(window.api.acknowledgeImportReport).not.toHaveBeenCalled();
    });

    test('is held back while another notice is up, and shows when that one is gone', async () => {
        answer(report(['rules[0].profile: "Gone"']));
        const { rerender } = render(<ImportReportModal hold />);
        await waitFor(() => expect(window.api.getImportReport).toHaveBeenCalledTimes(1));
        expect(screen.queryByRole('dialog')).toBeNull();

        rerender(<ImportReportModal hold={false} />);

        expect(await screen.findByRole('dialog')).toBeTruthy();
    });
});
