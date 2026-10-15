/**
 * The settings-recovery notice: a damaged settings file moved aside, a file that cannot be read, or 1.x settings that could not be imported.
 * Each reads as what happened / why (with the file's path) / what next, and can be dismissed for the session.
 */

import { act, fireEvent, render, screen, waitFor, within } from './helpers/test-utils';
import { SettingsRecoveryNotice } from '@/components/app/SettingsRecoveryNotice';
import { mockTranslator, defaultTranslate, fireSettingsChanged } from './helpers/setup';
import { invalid } from '../helpers/invalid';
import type { RendererGlobals } from '../../src/ts/types/capacitor';

const answer = (recovery: unknown) =>
    jest.mocked(window.api.getSettingsRecovery).mockResolvedValue(invalid({ success: true, recovery }));

describe('SettingsRecoveryNotice', () => {
    afterEach(() => {
        mockTranslator.t.mockImplementation(defaultTranslate);
        delete (globalThis as RendererGlobals).Capacitor;
    });

    test('shows nothing when the settings are in use', async () => {
        answer(null);
        const { container } = render(<SettingsRecoveryNotice />);
        await waitFor(() => expect(window.api.getSettingsRecovery).toHaveBeenCalledTimes(1));
        expect(container.textContent).toBe('');
    });

    test.each([
        ['settings-corrupt', 'Corrupt'],
        ['settings-unreadable', 'Unreadable'],
        ['settings-import-failed', 'Import'],
    ])('%s says what happened, why with the path, and what next', async (code, key) => {
        mockTranslator.t.mockImplementation((text) => (text === `notice.recovery${key}Why` ? 'Why at {path}' : text));
        answer({ code, path: '/data/config.json.corrupt-1' });
        render(<SettingsRecoveryNotice />);

        const alert = await screen.findByRole('alert');
        expect(alert.textContent).toContain(`notice.recovery${key}What`);
        expect(alert.textContent).toContain('Why at /data/config.json.corrupt-1');
        expect(alert.textContent).toContain(`notice.recovery${key}Next`);
    });

    test.each([
        ['conflict', 'recoveryDroppedWhyConflict', 'recoveryDroppedNext'],
        ['too-large', 'recoveryDroppedWhyTooLarge', 'recoveryDroppedNextTooLarge'],
        ['storage', 'recoveryDroppedWhyStorage', 'recoveryDroppedNext'],
        ['something-else', 'recoveryDroppedWhyUnknown', 'recoveryDroppedNext'],
        [undefined, 'recoveryDroppedWhyUnknown', 'recoveryDroppedNext'],
        ['constructor', 'recoveryDroppedWhyUnknown', 'recoveryDroppedNext'],
    ])('a dropped save with cause %s words its why (%s) and next (%s) by that cause', async (cause, why, next) => {
        answer({ code: 'settings-save-dropped', path: 'gurushots-config', cause });
        render(<SettingsRecoveryNotice />);

        const alert = await screen.findByRole('alert');
        expect(alert.textContent).toContain('notice.recoveryDroppedWhat');
        expect(alert.textContent).toContain(`notice.${why}`);
        expect(alert.textContent).toContain(`notice.${next}`);
        // One why only: the causes are not stacked.
        expect(alert.textContent?.match(/recoveryDroppedWhy/g)).toHaveLength(1);
    });

    test.each([
        ['settings-corrupt', 'Corrupt', 'gurushots-config_corrupt'],
        ['settings-unreadable', 'Unreadable', 'gurushots-config'],
        ['settings-import-failed', 'Import', 'gurushots-settings'],
    ])('%s on Android names no file and asks for no step on one', async (code, key, path) => {
        (globalThis as RendererGlobals).Capacitor = { isNativePlatform: () => true };
        answer({ code, path });
        render(<SettingsRecoveryNotice />);

        const alert = await screen.findByRole('alert');
        expect(alert.textContent).toContain(`notice.recovery${key}What`);
        expect(alert.textContent).toContain(`notice.recovery${key}WhyAndroid`);
        expect(alert.textContent).toContain(`notice.recovery${key}NextAndroid`);
        expect(alert.textContent).not.toContain(path);
    });

    test('a dropped save words the same on Android as elsewhere', async () => {
        (globalThis as RendererGlobals).Capacitor = { isNativePlatform: () => true };
        answer({ code: 'settings-save-dropped', path: 'gurushots-config', cause: 'storage' });
        render(<SettingsRecoveryNotice />);

        expect((await screen.findByRole('alert')).textContent).toContain('notice.recoveryDroppedWhyStorage');
    });

    test('Dismiss hides it', async () => {
        answer({ code: 'settings-corrupt', path: '/x' });
        render(<SettingsRecoveryNotice />);
        await screen.findByRole('alert');
        fireEvent.click(screen.getByRole('button', { name: 'errors.dismiss' }));
        expect(screen.queryByRole('alert')).toBeNull();
    });

    test('a save given up after it was first read shows the notice, and one that lands afterwards takes it away', async () => {
        answer(null);
        const { container } = render(<SettingsRecoveryNotice />);
        await waitFor(() => expect(window.api.getSettingsRecovery).toHaveBeenCalledTimes(1));
        expect(container.textContent).toBe('');

        answer({ code: 'settings-save-dropped', path: 'gurushots-settings' });
        act(() => fireSettingsChanged());
        await screen.findByRole('alert');

        answer(null);
        act(() => fireSettingsChanged());
        await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    });

    test('a notice dismissed and then gone shows again when a later save is given up', async () => {
        answer({ code: 'settings-save-dropped', path: 'gurushots-settings' });
        render(<SettingsRecoveryNotice />);
        await screen.findByRole('alert');
        fireEvent.click(screen.getByRole('button', { name: 'errors.dismiss' }));
        expect(screen.queryByRole('alert')).toBeNull();

        answer(null);
        act(() => fireSettingsChanged());
        await waitFor(() => expect(window.api.getSettingsRecovery).toHaveBeenCalledTimes(2));

        answer({ code: 'settings-save-dropped', path: 'gurushots-settings' });
        act(() => fireSettingsChanged());
        await screen.findByRole('alert');
    });

    test.each([
        ['a code this build has no wording for', { success: true, recovery: { code: 'settings-new', path: '/x' } }],
        ['a refused read', { success: false, error: 'x' }],
        ['no answer', undefined],
    ])('%s shows nothing', async (_name, result) => {
        jest.mocked(window.api.getSettingsRecovery).mockResolvedValue(invalid(result));
        const { container } = render(<SettingsRecoveryNotice />);
        await waitFor(() => expect(window.api.getSettingsRecovery).toHaveBeenCalledTimes(1));
        expect(container.textContent).toBe('');
    });
});

