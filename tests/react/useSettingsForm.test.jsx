/**
 * useSettingsForm — the form state behind the global Settings modal:
 * hydrate-once-per-open, per-key fallback semantics, UI vs schema reset
 * handlers, commit() reporting rejected schema writes, and revert().
 * Persistence of global defaults goes through the mocked
 * window.api.setGlobalDefault (helpers/setup.js).
 */

import { renderHook, act, waitFor } from '@testing-library/preact';
import { useSettingsForm, DEFAULT_UI_VALUES } from '@/hooks/useSettingsForm';

const schema = {
    exposure: { type: 'number', default: 100 },
    autoBoost: { type: 'boolean', default: false },
};

const baseProps = (over = {}) => ({
    isOpen: true,
    schema,
    defaults: { exposure: 70, autoBoost: true },
    settings: { ...DEFAULT_UI_VALUES, theme: 'dark', language: 'lv' },
    refetchSettings: jest.fn(),
    refetchSchema: jest.fn(),
    updateSetting: jest.fn().mockResolvedValue(undefined),
    ...over,
});

const renderForm = (props) =>
    renderHook((p) => useSettingsForm(p), {
        initialProps: props,
    });

beforeEach(() => {
    document.documentElement.removeAttribute('data-theme');
});

describe('useSettingsForm — open lifecycle', () => {
    test('refetches settings and schema on open and hydrates both halves', () => {
        const props = baseProps();
        const { result } = renderForm(props);

        expect(props.refetchSettings).toHaveBeenCalledTimes(1);
        expect(props.refetchSchema).toHaveBeenCalledTimes(1);
        expect(result.current.formValues).toEqual({ exposure: 70, autoBoost: true });
        expect(result.current.originalFormValues).toEqual({ exposure: 70, autoBoost: true });
        expect(result.current.uiValues.theme).toBe('dark');
        expect(result.current.originalUiValues.language).toBe('lv');
    });

    test('a closed form neither refetches nor hydrates', () => {
        const props = baseProps({ isOpen: false });
        const { result } = renderForm(props);

        expect(props.refetchSettings).not.toHaveBeenCalled();
        expect(result.current.formValues).toEqual({});
        expect(result.current.uiValues).toEqual(DEFAULT_UI_VALUES);
        expect(result.current.originalUiValues).toBeNull();
    });

    test('waits for defaults and settings to arrive before hydrating', () => {
        const props = baseProps({ defaults: null, settings: null });
        const { result, rerender } = renderForm(props);
        expect(result.current.originalFormValues).toBeNull();
        expect(result.current.originalUiValues).toBeNull();

        rerender({ ...props, defaults: { exposure: 5 }, settings: { theme: 'dark' } });
        expect(result.current.formValues).toEqual({ exposure: 5 });
        expect(result.current.uiValues.theme).toBe('dark');
    });

    test('a refetch mid-session does not clobber in-progress edits', () => {
        const props = baseProps();
        const { result, rerender } = renderForm(props);

        act(() => result.current.handleFormChange('exposure', 42));
        rerender({ ...props, defaults: { exposure: 1, autoBoost: false }, settings: { theme: 'light' } });

        expect(result.current.formValues.exposure).toBe(42);
        expect(result.current.uiValues.theme).toBe('dark');
    });

    test('closing and reopening re-hydrates from the latest values', () => {
        const props = baseProps();
        const { result, rerender } = renderForm(props);
        act(() => result.current.handleFormChange('exposure', 42));

        rerender({ ...props, isOpen: false });
        rerender({ ...props, isOpen: true, defaults: { exposure: 9 } });

        expect(result.current.formValues).toEqual({ exposure: 9 });
    });
});

describe('useSettingsForm — per-key fallback on hydrate', () => {
    test('arrays, strings and scalars each fall back with their own rule', () => {
        const props = baseProps({
            settings: {
                customTimezones: 'not-an-array',
                timezone: '',
                language: 'lv',
                stayLoggedIn: false,
                apiMaxRetries: 0,
                apiTimeout: null,
            },
        });
        const { result } = renderForm(props);
        const ui = result.current.uiValues;

        // Array default: a non-array stored value is replaced.
        expect(ui.customTimezones).toEqual(DEFAULT_UI_VALUES.customTimezones);
        // String default: '' counts as unset, a real string is kept.
        expect(ui.timezone).toBe(DEFAULT_UI_VALUES.timezone);
        expect(ui.language).toBe('lv');
        // Scalars: an explicit false / 0 is preserved; null falls back.
        expect(ui.stayLoggedIn).toBe(false);
        expect(ui.apiMaxRetries).toBe(0);
        expect(ui.apiTimeout).toBe(DEFAULT_UI_VALUES.apiTimeout);
    });

    test('a stored array is kept as-is', () => {
        const props = baseProps({ settings: { customTimezones: ['Asia/Tokyo'] } });
        const { result } = renderForm(props);
        expect(result.current.uiValues.customTimezones).toEqual(['Asia/Tokyo']);
    });
});

