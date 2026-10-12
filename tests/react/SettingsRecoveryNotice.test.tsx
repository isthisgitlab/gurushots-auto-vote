/**
 * The settings-recovery notice: a damaged settings file moved aside, or one that cannot be read or brought up to date.
 * Each reads as what happened / why (with the file's path) / what next, and can be dismissed for the session.
 */

import { act, fireEvent, render, screen, waitFor } from './helpers/test-utils';
import { SettingsRecoveryNotice } from '@/components/app/SettingsRecoveryNotice';
import { mockTranslator, defaultTranslate, fireSettingsChanged } from './helpers/setup';
import { invalid } from '../helpers/invalid';

const answer = (recovery: unknown) =>
    jest.mocked(window.api.getSettingsRecovery).mockResolvedValue(invalid({ success: true, recovery }));

describe('SettingsRecoveryNotice', () => {
    afterEach(() => mockTranslator.t.mockImplementation(defaultTranslate));

    test('shows nothing when the settings are in use', async () => {
        answer(null);
        const { container } = render(<SettingsRecoveryNotice />);
        await waitFor(() => expect(window.api.getSettingsRecovery).toHaveBeenCalledTimes(1));
        expect(container.textContent).toBe('');
    });

    test.each([
        ['settings-corrupt', 'Corrupt'],
        ['settings-unreadable', 'Unreadable'],
        ['settings-migration-failed', 'Migration'],
        ['settings-save-dropped', 'Dropped'],
    ])('%s says what happened, why with the path, and what next', async (code, key) => {
        mockTranslator.t.mockImplementation((text) => (text === `notice.recovery${key}Why` ? 'Why at {path}' : text));
        answer({ code, path: '/data/settings.json.corrupt-1' });
        render(<SettingsRecoveryNotice />);

        const alert = await screen.findByRole('alert');
        expect(alert.textContent).toContain(`notice.recovery${key}What`);
        expect(alert.textContent).toContain('Why at /data/settings.json.corrupt-1');
        expect(alert.textContent).toContain(`notice.recovery${key}Next`);
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
