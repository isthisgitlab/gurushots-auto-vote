/**
 * The unsaved-changes guard on SettingsModal and ChallengeSettingsModal, driven through the real hooks (only
 * window.api is mocked): what counts as an unsaved edit, what dismissing and Saving then ask, and that a Save
 * that failed partway does not ask about the part that landed.
 */

import { act, fireEvent, pickOption, render, screen, waitFor } from './helpers/test-utils';
import { SettingsModal } from '@/components/app/SettingsModal';
import { ChallengeSettingsModal } from '@/components/app/ChallengeSettingsModal';
import { announceChosenPhotosCleared } from '@/api/chosenPhotosCleared';
import { fireSettingsChanged, mockApi } from './helpers/setup';
import { invalid } from '../helpers/invalid';

const PHOTO = `00000001${'a'.repeat(24)}`;

const APP_SETTINGS = { theme: 'light', language: 'en', timezone: 'Europe/Riga' };

const SCHEMA = {
    exposure: {
        type: 'number',
        default: 70,
        label: 'app.exposure',
        description: 'app.exposureDesc',
        group: 'g',
        perChallenge: true,
    },
};

const onClose = jest.fn();

beforeEach(() => {
    window.api = invalid(mockApi);
    document.documentElement.setAttribute('data-theme', 'light');
    onClose.mockReset();
    mockApi.getSettings.mockReset().mockResolvedValue(invalid({ app: { ...APP_SETTINGS } }));
    mockApi.getSettingsSchema.mockReset().mockResolvedValue(
        invalid({
            schema: SCHEMA,
            defaults: { exposure: 70 },
            groups: [{ id: 'g', label: 'app.groupG', tier: 'core' }],
            tiers: [{ id: 'core', label: 'app.tierCore' }],
        }),
    );
    mockApi.setSetting.mockReset().mockResolvedValue(true);
    mockApi.setGlobalDefault.mockReset().mockResolvedValue(true);
    mockApi.getTitleRules.mockReset().mockResolvedValue(invalid([{ title: 'A', mustIncludeTags: ['x'] }]));
    mockApi.setTitleRules.mockReset().mockResolvedValue(true);
    mockApi.getChallengeProfiles.mockReset().mockResolvedValue({});
    mockApi.getScenarios.mockReset().mockResolvedValue(invalid({ success: true, scenarios: {}, templates: [] }));
    mockApi.getTitleProfile.mockReset().mockResolvedValue(null);
    mockApi.getChallengeOverrides.mockReset().mockResolvedValue({ exposure: 50 });
    mockApi.replaceChallengeOverrides.mockReset().mockResolvedValue(true);
    window.api.checkScenario = invalid(jest.fn(async () => ({ success: true })));
    window.api.saveScenario = invalid(jest.fn(async () => ({ success: true })));
});

// The change event is a native listener: flush the render it causes before the next step reads state.
const pick = (select: HTMLSelectElement, value: string) => act(() => pickOption(select, value));
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
const asked = () => screen.queryByText('app.settingsDiscardTitle') !== null;
const exposureInput = () => screen.getByLabelText<HTMLInputElement>(/^app\.exposure/);

const openSettings = async () => {
    const view = render(<SettingsModal isOpen onClose={onClose} />);
    await screen.findByRole('button', { name: 'app.addTitleTagRule' });
    await screen.findByRole('button', { name: 'app.sbNew' });
    await waitFor(() => expect(exposureInput().value).toBe('70'));
    return view;
};

