/**
 * Tests for sanitizeFillSchedule (settings/schema.js) and the
 * `_autoFillScheduleBoundsV1` load-time block in loadSettings() that applies
 * it per scope. The editor bounds tightened after the first schedule release
 * (count 2..4, at most 3 rows, seconds ≤ 30 days), so settings persisted
 * under the old bounds are normalized once on load: out-of-range rows
 * dropped, duplicates deduped first-wins, rows sorted by count, extra keys
 * stripped. A conforming value is left byte-for-byte untouched (the sanitizer
 * returns null for "no change" and for non-arrays).
 */

const { sanitizeFillSchedule, validateSetting } = require('../../src/js/settings/schema');

const MAX_SECONDS = 30 * 24 * 3600;

describe('sanitizeFillSchedule — pure normalization', () => {
    test('drops rows with a count outside 2..4 (old-bounds count 7)', () => {
        expect(
            sanitizeFillSchedule([
                { count: 7, seconds: 600 },
                { count: 2, seconds: 1800 },
            ]),
        ).toEqual([{ count: 2, seconds: 1800 }]);
    });

    test('dedupes duplicate counts, first occurrence wins', () => {
        expect(
            sanitizeFillSchedule([
                { count: 2, seconds: 100 },
                { count: 2, seconds: 200 },
            ]),
        ).toEqual([{ count: 2, seconds: 100 }]);
    });

    test('sorts unsorted input by count', () => {
        expect(
            sanitizeFillSchedule([
                { count: 4, seconds: 600 },
                { count: 2, seconds: 1800 },
            ]),
        ).toEqual([
            { count: 2, seconds: 1800 },
            { count: 4, seconds: 600 },
        ]);
    });

    test('strips extra keys from rows', () => {
        expect(sanitizeFillSchedule([{ count: 2, seconds: 600, extra: true }])).toEqual([{ count: 2, seconds: 600 }]);
    });

    test('drops rows with non-integer or out-of-range seconds', () => {
        expect(
            sanitizeFillSchedule([
                { count: 2, seconds: 600.5 },
                { count: 3, seconds: -1 },
                { count: 4, seconds: MAX_SECONDS + 1 },
            ]),
        ).toEqual([]);
    });

    test('drops non-object rows and rows missing fields', () => {
        expect(sanitizeFillSchedule([null, 'row', 42, { count: 2 }, { seconds: 600 }])).toEqual([]);
    });

    test('a conforming array returns null (nothing to change)', () => {
        expect(
            sanitizeFillSchedule([
                { count: 2, seconds: 1800 },
                { count: 3, seconds: 1200 },
                { count: 4, seconds: 600 },
            ]),
        ).toBeNull();
        expect(sanitizeFillSchedule([])).toBeNull();
        expect(sanitizeFillSchedule([{ count: 4, seconds: MAX_SECONDS }])).toBeNull();
    });

    test('non-array input returns null (nothing this sanitizer can do)', () => {
        expect(sanitizeFillSchedule('garbage')).toBeNull();
        expect(sanitizeFillSchedule(null)).toBeNull();
        expect(sanitizeFillSchedule(undefined)).toBeNull();
        expect(sanitizeFillSchedule({ count: 2, seconds: 600 })).toBeNull();
    });

    test('sanitized output always passes the schema validator', () => {
        const messy = [
            { count: 7, seconds: 600 },
            { count: 4, seconds: 900, note: 'x' },
            { count: 2, seconds: 1800 },
            { count: 2, seconds: 50 },
        ];
        const cleaned = sanitizeFillSchedule(messy);
        expect(cleaned).toEqual([
            { count: 2, seconds: 1800 },
            { count: 4, seconds: 900 },
        ]);
        expect(validateSetting('autoFillSchedule', cleaned)).toBe(true);
    });
});