describe('SettingsRecoveryNotice actions', () => {
    const action = (name: string) => screen.getByRole('button', { name });
    const settle = async <T,>(value: T) => {
        // A pending call the test resolves itself, to look at the state while it runs.
        let finish: (result: T) => void = () => {};
        const pending = new Promise<T>((done) => {
            finish = done;
        });
        return { pending, finish: (result: T = value) => act(async () => finish(result)) };
    };

    afterEach(() => {
        mockTranslator.t.mockImplementation(defaultTranslate);
        delete (globalThis as RendererGlobals).Capacitor;
    });

    describe('a failed import offers Retry and Start fresh', () => {
        test('words the file by name and offers both, and nothing else', async () => {
            mockTranslator.t.mockImplementation((text) =>
                text === 'notice.recoveryImportWhy' ? 'File at {path}' : text,
            );
            answer({ code: 'settings-import-failed', path: '/data/settings.json' });
            render(<SettingsRecoveryNotice />);

            const alert = await screen.findByRole('alert');
            expect(alert.textContent).toContain('File at /data/settings.json');
            expect(
                within(alert)
                    .getAllByRole('button')
                    .map((b) => b.textContent),
            ).toEqual(['notice.recoveryRetry', 'notice.recoveryStartFresh', 'errors.dismiss']);
        });

        test('Retry shows progress, then says it worked, and the notice goes with the next read', async () => {
            const call = await settle({ success: true as const });
            jest.mocked(window.api.retrySettingsImport).mockReturnValue(call.pending);
            answer({ code: 'settings-import-failed', path: '/data/settings.json' });
            render(<SettingsRecoveryNotice />);
            await screen.findByRole('alert');

            fireEvent.click(action('notice.recoveryRetry'));

            // While it runs: the working text is announced, and neither action can be started again.
            expect(await screen.findByRole('status')).toHaveProperty('textContent', 'notice.recoveryWorking');
            expect(action('notice.recoveryRetry').getAttribute('aria-busy')).toBe('true');
            expect(screen.getByRole('button', { name: 'notice.recoveryStartFresh' })).toHaveProperty('disabled', true);
            expect(screen.getByRole('button', { name: 'notice.recoveryRetry' })).toHaveProperty('disabled', true);

            answer(null);
            await call.finish();

            expect(window.api.retrySettingsImport).toHaveBeenCalledTimes(1);
            const done = (await screen.findByText('notice.recoveryRetryDone')).closest('[role="status"]');
            expect(done?.className).toContain('alert-success');
            await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
        });

        test('a failure says what happened, why and what next, in an alert beside the notice, and Dismiss clears it', async () => {
            jest.mocked(window.api.retrySettingsImport).mockResolvedValue({
                success: false,
                error: 'settings-import-failed',
            });
            answer({ code: 'settings-import-failed', path: '/data/settings.json' });
            render(<SettingsRecoveryNotice />);
            await screen.findByRole('alert');

            fireEvent.click(action('notice.recoveryRetry'));

            await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(2));
            const [, failure] = screen.getAllByRole('alert');
            expect(failure.textContent).toContain('notice.recoveryRetryFailed');
            expect(failure.textContent).not.toContain('settings-import-failed');
            expect(window.api.logWarning).toHaveBeenCalledWith(expect.stringContaining('"retry" failed'));
            // The actions are available again.
            expect(action('notice.recoveryRetry')).toHaveProperty('disabled', false);

            fireEvent.click(within(failure).getByRole('button', { name: 'errors.dismiss' }));
            expect(screen.getAllByRole('alert')).toHaveLength(1);
        });

        test.each([
            ['no answer', undefined, 'no answer'],
            ['a refusal without a code', { success: false }, 'no answer'],
        ])('%s is a failure too, logged', async (_name, result, logged) => {
            jest.mocked(window.api.retrySettingsImport).mockResolvedValue(invalid(result));
            answer({ code: 'settings-import-failed', path: '/x' });
            render(<SettingsRecoveryNotice />);
            await screen.findByRole('alert');

            fireEvent.click(action('notice.recoveryRetry'));

            await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(2));
            expect(window.api.logWarning).toHaveBeenCalledWith(expect.stringContaining(logged));
        });

        test('a call that throws is a failure, with its message logged', async () => {
            jest.mocked(window.api.retrySettingsImport).mockRejectedValue(new Error('bridge down'));
            answer({ code: 'settings-import-failed', path: '/x' });
            render(<SettingsRecoveryNotice />);
            await screen.findByRole('alert');

            fireEvent.click(action('notice.recoveryRetry'));

            await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(2));
            expect(window.api.logError).toHaveBeenCalledWith('Settings recovery "retry" threw: bridge down');
        });

        test('a throw without a message is logged as it came', async () => {
            jest.mocked(window.api.retrySettingsImport).mockRejectedValue(invalid(null));
            answer({ code: 'settings-import-failed', path: '/x' });
            render(<SettingsRecoveryNotice />);
            await screen.findByRole('alert');

            fireEvent.click(action('notice.recoveryRetry'));

            await waitFor(() =>
                expect(window.api.logError).toHaveBeenCalledWith('Settings recovery "retry" threw: null'),
            );
        });

        test('Start fresh asks first, saying settings.json stays as a backup; Cancel leaves everything as it was', async () => {
            answer({ code: 'settings-import-failed', path: '/x' });
            render(<SettingsRecoveryNotice />);
            await screen.findByRole('alert');

            fireEvent.click(action('notice.recoveryStartFresh'));

            const dialog = screen.getByRole('dialog', { name: 'notice.recoveryStartFreshTitle' });
            expect(within(dialog).getByText('notice.recoveryStartFreshBody')).toBeTruthy();
            expect(window.api.startFreshSettings).not.toHaveBeenCalled();

            fireEvent.click(within(dialog).getByRole('button', { name: 'app.cancel' }));

            expect(screen.queryByRole('dialog')).toBeNull();
            expect(window.api.startFreshSettings).not.toHaveBeenCalled();
        });

        test('confirming Start fresh runs it, shows progress in the dialog and then the result in the page', async () => {
            const call = await settle({ success: true as const });
            jest.mocked(window.api.startFreshSettings).mockReturnValue(call.pending);
            answer({ code: 'settings-import-failed', path: '/x' });
            render(<SettingsRecoveryNotice />);
            await screen.findByRole('alert');
            fireEvent.click(action('notice.recoveryStartFresh'));

            fireEvent.click(
                within(screen.getByRole('dialog')).getByRole('button', { name: 'notice.recoveryStartFresh' }),
            );

            const dialog = screen.getByRole('dialog');
            expect(
                within(dialog).getByRole('button', { name: 'notice.recoveryWorking' }).getAttribute('aria-disabled'),
            ).toBe('true');
            // Nothing can dismiss it while the call is out.
            expect(within(dialog).getByRole('button', { name: 'app.cancel' })).toHaveProperty('disabled', true);

            answer(null);
            await call.finish();

            await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
            expect(await screen.findByText('notice.recoveryStartFreshDone')).toBeTruthy();
        });

        test('a Start fresh that fails closes the question and says so', async () => {
            jest.mocked(window.api.startFreshSettings).mockResolvedValue({ success: false, error: 'x' });
            answer({ code: 'settings-import-failed', path: '/x' });
            render(<SettingsRecoveryNotice />);
            await screen.findByRole('alert');
            fireEvent.click(action('notice.recoveryStartFresh'));

            fireEvent.click(
                within(screen.getByRole('dialog')).getByRole('button', { name: 'notice.recoveryStartFresh' }),
            );

            await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
            expect(screen.getAllByRole('alert').at(-1)?.textContent).toContain('notice.recoveryStartFreshFailed');
        });

        test('on Android the same two actions are offered, with the no-file wording', async () => {
            (globalThis as RendererGlobals).Capacitor = { isNativePlatform: () => true };
            answer({ code: 'settings-import-failed', path: 'gurushots-settings' });
            render(<SettingsRecoveryNotice />);

            const alert = await screen.findByRole('alert');
            expect(alert.textContent).toContain('notice.recoveryImportNextAndroid');
            expect(within(alert).getByRole('button', { name: 'notice.recoveryRetry' })).toBeTruthy();
            expect(within(alert).getByRole('button', { name: 'notice.recoveryStartFresh' })).toBeTruthy();
        });
    });

    describe('a damaged config.json offers Re-import from settings.json', () => {
        test('names config.json, says where the copy went, and asks before replacing the settings in use', async () => {
            answer({ code: 'settings-corrupt', path: '/data/config.json.corrupt-1' });
            render(<SettingsRecoveryNotice />);
            const alert = await screen.findByRole('alert');
            expect(
                within(alert)
                    .getAllByRole('button')
                    .map((b) => b.textContent),
            ).toEqual(['notice.recoveryReimport', 'errors.dismiss']);

            fireEvent.click(action('notice.recoveryReimport'));

            const dialog = screen.getByRole('dialog', { name: 'notice.recoveryReimportTitle' });
            expect(within(dialog).getByText('notice.recoveryReimportBody')).toBeTruthy();
            expect(window.api.reimportSettingsFromV1).not.toHaveBeenCalled();

            jest.mocked(window.api.reimportSettingsFromV1).mockResolvedValue({ success: true });
            answer(null);
            fireEvent.click(within(dialog).getByRole('button', { name: 'notice.recoveryReimportConfirm' }));

            expect(window.api.reimportSettingsFromV1).toHaveBeenCalledTimes(1);
            expect(await screen.findByText('notice.recoveryReimportDone')).toBeTruthy();
            await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
        });

        test('a re-import that fails says so beside the notice, which stays', async () => {
            jest.mocked(window.api.reimportSettingsFromV1).mockResolvedValue({ success: false, error: 'x' });
            answer({ code: 'settings-corrupt', path: '/x' });
            render(<SettingsRecoveryNotice />);
            await screen.findByRole('alert');
            fireEvent.click(action('notice.recoveryReimport'));

            fireEvent.click(
                within(screen.getByRole('dialog')).getByRole('button', { name: 'notice.recoveryReimportConfirm' }),
            );

            await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(2));
            expect(screen.getAllByRole('alert')[1].textContent).toContain('notice.recoveryReimportFailed');
        });
    });

    describe('a settings.json that changed offers Re-import and Keep current settings', () => {
        test('says it changed since the import, and that saving works', async () => {
            mockTranslator.t.mockImplementation((text) => (text === 'notice.recoveryChangedWhy' ? 'At {path}' : text));
            answer({ code: 'settings-v1-changed', path: '/data/settings.json', blocking: false });
            render(<SettingsRecoveryNotice />);

            const alert = await screen.findByRole('alert');
            expect(alert.textContent).toContain('notice.recoveryChangedWhat');
            expect(alert.textContent).toContain('At /data/settings.json');
            expect(alert.textContent).toContain('notice.recoveryChangedNext');
            expect(
                within(alert)
                    .getAllByRole('button')
                    .map((b) => b.textContent),
            ).toEqual(['notice.recoveryReimport', 'notice.recoveryKeep', 'errors.dismiss']);
        });

        test('on Android it names no file', async () => {
            (globalThis as RendererGlobals).Capacitor = { isNativePlatform: () => true };
            answer({ code: 'settings-v1-changed', path: 'gurushots-settings' });
            render(<SettingsRecoveryNotice />);

            const alert = await screen.findByRole('alert');
            expect(alert.textContent).toContain('notice.recoveryChangedWhyAndroid');
            expect(alert.textContent).toContain('notice.recoveryChangedNextAndroid');
            expect(alert.textContent).not.toContain('gurushots-settings');
        });

        test('Keep current settings needs no question: it runs, says it is kept, and the notice goes', async () => {
            jest.mocked(window.api.keepCurrentConfig).mockResolvedValue({ success: true });
            answer({ code: 'settings-v1-changed', path: '/data/settings.json' });
            render(<SettingsRecoveryNotice />);
            await screen.findByRole('alert');

            answer(null);
            fireEvent.click(action('notice.recoveryKeep'));

            expect(screen.queryByRole('dialog')).toBeNull();
            expect(await screen.findByText('notice.recoveryKeepDone')).toBeTruthy();
            expect(window.api.keepCurrentConfig).toHaveBeenCalledTimes(1);
            await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
        });

        test('Keep that fails says so', async () => {
            jest.mocked(window.api.keepCurrentConfig).mockResolvedValue({ success: false, error: 'x' });
            answer({ code: 'settings-v1-changed', path: '/data/settings.json' });
            render(<SettingsRecoveryNotice />);
            await screen.findByRole('alert');

            fireEvent.click(action('notice.recoveryKeep'));

            await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(2));
            expect(screen.getAllByRole('alert')[1].textContent).toContain('notice.recoveryKeepFailed');
        });

        test('Re-import asks first and replaces the settings in use', async () => {
            jest.mocked(window.api.reimportSettingsFromV1).mockResolvedValue({ success: true });
            answer({ code: 'settings-v1-changed', path: '/data/settings.json' });
            render(<SettingsRecoveryNotice />);
            await screen.findByRole('alert');

            fireEvent.click(action('notice.recoveryReimport'));
            expect(screen.getByRole('dialog', { name: 'notice.recoveryReimportTitle' })).toBeTruthy();
            answer(null);
            fireEvent.click(
                within(screen.getByRole('dialog')).getByRole('button', { name: 'notice.recoveryReimportConfirm' }),
            );

            expect(await screen.findByText('notice.recoveryReimportDone')).toBeTruthy();
        });
    });

    test('a notice without a way forward offers no action', async () => {
        answer({ code: 'settings-unreadable', path: '/x' });
        render(<SettingsRecoveryNotice />);

        const alert = await screen.findByRole('alert');
        expect(
            within(alert)
                .getAllByRole('button')
                .map((b) => b.textContent),
        ).toEqual(['errors.dismiss']);
    });

    test('a new action clears the outcome of the one before', async () => {
        jest.mocked(window.api.retrySettingsImport)
            .mockResolvedValueOnce({ success: false, error: 'x' })
            .mockResolvedValueOnce({ success: true });
        answer({ code: 'settings-import-failed', path: '/x' });
        render(<SettingsRecoveryNotice />);
        await screen.findByRole('alert');
        fireEvent.click(action('notice.recoveryRetry'));
        await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(2));

        answer(null);
        fireEvent.click(action('notice.recoveryRetry'));

        expect(await screen.findByText('notice.recoveryRetryDone')).toBeTruthy();
        expect(screen.queryByText('notice.recoveryRetryFailed')).toBeNull();
    });
});