describe('SettingsModal — dismissing', () => {
    test('a no-edit open closes without asking, even after background refetches', async () => {
        await openSettings();
        act(() => fireSettingsChanged({ app: { ...APP_SETTINGS } }));
        await act(async () => {});

        click('app.cancel');
        expect(asked()).toBe(false);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    test('an edit asks first: Keep editing stays, Discard closes; Escape asks the same', async () => {
        await openSettings();
        fireEvent.change(exposureInput(), { target: { value: '80' } });

        click('app.cancel');
        expect(asked()).toBe(true);
        expect(onClose).not.toHaveBeenCalled();
        click('app.settingsKeepEditing');
        expect(asked()).toBe(false);
        expect(exposureInput().value).toBe('80');

        fireEvent.keyDown(document, { key: 'Escape' });
        expect(asked()).toBe(true);
        click('app.settingsDiscard');
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    test('an edit that is undone does not ask', async () => {
        await openSettings();
        fireEvent.change(exposureInput(), { target: { value: '80' } });
        fireEvent.change(exposureInput(), { target: { value: '70' } });

        click('app.cancel');
        expect(asked()).toBe(false);
        expect(onClose).toHaveBeenCalled();
    });

    test('an edited title rule asks, and so does a language change', async () => {
        await openSettings();
        click('app.addTitleTagRule');
        click('app.cancel');
        expect(asked()).toBe(true);
        click('app.settingsKeepEditing');

        const language = screen.getByLabelText<HTMLSelectElement>(/^app\.language/);
        pick(language, 'lv');
        click('app.cancel');
        expect(asked()).toBe(true);
    });

    test('a failed title-rules load still guards the form edits, and guards nothing without them', async () => {
        mockApi.getTitleRules.mockReset().mockRejectedValue(new Error('disk'));
        render(<SettingsModal isOpen onClose={onClose} />);
        await screen.findByText('app.titleTagRulesLoadError');
        await waitFor(() => expect(exposureInput().value).toBe('70'));

        click('app.cancel');
        expect(onClose).toHaveBeenCalledTimes(1);

        onClose.mockClear();
        fireEvent.change(exposureInput(), { target: { value: '80' } });
        click('app.cancel');
        expect(asked()).toBe(true);
    });

    test('nothing is guarded while the form is still loading', async () => {
        mockApi.getSettingsSchema.mockReset().mockReturnValue(new Promise(() => {}));
        render(<SettingsModal isOpen onClose={onClose} />);
        await screen.findByText('common.loading');

        fireEvent.keyDown(document, { key: 'Escape' });
        expect(asked()).toBe(false);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    test('a chosen-photos list removed while the modal is open is not an unsaved edit', async () => {
        mockApi.getTitleRules
            .mockReset()
            .mockResolvedValue(invalid([{ title: 'Tagged', mustIncludeTags: ['hat'], chosenPhotos: [PHOTO] }]));
        await openSettings();
        act(() => announceChosenPhotosCleared());

        click('app.cancel');
        expect(asked()).toBe(false);
        expect(onClose).toHaveBeenCalled();
    });
});

describe('SettingsModal — after a Save that failed partway', () => {
    test('rules that landed are not asked about; the rejected language still is until it is put back', async () => {
        mockApi.setSetting.mockImplementation(async (key) => key !== 'language');
        await openSettings();
        click('app.addTitleTagRule');
        pick(screen.getByLabelText<HTMLSelectElement>(/^app\.language/), 'lv');

        click('app.save');
        await screen.findByText('app.settingsSaveError');
        expect(mockApi.setTitleRules).toHaveBeenCalledTimes(1);
        expect(onClose).not.toHaveBeenCalled();

        click('app.cancel');
        expect(asked()).toBe(true);
        click('app.settingsKeepEditing');

        pick(screen.getByLabelText<HTMLSelectElement>(/^app\.language/), 'en');
        click('app.cancel');
        expect(asked()).toBe(false);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    test('Discard keeps the theme that was saved when another key was rejected', async () => {
        mockApi.setGlobalDefault.mockResolvedValue(false);
        await openSettings();
        pick(screen.getByLabelText<HTMLSelectElement>(/^app\.theme/), 'dark');
        fireEvent.change(exposureInput(), { target: { value: '80' } });

        click('app.save');
        await screen.findByText('app.settingsSaveError');
        expect(mockApi.setSetting).toHaveBeenCalledWith('theme', 'dark');

        click('app.cancel');
        click('app.settingsDiscard');
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });

    test("Discard puts the old theme back when the theme's own write was refused", async () => {
        mockApi.setSetting.mockResolvedValue(false);
        await openSettings();
        pick(screen.getByLabelText<HTMLSelectElement>(/^app\.theme/), 'dark');
        expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

        click('app.save');
        await screen.findByText('app.settingsSaveError');

        click('app.cancel');
        click('app.settingsDiscard');
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    });
});

describe('SettingsModal — work Save would drop', () => {
    // A valid zone is added when the input loses focus (as Save's click does), so only text that is not a zone is
    // still un-added by the time Save asks.
    const typeTimezone = () => {
        fireEvent.click(screen.getByRole('button', { name: 'app.addCustomTimezone' }));
        fireEvent.change(screen.getByPlaceholderText('app.timezonePlaceholder'), { target: { value: 'Not/A/Zone' } });
    };
    const editScenario = async () => {
        click('app.sbNew');
        await screen.findByLabelText('app.sbName');
        fireEvent.change(screen.getByLabelText('app.sbName'), { target: { value: 'Draft' } });
    };

    test('an un-added timezone is listed in one confirm; Keep editing writes nothing', async () => {
        await openSettings();
        fireEvent.change(exposureInput(), { target: { value: '80' } });
        typeTimezone();

        click('app.save');
        expect(screen.getByText('app.settingsDropTitle')).toBeTruthy();
        expect(screen.getByText('app.settingsDropTimezone')).toBeTruthy();
        expect(screen.queryByText('app.settingsDropScenario')).toBeNull();
        click('app.settingsKeepEditing');
        expect(mockApi.setGlobalDefault).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
    });

    test('with an unsaved scenario draft as well, one confirm lists both; Save without them saves and closes', async () => {
        await openSettings();
        fireEvent.change(exposureInput(), { target: { value: '80' } });
        typeTimezone();
        await editScenario();

        click('app.save');
        expect(screen.getAllByText('app.settingsDropTitle')).toHaveLength(1);
        expect(screen.getByText('app.settingsDropTimezone')).toBeTruthy();
        expect(screen.getByText('app.settingsDropScenario')).toBeTruthy();

        click('app.settingsSaveWithout');
        await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
        expect(mockApi.setGlobalDefault).toHaveBeenCalledWith('exposure', 80);
    });

    test('a scenario draft asks on dismiss; saving the scenario first means nothing is asked', async () => {
        await openSettings();
        await editScenario();
        // The builder has a Cancel of its own; the modal's is the last one.
        fireEvent.click(screen.getAllByRole('button', { name: 'app.cancel' }).at(-1) as HTMLElement);
        expect(asked()).toBe(true);
        click('app.settingsKeepEditing');

        click('app.sbSave');
        await waitFor(() => expect(screen.queryByLabelText('app.sbName')).toBeNull());
        // The builder's closing report runs as an effect cleanup, which Preact defers by up to its 35 ms
        // frame fallback after it unmounts; wait out more than that.
        await act(() => new Promise((resolve) => setTimeout(resolve, 50)));

        click('app.save');
        expect(screen.queryByText('app.settingsDropTitle')).toBeNull();
        await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
        expect(asked()).toBe(false);
    });

    test('closing and reopening after a dirty draft starts clean', async () => {
        const { rerender } = await openSettings();
        await editScenario();

        rerender(<SettingsModal isOpen={false} onClose={onClose} />);
        rerender(<SettingsModal isOpen onClose={onClose} />);
        await screen.findByRole('button', { name: 'app.sbNew' });
        await waitFor(() => expect(exposureInput().value).toBe('70'));

        click('app.cancel');
        expect(asked()).toBe(false);
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});

describe('ChallengeSettingsModal — dismissing', () => {
    const openChallenge = async () => {
        const view = render(<ChallengeSettingsModal isOpen onClose={onClose} challengeId="1" challengeTitle="One" />);
        await waitFor(() => expect(exposureInput().value).toBe('50'));
        return view;
    };

    test('a no-edit open closes without asking', async () => {
        await openChallenge();
        click('app.cancel');
        expect(asked()).toBe(false);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    test('an edit asks first; Keep editing stays, Discard closes; Escape asks the same', async () => {
        await openChallenge();
        fireEvent.change(exposureInput(), { target: { value: '60' } });

        click('app.cancel');
        expect(asked()).toBe(true);
        click('app.settingsKeepEditing');
        expect(onClose).not.toHaveBeenCalled();

        fireEvent.keyDown(document, { key: 'Escape' });
        expect(asked()).toBe(true);
        click('app.settingsDiscard');
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    test('Save with edits saves without asking', async () => {
        await openChallenge();
        fireEvent.change(exposureInput(), { target: { value: '60' } });

        click('app.save');
        await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
        expect(mockApi.replaceChallengeOverrides).toHaveBeenCalledWith('1', { exposure: 60 }, false);
        expect(asked()).toBe(false);
    });

    test('a failed load guards nothing', async () => {
        mockApi.getChallengeOverrides.mockReset().mockRejectedValue(new Error('ipc'));
        render(<ChallengeSettingsModal isOpen onClose={onClose} challengeId="1" challengeTitle="One" />);
        await screen.findByText('app.challengeOverridesLoadError');

        fireEvent.keyDown(document, { key: 'Escape' });
        expect(asked()).toBe(false);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    test('closing the modal drops the question: it does not reopen on it', async () => {
        const { rerender } = await openChallenge();
        fireEvent.change(exposureInput(), { target: { value: '60' } });
        click('app.cancel');
        expect(asked()).toBe(true);

        rerender(<ChallengeSettingsModal isOpen={false} onClose={onClose} challengeId="1" challengeTitle="One" />);
        rerender(<ChallengeSettingsModal isOpen onClose={onClose} challengeId="1" challengeTitle="One" />);
        await waitFor(() => expect(exposureInput().value).toBe('50'));
        expect(asked()).toBe(false);
    });
});
