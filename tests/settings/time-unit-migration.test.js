/**
 * Tests for the time-unit migrations in loadSettings().
 *
 * 1. boostTime/turboTime: pre-fix, SettingInput.jsx encoded these
 *    `type: 'time'` values as minutes (h*60+m) while the runtime treated
 *    them as seconds. The migration detects values produced by the buggy
 *    GUI (range [1, 1439]) and multiplies by 60. Defaults (3600s, 7200s)
 *    are above this band so they pass through.
 * 2. emergencyFill: was a plain `number` of minutes-before-close (1-59); it
 *    is now a `time` setting in seconds. The migration multiplies stored
 *    values in (0, 60) by 60 under the `_emergencyFillTimeMigratedV1` flag.
 */

const buildFixture = (overrides = {}) => ({
    challengeSettings: {
        globalDefaults: {},
        perChallenge: {},
        ...overrides,
    },
});

describe('time-unit migration in loadSettings', () => {
    let settings;
    let fs;

    const setSettingsFile = (payload) => {
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(JSON.stringify(payload));
    };

    const findMigrationWrite = () => {
        const calls = fs.writeFileSync.mock.calls;
        for (let i = calls.length - 1; i >= 0; i -= 1) {
            const [, body] = calls[i];
            if (typeof body === 'string' && body.includes('_timeUnitMigratedV1')) {
                return JSON.parse(body);
            }
        }
        return null;
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

    test('inflates minute-encoded global defaults by 60', () => {
        setSettingsFile(
            buildFixture({
                globalDefaults: { turboTime: 180, boostTime: 60 },
            }),
        );

        const loaded = settings.loadSettings();

        expect(loaded.challengeSettings.globalDefaults.turboTime).toBe(180 * 60);
        expect(loaded.challengeSettings.globalDefaults.boostTime).toBe(60 * 60);
        expect(loaded._timeUnitMigratedV1).toBe(true);
    });

    test('leaves values >= 1440 untouched (already seconds)', () => {
        setSettingsFile(
            buildFixture({
                globalDefaults: { turboTime: 7200, boostTime: 3600 },
            }),
        );

        const loaded = settings.loadSettings();

        expect(loaded.challengeSettings.globalDefaults.turboTime).toBe(7200);
        expect(loaded.challengeSettings.globalDefaults.boostTime).toBe(3600);
        expect(loaded._timeUnitMigratedV1).toBe(true);
    });

    test('leaves zero untouched (means "disabled")', () => {
        setSettingsFile(
            buildFixture({
                globalDefaults: { turboTime: 0, boostTime: 0 },
            }),
        );

        const loaded = settings.loadSettings();

        expect(loaded.challengeSettings.globalDefaults.turboTime).toBe(0);
        expect(loaded.challengeSettings.globalDefaults.boostTime).toBe(0);
    });

    test('migrates per-challenge overrides independently', () => {
        setSettingsFile(
            buildFixture({
                globalDefaults: { turboTime: 7200 },
                perChallenge: {
                    42: { turboTime: 60 },
                    99: { boostTime: 1380, turboTime: 7200 },
                },
            }),
        );

        const loaded = settings.loadSettings();

        expect(loaded.challengeSettings.perChallenge[42].turboTime).toBe(60 * 60);
        expect(loaded.challengeSettings.perChallenge[99].boostTime).toBe(1380 * 60);
        expect(loaded.challengeSettings.perChallenge[99].turboTime).toBe(7200);
    });

    test('persists the migration result via writeFileSync', () => {
        setSettingsFile(
            buildFixture({
                globalDefaults: { turboTime: 180 },
            }),
        );

        settings.loadSettings();

        const persisted = findMigrationWrite();
        expect(persisted).not.toBeNull();
        expect(persisted._timeUnitMigratedV1).toBe(true);
        expect(persisted.challengeSettings.globalDefaults.turboTime).toBe(10800);
    });

    test('is idempotent: second load with flag set does not re-migrate', () => {
        setSettingsFile(
            buildFixture({
                globalDefaults: { turboTime: 180 },
                // Flag already set: pretend migration already ran somehow
                // (file is read fresh each time fs.readFileSync is called)
            }),
        );
        // First load: runs migration. Writes file with flag = true.
        settings.loadSettings();
        const firstWrites = fs.writeFileSync.mock.calls.length;

        // Now simulate that the file on disk reflects the migrated state
        // (every loadSettings migration flag set).
        setSettingsFile({
            challengeSettings: {
                globalDefaults: { turboTime: 10800 },
                perChallenge: {},
            },
            _timeUnitMigratedV1: true,
            _emergencyFillTimeMigratedV1: true,
            _autoFillScheduleMigratedV1: true,
        });

        settings.loadSettings();
        const secondWrites = fs.writeFileSync.mock.calls.length;

        // No new writes for migration purposes (turboTime already 10800 and flag set).
        expect(secondWrites).toBe(firstWrites);
    });

    test('does not migrate when flag is already true even if buggy values present', () => {
        // Edge case: someone restored an old backup with the flag true but
        // buggy values still in place. Migration must respect the flag.
        setSettingsFile({
            challengeSettings: {
                globalDefaults: { turboTime: 180 },
                perChallenge: {},
            },
            _timeUnitMigratedV1: true,
        });

        const loaded = settings.loadSettings();

        expect(loaded.challengeSettings.globalDefaults.turboTime).toBe(180);
    });

    test('upper bound: value of exactly 1440 is left alone', () => {
        // 1440 is outside the buggy GUI's writable range (max was 1439).
        // Anything >= 1440 must have come from elsewhere (e.g. raw JSON edit).
        setSettingsFile(
            buildFixture({
                globalDefaults: { turboTime: 1440 },
            }),
        );

        const loaded = settings.loadSettings();

        expect(loaded.challengeSettings.globalDefaults.turboTime).toBe(1440);
    });

    test('lower bound: value of exactly 1 is migrated', () => {
        setSettingsFile(
            buildFixture({
                globalDefaults: { boostTime: 1 },
            }),
        );

        const loaded = settings.loadSettings();

        expect(loaded.challengeSettings.globalDefaults.boostTime).toBe(60);
    });
});

describe('emergencyFill minute->second migration in loadSettings', () => {
    let settings;
    let fs;

    const setSettingsFile = (payload) => {
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(JSON.stringify(payload));
    };

    beforeEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
        if (typeof global !== 'undefined') delete global.autovoteRunning;
        if (typeof globalThis !== 'undefined') delete globalThis.autovoteRunning;
        fs = require('node:fs');
        settings = require('../../src/js/settings');
    });

    test('inflates a minute-encoded global default by 60 (5 -> 300)', () => {
        setSettingsFile(
            buildFixture({
                globalDefaults: { emergencyFill: 5 },
            }),
        );

        const loaded = settings.loadSettings();

        expect(loaded.challengeSettings.globalDefaults.emergencyFill).toBe(300);
        expect(loaded._emergencyFillTimeMigratedV1).toBe(true);
    });

    test('leaves zero untouched (means "disabled")', () => {
        setSettingsFile(
            buildFixture({
                globalDefaults: { emergencyFill: 0 },
            }),
        );

        const loaded = settings.loadSettings();

        expect(loaded.challengeSettings.globalDefaults.emergencyFill).toBe(0);
    });

    test('leaves an already-seconds value (>= 60) untouched', () => {
        setSettingsFile(
            buildFixture({
                globalDefaults: { emergencyFill: 300 },
            }),
        );

        const loaded = settings.loadSettings();

        expect(loaded.challengeSettings.globalDefaults.emergencyFill).toBe(300);
        expect(loaded._emergencyFillTimeMigratedV1).toBe(true);
    });

    test('migrates per-challenge overrides independently', () => {
        setSettingsFile(
            buildFixture({
                globalDefaults: { emergencyFill: 300 },
                perChallenge: {
                    42: { emergencyFill: 10 },
                    99: { emergencyFill: 600 },
                },
            }),
        );

        const loaded = settings.loadSettings();

        expect(loaded.challengeSettings.perChallenge[42].emergencyFill).toBe(600);
        expect(loaded.challengeSettings.perChallenge[99].emergencyFill).toBe(600);
    });

    test('boundary: 59 migrates, 60 is left alone', () => {
        setSettingsFile(
            buildFixture({
                globalDefaults: { emergencyFill: 59 },
                perChallenge: { 7: { emergencyFill: 60 } },
            }),
        );

        const loaded = settings.loadSettings();

        expect(loaded.challengeSettings.globalDefaults.emergencyFill).toBe(59 * 60);
        expect(loaded.challengeSettings.perChallenge[7].emergencyFill).toBe(60);
    });

    test('does not migrate when flag is already true even if minute value present', () => {
        setSettingsFile({
            challengeSettings: {
                globalDefaults: { emergencyFill: 5 },
                perChallenge: {},
            },
            _emergencyFillTimeMigratedV1: true,
        });

        const loaded = settings.loadSettings();

        expect(loaded.challengeSettings.globalDefaults.emergencyFill).toBe(5);
    });
});
