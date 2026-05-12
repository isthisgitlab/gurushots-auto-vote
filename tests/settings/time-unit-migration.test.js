/**
 * Tests for the boostTime/turboTime unit migration in loadSettings().
 *
 * Pre-fix, SettingInput.jsx encoded these `type: 'time'` values as minutes
 * (h*60+m) while the runtime treated them as seconds. The migration
 * detects values produced by the buggy GUI (range [1, 1439]) and multiplies
 * by 60. Defaults (3600s, 7200s) are above this band so they pass through.
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

        // Now simulate that the file on disk reflects the migrated state.
        setSettingsFile({
            challengeSettings: {
                globalDefaults: { turboTime: 10800 },
                perChallenge: {},
            },
            _timeUnitMigratedV1: true,
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
