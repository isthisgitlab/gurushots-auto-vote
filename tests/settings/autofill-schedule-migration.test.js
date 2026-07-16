/**
 * Tests for the autoFillIntervalMinutes → autoFillSchedule migration in
 * loadSettings() (`_autoFillScheduleMigratedV1`).
 *
 * The old single interval M (minutes) is converted, per scope, into an
 * explicit per-image schedule derived from the USER'S value (never the schema
 * default):
 *   [{ count: 2, seconds: round(3*M*60) },
 *    { count: 3, seconds: round(2*M*60) },
 *    { count: 4, seconds: round(M*60) }]
 * with M clamped to the old validator's 60-minute ceiling. The legacy key is
 * always deleted; an existing autoFillSchedule in the same scope is never
 * overwritten.
 */

const { validateSetting } = require('../../src/js/settings/schema');

const buildFixture = (overrides = {}) => ({
    challengeSettings: {
        globalDefaults: {},
        perChallenge: {},
        ...overrides,
    },
});

// Expected conversion for M=15 — deliberately NOT the schema default (M=10),
// so a regression that substitutes the default for the user's value fails here.
const SCHEDULE_FOR_15 = [
    { count: 2, seconds: 2700 },
    { count: 3, seconds: 1800 },
    { count: 4, seconds: 900 },
];

