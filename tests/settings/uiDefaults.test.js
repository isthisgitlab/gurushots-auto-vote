/**
 * Tests for settings/uiDefaults — the single source of truth for the
 * app-level (non-schema) settings defaults shared by the settings
 * facade's getDefaultSettings() and the renderer's Settings form.
 */

const { getUiDefaultSettings } = require('../../src/js/settings/uiDefaults');

describe('getUiDefaultSettings', () => {
    test('returns the documented UI-form defaults', () => {
        expect(getUiDefaultSettings()).toEqual({
            theme: 'light',
            language: 'en',
            timezone: 'Europe/Riga',
            customTimezones: [],
            stayLoggedIn: false,
            apiTimeout: 30,
            checkFrequencyMin: 3,
            checkFrequencyMax: 3,
            apiMaxRetries: 3,
            apiRetryBaseDelayMs: 1000,
        });
    });

    test('returns a fresh object (and array) per call so callers cannot share mutable state', () => {
        const a = getUiDefaultSettings();
        const b = getUiDefaultSettings();
        expect(a).not.toBe(b);
        expect(a.customTimezones).not.toBe(b.customTimezones);
    });
});
