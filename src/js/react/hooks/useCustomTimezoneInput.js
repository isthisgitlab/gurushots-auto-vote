import { useState, useEffect, useRef, useCallback } from 'react';
import { DEFAULT_TIMEZONE } from '../../settings/uiDefaults';

const isValidTimezone = (tz) => {
    try {
        new Intl.DateTimeFormat(undefined, { timeZone: tz });
        return true;
    } catch {
        return false;
    }
};

/**
 * The custom-timezone "+" input: local UI state, never persisted, so it stays
 * out of the settings form hook. Reset on every open so a stale "+" panel from
 * a previous session doesn't carry over. Adding a valid zone stores it in
 * `customTimezones` and selects it; removing drops the selected custom zone
 * and falls back to the default.
 */
export function useCustomTimezoneInput({ isOpen, uiValues, handleUiChange }) {
    const [visible, setVisible] = useState(false);
    const [value, setValue] = useState('');
    const [error, setError] = useState(false);
    // Revealing the input (the "+" button) moves focus into it, so the user
    // can type straight away.
    const inputRef = useRef(null);
    useEffect(() => {
        if (visible) inputRef.current?.focus();
    }, [visible]);

    const close = useCallback(() => {
        setVisible(false);
        setValue('');
        setError(false);
    }, []);

    useEffect(() => {
        if (isOpen) close();
    }, [isOpen, close]);

    const add = useCallback(() => {
        const zone = value.trim();
        if (!zone || !isValidTimezone(zone)) {
            setError(true);
            return;
        }
        // useSettingsForm guarantees an array here (withFallback's array guard
        // on hydrate, DEFAULT_UI_VALUES before it), so no `|| []` fallback.
        const list = uiValues.customTimezones;
        handleUiChange('customTimezones', list.includes(zone) ? list : [...list, zone]);
        handleUiChange('timezone', zone);
        close();
    }, [value, uiValues.customTimezones, handleUiChange, close]);

    const remove = useCallback(() => {
        handleUiChange(
            'customTimezones',
            uiValues.customTimezones.filter((tz) => tz !== uiValues.timezone),
        );
        handleUiChange('timezone', DEFAULT_TIMEZONE);
    }, [uiValues.customTimezones, uiValues.timezone, handleUiChange]);

    const toggle = () => {
        setVisible((v) => !v);
        setError(false);
    };

    const change = (next) => {
        setValue(next);
        if (error) setError(false);
    };

    return { visible, value, error, inputRef, add, remove, toggle, change, close };
}