describe('_autoFillScheduleBoundsV1 sanitizer pass in loadSettings', () => {
    let settings;
    let fs;

    const buildFixture = (overrides = {}) => ({
        challengeSettings: {
            globalDefaults: {},
            perChallenge: {},
            ...overrides,
        },
    });

    const setSettingsFile = (payload) => {
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(JSON.stringify(payload));
    };

    beforeEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
        // Ensure no autovote-running flag bleeds across tests
        if (typeof global !== 'undefined') delete global.autovoteRunning;
        if (typeof globalThis !== 'undefined') delete globalThis.autovoteRunning;
        // Re-require fs *after* resetModules so we share the fresh mock
        // instance that settings.js will see.
        fs = require('node:fs');
        settings = require('../../src/js/settings');
    });

    test('cleans an out-of-bounds global default and sets the flag', () => {
        setSettingsFile(
            buildFixture({
                globalDefaults: {
                    autoFillSchedule: [
                        { count: 7, seconds: 600 },
                        { count: 4, seconds: 900 },
                        { count: 2, seconds: 1800 },
                    ],
                },
            }),
        );

        const loaded = settings.loadSettings();

        expect(loaded.challengeSettings.globalDefaults.autoFillSchedule).toEqual([
            { count: 2, seconds: 1800 },
            { count: 4, seconds: 900 },
        ]);
        expect(loaded._autoFillScheduleBoundsV1).toBe(true);
    });

    test('cleans an out-of-bounds per-challenge override independently', () => {
        const conforming = [{ count: 2, seconds: 1800 }];
        setSettingsFile(
            buildFixture({
                globalDefaults: { autoFillSchedule: conforming },
                perChallenge: {
                    42: {
                        autoFillSchedule: [
                            { count: 2, seconds: 100 },
                            { count: 2, seconds: 200 },
                            { count: 20, seconds: 300 },
                        ],
                    },
                },
            }),
        );

        const loaded = settings.loadSettings();

        expect(loaded.challengeSettings.perChallenge[42].autoFillSchedule).toEqual([{ count: 2, seconds: 100 }]);
        expect(loaded.challengeSettings.globalDefaults.autoFillSchedule).toEqual(conforming);
    });

    test('a conforming schedule is left untouched (flag still set)', () => {
        const conforming = [
            { count: 2, seconds: 1800 },
            { count: 3, seconds: 1200 },
            { count: 4, seconds: 600 },
        ];
        setSettingsFile(
            buildFixture({
                globalDefaults: { autoFillSchedule: conforming },
            }),
        );

        const loaded = settings.loadSettings();

        expect(loaded.challengeSettings.globalDefaults.autoFillSchedule).toEqual(conforming);
        expect(loaded._autoFillScheduleBoundsV1).toBe(true);
    });

    test('is idempotent: a second load of the sanitized file writes nothing new', () => {
        setSettingsFile(
            buildFixture({
                globalDefaults: { autoFillSchedule: [{ count: 7, seconds: 600 }] },
            }),
        );
        // First load: sanitizes and persists the flag.
        settings.loadSettings();
        const firstWrites = fs.writeFileSync.mock.calls.length;

        // Simulate the on-disk file now reflecting the sanitized state
        // (every loadSettings migration flag set).
        setSettingsFile({
            challengeSettings: {
                globalDefaults: { autoFillSchedule: [] },
                perChallenge: {},
            },
            _timeUnitMigratedV1: true,
            _emergencyFillTimeMigratedV1: true,
            _autoFillScheduleMigratedV1: true,
            _autoFillScheduleBoundsV1: true,
        });

        const loaded = settings.loadSettings();
        const secondWrites = fs.writeFileSync.mock.calls.length;

        expect(loaded.challengeSettings.globalDefaults.autoFillSchedule).toEqual([]);
        expect(secondWrites).toBe(firstWrites); // no new migration writes
    });

    test('does not re-sanitize when the flag is already true', () => {
        const stale = [{ count: 7, seconds: 600 }];
        setSettingsFile({
            challengeSettings: {
                globalDefaults: { autoFillSchedule: stale },
                perChallenge: {},
            },
            _timeUnitMigratedV1: true,
            _emergencyFillTimeMigratedV1: true,
            _autoFillScheduleMigratedV1: true,
            _autoFillScheduleBoundsV1: true,
        });

        const loaded = settings.loadSettings();

        expect(loaded.challengeSettings.globalDefaults.autoFillSchedule).toEqual(stale);
    });

    test('composition: legacy interval + no flags runs migration then sanitizer in one load', () => {
        // A pre-schedule install: autoFillIntervalMinutes present, neither the
        // migration flag nor the bounds flag set. One loadSettings() must
        // convert the interval AND leave a bounds-conforming schedule, with
        // both flags true.
        setSettingsFile(
            buildFixture({
                globalDefaults: { autoFillIntervalMinutes: 15 },
            }),
        );

        const loaded = settings.loadSettings();
        const migrated = loaded.challengeSettings.globalDefaults.autoFillSchedule;

        expect(migrated).toEqual([
            { count: 2, seconds: 2700 },
            { count: 3, seconds: 1800 },
            { count: 4, seconds: 900 },
        ]);
        expect(validateSetting('autoFillSchedule', migrated)).toBe(true);
        expect(sanitizeFillSchedule(migrated)).toBeNull(); // already conforming
        expect(loaded._autoFillScheduleMigratedV1).toBe(true);
        expect(loaded._autoFillScheduleBoundsV1).toBe(true);
        expect(
            Object.prototype.hasOwnProperty.call(loaded.challengeSettings.globalDefaults, 'autoFillIntervalMinutes'),
        ).toBe(false);
    });
});
