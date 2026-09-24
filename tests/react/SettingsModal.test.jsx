/**
 * Component tests for SettingsModal.jsx — focuses on the two
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

import { act, fireEvent, render, screen, waitFor } from './helpers/test-utils';
import { SettingsModal } from '@/components/app/SettingsModal';

const mockFormState = {
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
    originalUiValues: {
        theme: 'light',
        language: 'en',
        timezone: 'Europe/Riga',
        customTimezones: [],
        checkFrequencyMin: 5,
        checkFrequencyMax: 10,
        apiMaxRetries: 3,
        apiRetryBaseDelayMs: 1000,
    },
    handleFormChange: jest.fn(),
    handleUiChange: jest.fn(),
    handleResetGlobal: jest.fn(),
    handleResetUi: jest.fn(),
    handleResetAll: jest.fn(),
    commit: jest.fn().mockResolvedValue(undefined),
    revert: jest.fn(),
};

const mockSettingsState = {
    settings: {},
    updateSetting: jest.fn(),
    refetch: jest.fn(),
};

const mockSchemaState = {
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
        originalUiValues: {
            theme: 'light',
            language: 'en',
            timezone: 'Europe/Riga',
            customTimezones: [],
            checkFrequencyMin: 5,
            checkFrequencyMax: 10,
            apiMaxRetries: 3,
            apiRetryBaseDelayMs: 1000,
        },
        handleFormChange: jest.fn(),
        handleUiChange: jest.fn(),
        handleResetGlobal: jest.fn(),
        handleResetUi: jest.fn(),
        handleResetAll: jest.fn(),
        commit: jest.fn().mockResolvedValue(undefined),
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
        expect(input.className).not.toMatch(/input-error/);
        // Revealing it moves focus in, and it is named for assistive tech.
        expect(document.activeElement).toBe(input);
        expect(input.getAttribute('aria-label')).toBe('app.addCustomTimezone');
    });

    test('each static UI setting is reachable by its label', () => {
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        // The accessible name also carries the "UI setting" badge text.
        expect(screen.getByLabelText(/^app\.theme/).type).toBe('checkbox');
        expect(screen.getByLabelText(/^app\.language/).tagName).toBe('SELECT');
        expect(screen.getByLabelText(/^app\.timezone/).tagName).toBe('SELECT');
        expect(screen.getByRole('group', { name: /^app\.checkFrequency/ })).toBeTruthy();
        expect(screen.getByRole('group', { name: /^app\.reliability/ })).toBeTruthy();
    });

    test('blurring with an invalid timezone toggles the error class', () => {
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        fireEvent.click(findTimezoneAddButton());
        const input = document.querySelector('input[type="text"]');
        fireEvent.change(input, { target: { value: 'Not/A/Real/Tz' } });
        // Pressing Enter routes through the same handleTimezoneAdd path that
        // onBlur uses, but without the focusout-translation flakiness — onBlur
        // sometimes fails to fire under @testing-library/preact when the new
        // state from the prior fireEvent.change hasn't flushed yet, leaving
        // the closure stale. Enter avoids that race entirely.
        fireEvent.keyDown(input, { key: 'Enter' });
        // After invalid submit the input-error class should be set.
        // Re-query because the rerender may have replaced the node.
        const after = document.querySelector('input[type="text"]');
        expect(after.className).toMatch(/input-error/);
        // No handleUiChange call for an invalid value.
        expect(mockFormState.handleUiChange).not.toHaveBeenCalled();
    });

    test('blurring with a valid timezone calls handleUiChange for both customTimezones and timezone', () => {
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        fireEvent.click(findTimezoneAddButton());
        const input = document.querySelector('input[type="text"]');
        fireEvent.change(input, { target: { value: 'Asia/Tokyo' } });
        fireEvent.blur(input);
        expect(mockFormState.handleUiChange).toHaveBeenCalledWith('customTimezones', ['Asia/Tokyo']);
        expect(mockFormState.handleUiChange).toHaveBeenCalledWith('timezone', 'Asia/Tokyo');
    });

    test('valid timezone added via Enter key produces the same handleUiChange calls', () => {
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        fireEvent.click(findTimezoneAddButton());
        const input = document.querySelector('input[type="text"]');
        fireEvent.change(input, { target: { value: 'America/Los_Angeles' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        expect(mockFormState.handleUiChange).toHaveBeenCalledWith('customTimezones', ['America/Los_Angeles']);
        expect(mockFormState.handleUiChange).toHaveBeenCalledWith('timezone', 'America/Los_Angeles');
    });

    test('Escape key closes the input without calling handleUiChange', () => {
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        fireEvent.click(findTimezoneAddButton());
        const input = document.querySelector('input[type="text"]');
        fireEvent.change(input, { target: { value: 'Asia/Tokyo' } });
        fireEvent.keyDown(input, { key: 'Escape' });
        // Input should be hidden after Escape.
        expect(document.querySelector('input[type="text"]')).toBeNull();
        expect(mockFormState.handleUiChange).not.toHaveBeenCalled();
    });
});

describe('SettingsModal — handleCancel theme revert', () => {
    test('writes data-theme back to documentElement when theme changed mid-session', () => {
        // Simulate the user having toggled to dark during this open session
        // (originalUiValues kept the prior value).
        mockFormState.uiValues.theme = 'dark';
        mockFormState.originalUiValues.theme = 'light';
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
        // No theme drift: original and current both 'light'.
        const setSpy = jest.spyOn(document.documentElement, 'setAttribute');

        const onClose = jest.fn();
        render(<SettingsModal isOpen={true} onClose={onClose} />);
        const cancel = Array.from(document.querySelectorAll('button')).find(
            (b) => b.textContent.trim() === 'app.cancel',
        );
        fireEvent.click(cancel);

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
        expect(screen.getByLabelText('app.apiMaxRetries').value).toBe('3');
        expect(screen.getByLabelText('app.apiRetryBaseDelayMs').value).toBe('1000');
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

describe('SettingsModal — schema save rejection (commit reports rejected keys)', () => {
    const clickSave = () => {
        const saveBtn = Array.from(document.querySelectorAll('button')).find(
            (b) => b.textContent.trim() === 'app.save',
        );
        fireEvent.click(saveBtn);
    };

    test('a commit() reporting rejected keys shows the save-error alert and keeps the modal open', async () => {
        // useSettingsForm.commit resolves the schema keys whose
        // setGlobalDefault write returned false (validation rejection —
        // e.g. a duplicate-count auto-fill schedule).
        mockFormState.commit = jest.fn().mockResolvedValue(['autoFillSchedule']);
        const onClose = jest.fn();

        render(<SettingsModal isOpen={true} onClose={onClose} />);
        clickSave();

        const alert = await screen.findByText('app.settingsSaveError');
        expect(alert).toBeTruthy();
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

describe('SettingsModal — title-tag-rules save', () => {
    const clickSave = () => {
        const saveBtn = Array.from(document.querySelectorAll('button')).find(
            (b) => b.textContent.trim() === 'app.save',
        );
        fireEvent.click(saveBtn);
    };

    test('a rejected setTitleRules (returns false) shows an error and keeps the modal open', async () => {
        const rule = { title: 'Hats', mustIncludeTags: ['hat'], shouldIncludeTags: [] };
        window.api.getTitleRules.mockResolvedValueOnce([rule]);
        window.api.setTitleRules.mockResolvedValueOnce(false); // validation rejection
        const onClose = jest.fn();

        render(<SettingsModal isOpen={true} onClose={onClose} />);
        // Wait for the load effect to seed the rule (and mark it loaded).
        await screen.findByDisplayValue('Hats');

        clickSave();

        await screen.findByText('app.titleTagRulesSaveError');
        expect(window.api.setTitleRules).toHaveBeenCalledWith([rule]);
        expect(onClose).not.toHaveBeenCalled();
    });

    test('a successful save persists the rules and closes the modal', async () => {
        const rule = { title: 'Hats', mustIncludeTags: ['hat'], shouldIncludeTags: [] };
        window.api.getTitleRules.mockResolvedValueOnce([rule]);
        const onClose = jest.fn();

        render(<SettingsModal isOpen={true} onClose={onClose} />);
        await screen.findByDisplayValue('Hats');

        clickSave();

        await waitFor(() => expect(onClose).toHaveBeenCalled());
        expect(window.api.setTitleRules).toHaveBeenCalledWith([rule]);
    });

    test('loads saved profiles into each title rule profile selector', async () => {
        window.api.getChallengeProfiles.mockResolvedValueOnce({ 'Portrait Tactic': { exposure: 80 } });
        window.api.getTitleRules.mockResolvedValueOnce([
            {
                title: 'Portraits',
                profile: 'Portrait Tactic',
                mustIncludeTags: [],
                shouldIncludeTags: [],
            },
        ]);

        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);

        const profileSelect = await screen.findByLabelText('app.titleRuleProfile');
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
        expect(bands.map((h) => h.textContent)).toEqual(['app.tierCore', 'app.tierOverrides']);

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

const clickButtonByText = (text, index = 0) => {
    const buttons = Array.from(document.querySelectorAll('button')).filter((b) => b.textContent.trim() === text);
    fireEvent.click(buttons[index]);
};

// The application-settings ResetButtons carry no title attribute, in DOM order:
// theme, language, timezone, check frequency, reliability.
const appResetButtons = () =>
    Array.from(document.querySelectorAll('button:not([title])')).filter(
        (b) => b.className === 'btn btn-outline btn-sm' && b.querySelector('svg'),
    );

// Set a select's value and dispatch a native change event (fireEvent.change
// does not reach preact's select onChange under happy-dom).
const pickOption = (select, value) => {
    select.value = value;
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
};

describe('SettingsModal — loading state', () => {
    afterEach(() => {
        mockSchemaState.loading = false;
        mockSchemaState.schema = {};
    });

    test('shows the spinner instead of the form while the schema first loads', () => {
        mockSchemaState.loading = true;
        mockSchemaState.schema = null;
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        expect(screen.getByLabelText('Loading')).toBeTruthy();
        expect(screen.queryByText('app.applicationSettings')).toBeNull();
    });

    test('keeps the form on screen during a background schema refetch', async () => {
        // Every settings write broadcasts a change that refetches the schema;
        // with a schema already in hand that refresh must not blank the form.
        mockSchemaState.loading = true;
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        await screen.findByText('app.noTitleTagRules');
        expect(screen.queryByLabelText('Loading')).toBeNull();
        expect(screen.getByText('app.applicationSettings')).toBeTruthy();
    });
});

describe('SettingsModal — application settings controls', () => {
    test('the theme toggle emits dark when checked and light when unchecked', () => {
        const { unmount } = render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        fireEvent.click(document.querySelector('input.toggle'));
        expect(mockFormState.handleUiChange).toHaveBeenLastCalledWith('theme', 'dark');
        unmount();

        mockFormState.uiValues.theme = 'dark';
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        const toggle = document.querySelector('input.toggle');
        expect(toggle.checked).toBe(true);
        fireEvent.click(toggle);
        expect(mockFormState.handleUiChange).toHaveBeenLastCalledWith('theme', 'light');
    });

    test('changing the language select emits the new language', () => {
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        const select = screen.getByRole('option', { name: 'app.latvian' }).parentElement;
        pickOption(select, 'lv');
        expect(mockFormState.handleUiChange).toHaveBeenCalledWith('language', 'lv');
    });

    test('every application reset button resets its own UI keys', () => {
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        const resets = appResetButtons();
        expect(resets).toHaveLength(5);
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

    test('check-frequency inputs parse integers and fall back to 1 when cleared', () => {
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        const [minInput, maxInput] = document.querySelectorAll('input[type="number"][max="60"]');
        fireEvent.change(minInput, { target: { value: '7' } });
        expect(mockFormState.handleUiChange).toHaveBeenLastCalledWith('checkFrequencyMin', 7);
        fireEvent.change(minInput, { target: { value: '' } });
        expect(mockFormState.handleUiChange).toHaveBeenLastCalledWith('checkFrequencyMin', 1);
        fireEvent.change(maxInput, { target: { value: '12' } });
        expect(mockFormState.handleUiChange).toHaveBeenLastCalledWith('checkFrequencyMax', 12);
        fireEvent.change(maxInput, { target: { value: '' } });
        expect(mockFormState.handleUiChange).toHaveBeenLastCalledWith('checkFrequencyMax', 1);
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

    test('blurring an emptied max treats it as 1 and clamps to the min', () => {
        mockFormState.uiValues.checkFrequencyMax = '';
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        fireEvent.blur(document.querySelectorAll('input[type="number"][max="60"]')[1]);
        expect(mockFormState.handleUiChange).toHaveBeenCalledWith('checkFrequencyMax', 5);
    });

    test('clearing the reliability inputs falls back to 0 retries and a 1000 ms base delay', () => {
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        fireEvent.change(screen.getByLabelText('app.apiMaxRetries'), { target: { value: '' } });
        expect(mockFormState.handleUiChange).toHaveBeenLastCalledWith('apiMaxRetries', 0);
        fireEvent.change(screen.getByLabelText('app.apiRetryBaseDelayMs'), { target: { value: '' } });
        expect(mockFormState.handleUiChange).toHaveBeenLastCalledWith('apiRetryBaseDelayMs', 1000);
    });
});

describe('SettingsModal — timezone select and custom zones', () => {
    const tzSelect = () => screen.getByRole('option', { name: 'Europe/Riga' }).parentElement;
    const removeButton = () => document.querySelector('button[title="app.removeCurrentTimezone"]');

    test('the default zone hides the remove button', () => {
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        expect(removeButton().className).toContain('invisible');
    });

    test('custom zones are offered and the selection is emitted', () => {
        mockFormState.uiValues.customTimezones = ['Asia/Tokyo'];
        mockFormState.uiValues.timezone = 'Asia/Tokyo';
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);

        expect(Array.from(tzSelect().options).map((o) => o.value)).toEqual(['Europe/Riga', 'Asia/Tokyo']);
        pickOption(tzSelect(), 'Europe/Riga');
        expect(mockFormState.handleUiChange).toHaveBeenCalledWith('timezone', 'Europe/Riga');
    });

    test('a selected zone missing from the custom list still gets its own option', () => {
        mockFormState.uiValues.timezone = 'America/New_York';
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        expect(Array.from(tzSelect().options).map((o) => o.value)).toEqual(['Europe/Riga', 'America/New_York']);
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
        const input = document.querySelector('input[type="text"]');
        fireEvent.change(input, { target: { value: ' Asia/Tokyo ' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        expect(mockFormState.handleUiChange).toHaveBeenCalledWith('customTimezones', ['Asia/Tokyo']);
        expect(mockFormState.handleUiChange).toHaveBeenCalledWith('timezone', 'Asia/Tokyo');
    });

    test('typing after an invalid submit clears the error state', () => {
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        fireEvent.click(findTimezoneAddButton());
        fireEvent.keyDown(document.querySelector('input[type="text"]'), { key: 'Enter' }); // empty → invalid
        expect(document.querySelector('input[type="text"]').className).toMatch(/input-error/);

        fireEvent.change(document.querySelector('input[type="text"]'), { target: { value: 'A' } });
        expect(document.querySelector('input[type="text"]').className).not.toMatch(/input-error/);
    });

    test('other keys in the zone input are ignored', () => {
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        fireEvent.click(findTimezoneAddButton());
        fireEvent.keyDown(document.querySelector('input[type="text"]'), { key: 'a' });
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
        let resolveRules;
        window.api.getTitleRules.mockReturnValueOnce(
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
        window.api.getTitleRules.mockResolvedValueOnce({ not: 'an array' });
        window.api.getChallengeProfiles.mockResolvedValueOnce(null);

        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);

        expect(await screen.findByText('app.noTitleTagRules')).toBeTruthy();
    });

    test('the rule editor offers the known challenge types as suggestions', async () => {
        const { container } = render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        await screen.findByText('app.noTitleTagRules');
        const options = Array.from(container.querySelectorAll('#gs-rule-types option')).map((o) => o.value);
        expect(options).toEqual(['default', 'exhibition', 'flash', 'speed']);
    });

    test.each([
        [new Error('ipc down'), 'Error loading title rules: ipc down'],
        ['plain failure', 'Error loading title rules: plain failure'],
    ])('a failed load is logged and replaces the editor with an alert (%p)', async (failure, message) => {
        window.api.getTitleRules.mockRejectedValueOnce(failure);
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        await waitFor(() => expect(window.api.logError).toHaveBeenCalledWith(message));
        expect(screen.getByText('app.titleTagRulesLoadError')).toBeTruthy();
        // The editor is gone, so no edit can be made that the skipped save would drop.
        expect(screen.queryByText('app.noTitleTagRules')).toBeNull();
    });

    test('a load that fails after the modal closed is dropped silently', async () => {
        let rejectStale;
        window.api.getTitleRules
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
        let resolveStale;
        window.api.getTitleRules
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
        window.api.getTitleRules.mockResolvedValueOnce([{ title: 'Hats', mustIncludeTags: [], shouldIncludeTags: [] }]);
        window.api.setTitleRules.mockResolvedValueOnce(false);
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
        window.api.setSetting.mockResolvedValueOnce(false);
        const onClose = jest.fn();
        render(<SettingsModal isOpen={true} onClose={onClose} />);
        clickButtonByText('app.save');

        await screen.findByText('app.settingsSaveError');
        expect(onClose).not.toHaveBeenCalled();
    });

    test.each([
        [new Error('boom'), 'Error saving settings: boom'],
        ['raw', 'Error saving settings: raw'],
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
    const bool = (label) => ({ type: 'boolean', default: false, group: 'general', label });
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
        window.api.getTitleRules.mockResolvedValueOnce([
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