describe('useSettingsForm — change and reset handlers', () => {
    test('a theme change is applied to the DOM live; other UI keys are not', () => {
        const { result } = renderForm(baseProps());

        act(() => result.current.handleUiChange('language', 'en'));
        expect(result.current.uiValues.language).toBe('en');
        expect(document.documentElement.getAttribute('data-theme')).toBeNull();

        act(() => result.current.handleUiChange('theme', 'light'));
        expect(result.current.uiValues.theme).toBe('light');
        expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    });

    test('resetting a UI key restores its default, touching the DOM only for theme', () => {
        const { result } = renderForm(baseProps());

        act(() => result.current.handleResetUi('language'));
        expect(result.current.uiValues.language).toBe(DEFAULT_UI_VALUES.language);
        expect(document.documentElement.getAttribute('data-theme')).toBeNull();

        act(() => result.current.handleResetUi('theme'));
        expect(result.current.uiValues.theme).toBe(DEFAULT_UI_VALUES.theme);
        expect(document.documentElement.getAttribute('data-theme')).toBe(DEFAULT_UI_VALUES.theme);
    });

    test('resetting a global key uses its schema default and ignores unknown keys', () => {
        const { result } = renderForm(baseProps());

        act(() => result.current.handleResetGlobal('exposure'));
        expect(result.current.formValues.exposure).toBe(100);

        act(() => result.current.handleResetGlobal('notInSchema'));
        expect(result.current.formValues).toEqual({ exposure: 100, autoBoost: true });
    });

    test('resetting a global key before the schema loads is a no-op', () => {
        const { result } = renderForm(baseProps({ schema: null }));
        act(() => result.current.handleResetGlobal('exposure'));
        expect(result.current.formValues).toEqual({ exposure: 70, autoBoost: true });
    });

    test('reset-all restores every schema default and every UI default', () => {
        const { result } = renderForm(baseProps());

        act(() => result.current.handleResetAll());
        expect(result.current.formValues).toEqual({ exposure: 100, autoBoost: false });
        expect(result.current.uiValues).toEqual(DEFAULT_UI_VALUES);
        expect(document.documentElement.getAttribute('data-theme')).toBe(DEFAULT_UI_VALUES.theme);
    });

    test('reset-all without a schema still resets the UI half', () => {
        const { result } = renderForm(baseProps({ schema: null }));

        act(() => result.current.handleResetAll());
        expect(result.current.formValues).toEqual({ exposure: 70, autoBoost: true });
        expect(result.current.uiValues).toEqual(DEFAULT_UI_VALUES);
    });
});

describe('useSettingsForm — commit and revert', () => {
    test('commit writes every UI value and global default, returning rejected keys', async () => {
        // Written in formValues key order: exposure (rejected), then autoBoost.
        window.api.setGlobalDefault.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        const props = baseProps();
        const { result } = renderForm(props);

        let rejected;
        await act(async () => {
            rejected = await result.current.commit();
        });

        expect(rejected).toEqual(['exposure']);
        expect(props.updateSetting).toHaveBeenCalledTimes(Object.keys(DEFAULT_UI_VALUES).length);
        expect(props.updateSetting).toHaveBeenCalledWith('theme', 'dark');
        expect(window.api.setGlobalDefault).toHaveBeenCalledWith('exposure', 70);
        expect(window.api.setGlobalDefault).toHaveBeenCalledWith('autoBoost', true);
        expect(result.current.saving).toBe(false);
    });

    test('a throwing write clears the saving flag and propagates', async () => {
        const props = baseProps({ updateSetting: jest.fn().mockRejectedValue(new Error('nope')) });
        const { result } = renderForm(props);

        await act(async () => {
            await expect(result.current.commit()).rejects.toThrow('nope');
        });
        await waitFor(() => expect(result.current.saving).toBe(false));
        expect(window.api.setGlobalDefault).not.toHaveBeenCalled();
    });

    test('revert rolls both halves back to what the modal opened with', () => {
        const { result } = renderForm(baseProps());
        act(() => {
            result.current.handleFormChange('exposure', 1);
            result.current.handleUiChange('language', 'en');
        });

        act(() => result.current.revert());
        expect(result.current.formValues).toEqual({ exposure: 70, autoBoost: true });
        expect(result.current.uiValues.language).toBe('lv');
    });

    test('revert before hydration leaves state untouched', () => {
        const { result } = renderForm(baseProps({ isOpen: false }));
        act(() => result.current.handleFormChange('exposure', 1));

        act(() => result.current.revert());
        expect(result.current.formValues).toEqual({ exposure: 1 });
        expect(result.current.uiValues).toEqual(DEFAULT_UI_VALUES);
    });
});
