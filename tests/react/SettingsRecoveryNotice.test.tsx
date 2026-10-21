/**
 * The settings-recovery notice: a damaged settings file moved aside, a file that cannot be read, or a settings.json that could not be imported.
 * Each reads as what happened / why (with the file's path) / what next, and can be dismissed for the session.
 */

import { useRef } from 'react';
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
        // The what of a notice that names a file has its own wording where there is none to name.
        expect(alert.textContent).toContain(
            key === 'Unreadable' ? `notice.recovery${key}What` : `notice.recovery${key}WhatAndroid`,
        );
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

    test('a notice stays dismissed when the same one is read again, and shows again for another save given up with the same cause', async () => {
        const dropped = (serial: number) => ({
            code: 'settings-save-dropped',
            path: 'gurushots-config',
            cause: 'too-large',
            serial,
        });
        answer(dropped(1));
        render(<SettingsRecoveryNotice />);
        await screen.findByRole('alert');
        fireEvent.click(screen.getByRole('button', { name: 'errors.dismiss' }));
        expect(screen.queryByRole('alert')).toBeNull();

        // The same save, read again after another settings change.
        act(() => fireSettingsChanged());
        await waitFor(() => expect(window.api.getSettingsRecovery).toHaveBeenCalledTimes(2));
        expect(screen.queryByRole('alert')).toBeNull();

        // The next change is given up too, for the same cause, with no notice between.
        answer(dropped(2));
        act(() => fireSettingsChanged());
        await screen.findByRole('alert');
    });

    test('a different notice replacing a dismissed one is shown', async () => {
        answer({ code: 'settings-corrupt', path: '/data/config.json.corrupt-1' });
        render(<SettingsRecoveryNotice />);
        await screen.findByRole('alert');
        fireEvent.click(screen.getByRole('button', { name: 'errors.dismiss' }));
        expect(screen.queryByRole('alert')).toBeNull();

        answer({ code: 'settings-import-failed', path: '/data/settings.json', blocking: true });
        act(() => fireSettingsChanged());

        expect((await screen.findByRole('alert')).textContent).toContain('notice.recoveryImportWhat');
    });

    test.each([
        ['on a desktop', undefined, 'notice.recoverySignInKept'],
        ['on Android', { isNativePlatform: () => true }, 'notice.recoverySignInKeptAndroid'],
    ])('the damaged copy %s may still hold the sign-in, and the notice says so', async (_name, capacitor, key) => {
        if (capacitor) (globalThis as RendererGlobals).Capacitor = capacitor;
        answer({ code: 'settings-corrupt', path: '/data/config.json.corrupt-1' });
        render(<SettingsRecoveryNotice />);

        expect((await screen.findByRole('alert')).textContent).toContain(key);
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
    // The live region the outcomes are announced in: it is there before there is anything to say.
    const announced = () => screen.getByRole('status');
    // Where a failure is announced, assertively; it has no role of its own (a persistent role=alert would be one more alert on the page).
    const failureRegion = () => document.body.querySelector('[aria-live="assertive"]');
    const failureText = () => failureRegion()?.textContent ?? '';
    // The box an outcome is shown in: its message regions and its Dismiss button.
    const outcomeBox = () => announced().parentElement?.parentElement as HTMLElement;
    // A page that gives the notice a place of its own for focus to return to (it makes it focusable itself).
    const PageWithNotice = () => {
        const target = useRef<HTMLHeadingElement>(null);
        return (
            <>
                <h2 ref={target} tabIndex={-1}>
                    Page heading
                </h2>
                <SettingsRecoveryNotice returnFocusTo={target} />
            </>
        );
    };
    const pageHeading = () => screen.getByRole('heading', { name: 'Page heading' });
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
            answer({ code: 'settings-import-failed', path: '/data/settings.json', blocking: true });
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
            answer({ code: 'settings-import-failed', path: '/data/settings.json', blocking: true });
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
            const done = (await screen.findByText('notice.recoveryRetryDone')).closest('.alert');
            expect(done?.className).toContain('alert-success');
            await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
        });

        test('a Retry that finds the settings in place already says nothing was imported', async () => {
            jest.mocked(window.api.retrySettingsImport).mockResolvedValue({ success: true, adopted: true });
            answer({ code: 'settings-import-failed', path: '/data/settings.json', blocking: true });
            render(<SettingsRecoveryNotice />);
            await screen.findByRole('alert');
            answer(null);

            fireEvent.click(action('notice.recoveryRetry'));

            expect(await screen.findByText('notice.recoveryRetryDoneAdopted')).toBeTruthy();
            expect(screen.queryByText('notice.recoveryRetryDone')).toBeNull();
        });

        test('a failure says what happened, why and what next, in an alert beside the notice, and Dismiss clears it', async () => {
            jest.mocked(window.api.retrySettingsImport).mockResolvedValue({
                success: false,
                error: 'settings-import-failed',
            });
            answer({ code: 'settings-import-failed', path: '/data/settings.json', blocking: true });
            render(<SettingsRecoveryNotice />);
            await screen.findByRole('alert');

            fireEvent.click(action('notice.recoveryRetry'));

            await waitFor(() => expect(failureText()).toContain('notice.recoveryRetryFailed'));
            expect(failureText()).not.toContain('settings-import-failed');
            expect(window.api.logWarning).toHaveBeenCalledWith(expect.stringContaining('"retry" failed'));
            // The actions are available again.
            expect(action('notice.recoveryRetry')).toHaveProperty('disabled', false);

            fireEvent.click(within(outcomeBox()).getByRole('button', { name: 'errors.dismiss' }));
            expect(failureText()).toBe('');
        });

        test.each([
            ['no answer', undefined, 'no answer'],
            ['a refusal without a code', { success: false }, 'no answer'],
        ])('%s is a failure too, logged', async (_name, result, logged) => {
            jest.mocked(window.api.retrySettingsImport).mockResolvedValue(invalid(result));
            answer({ code: 'settings-import-failed', path: '/x', blocking: true });
            render(<SettingsRecoveryNotice />);
            await screen.findByRole('alert');

            fireEvent.click(action('notice.recoveryRetry'));

            await waitFor(() => expect(failureText()).toMatch(/Failed/));
            expect(window.api.logWarning).toHaveBeenCalledWith(expect.stringContaining(logged));
        });

        test('a call that throws is a failure, with its message logged', async () => {
            jest.mocked(window.api.retrySettingsImport).mockRejectedValue(new Error('bridge down'));
            answer({ code: 'settings-import-failed', path: '/x', blocking: true });
            render(<SettingsRecoveryNotice />);
            await screen.findByRole('alert');

            fireEvent.click(action('notice.recoveryRetry'));

            await waitFor(() => expect(failureText()).toMatch(/Failed/));
            expect(window.api.logError).toHaveBeenCalledWith('Settings recovery "retry" threw: bridge down');
        });

        test('a throw without a message is logged as it came', async () => {
            jest.mocked(window.api.retrySettingsImport).mockRejectedValue(invalid(null));
            answer({ code: 'settings-import-failed', path: '/x', blocking: true });
            render(<SettingsRecoveryNotice />);
            await screen.findByRole('alert');

            fireEvent.click(action('notice.recoveryRetry'));

            await waitFor(() =>
                expect(window.api.logError).toHaveBeenCalledWith('Settings recovery "retry" threw: null'),
            );
        });

        test('Start fresh asks first, saying a copy of settings.json is kept; Cancel leaves everything as it was', async () => {
            answer({ code: 'settings-import-failed', path: '/x', blocking: true });
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
            const call = await settle({
                success: true as const,
                kept: { kind: 'path' as const, path: '/x/settings.json.original' },
            });
            jest.mocked(window.api.startFreshSettings).mockReturnValue(call.pending);
            answer({ code: 'settings-import-failed', path: '/x', blocking: true });
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
            answer({ code: 'settings-import-failed', path: '/x', blocking: true });
            render(<SettingsRecoveryNotice />);
            await screen.findByRole('alert');
            fireEvent.click(action('notice.recoveryStartFresh'));

            fireEvent.click(
                within(screen.getByRole('dialog')).getByRole('button', { name: 'notice.recoveryStartFresh' }),
            );

            await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
            expect(failureText()).toContain('notice.recoveryStartFreshFailed');
        });

        test('on Android the same two actions are offered, with the no-file wording', async () => {
            (globalThis as RendererGlobals).Capacitor = { isNativePlatform: () => true };
            answer({ code: 'settings-import-failed', path: 'gurushots-settings', blocking: true });
            render(<SettingsRecoveryNotice />);

            const alert = await screen.findByRole('alert');
            expect(alert.textContent).toContain('notice.recoveryImportNextAndroid');
            expect(within(alert).getByRole('button', { name: 'notice.recoveryRetry' })).toBeTruthy();
            expect(within(alert).getByRole('button', { name: 'notice.recoveryStartFresh' })).toBeTruthy();
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
        answer({ code: 'settings-import-failed', path: '/x', blocking: true });
        render(<SettingsRecoveryNotice />);
        await screen.findByRole('alert');
        fireEvent.click(action('notice.recoveryRetry'));
        await waitFor(() => expect(failureText()).toMatch(/Failed/));

        answer(null);
        fireEvent.click(action('notice.recoveryRetry'));

        expect(await screen.findByText('notice.recoveryRetryDone')).toBeTruthy();
        expect(screen.queryByText('notice.recoveryRetryFailed')).toBeNull();
    });

    describe('the live region', () => {
        test('is mounted before any outcome, and the same element carries the working text and the outcome', async () => {
            const call = await settle({ success: true as const });
            jest.mocked(window.api.retrySettingsImport).mockReturnValue(call.pending);
            answer({ code: 'settings-import-failed', path: '/x', blocking: true });
            render(<SettingsRecoveryNotice />);
            await screen.findByRole('alert');
            const region = announced();
            expect(region.textContent).toBe('');
            expect(region.getAttribute('aria-live')).toBe('polite');

            fireEvent.click(action('notice.recoveryRetry'));
            await waitFor(() => expect(region.textContent).toBe('notice.recoveryWorking'));

            answer(null);
            await call.finish();
            await waitFor(() => expect(region.textContent).toContain('notice.recoveryRetryDone'));
            expect(announced()).toBe(region);
        });

        test('announces a failure assertively, in a region mounted before it, with Dismiss outside both regions', async () => {
            jest.mocked(window.api.retrySettingsImport).mockResolvedValue({ success: false, error: 'x' });
            answer({ code: 'settings-import-failed', path: '/x', blocking: true });
            render(<SettingsRecoveryNotice />);
            await screen.findByRole('alert');
            const assertive = failureRegion();
            expect(assertive?.getAttribute('aria-atomic')).toBe('true');
            expect(assertive?.textContent).toBe('');

            fireEvent.click(action('notice.recoveryRetry'));
            await waitFor(() => expect(assertive?.textContent).toContain('notice.recoveryRetryFailed'));

            expect(failureRegion()).toBe(assertive);
            expect(announced().textContent).toBe('');
            const dismiss = within(outcomeBox()).getByRole('button', { name: 'errors.dismiss' });
            expect(announced().contains(dismiss)).toBe(false);
            expect(assertive?.contains(dismiss)).toBe(false);
        });

        test('Start fresh says it worked, in one wording for both platforms', async () => {
            jest.mocked(window.api.startFreshSettings).mockResolvedValue({ success: true });
            answer({ code: 'settings-import-failed', path: '/x', blocking: true });
            render(<SettingsRecoveryNotice />);
            await screen.findByRole('alert');
            fireEvent.click(action('notice.recoveryStartFresh'));
            fireEvent.click(
                within(screen.getByRole('dialog')).getByRole('button', { name: 'notice.recoveryStartFresh' }),
            );
            await waitFor(() => expect(announced().textContent).toBe('notice.recoveryStartFreshDone'));
        });

        test('Start fresh that found the settings saved meanwhile says nothing was reset, not that defaults were started', async () => {
            jest.mocked(window.api.startFreshSettings).mockResolvedValue({ success: true, adopted: true });
            answer({ code: 'settings-import-failed', path: '/x', blocking: true });
            render(<SettingsRecoveryNotice />);
            await screen.findByRole('alert');
            fireEvent.click(action('notice.recoveryStartFresh'));
            fireEvent.click(
                within(screen.getByRole('dialog')).getByRole('button', { name: 'notice.recoveryStartFresh' }),
            );
            await waitFor(() => expect(announced().textContent).toBe('notice.recoveryStartFreshDoneAdopted'));
        });

        test('Dismiss puts focus back on the button that ran the action', async () => {
            jest.mocked(window.api.retrySettingsImport).mockResolvedValue({ success: false, error: 'x' });
            answer({ code: 'settings-import-failed', path: '/x', blocking: true });
            render(<SettingsRecoveryNotice />);
            await screen.findByRole('alert');
            fireEvent.click(action('notice.recoveryRetry'));
            await waitFor(() => expect(failureText()).toContain('notice.recoveryRetryFailed'));

            fireEvent.click(within(outcomeBox()).getByRole('button', { name: 'errors.dismiss' }));

            expect(document.activeElement).toBe(action('notice.recoveryRetry'));
        });

        test("Dismiss puts focus on the notice's heading when the button that ran the action is gone", async () => {
            jest.mocked(window.api.startFreshSettings).mockResolvedValue({ success: false, error: 'x' });
            answer({ code: 'settings-import-failed', path: '/x', blocking: true });
            render(<SettingsRecoveryNotice />);
            await screen.findByRole('alert');
            fireEvent.click(action('notice.recoveryStartFresh'));
            fireEvent.click(
                within(screen.getByRole('dialog')).getByRole('button', { name: 'notice.recoveryStartFresh' }),
            );
            await waitFor(() => expect(failureText()).toContain('notice.recoveryStartFreshFailed'));
            // The notice has changed meanwhile: Start fresh is not offered any more.
            answer({ code: 'settings-unreadable', path: '/x' });
            act(() => fireSettingsChanged());
            await screen.findByText('notice.recoveryUnreadableWhat');
            expect(screen.queryByRole('button', { name: 'notice.recoveryStartFresh' })).toBeNull();

            fireEvent.click(within(outcomeBox()).getByRole('button', { name: 'errors.dismiss' }));

            expect(document.activeElement).toBe(screen.getByText('notice.recoveryUnreadableWhat'));
        });

        test("Dismiss puts focus on the page's own place when there is no button and no notice heading to put it on", async () => {
            jest.mocked(window.api.retrySettingsImport).mockResolvedValue({ success: false, error: 'x' });
            answer({ code: 'settings-import-failed', path: '/x', blocking: true });
            render(<PageWithNotice />);
            await screen.findByRole('alert');
            fireEvent.click(action('notice.recoveryRetry'));
            await waitFor(() => expect(failureText()).toContain('notice.recoveryRetryFailed'));
            fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'errors.dismiss' }));
            expect(screen.queryByRole('alert')).toBeNull();

            fireEvent.click(within(outcomeBox()).getByRole('button', { name: 'errors.dismiss' }));

            expect(document.activeElement).toBe(pageHeading());
            expect(failureText()).toBe('');
        });

        test("a success, which took the notice away, stays on screen as a named message until it is dismissed, and Dismiss moves focus to the page's own place, not to the body or an empty element", async () => {
            jest.mocked(window.api.retrySettingsImport).mockResolvedValue({ success: true });
            answer({ code: 'settings-import-failed', path: '/x', blocking: true });
            render(<PageWithNotice />);
            await screen.findByRole('alert');
            answer(null);
            fireEvent.click(action('notice.recoveryRetry'));
            await waitFor(() => expect(announced().textContent).toContain('notice.recoveryRetryDone'));
            await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
            // The message is still there, in a named region, until the user has seen it.
            expect(
                within(screen.getByRole('region', { name: 'notice.recoveryRegion' })).getByRole('status').textContent,
            ).toContain('notice.recoveryRetryDone');

            fireEvent.click(within(outcomeBox()).getByRole('button', { name: 'errors.dismiss' }));

            expect(document.activeElement).toBe(pageHeading());
            expect(document.activeElement?.textContent).not.toBe('');
            expect(screen.queryByRole('region')).toBeNull();
        });

        test('with no place given by the page, Dismiss moves focus nowhere (never to an empty element)', async () => {
            jest.mocked(window.api.retrySettingsImport).mockResolvedValue({ success: true });
            answer({ code: 'settings-import-failed', path: '/x', blocking: true });
            render(<SettingsRecoveryNotice />);
            await screen.findByRole('alert');
            answer(null);
            fireEvent.click(action('notice.recoveryRetry'));
            await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
            await waitFor(() => expect(announced().textContent).toContain('notice.recoveryRetryDone'));

            fireEvent.click(within(outcomeBox()).getByRole('button', { name: 'errors.dismiss' }));

            expect(document.querySelector('[tabindex]:focus')).toBeNull();
        });

        test('the container is a named region only while it has something in it', async () => {
            jest.mocked(window.api.retrySettingsImport).mockResolvedValue({ success: false, error: 'x' });
            answer(null);
            const empty = render(<SettingsRecoveryNotice />);
            await waitFor(() => expect(window.api.getSettingsRecovery).toHaveBeenCalledTimes(1));
            // Nothing to say: no landmark for a screen reader to stop at.
            expect(screen.queryByRole('region')).toBeNull();
            empty.unmount();

            answer({ code: 'settings-import-failed', path: '/x', blocking: true });
            render(<SettingsRecoveryNotice />);
            await screen.findByRole('alert');
            expect(screen.getByRole('region', { name: 'notice.recoveryRegion' })).toBeTruthy();

            // Dismissed, and its failure dismissed: empty again.
            fireEvent.click(action('notice.recoveryRetry'));
            await waitFor(() => expect(failureText()).toContain('notice.recoveryRetryFailed'));
            expect(screen.getByRole('region', { name: 'notice.recoveryRegion' })).toBeTruthy();
            fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'errors.dismiss' }));
            fireEvent.click(within(outcomeBox()).getByRole('button', { name: 'errors.dismiss' }));
            expect(screen.queryByRole('region')).toBeNull();
        });

        test("touches no other component's markup: a heading of the page keeps its attributes", async () => {
            jest.mocked(window.api.retrySettingsImport).mockResolvedValue({ success: true });
            answer({ code: 'settings-import-failed', path: '/x', blocking: true });
            render(
                <>
                    <h1>Page title</h1>
                    <SettingsRecoveryNotice />
                </>,
            );
            await screen.findByRole('alert');
            answer(null);
            fireEvent.click(action('notice.recoveryRetry'));
            await waitFor(() => expect(announced().textContent).toContain('notice.recoveryRetryDone'));
            fireEvent.click(within(outcomeBox()).getByRole('button', { name: 'errors.dismiss' }));

            expect(screen.getByRole('heading', { name: 'Page title' }).hasAttribute('tabindex')).toBe(false);
        });

        test('the two regions share one element, so that an empty one takes no cell of a grid alert', async () => {
            jest.mocked(window.api.retrySettingsImport).mockResolvedValue({ success: false, error: 'x' });
            answer({ code: 'settings-import-failed', path: '/x', blocking: true });
            render(<SettingsRecoveryNotice />);
            await screen.findByRole('alert');
            fireEvent.click(action('notice.recoveryRetry'));
            await waitFor(() => expect(failureText()).toContain('notice.recoveryRetryFailed'));

            const box = outcomeBox();

            expect(box.className).toContain('alert-error');
            expect(box.children).toHaveLength(2);
            expect(box.children[0]).toBe(announced().parentElement);
            expect(box.children[0].contains(failureRegion())).toBe(true);
            expect(box.children[1].tagName).toBe('BUTTON');
        });

        test('is there with nothing to say when the settings are in use', async () => {
            answer(null);
            render(<SettingsRecoveryNotice />);
            await waitFor(() => expect(window.api.getSettingsRecovery).toHaveBeenCalledTimes(1));

            expect(announced().textContent).toBe('');
        });
    });

    describe('on Android the questions and outcomes name no file either', () => {
        beforeEach(() => {
            (globalThis as RendererGlobals).Capacitor = { isNativePlatform: () => true };
        });

        test('Start fresh asks, and says it worked, in the no-file wording', async () => {
            jest.mocked(window.api.startFreshSettings).mockResolvedValue({ success: true });
            answer({ code: 'settings-import-failed', path: 'gurushots-settings', blocking: true });
            render(<SettingsRecoveryNotice />);
            await screen.findByRole('alert');

            fireEvent.click(action('notice.recoveryStartFresh'));
            const dialog = screen.getByRole('dialog');
            expect(within(dialog).getByText('notice.recoveryStartFreshBodyAndroid')).toBeTruthy();
            answer(null);
            fireEvent.click(within(dialog).getByRole('button', { name: 'notice.recoveryStartFresh' }));

            expect(await screen.findByText('notice.recoveryStartFreshDoneAndroid')).toBeTruthy();
        });

        test('Retry says it worked, or did not, in the no-file wording', async () => {
            jest.mocked(window.api.retrySettingsImport)
                .mockResolvedValueOnce({ success: false, error: 'x' })
                .mockResolvedValueOnce({ success: true });
            answer({ code: 'settings-import-failed', path: 'gurushots-settings', blocking: true });
            render(<SettingsRecoveryNotice />);
            await screen.findByRole('alert');

            fireEvent.click(action('notice.recoveryRetry'));
            await waitFor(() => expect(failureText()).toContain('notice.recoveryRetryFailedAndroid'));

            answer(null);
            fireEvent.click(action('notice.recoveryRetry'));
            expect(await screen.findByText('notice.recoveryRetryDoneAndroid')).toBeTruthy();
        });

        test('a Start fresh that fails keeps its shared wording, which names no file', async () => {
            jest.mocked(window.api.startFreshSettings).mockResolvedValue({ success: false, error: 'x' });
            answer({ code: 'settings-import-failed', path: 'gurushots-settings', blocking: true });
            render(<SettingsRecoveryNotice />);
            await screen.findByRole('alert');

            fireEvent.click(action('notice.recoveryStartFresh'));
            const dialog = screen.getByRole('dialog');
            answer(null);
            fireEvent.click(within(dialog).getByRole('button', { name: 'notice.recoveryStartFresh' }));

            await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
            expect(failureText()).toContain('notice.recoveryStartFreshFailed');
        });
    });

    describe('an import that cannot pass (the defaults were stored in its place)', () => {
        test('names the reason, says saving works, and offers no action', async () => {
            answer({ code: 'settings-import-failed', path: '/data/settings.json', blocking: false, detail: 'corrupt' });
            render(<SettingsRecoveryNotice />);

            const alert = await screen.findByRole('alert');
            expect(alert.textContent).toContain('notice.recoveryImportSettledWhat');
            expect(alert.textContent).toContain('notice.recoveryImportWhyCorrupt');
            expect(alert.textContent).toContain('notice.recoveryImportSettledNext');
            expect(
                within(alert)
                    .getAllByRole('button')
                    .map((b) => b.textContent),
            ).toEqual(['errors.dismiss']);
        });

        test('a conversion that cannot be done is named as the reason', async () => {
            answer({
                code: 'settings-import-failed',
                path: '/data/settings.json',
                blocking: false,
                detail: 'migration-failed',
            });
            render(<SettingsRecoveryNotice />);

            expect((await screen.findByRole('alert')).textContent).toContain('notice.recoveryImportWhyMigration');
        });

        test('on Android it names no file', async () => {
            (globalThis as RendererGlobals).Capacitor = { isNativePlatform: () => true };
            answer({ code: 'settings-import-failed', path: 'gurushots-settings', blocking: false, detail: 'corrupt' });
            render(<SettingsRecoveryNotice />);

            const alert = await screen.findByRole('alert');
            expect(alert.textContent).toContain('notice.recoveryImportSettledWhatAndroid');
            expect(alert.textContent).toContain('notice.recoveryImportWhyCorrupt');
            expect(alert.textContent).toContain('notice.recoveryImportSettledNextAndroid');
            expect(alert.textContent).not.toContain('gurushots-settings');
        });
    });
});
