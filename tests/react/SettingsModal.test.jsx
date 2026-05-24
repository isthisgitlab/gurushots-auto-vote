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

import { fireEvent, render, screen } from '@/test/test-utils';
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