describe('autoFillIntervalMinutes → autoFillSchedule migration in loadSettings', () => {
    let settings;
    let fs;

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

    test('converts a global default of 15 minutes and deletes the legacy key', () => {
        setSettingsFile(
            buildFixture({
                globalDefaults: { autoFillIntervalMinutes: 15 },
            }),
        );

        const loaded = settings.loadSettings();
        const globalDefaults = loaded.challengeSettings.globalDefaults;

        expect(globalDefaults.autoFillSchedule).toEqual(SCHEDULE_FOR_15);
        expect(Object.prototype.hasOwnProperty.call(globalDefaults, 'autoFillIntervalMinutes')).toBe(false);
        expect(loaded._autoFillScheduleMigratedV1).toBe(true);
    });

    test('converts a per-challenge override of 15 minutes the same way', () => {
        setSettingsFile(
            buildFixture({
                perChallenge: { 42: { autoFillIntervalMinutes: 15 } },
            }),
        );

        const loaded = settings.loadSettings();
        const override = loaded.challengeSettings.perChallenge[42];

        expect(override.autoFillSchedule).toEqual(SCHEDULE_FOR_15);
        expect(Object.prototype.hasOwnProperty.call(override, 'autoFillIntervalMinutes')).toBe(false);
        expect(loaded._autoFillScheduleMigratedV1).toBe(true);
    });

    test('asymmetric scopes: legacy only in globalDefaults leaves per-challenge untouched', () => {
        setSettingsFile(
            buildFixture({
                globalDefaults: { autoFillIntervalMinutes: 15 },
                perChallenge: { 42: { autoFill: true } },
            }),
        );

        const loaded = settings.loadSettings();

        expect(loaded.challengeSettings.globalDefaults.autoFillSchedule).toEqual(SCHEDULE_FOR_15);
        // The scope without the legacy key gains nothing (effective-setting
        // resolution falls through to the global default at read time).
        expect(loaded.challengeSettings.perChallenge[42]).toEqual({ autoFill: true });
    });

    test('asymmetric scopes: legacy only per-challenge leaves globalDefaults untouched', () => {
        setSettingsFile(
            buildFixture({
                globalDefaults: { autoFill: false },
                perChallenge: { 42: { autoFillIntervalMinutes: 15 } },
            }),
        );

        const loaded = settings.loadSettings();

        expect(loaded.challengeSettings.perChallenge[42].autoFillSchedule).toEqual(SCHEDULE_FOR_15);
        expect(loaded.challengeSettings.globalDefaults).toEqual({ autoFill: false });
    });

    test('non-integer legacy value 1.35 rounds to integer seconds', () => {
        setSettingsFile(
            buildFixture({
                globalDefaults: { autoFillIntervalMinutes: 1.35 },
            }),
        );

        const loaded = settings.loadSettings();
        const migrated = loaded.challengeSettings.globalDefaults.autoFillSchedule;

        expect(migrated).toEqual([
            { count: 2, seconds: 243 }, // round(3 * 1.35 * 60)
            { count: 3, seconds: 162 }, // round(2 * 1.35 * 60)
            { count: 4, seconds: 81 }, // round(1.35 * 60)
        ]);
        migrated.forEach((row) => expect(Number.isInteger(row.seconds)).toBe(true));
    });

    test('oversized legacy value 120 clamps to the old 60-minute ceiling first', () => {
        setSettingsFile(
            buildFixture({
                globalDefaults: { autoFillIntervalMinutes: 120 },
            }),
        );

        const loaded = settings.loadSettings();

        expect(loaded.challengeSettings.globalDefaults.autoFillSchedule).toEqual([
            { count: 2, seconds: 10800 },
            { count: 3, seconds: 7200 },
            { count: 4, seconds: 3600 },
        ]);
    });

    test('is idempotent: a second load of the migrated file changes nothing', () => {
        setSettingsFile(
            buildFixture({
                globalDefaults: { autoFillIntervalMinutes: 15 },
            }),
        );
        // First load: runs the migration and persists the flag.
        settings.loadSettings();
        const firstWrites = fs.writeFileSync.mock.calls.length;

        // Simulate the on-disk file now reflecting the fully migrated state
        // (all migration flags set).
        setSettingsFile({
            challengeSettings: {
                globalDefaults: { autoFillSchedule: SCHEDULE_FOR_15 },
                perChallenge: {},
            },
            _timeUnitMigratedV1: true,
            _emergencyFillTimeMigratedV1: true,
            _autoFillScheduleMigratedV1: true,
            _autoFillScheduleBoundsV1: true,
        });

        const loaded = settings.loadSettings();
        const secondWrites = fs.writeFileSync.mock.calls.length;

        expect(loaded.challengeSettings.globalDefaults.autoFillSchedule).toEqual(SCHEDULE_FOR_15);
        expect(secondWrites).toBe(firstWrites); // no new migration writes
    });

    test('does not re-convert when the flag is already true even if a legacy key is present', () => {
        setSettingsFile({
            challengeSettings: {
                globalDefaults: { autoFillIntervalMinutes: 15 },
                perChallenge: {},
            },
            _timeUnitMigratedV1: true,
            _emergencyFillTimeMigratedV1: true,
            _autoFillScheduleMigratedV1: true,
            _autoFillScheduleBoundsV1: true,
        });

        const loaded = settings.loadSettings();

        expect(loaded.challengeSettings.globalDefaults.autoFillSchedule).toBeUndefined();
        expect(loaded.challengeSettings.globalDefaults.autoFillIntervalMinutes).toBe(15);
    });

    test('an untouched default of 10 minutes converts to the schema-default-equivalent schedule', () => {
        setSettingsFile(
            buildFixture({
                globalDefaults: { autoFillIntervalMinutes: 10 },
            }),
        );

        const loaded = settings.loadSettings();

        expect(loaded.challengeSettings.globalDefaults.autoFillSchedule).toEqual([
            { count: 2, seconds: 1800 },
            { count: 3, seconds: 1200 },
            { count: 4, seconds: 600 },
        ]);
    });

    test('migrated output passes the schema validator (strict rows, unique counts)', () => {
        setSettingsFile(
            buildFixture({
                globalDefaults: { autoFillIntervalMinutes: 15 },
                perChallenge: { 42: { autoFillIntervalMinutes: 1.35 }, 99: { autoFillIntervalMinutes: 120 } },
            }),
        );

        const loaded = settings.loadSettings();

        expect(validateSetting('autoFillSchedule', loaded.challengeSettings.globalDefaults.autoFillSchedule)).toBe(
            true,
        );
        expect(validateSetting('autoFillSchedule', loaded.challengeSettings.perChallenge[42].autoFillSchedule)).toBe(
            true,
        );
        expect(validateSetting('autoFillSchedule', loaded.challengeSettings.perChallenge[99].autoFillSchedule)).toBe(
            true,
        );
    });

    test('an existing autoFillSchedule is not overwritten but the legacy key is still deleted', () => {
        const custom = [{ count: 2, seconds: 4242 }];
        setSettingsFile(
            buildFixture({
                globalDefaults: { autoFillIntervalMinutes: 15, autoFillSchedule: custom },
            }),
        );

        const loaded = settings.loadSettings();
        const globalDefaults = loaded.challengeSettings.globalDefaults;

        expect(globalDefaults.autoFillSchedule).toEqual(custom);
        expect(Object.prototype.hasOwnProperty.call(globalDefaults, 'autoFillIntervalMinutes')).toBe(false);
        expect(loaded._autoFillScheduleMigratedV1).toBe(true);
    });

    test('persists the migration result (flag + converted schedule) via writeFileSync', () => {
        setSettingsFile(
            buildFixture({
                globalDefaults: { autoFillIntervalMinutes: 15 },
            }),
        );

        settings.loadSettings();

        const calls = fs.writeFileSync.mock.calls;
        let persisted = null;
        for (let i = calls.length - 1; i >= 0; i -= 1) {
            const [, body] = calls[i];
            if (typeof body === 'string' && body.includes('_autoFillScheduleMigratedV1')) {
                persisted = JSON.parse(body);
                break;
            }
        }
        expect(persisted).not.toBeNull();
        expect(persisted._autoFillScheduleMigratedV1).toBe(true);
        expect(persisted.challengeSettings.globalDefaults.autoFillSchedule).toEqual(SCHEDULE_FOR_15);
        expect(persisted.challengeSettings.globalDefaults.autoFillIntervalMinutes).toBeUndefined();
    });
});
