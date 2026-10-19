/**
 * Tests for settings/uiDefaults — the single source of truth for the
 * app-level (non-schema) settings defaults shared by the settings
 * facade's getDefaultSettings() and the renderer's Settings form.
 */

import type * as uiDefaultsModule from '../../src/ts/settings/uiDefaults';

const { getUiDefaultSettings, effectiveTimezone, isValidTimezone, BUILT_IN_TIMEZONES } =
    require('../../src/ts/settings/uiDefaults') as typeof uiDefaultsModule;

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

describe('effectiveTimezone', () => {
    test.each([
        [undefined, 'Europe/Riga'],
        [null, 'Europe/Riga'],
        ['', 'UTC'],
        ['  ', 'UTC'],
        [' Asia/Tokyo ', 'Asia/Tokyo'],
        ['local', 'local'],
        ['America/New_York', 'America/New_York'],
        ['Europe/Rgia', 'UTC'],
        [' Nowhere/Land ', 'UTC'],
    ])('%j is read as %s', (value, zone) => {
        expect(effectiveTimezone(value)).toBe(zone);
    });
});

describe('isValidTimezone', () => {
    test('accepts a zone the runtime knows and rejects a typo and "local"', () => {
        expect(isValidTimezone('Pacific/Auckland')).toBe(true);
        expect(isValidTimezone('Europe/Rgia')).toBe(false);
        expect(isValidTimezone('local')).toBe(false);
    });

    test('serves a repeated valid zone from the cache', () => {
        const probe = jest.spyOn(Intl, 'DateTimeFormat');
        try {
            expect(isValidTimezone('Asia/Kolkata')).toBe(true);
            const probes = probe.mock.calls.length;
            expect(isValidTimezone('Asia/Kolkata')).toBe(true);
            expect(probe.mock.calls.length).toBe(probes);
        } finally {
            probe.mockRestore();
        }
    });

    test('does not cache a rejected zone, so a later probe is consulted again', () => {
        expect(isValidTimezone('Fake/Zone')).toBe(false);
        const real = Intl.DateTimeFormat;
        const probe = jest.spyOn(Intl, 'DateTimeFormat').mockImplementation(() => new real('en-US'));
        try {
            expect(isValidTimezone('Fake/Zone')).toBe(true);
            expect(probe).toHaveBeenCalledTimes(1);
        } finally {
            probe.mockRestore();
        }
    });
});

describe('BUILT_IN_TIMEZONES', () => {
    test('are the default zone and UTC', () => {
        expect(BUILT_IN_TIMEZONES).toEqual(['Europe/Riga', 'UTC']);
    });
});
