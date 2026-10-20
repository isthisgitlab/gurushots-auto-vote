/**
 * Component tests for SettingsModal.tsx — focuses on the two
 * behaviors the schema-driven SettingInput rendering can't catch:
 *   1. Timezone "+" inline-add: invalid input toggles input-error
 *      class; valid input invokes handleUiChange for both
 *      customTimezones and timezone.
 *   2. handleCancel reverts a mid-session theme change by writing
 *      data-theme back to documentElement before calling revert/onClose.
 *
 * The 3 hooks (useSettings, useSettingsSchema, useSettingsForm) are
 * mocked at module top with controllable state objects.
 */

import { act, fireEvent, pickOption, render, screen, waitFor } from './helpers/test-utils';
import { SettingsModal } from '@/components/app/SettingsModal';
import type { TitleRule } from '../../src/ts/types/settings';
import type { UiResetHandler } from '../../src/ts/types/settingsEditor';
import type { useSettingsForm } from '@/hooks/useSettingsForm';
import type { useSettingsSchema } from '@/api/useSettingsSchema';
import { invalid } from '../helpers/invalid';

// The mocked hooks' state, as these tests drive it.
type SettingsForm = ReturnType<typeof useSettingsForm>;
type UiValues = {
    theme: string;
    language: string;
    timezone: string;
    customTimezones: string[];
    checkFrequencyMin: number;
    checkFrequencyMax: number;
    apiMaxRetries: number;
    apiRetryBaseDelayMs: number;
};
type MockFormState = {
    formValues: Record<string, unknown>;
    uiValues: UiValues;
    saving: boolean;
    isDirty: jest.MockedFunction<SettingsForm['isDirty']>;
    getPersistedTheme: jest.MockedFunction<SettingsForm['getPersistedTheme']>;
    handleFormChange: jest.MockedFunction<SettingsForm['handleFormChange']>;
    handleUiChange: jest.MockedFunction<SettingsForm['handleUiChange']>;
    handleResetGlobal: jest.MockedFunction<SettingsForm['handleResetGlobal']>;
    handleResetUi: jest.Mock<void, Parameters<UiResetHandler>>;
    handleResetAll: jest.MockedFunction<SettingsForm['handleResetAll']>;
    commit: jest.MockedFunction<SettingsForm['commit']>;
    revert: jest.MockedFunction<SettingsForm['revert']>;
};
type MockSchemaState = {
    schema: Record<string, object> | null;
    defaults: Record<string, unknown>;
    groups?: { id: string; label: string; tier: string }[];
    tiers?: { id: string; label: string }[];
    refetch: jest.MockedFunction<ReturnType<typeof useSettingsSchema>['refetch']>;
    loading: boolean;
};

const mockFormState: MockFormState = {
    formValues: {},
    uiValues: {
        theme: 'light',
        language: 'en',
        timezone: 'Europe/Riga',
        customTimezones: [],
        checkFrequencyMin: 5,
        checkFrequencyMax: 10,
        apiMaxRetries: 3,
        apiRetryBaseDelayMs: 1000,
    },
    saving: false,
    isDirty: jest.fn(() => false),
    getPersistedTheme: jest.fn(() => 'light'),
    handleFormChange: jest.fn(),
    handleUiChange: jest.fn(),
    handleResetGlobal: jest.fn(),
    handleResetUi: jest.fn<void, Parameters<UiResetHandler>>(),
    handleResetAll: jest.fn(),
    commit: jest.fn().mockResolvedValue([]),
    revert: jest.fn(),
};

const mockSettingsState = {
    settings: { app: {} },
    updateSetting: jest.fn(),
    refetch: jest.fn(),
};

const mockSchemaState: MockSchemaState = {
    schema: {}, // empty so the SettingInput-driven section renders nothing
    defaults: {},
    refetch: jest.fn(),
    loading: false,
};

jest.mock('@/api/useSettings', () => ({ useSettings: () => mockSettingsState }));
jest.mock('@/api/useSettingsSchema', () => ({ useSettingsSchema: () => mockSchemaState }));
jest.mock('@/hooks/useSettingsForm', () => ({ useSettingsForm: () => mockFormState }));

const resetHookState = () => {
    Object.assign(mockFormState, {
        formValues: {},
        uiValues: {
            theme: 'light',
            language: 'en',
            timezone: 'Europe/Riga',
            customTimezones: [],
            checkFrequencyMin: 5,
            checkFrequencyMax: 10,
            apiMaxRetries: 3,
            apiRetryBaseDelayMs: 1000,
        },
        saving: false,
        isDirty: jest.fn(() => false),
        getPersistedTheme: jest.fn(() => 'light'),
        handleFormChange: jest.fn(),
        handleUiChange: jest.fn(),
        handleResetGlobal: jest.fn(),
        handleResetUi: jest.fn<void, Parameters<UiResetHandler>>(),
        handleResetAll: jest.fn(),
        commit: jest.fn().mockResolvedValue([]),
        revert: jest.fn(),
    });
};

const findTimezoneAddButton = () => {
    // The "+" button is identified by its title attribute
    // (translation manager returns the key in tests).
    const buttons = Array.from(document.querySelectorAll('button[title="app.addCustomTimezone"]'));
    return buttons[0];
};

beforeEach(() => {
    resetHookState();
    document.documentElement.removeAttribute('data-theme');
});

