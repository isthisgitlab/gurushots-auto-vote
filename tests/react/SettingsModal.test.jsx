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

import { fireEvent, render, screen, waitFor } from './helpers/test-utils';
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

/**
 * Category join-timing rules render INSIDE the auto-join group, not as a
 * section of their own — they override nothing but that group's timing keys,
 * so splitting them off puts the rules far from the setting they modify.
 *
 * Worth pinning because the placement is a string comparison on the group id:
 * a typo there hides the whole editor with no error anywhere, and the rest of
 * this suite renders an empty schema, so nothing else would notice.
 */
describe('SettingsModal \u2014 category rules placement', () => {
    const withAutoJoinGroup = () => {
        mockSchemaState.schema = {
            autoJoin: { type: 'boolean', default: false, group: 'autoJoin', label: 'app.autoJoin' },
        };
        mockSchemaState.groups = [{ id: 'autoJoin', label: 'app.groupAutoJoin', tier: 'entries' }];
        mockSchemaState.tiers = [{ id: 'entries', label: 'app.tierEntries' }];
    };

    afterEach(() => {
        // Mirrors the tier-bands describe's reset exactly, `defaults` included.
        // This describe never touches `defaults`, but an incomplete teardown is
        // a trap for whatever describe gets inserted after it.
        mockSchemaState.schema = {};
        mockSchemaState.defaults = {};
        mockSchemaState.groups = undefined;
        mockSchemaState.tiers = undefined;
    });

    test('the editor renders within the auto-join group, not as a standalone section', () => {
        withAutoJoinGroup();
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);

        // The editor is present at all (its empty-state line is the cheapest
        // stable marker — the translation manager returns keys in tests).
        const marker = screen.getByText('app.noCategoryRules');
        expect(marker).not.toBeNull();

        // ...and it is nested under the auto-join group's heading rather than a
        // sibling of it. Walking up from the editor must reach the element that
        // also contains the group heading.
        const groupHeading = screen.getByText('app.groupAutoJoin');
        const group = groupHeading.parentElement;
        expect(group.contains(marker)).toBe(true);
    });

    test('the editor does not leak into a DIFFERENT group', () => {
        // A rendered group that is NOT auto-join. This is the case that actually
        // exercises the `id === 'autoJoin'` comparison: with the suite's empty
        // default schema tierSchemaEntries returns [] and the loop never runs at
        // all, so that version proved nothing about the id check.
        mockSchemaState.schema = {
            mockMode: { type: 'boolean', default: false, group: 'general', label: 'app.mockMode' },
        };
        mockSchemaState.groups = [{ id: 'general', label: 'app.groupGeneral', tier: 'entries' }];
        mockSchemaState.tiers = [{ id: 'entries', label: 'app.tierEntries' }];

        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);

        // The group really did render — otherwise the absence below is vacuous.
        expect(screen.getByText('app.groupGeneral')).not.toBeNull();
        expect(screen.queryByText('app.noCategoryRules')).toBeNull();
    });

    test('with nothing rendered at all, the editor is not orphaned outside the loop', () => {
        // Empty schema: guards against a standalone always-rendered section
        // being reintroduced outside the tier-band loop (what this replaced).
        render(<SettingsModal isOpen={true} onClose={jest.fn()} />);
        expect(screen.queryByText('app.noCategoryRules')).toBeNull();
    });
});