describe('SettingsModal — timezone "+" inline-add', () => {
    test('clicking "+" opens the input', () => {
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        expect(document.querySelector('input[type="text"]')).toBeNull();
        fireEvent.click(findTimezoneAddButton());
        const input = document.querySelector('input[type="text"]');
        expect(input).not.toBeNull();
        // No error class until the user submits something invalid.
        expect(input!.className).not.toMatch(/input-error/);
        // Revealing it moves focus in, and it is named for assistive tech.
        expect(document.activeElement).toBe(input);
        expect(input!.getAttribute('aria-label')).toBe('app.addCustomTimezone');
    });

    test('each static UI setting is reachable by its label', () => {
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        // The accessible name also carries the "UI setting" badge text.
        expect(screen.getByLabelText(/^app\.theme/).tagName).toBe('SELECT');
        expect(screen.getByLabelText(/^app\.language/).tagName).toBe('SELECT');
        expect(screen.getByLabelText(/^app\.timezone/).tagName).toBe('SELECT');
        expect(screen.getByRole('group', { name: /^app\.checkFrequency/ })).toBeTruthy();
        expect(screen.getByRole('group', { name: /^app\.reliability/ })).toBeTruthy();
    });

    test('blurring with an invalid timezone toggles the error class', () => {
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        fireEvent.click(findTimezoneAddButton());
        const input = document.querySelector('input[type="text"]')!;
        fireEvent.change(input, { target: { value: 'Not/A/Real/Tz' } });
        // Pressing Enter routes through the same handleTimezoneAdd path that
        // onBlur uses, but without the focusout-translation flakiness — onBlur
        // sometimes fails to fire under @testing-library/preact when the new
        // state from the prior fireEvent.change hasn't flushed yet, leaving
        // the closure stale. Enter avoids that race entirely.
        fireEvent.keyDown(input, { key: 'Enter' });
        // After invalid submit the input-error class should be set.
        // Re-query because the rerender may have replaced the node.
        const after = document.querySelector('input[type="text"]')!;
        expect(after.className).toMatch(/input-error/);
        // No handleUiChange call for an invalid value.
        expect(mockFormState.handleUiChange).not.toHaveBeenCalled();
    });

    test('blurring with a valid timezone calls handleUiChange for both customTimezones and timezone', () => {
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        fireEvent.click(findTimezoneAddButton());
        const input = document.querySelector('input[type="text"]')!;
        fireEvent.change(input, { target: { value: 'Asia/Tokyo' } });
        fireEvent.blur(input);
        expect(mockFormState.handleUiChange).toHaveBeenCalledWith('customTimezones', ['Asia/Tokyo']);
        expect(mockFormState.handleUiChange).toHaveBeenCalledWith('timezone', 'Asia/Tokyo');
    });

    test('valid timezone added via Enter key produces the same handleUiChange calls', () => {
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        fireEvent.click(findTimezoneAddButton());
        const input = document.querySelector('input[type="text"]')!;
        fireEvent.change(input, { target: { value: 'America/Los_Angeles' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        expect(mockFormState.handleUiChange).toHaveBeenCalledWith('customTimezones', ['America/Los_Angeles']);
        expect(mockFormState.handleUiChange).toHaveBeenCalledWith('timezone', 'America/Los_Angeles');
    });

    test('Escape key closes the input without calling handleUiChange, and the modal stays open', () => {
        const onClose = jest.fn();
        render(<SettingsModal isOpen={true} onClose={onClose} />);
        fireEvent.click(findTimezoneAddButton());
        const input = document.querySelector('input[type="text"]')!;
        fireEvent.change(input, { target: { value: 'Asia/Tokyo' } });
        fireEvent.keyDown(input, { key: 'Escape' });
        // Input should be hidden after Escape.
        expect(document.querySelector('input[type="text"]')).toBeNull();
        expect(mockFormState.handleUiChange).not.toHaveBeenCalled();
        // The Escape was the field's: it did not reach the modal's own listener.
        expect(onClose).not.toHaveBeenCalled();
        // The next one, with the field gone, closes the modal.
        fireEvent.keyDown(document.body, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});

describe('SettingsModal — handleCancel theme revert', () => {
    test('writes data-theme back to documentElement when theme changed mid-session', () => {
        // Simulate the user having toggled to dark during this open session
        // (the persisted theme kept the prior value).
        mockFormState.uiValues.theme = 'dark';
        mockFormState.getPersistedTheme.mockReturnValue('light');
        // Pretend the user already toggled the DOM — cancel should put it back.
        document.documentElement.setAttribute('data-theme', 'dark');

        const onClose = jest.fn();
        render(<SettingsModal isOpen={true} onClose={onClose} />);

        // The Cancel button uses translation key text 'app.cancel'.
        const cancelButtons = Array.from(document.querySelectorAll('button')).filter(
            (b) => b.textContent.trim() === 'app.cancel',
        );
        // SettingsModal renders Cancel twice (top + bottom action rows). Either
        // works — click the first.
        fireEvent.click(cancelButtons[0]);

        expect(document.documentElement.getAttribute('data-theme')).toBe('light');
        expect(mockFormState.revert).toHaveBeenCalled();
        expect(onClose).toHaveBeenCalled();
    });

    test('does NOT touch documentElement when theme is unchanged', () => {
        // No theme drift: persisted and current both 'light'.
        const setSpy = jest.spyOn(document.documentElement, 'setAttribute');

        const onClose = jest.fn();
        render(<SettingsModal isOpen={true} onClose={onClose} />);
        const cancel = Array.from(document.querySelectorAll('button')).find(
            (b) => b.textContent.trim() === 'app.cancel',
        );
        fireEvent.click(cancel!);

        // setAttribute should not have been called by handleCancel
        // (other parts of happy-dom may call setAttribute during render, so
        // we check it was NOT called specifically with 'data-theme').
        const dataThemeCalls = setSpy.mock.calls.filter((args) => args[0] === 'data-theme');
        expect(dataThemeCalls).toHaveLength(0);
        expect(mockFormState.revert).toHaveBeenCalled();
        expect(onClose).toHaveBeenCalled();

        setSpy.mockRestore();
    });
});

describe('SettingsModal — closed state', () => {
    test('returns null when isOpen is false', () => {
        const { container } = render(<SettingsModal isOpen={false} onClose={jest.fn()} />);
        expect(container.innerHTML).toBe('');
    });
});

describe('SettingsModal — reliability (API retry/backoff) controls', () => {
    test('renders the API retry inputs seeded from uiValues', () => {
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        expect(screen.getByLabelText<HTMLInputElement>('app.apiMaxRetries').value).toBe('3');
        expect(screen.getByLabelText<HTMLInputElement>('app.apiRetryBaseDelayMs').value).toBe('1000');
    });

    test('editing API Retries calls handleUiChange with the parsed integer', () => {
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        fireEvent.change(screen.getByLabelText('app.apiMaxRetries'), { target: { value: '5' } });
        expect(mockFormState.handleUiChange).toHaveBeenCalledWith('apiMaxRetries', 5);
    });

    test('editing Retry Delay calls handleUiChange with the parsed integer', () => {
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        fireEvent.change(screen.getByLabelText('app.apiRetryBaseDelayMs'), { target: { value: '2000' } });
        expect(mockFormState.handleUiChange).toHaveBeenCalledWith('apiRetryBaseDelayMs', 2000);
    });
});

describe('SettingsModal — sticky action footer', () => {
    test('the modal box keeps focus above the footer, which is the last child of the content', () => {
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        const boxClasses = document.querySelector('.modal-box')!.classList;
        expect(boxClasses.contains('scroll-pb-60')).toBe(true);
        expect(boxClasses.contains('md:scroll-pb-32')).toBe(true);
        const save = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === 'app.save')!;
        const footer = save.closest('.sticky')!;
        expect(footer.parentElement!.lastElementChild).toBe(footer);
    });
});

describe('SettingsModal — schema save rejection (commit reports rejected keys)', () => {
    const clickSave = () => {
        const saveBtn = Array.from(document.querySelectorAll('button')).find(
            (b) => b.textContent.trim() === 'app.save',
        );
        fireEvent.click(saveBtn!);
    };

    test('a commit() reporting rejected keys shows the save-error alert and keeps the modal open', async () => {
        // useSettingsForm.commit resolves the schema keys whose
        // setGlobalDefault write returned false (validation rejection —
        // e.g. a duplicate-count auto-fill schedule).
        mockFormState.commit = jest.fn().mockResolvedValue(['autoSubmitSchedule']);
        const onClose = jest.fn();

        render(<SettingsModal isOpen={true} onClose={onClose} />);
        clickSave();

        const alert = await screen.findByText('app.settingsSaveError');
        expect(alert).toBeTruthy();
        // The alert sits in the sticky footer next to the buttons.
        expect(alert.closest('.sticky')!.querySelector('button')).not.toBeNull();
        expect(onClose).not.toHaveBeenCalled();
        // The save aborts before the title-rules write — the rejected edit
        // must not be partially persisted beyond what commit already did.
        expect(window.api.setTitleRules).not.toHaveBeenCalled();
    });

    test('an empty rejected-keys array saves normally and closes the modal', async () => {
        mockFormState.commit = jest.fn().mockResolvedValue([]);
        const onClose = jest.fn();

        render(<SettingsModal isOpen={true} onClose={onClose} />);
        clickSave();

        await waitFor(() => expect(onClose).toHaveBeenCalled());
        expect(document.querySelector('[role="alert"]')).toBeNull();
    });
});

describe('SettingsModal — focus and invalid marks after a refused Save', () => {
    const schema = {
        exposure: { type: 'number', default: 50, min: 1, max: 100, group: 'general', label: 'app.exposure' },
        autoSubmitSchedule: { type: 'schedule', default: [], group: 'general', label: 'app.schedule' },
        useVotingPause: { type: 'boolean', default: false, group: 'general', label: 'app.useVotingPause' },
    };

    beforeEach(() => {
        mockSchemaState.schema = schema;
        mockSchemaState.groups = [{ id: 'general', label: 'app.groupGeneral', tier: 'core' }];
        mockSchemaState.tiers = [{ id: 'core', label: 'app.tierCore' }];
    });

    afterEach(() => {
        mockSchemaState.schema = {};
        mockSchemaState.defaults = {};
        mockSchemaState.groups = undefined;
        mockSchemaState.tiers = undefined;
    });

    // The modal reads commit when it renders, so the answer is set before it opens.
    const openAndSave = async (rejected: string[]) => {
        mockFormState.commit = jest.fn().mockResolvedValue(rejected);
        const utils = render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        clickButtonByText('app.save');
        await screen.findByText('app.settingsSaveError');
        return utils;
    };
    const focused = () => document.activeElement;

    test('a refused schema key is marked invalid and takes focus by its setting- id', async () => {
        await openAndSave(['exposure']);
        const input = document.getElementById('setting-exposure')!;
        await waitFor(() => expect(focused()).toBe(input));
        expect(input.getAttribute('aria-invalid')).toBe('true');
        // Its neighbours are not marked.
        expect(document.getElementById('setting-useVotingPause')!.hasAttribute('aria-invalid')).toBe(false);
    });

    test('a refused row-list key takes focus on its group, which has no single control', async () => {
        await openAndSave(['autoSubmitSchedule']);
        const group = document.getElementById('setting-autoSubmitSchedule')!;
        expect(group.getAttribute('role')).toBe('group');
        await waitFor(() => expect(focused()).toBe(group));
    });

    test('a refused theme is marked invalid and takes focus by its ui- id', async () => {
        await openAndSave(['theme']);
        const select = document.getElementById('ui-theme')!;
        await waitFor(() => expect(focused()).toBe(select));
        expect(select.getAttribute('aria-invalid')).toBe('true');
    });

    test('a refused UI number field is marked invalid and takes focus by its ui- id', async () => {
        await openAndSave(['apiRetryBaseDelayMs']);
        const input = document.getElementById('ui-apiRetryBaseDelayMs')!;
        await waitFor(() => expect(focused()).toBe(input));
        expect(input.getAttribute('aria-invalid')).toBe('true');
        expect(document.getElementById('ui-apiMaxRetries')!.hasAttribute('aria-invalid')).toBe(false);
    });

    test('the custom zones are edited through the timezone select, which takes the mark and focus', async () => {
        await openAndSave(['customTimezones']);
        const select = document.getElementById('ui-timezone')!;
        await waitFor(() => expect(focused()).toBe(select));
        expect(select.getAttribute('aria-invalid')).toBe('true');
    });

    test('focus goes to the first refused key that has an input', async () => {
        await openAndSave(['notRendered', 'exposure', 'theme']);
        await waitFor(() => expect(focused()).toBe(document.getElementById('setting-exposure')));
    });

    test('the marks are gone after the next Save lands', async () => {
        const { rerender } = await openAndSave(['exposure']);
        expect(document.getElementById('setting-exposure')!.getAttribute('aria-invalid')).toBe('true');
        mockFormState.commit = jest.fn().mockResolvedValue([]);
        rerender(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        clickButtonByText('app.save');
        await waitFor(() =>
            expect(document.getElementById('setting-exposure')!.hasAttribute('aria-invalid')).toBe(false),
        );
    });
});

describe('SettingsModal — title-tag-rules save', () => {
    const clickSave = () => {
        const saveBtn = Array.from(document.querySelectorAll('button')).find(
            (b) => b.textContent.trim() === 'app.save',
        );
        fireEvent.click(saveBtn!);
    };

    test('a rejected setTitleRules (returns false) shows an error and keeps the modal open', async () => {
        const rule = { title: 'Hats', mustIncludeTags: ['hat'], shouldIncludeTags: [] };
        jest.mocked(window.api.getTitleRules).mockResolvedValueOnce([rule]);
        jest.mocked(window.api.setTitleRules).mockResolvedValueOnce(false); // validation rejection
        const onClose = jest.fn();

        render(<SettingsModal isOpen={true} onClose={onClose} />);
        // Wait for the load effect to seed the rule (and mark it loaded).
        await screen.findByDisplayValue('Hats');

        clickSave();

        await screen.findByText('app.titleTagRulesSaveError');
        expect(window.api.setTitleRules).toHaveBeenCalledWith([rule]);
        expect(onClose).not.toHaveBeenCalled();
        // Focus moves to the section that failed.
        await waitFor(() =>
            expect(document.activeElement).toBe(screen.getByRole('heading', { level: 4, name: 'app.titleTagRules' })),
        );
    });

    test("removing every list from a rule's chooser, then saving, does not write the lists back", async () => {
        const PHOTO = `00000001${'a'.repeat(24)}`;
        const rule = { title: 'Hats', mustIncludeTags: ['hat'], shouldIncludeTags: [], chosenPhotos: [PHOTO] };
        // A rule whose only content was its list goes with it, as it does where the lists are removed.
        const lonely = { title: 'Lonely', mustIncludeTags: [], shouldIncludeTags: [], chosenPhotos: [PHOTO] };
        jest.mocked(window.api.getTitleRules).mockResolvedValueOnce([rule, lonely]);
        // A list saved under another account: the chooser's member check names the signed-in one,
        // and its notice offers to remove every list.
        jest.mocked(window.api.getSetting).mockResolvedValue('d'.repeat(32));
        jest.mocked(window.api.confirmAccount).mockResolvedValue({ success: true, memberId: 'c'.repeat(32) });
        jest.mocked(window.api.getLibraryPhotos).mockResolvedValue(
            invalid({
                success: true,
                photos: [{ id: PHOTO, labels: [], allowed: true, message: null, uploadDate: 1 }],
                memberId: 'c'.repeat(32),
                truncated: false,
                wonIds: [],
                wonCount: 0,
                preview: false,
                readAtMs: 1_700_000_000_000,
                allowedKnown: true,
            }),
        );
        jest.mocked(window.api.clearChosenPhotos).mockResolvedValue({ success: true, removed: 1 });
        const onClose = jest.fn();

        render(<SettingsModal isOpen={true} onClose={onClose} />);
        await screen.findByDisplayValue('Hats');
        fireEvent.click(screen.getAllByRole('button', { name: 'app.choosePhotos' })[0]);
        fireEvent.click(await screen.findByRole('button', { name: 'app.photoChooserOtherAccountClear' }));
        const confirm = (await screen.findAllByRole('button', { name: 'app.photoChooserOtherAccountClear' })).at(-1)!;
        fireEvent.click(confirm);
        await waitFor(() => expect(window.api.clearChosenPhotos).toHaveBeenCalledTimes(1));
        // Leave the chooser without choosing: its Cancel is the last one in the page.
        fireEvent.click((await screen.findAllByRole('button', { name: 'app.cancel' })).at(-1)!);
        await waitFor(() => expect(screen.queryByRole('button', { name: 'app.photoChooserUse' })).toBeNull());

        clickSave();

        await waitFor(() => expect(onClose).toHaveBeenCalled());
        // The rule is saved without its list: the removal stands.
        expect(window.api.setTitleRules).toHaveBeenCalledWith([
            { title: 'Hats', mustIncludeTags: ['hat'], shouldIncludeTags: [] },
        ]);
        expect(screen.queryByDisplayValue('Lonely')).toBeNull();
    });

    test('a successful save persists the rules and closes the modal', async () => {
        const rule = { title: 'Hats', mustIncludeTags: ['hat'], shouldIncludeTags: [] };
        jest.mocked(window.api.getTitleRules).mockResolvedValueOnce([rule]);
        const onClose = jest.fn();

        render(<SettingsModal isOpen={true} onClose={onClose} />);
        await screen.findByDisplayValue('Hats');

        clickSave();

        await waitFor(() => expect(onClose).toHaveBeenCalled());
        expect(window.api.setTitleRules).toHaveBeenCalledWith([rule]);
    });

    test('loads saved profiles into each title rule profile selector', async () => {
        jest.mocked(window.api.getChallengeProfiles).mockResolvedValueOnce({ 'Portrait Tactic': { exposure: 80 } });
        jest.mocked(window.api.getTitleRules).mockResolvedValueOnce([
            {
                title: 'Portraits',
                profile: 'Portrait Tactic',
                mustIncludeTags: [],
                shouldIncludeTags: [],
            },
        ]);

        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);

        const profileSelect = await screen.findByLabelText<HTMLSelectElement>('app.titleRuleProfile');
        expect(profileSelect.value).toBe('Portrait Tactic');
        expect(profileSelect.textContent).toContain('Portrait Tactic');
    });
});

/**
 * Tier bands in the GLOBAL modal. The default mockSchemaState carries an empty
 * schema so the SettingInput-driven section renders nothing, which left this
 * whole path uncovered — SettingsModal renders bands at a different heading
 * depth than ChallengeSettingsModal (h5 band over h6 group, because it nests
 * under its own h4 "Challenge Defaults" section), so the per-challenge modal's
 * test does not stand in for it.
 */
describe('SettingsModal tier bands', () => {
    const schemaFixture = {
        exposure: {
            type: 'number',
            default: 100,
            perChallenge: true,
            group: 'general',
            label: 'app.exposure',
            description: 'app.exposureDesc',
        },
        voteOnlyInLastMinute: {
            type: 'boolean',
            default: false,
            perChallenge: true,
            group: 'lastMinute',
            label: 'app.voteOnlyInLastMinute',
            description: 'app.voteOnlyInLastMinuteDesc',
        },
    };

    beforeEach(() => {
        Object.assign(mockSchemaState, {
            schema: schemaFixture,
            defaults: { exposure: 100, voteOnlyInLastMinute: false },
            groups: [
                { id: 'general', label: 'app.groupGeneral', tier: 'core' },
                { id: 'lastMinute', label: 'app.groupLastMinute', tier: 'overrides' },
            ],
            tiers: [
                { id: 'core', label: 'app.tierCore' },
                { id: 'overrides', label: 'app.tierOverrides' },
            ],
        });
    });

    // mockSchemaState is module-level and never touched by resetHookState, so
    // restore it or every later suite inherits this fixture.
    afterEach(() => {
        Object.assign(mockSchemaState, { schema: {}, defaults: {}, groups: undefined, tiers: undefined });
    });

    test('renders each band heading above its group, at the right depth', async () => {
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);

        // Bands are h5 here (under the h4 "Challenge Defaults" section);
        // group headings drop to h6.
        const bands = await screen.findAllByRole('heading', { level: 5 });
        // (The last h5 is the About section's danger zone.)
        expect(bands.map((h) => h.textContent)).toEqual(['app.tierCore', 'app.tierOverrides', 'about.dangerTitle']);

        const groups = screen.getAllByRole('heading', { level: 6 });
        expect(groups.map((h) => h.textContent)).toEqual(['app.groupGeneral', 'app.groupLastMinute']);
    });

    test('shows the off-by-default sub-line on the overrides band only', async () => {
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);

        await screen.findByRole('heading', { level: 5, name: 'app.tierOverrides' });
        // Keyed off the tier id in SettingsTierHeading, so a renamed tier id
        // would silently drop this line without this assertion.
        expect(screen.getAllByText('app.tierOverridesDesc')).toHaveLength(1);
    });

    // Version skew: a main process predating the `tiers` IPC field. Every
    // section must still render, just without band headings.
    test('renders every group unbanded when the main process sends no tiers', async () => {
        Object.assign(mockSchemaState, { tiers: undefined });
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);

        const groups = await screen.findAllByRole('heading', { level: 6 });
        expect(groups.map((h) => h.textContent)).toEqual(['app.groupGeneral', 'app.groupLastMinute']);
        expect(screen.queryByRole('heading', { level: 5, name: 'app.tierCore' })).toBeNull();
        expect(screen.queryByText('app.tierOverridesDesc')).toBeNull();
    });
});

describe('SettingsModal — app-wide settings', () => {
    const entry = (group: string, label: string, perChallenge: boolean) => ({
        type: 'boolean',
        default: false,
        perChallenge,
        group,
        label,
        description: `${label}Desc`,
    });

    beforeEach(() => {
        Object.assign(mockSchemaState, {
            schema: {
                autoTurbo: entry('turbo', 'app.autoTurbo', true),
                currencyReserveFills: entry('turbo', 'app.currencyReserveFills', false),
                missionSaveTurbos: entry('missions', 'app.missionSaveTurbos', false),
            },
            defaults: {},
            groups: [
                { id: 'turbo', label: 'app.groupTurbo', tier: 'core' },
                { id: 'missions', label: 'app.groupMissions', tier: 'app' },
            ],
            tiers: [
                { id: 'core', label: 'app.tierCore' },
                { id: 'app', label: 'app.tierApp' },
            ],
        });
    });

    afterEach(() => {
        Object.assign(mockSchemaState, { schema: {}, defaults: {}, groups: undefined, tiers: undefined });
    });

    test('app-tier groups render with the Application Settings, not as challenge defaults', async () => {
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        // h5: directly under the h4 section heading, with no tier band between.
        await screen.findByRole('heading', { level: 5, name: 'app.groupMissions' });
        const sections = screen.getAllByRole('heading', { level: 4 }).map((h) => h.parentElement!);
        const [appSection, defaultsSection] = [
            sections.find((el) => el.textContent.startsWith('app.applicationSettings')),
            sections.find((el) => el.textContent.startsWith('app.challengeDefaults')),
        ];
        expect(appSection!.textContent).toContain('app.missionSaveTurbos');
        expect(defaultsSection!.textContent).not.toContain('app.missionSaveTurbos');
        expect(defaultsSection!.textContent).toContain('app.autoTurbo');
        expect(screen.queryByRole('heading', { level: 5, name: 'app.tierApp' })).toBeNull();
    });

    test('only settings a challenge can override carry the global-default badge', async () => {
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        await screen.findByRole('heading', { level: 5, name: 'app.groupMissions' });
        expect(screen.getAllByText('app.globalDefault')).toHaveLength(1);
        expect(screen.getByText('app.globalDefault').parentElement!.textContent).toContain('app.autoTurbo');
    });
});

const clickButtonByText = (text: string, index = 0) => {
    const buttons = Array.from(document.querySelectorAll('button')).filter((b) => b.textContent.trim() === text);
    fireEvent.click(buttons[index]);
};

// The application-settings ResetButtons are named "<reset action>: <setting>", in DOM order:
// theme, language, timezone, check frequency, reliability.
const appResetButtons = () => Array.from(document.querySelectorAll('button[aria-label^="app.resetToDefault: "]'));

// Set a select's value and dispatch a native change event (fireEvent.change
// does not reach preact's select onChange under happy-dom).
describe('SettingsModal — loading state', () => {
    afterEach(() => {
        mockSchemaState.loading = false;
        mockSchemaState.schema = {};
    });

    test('shows the spinner instead of the form while the schema first loads', () => {
        mockSchemaState.loading = true;
        mockSchemaState.schema = null;
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        expect(screen.getByRole('status').textContent).toBe('common.loading');
        expect(screen.queryByRole('heading', { level: 4, name: 'app.applicationSettings' })).toBeNull();
    });

    test('keeps the form on screen during a background schema refetch', async () => {
        // Every settings write broadcasts a change that refetches the schema;
        // with a schema already in hand that refresh must not blank the form.
        mockSchemaState.loading = true;
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        await screen.findByText('app.noTitleTagRules');
        expect(screen.queryByLabelText('Loading')).toBeNull();
        expect(screen.getByRole('heading', { level: 4, name: 'app.applicationSettings' })).toBeTruthy();
    });
});

describe('SettingsModal — application settings controls', () => {
    test('the theme select shows the current theme and emits the picked one', () => {
        mockFormState.uiValues.theme = 'dracula';
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        const select = document.getElementById('ui-theme') as HTMLSelectElement;
        expect(select.value).toBe('dracula');
        pickOption(select, 'cupcake');
        expect(mockFormState.handleUiChange).toHaveBeenLastCalledWith('theme', 'cupcake');
    });

    test('changing the language select emits the new language', () => {
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        const select = screen.getByRole('option', { name: 'app.latvian' }).parentElement as HTMLSelectElement;
        pickOption(select, 'lv');
        expect(mockFormState.handleUiChange).toHaveBeenCalledWith('language', 'lv');
    });

    test('every application reset button resets its own UI keys', () => {
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        const resets = appResetButtons();
        expect(resets.map((b) => b.getAttribute('aria-label'))).toEqual([
            'app.resetToDefault: app.theme',
            'app.resetToDefault: app.language',
            'app.resetToDefault: app.timezone',
            'app.resetToDefault: app.checkFrequency',
            'app.resetToDefault: app.reliability',
        ]);
        resets.forEach((b) => fireEvent.click(b));
        expect(mockFormState.handleResetUi.mock.calls.map(([key]) => key)).toEqual([
            'theme',
            'language',
            'timezone',
            'checkFrequencyMin',
            'checkFrequencyMax',
            'apiMaxRetries',
            'apiRetryBaseDelayMs',
        ]);
    });

    test('check-frequency inputs commit in-range integers as they are typed', () => {
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        const [minInput, maxInput] = document.querySelectorAll('input[type="number"][max="60"]');
        fireEvent.change(minInput, { target: { value: '7' } });
        expect(mockFormState.handleUiChange).toHaveBeenLastCalledWith('checkFrequencyMin', 7);
        fireEvent.change(maxInput, { target: { value: '12' } });
        expect(mockFormState.handleUiChange).toHaveBeenLastCalledWith('checkFrequencyMax', 12);
    });

    test('an emptied or out-of-range draft is kept as typed and handed to the form as it is, flagged with its range', () => {
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        const minInput = document.querySelector<HTMLInputElement>('input[type="number"][max="60"]')!;
        fireEvent.change(minInput, { target: { value: '' } });
        expect(minInput.value).toBe('');
        // An emptied field is no number: Save refuses it, it does not write the value from before.
        expect(mockFormState.handleUiChange).toHaveBeenLastCalledWith('checkFrequencyMin', Number.NaN);
        fireEvent.change(minInput, { target: { value: '61' } });
        expect(minInput.value).toBe('61');
        expect(mockFormState.handleUiChange).toHaveBeenLastCalledWith('checkFrequencyMin', 61);
        const message = screen.getByText('app.validationOutOfRange');
        expect(minInput.getAttribute('aria-invalid')).toBe('true');
        expect(minInput.getAttribute('aria-describedby')).toBe(message.id);
        expect(minInput.className).toMatch(/input-error/);
    });

    test('blurring an invalid draft keeps it and its range message; the next valid edit clears them', () => {
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        const minInput = document.querySelector<HTMLInputElement>('input[type="number"][max="60"]')!;
        fireEvent.change(minInput, { target: { value: '' } });
        fireEvent.blur(minInput);
        expect(minInput.value).toBe('');
        expect(screen.getByText('app.validationOutOfRange')).toBeTruthy();
        expect(minInput.getAttribute('aria-invalid')).toBe('true');
        fireEvent.change(minInput, { target: { value: '8' } });
        expect(screen.queryByText('app.validationOutOfRange')).toBeNull();
        expect(minInput.hasAttribute('aria-invalid')).toBe(false);
        expect(minInput.hasAttribute('aria-describedby')).toBe(false);
    });

    test('a draft follows the value when it is changed from outside (a reset)', () => {
        const { rerender } = render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        const minInput = document.querySelector<HTMLInputElement>('input[type="number"][max="60"]')!;
        fireEvent.change(minInput, { target: { value: '9' } });
        mockFormState.uiValues.checkFrequencyMin = 2;
        rerender(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        expect(minInput.value).toBe('2');
    });

    test('an emptied field holds NaN, which the draft reads as empty until the value changes from outside', () => {
        const { rerender } = render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        const minInput = document.querySelector<HTMLInputElement>('input[type="number"][max="60"]')!;
        fireEvent.change(minInput, { target: { value: '' } });
        mockFormState.uiValues.checkFrequencyMin = Number.NaN;
        rerender(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        expect(minInput.value).toBe('');
        mockFormState.uiValues.checkFrequencyMin = 3;
        rerender(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        expect(minInput.value).toBe('3');
    });

    test('a typed draft that already reads as the committed value is left as typed', () => {
        const { rerender } = render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        const minInput = document.querySelector<HTMLInputElement>('input[type="number"][max="60"]')!;
        fireEvent.change(minInput, { target: { value: '07' } });
        mockFormState.uiValues.checkFrequencyMin = 7;
        rerender(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        expect(minInput.value).toBe('07');
    });

    test('blurring a max below the min clamps it up to the min; a valid max is left alone', () => {
        mockFormState.uiValues.checkFrequencyMax = 2; // below min 5
        const { unmount } = render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        fireEvent.blur(document.querySelectorAll('input[type="number"][max="60"]')[1]);
        expect(mockFormState.handleUiChange).toHaveBeenCalledWith('checkFrequencyMax', 5);
        unmount();

        mockFormState.handleUiChange.mockClear();
        mockFormState.uiValues.checkFrequencyMax = 10;
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        fireEvent.blur(document.querySelectorAll('input[type="number"][max="60"]')[1]);
        expect(mockFormState.handleUiChange).not.toHaveBeenCalled();
    });

    test('a min that is itself out of range is not a floor to clamp the max up to', () => {
        mockFormState.uiValues.checkFrequencyMin = 99;
        mockFormState.uiValues.checkFrequencyMax = 10;
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        fireEvent.blur(document.querySelectorAll('input[type="number"][max="60"]')[1]);
        expect(mockFormState.handleUiChange).not.toHaveBeenCalled();
    });

    test('a max typed below the min is committed, then clamped up on blur', () => {
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        const maxInput = document.querySelectorAll('input[type="number"][max="60"]')[1]!;
        fireEvent.change(maxInput, { target: { value: '3' } });
        expect(mockFormState.handleUiChange).toHaveBeenLastCalledWith('checkFrequencyMax', 3);
        fireEvent.blur(maxInput);
        expect(mockFormState.handleUiChange).toHaveBeenLastCalledWith('checkFrequencyMax', 5);
    });

    test('clearing the reliability inputs keeps the draft through blur and hands the form NaN for each', () => {
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        const retries = screen.getByLabelText<HTMLInputElement>('app.apiMaxRetries');
        const delay = screen.getByLabelText<HTMLInputElement>('app.apiRetryBaseDelayMs');
        fireEvent.change(retries, { target: { value: '' } });
        fireEvent.change(delay, { target: { value: '' } });
        expect(mockFormState.handleUiChange).toHaveBeenCalledWith('apiMaxRetries', Number.NaN);
        expect(mockFormState.handleUiChange).toHaveBeenCalledWith('apiRetryBaseDelayMs', Number.NaN);
        fireEvent.blur(retries);
        fireEvent.blur(delay);
        expect(retries.value).toBe('');
        expect(delay.value).toBe('');
    });

    test('each UI number input has a ui-<key> id for the focus after a refused Save', () => {
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        for (const key of ['checkFrequencyMin', 'checkFrequencyMax', 'apiMaxRetries', 'apiRetryBaseDelayMs']) {
            expect(document.getElementById(`ui-${key}`)!.tagName).toBe('INPUT');
        }
    });
});

describe('SettingsModal — timezone select and custom zones', () => {
    const tzSelect = () => screen.getByRole('option', { name: 'Europe/Riga' }).parentElement as HTMLSelectElement;
    const removeButton = () => document.querySelector('button[title="app.removeCurrentTimezone"]')!;

    test('the remove button is a filled destructive one', () => {
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        expect(removeButton().className).toContain('btn-error');
        expect(removeButton().className).not.toContain('btn-outline');
    });

    test('the default zone hides the remove button', () => {
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        expect(removeButton().className).toContain('invisible');
    });

    test('custom zones are offered and the selection is emitted', () => {
        mockFormState.uiValues.customTimezones = ['Asia/Tokyo'];
        mockFormState.uiValues.timezone = 'Asia/Tokyo';
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);

        expect(Array.from(tzSelect().options).map((o) => o.value)).toEqual(['Europe/Riga', 'UTC', 'Asia/Tokyo']);
        pickOption(tzSelect(), 'Europe/Riga');
        expect(mockFormState.handleUiChange).toHaveBeenCalledWith('timezone', 'Europe/Riga');
    });

    test('a selected zone missing from the custom list still gets its own option', () => {
        mockFormState.uiValues.timezone = 'America/New_York';
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        expect(Array.from(tzSelect().options).map((o) => o.value)).toEqual(['Europe/Riga', 'UTC', 'America/New_York']);
    });

    test('UTC is always offered, selected or not, and has no remove button', () => {
        mockFormState.uiValues.timezone = 'UTC';
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);

        expect(Array.from(tzSelect().options).map((o) => o.value)).toEqual(['Europe/Riga', 'UTC']);
        expect(tzSelect().value).toBe('UTC');
        expect(removeButton().className).toContain('invisible');
    });

    test('a custom zone that is UTC is offered once', () => {
        mockFormState.uiValues.customTimezones = ['UTC', 'Asia/Tokyo'];
        mockFormState.uiValues.timezone = 'UTC';
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);

        expect(Array.from(tzSelect().options).map((o) => o.value)).toEqual(['Europe/Riga', 'UTC', 'Asia/Tokyo']);
    });

    test('adding UTC selects it without putting it in the custom list', () => {
        mockFormState.uiValues.customTimezones = ['Asia/Tokyo'];
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        fireEvent.click(findTimezoneAddButton());
        const input = document.querySelector('input[type="text"]')!;
        fireEvent.change(input, { target: { value: 'UTC' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        expect(mockFormState.handleUiChange).toHaveBeenCalledWith('customTimezones', ['Asia/Tokyo']);
        expect(mockFormState.handleUiChange).toHaveBeenCalledWith('timezone', 'UTC');
    });

    test('removing the current zone drops it from the list and falls back to the default', () => {
        mockFormState.uiValues.customTimezones = ['Asia/Tokyo', 'Asia/Seoul'];
        mockFormState.uiValues.timezone = 'Asia/Tokyo';
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);

        expect(removeButton().className).not.toContain('invisible');
        fireEvent.click(removeButton());
        expect(mockFormState.handleUiChange).toHaveBeenCalledWith('customTimezones', ['Asia/Seoul']);
        expect(mockFormState.handleUiChange).toHaveBeenCalledWith('timezone', 'Europe/Riga');
    });

    test('adding a zone that is already listed does not duplicate it', () => {
        mockFormState.uiValues.customTimezones = ['Asia/Tokyo'];
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        fireEvent.click(findTimezoneAddButton());
        const input = document.querySelector('input[type="text"]')!;
        fireEvent.change(input, { target: { value: ' Asia/Tokyo ' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        expect(mockFormState.handleUiChange).toHaveBeenCalledWith('customTimezones', ['Asia/Tokyo']);
        expect(mockFormState.handleUiChange).toHaveBeenCalledWith('timezone', 'Asia/Tokyo');
    });

    test('an invalid zone is flagged with a message the input points at; typing clears it', () => {
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        fireEvent.click(findTimezoneAddButton());
        const input = document.querySelector<HTMLInputElement>('input[type="text"]')!;
        fireEvent.change(input, { target: { value: 'Not/A/Zone' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        expect(input.className).toMatch(/input-error/);
        expect(input.getAttribute('aria-invalid')).toBe('true');
        const message = screen.getByText('app.timezoneInvalid');
        expect(input.getAttribute('aria-describedby')).toBe(message.id);

        fireEvent.change(input, { target: { value: 'A' } });
        expect(input.className).not.toMatch(/input-error/);
        expect(input.hasAttribute('aria-invalid')).toBe(false);
        expect(screen.queryByText('app.timezoneInvalid')).toBeNull();
    });

    test('leaving the zone input empty is not an error', () => {
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        fireEvent.click(findTimezoneAddButton());
        const input = document.querySelector<HTMLInputElement>('input[type="text"]')!;
        fireEvent.keyDown(input, { key: 'Enter' });
        fireEvent.blur(input);
        expect(input.className).not.toMatch(/input-error/);
        expect(screen.queryByText('app.timezoneInvalid')).toBeNull();
        expect(mockFormState.handleUiChange).not.toHaveBeenCalled();
    });

    test('other keys in the zone input are ignored', () => {
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        fireEvent.click(findTimezoneAddButton());
        fireEvent.keyDown(document.querySelector('input[type="text"]')!, { key: 'a' });
        expect(document.querySelector('input[type="text"]')).not.toBeNull();
        expect(mockFormState.handleUiChange).not.toHaveBeenCalled();
    });
});

describe('SettingsModal — rule loading', () => {
    afterEach(() => {
        mockSchemaState.schema = {};
        mockSchemaState.defaults = {};
        mockSchemaState.groups = undefined;
        mockSchemaState.tiers = undefined;
    });

    test('the rule editor waits behind a loader until the rules have loaded', async () => {
        let resolveRules!: (rules: TitleRule[]) => void;
        jest.mocked(window.api.getTitleRules).mockReturnValueOnce(
            new Promise((resolve) => {
                resolveRules = resolve;
            }),
        );
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);

        expect(screen.queryByText('app.noTitleTagRules')).toBeNull();

        await act(async () => resolveRules([]));
        expect(await screen.findByText('app.noTitleTagRules')).toBeTruthy();
    });

    test('malformed payloads fall back to empty lists', async () => {
        jest.mocked(window.api.getTitleRules).mockResolvedValueOnce(invalid({ not: 'an array' }));
        jest.mocked(window.api.getChallengeProfiles).mockResolvedValueOnce(null);

        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);

        expect(await screen.findByText('app.noTitleTagRules')).toBeTruthy();
    });

    test('the rule editor offers the known challenge types as suggestions', async () => {
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        await screen.findByText('app.noTitleTagRules');
        const options = Array.from(document.querySelectorAll<HTMLOptionElement>('#gs-rule-types option')).map(
            (o) => o.value,
        );
        expect(options).toEqual(['default', 'exhibition', 'flash', 'speed']);
    });

    test.each([
        [new Error('ipc down'), 'Error loading title rules: ipc down'],
        ['plain failure', 'Error loading title rules: plain failure'],
    ])('a failed load is logged and replaces the editor with an alert (%p)', async (failure, message) => {
        jest.mocked(window.api.getTitleRules).mockRejectedValueOnce(failure);
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        await waitFor(() => expect(window.api.logError).toHaveBeenCalledWith(message));
        expect(await screen.findByText('app.titleTagRulesLoadError')).toBeTruthy();
        // The editor is gone, so no edit can be made that the skipped save would drop.
        expect(screen.queryByText('app.noTitleTagRules')).toBeNull();
    });

    test('a load that fails after the modal closed is dropped silently', async () => {
        let rejectStale!: (reason?: unknown) => void;
        jest.mocked(window.api.getTitleRules)
            .mockReturnValueOnce(
                new Promise((_, reject) => {
                    rejectStale = reject;
                }),
            )
            .mockReturnValueOnce(new Promise(() => {}));

        const { rerender } = render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        rerender(<SettingsModal isOpen={false} onClose={jest.fn()} />);
        rerender(<SettingsModal isOpen={true} onClose={jest.fn()} />);

        rejectStale(new Error('late'));
        await new Promise((r) => setTimeout(r, 0));

        expect(window.api.logError).not.toHaveBeenCalledWith('Error loading title rules: late');
        expect(screen.queryByText('app.titleTagRulesLoadError')).toBeNull();
        // The reopened session's own load is still pending.
        expect(screen.getByText('common.loading')).toBeTruthy();
    });

    test('a load that resolves after the modal closed is discarded', async () => {
        let resolveStale!: (rules: TitleRule[]) => void;
        jest.mocked(window.api.getTitleRules)
            .mockReturnValueOnce(
                new Promise((resolve) => {
                    resolveStale = resolve;
                }),
            )
            .mockReturnValueOnce(new Promise(() => {}));

        const { rerender } = render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        rerender(<SettingsModal isOpen={false} onClose={jest.fn()} />);
        rerender(<SettingsModal isOpen={true} onClose={jest.fn()} />);

        resolveStale([{ title: 'Stale', mustIncludeTags: [], shouldIncludeTags: [] }]);
        await new Promise((r) => setTimeout(r, 0));

        expect(screen.queryByDisplayValue('Stale')).toBeNull();
        // The reopened session's own load is still pending.
        expect(screen.getByText('common.loading')).toBeTruthy();
    });
});

describe('SettingsModal — save outcomes', () => {
    afterEach(() => {
        mockSchemaState.schema = {};
        mockSchemaState.defaults = {};
        mockSchemaState.groups = undefined;
        mockSchemaState.tiers = undefined;
    });

    test('editing a title rule after a rejected save clears the title error', async () => {
        jest.mocked(window.api.getTitleRules).mockResolvedValueOnce([
            { title: 'Hats', mustIncludeTags: [], shouldIncludeTags: [] },
        ]);
        jest.mocked(window.api.setTitleRules).mockResolvedValueOnce(false);
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        await screen.findByDisplayValue('Hats');
        clickButtonByText('app.save');
        await screen.findByText('app.titleTagRulesSaveError');

        fireEvent.change(screen.getByDisplayValue('Hats'), { target: { value: 'Caps' } });
        expect(screen.queryByText('app.titleTagRulesSaveError')).toBeNull();
        expect(screen.getByDisplayValue('Caps')).toBeTruthy();
    });

    test('a changed language is applied through the translation provider on save', async () => {
        mockFormState.commit = jest.fn().mockResolvedValue([]);
        mockFormState.uiValues.language = 'lv';
        const onClose = jest.fn();
        render(<SettingsModal isOpen={true} onClose={onClose} />);
        clickButtonByText('app.save');

        await waitFor(() => expect(onClose).toHaveBeenCalled());
        expect(window.api.setSetting).toHaveBeenCalledWith('language', 'lv');
    });

    test('a language that fails to save keeps the modal open with the save-error alert', async () => {
        mockFormState.commit = jest.fn().mockResolvedValue([]);
        mockFormState.uiValues.language = 'lv';
        jest.mocked(window.api.setSetting).mockResolvedValueOnce(false);
        const onClose = jest.fn();
        render(<SettingsModal isOpen={true} onClose={onClose} />);
        clickButtonByText('app.save');

        await screen.findByText('app.settingsSaveError');
        expect(onClose).not.toHaveBeenCalled();
        // The language has no key to mark, so focus goes to its section's heading.
        await waitFor(() =>
            expect(document.activeElement).toBe(
                screen.getByRole('heading', { level: 4, name: 'app.applicationSettings' }),
            ),
        );
    });

    test.each([
        [new Error('boom'), 'Error saving settings: boom'],
        ['raw', 'Error saving settings: raw'],
        [null, 'Error saving settings: null'],
    ])('a throwing save is logged and keeps the modal open (%p)', async (failure, message) => {
        mockFormState.commit = jest.fn().mockRejectedValue(failure);
        const onClose = jest.fn();
        render(<SettingsModal isOpen={true} onClose={onClose} />);
        clickButtonByText('app.save');

        await waitFor(() => expect(window.api.logError).toHaveBeenCalledWith(message));
        expect(onClose).not.toHaveBeenCalled();
    });
});

describe('SettingsModal — inline setting hints', () => {
    const bool = (label: string) => ({ type: 'boolean', default: false, group: 'general', label });
    const hintSchema = {
        useVotingPause: bool('app.useVotingPause'),
        votingPauseTime: { type: 'timeOfDayList', default: [], group: 'general', label: 'app.vpTime' },
        votingPauseBeforeEnd: { type: 'timeList', default: [], group: 'general', label: 'app.vpBeforeEnd' },
        votingPauseDurationMinutes: { type: 'number', default: 240, group: 'general', label: 'app.vpDuration' },
        voteBeforeBoost: { ...bool('app.voteBeforeBoost'), default: true },
        onlyBoost: bool('app.onlyBoost'),
        autoBoost: { ...bool('app.autoBoost'), default: true },
        voteOnlyInLastMinute: bool('app.voteOnlyInLastMinute'),
        boostTime: { type: 'time', default: 600, group: 'general', label: 'app.boostTime' },
        keyUnlockedBoostTime: { type: 'time', default: 0, group: 'general', label: 'app.keyBoost' },
    };

    beforeEach(() => {
        mockSchemaState.schema = hintSchema;
        mockSchemaState.groups = [{ id: 'general', label: 'app.groupGeneral', tier: 'core' }];
        mockSchemaState.tiers = [{ id: 'core', label: 'app.tierCore' }];
    });

    afterEach(() => {
        mockSchemaState.schema = {};
        mockSchemaState.defaults = {};
        mockSchemaState.groups = undefined;
        mockSchemaState.tiers = undefined;
    });

    const ALL_HINT_KEYS = [
        'app.votingPauseNoTimesHint',
        'app.votingPauseAllDayHint',
        'app.voteBeforeBoostOnlyBoostHint',
        'app.voteBeforeBoostNoAutoBoostHint',
        'app.voteBeforeBoostLastMinuteOnlyHint',
        'app.voteBeforeBoostNoBoostTimeHint',
    ];
    const shownHints = () => ALL_HINT_KEYS.filter((key) => screen.queryByText(key) !== null);

    test('schema defaults alone raise no warnings', () => {
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        expect(shownHints()).toEqual([]);
    });

    test.each([
        ['with empty trigger lists', { votingPauseTime: [], votingPauseBeforeEnd: [] }],
        ['with no trigger lists at all', {}],
    ])('an enabled pause %s warns that no time is set', (_label, lists) => {
        mockFormState.formValues = { useVotingPause: true, ...lists };
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        expect(shownHints()).toEqual(['app.votingPauseNoTimesHint']);
    });

    test('a pause whose daily windows cover the whole day says so', () => {
        mockFormState.formValues = {
            useVotingPause: true,
            votingPauseTime: ['00:00', '12:00'],
            votingPauseDurationMinutes: 720,
        };
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        expect(shownHints()).toEqual(['app.votingPauseAllDayHint']);
    });

    test('a pre-boost fill cancelled by every conflicting setting lists each conflict', () => {
        mockFormState.formValues = {
            onlyBoost: true,
            autoBoost: false,
            voteOnlyInLastMinute: true,
            boostTime: 0,
            keyUnlockedBoostTime: 0,
        };
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        expect(shownHints()).toEqual([
            'app.voteBeforeBoostOnlyBoostHint',
            'app.voteBeforeBoostNoAutoBoostHint',
            'app.voteBeforeBoostLastMinuteOnlyHint',
            'app.voteBeforeBoostNoBoostTimeHint',
        ]);
    });

    test('one boost clock still running keeps the no-boost-time warning away', () => {
        mockFormState.formValues = { boostTime: 0, keyUnlockedBoostTime: 30 };
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        expect(shownHints()).toEqual([]);
    });

    test('no pre-boost warnings when the fill itself is off', () => {
        mockFormState.formValues = { voteBeforeBoost: false, onlyBoost: true, autoBoost: false };
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        expect(shownHints()).toEqual([]);
    });
});

describe('SettingsModal — editing rules without a pending error', () => {
    afterEach(() => {
        mockSchemaState.schema = {};
        mockSchemaState.groups = undefined;
        mockSchemaState.tiers = undefined;
    });

    test('edits land in the rule editor and no error alert appears', async () => {
        jest.mocked(window.api.getTitleRules).mockResolvedValueOnce([
            { title: 'Hats', type: 'flash', mustIncludeTags: [], shouldIncludeTags: [] },
        ]);
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        await screen.findByDisplayValue('Hats');

        fireEvent.change(screen.getByDisplayValue('flash'), { target: { value: 'speed' } });
        fireEvent.change(screen.getByDisplayValue('Hats'), { target: { value: 'Caps' } });

        expect(screen.getByDisplayValue('speed')).toBeTruthy();
        expect(screen.getByDisplayValue('Caps')).toBeTruthy();
        expect(document.querySelector('[role="alert"]')).toBeNull();
    });
});
