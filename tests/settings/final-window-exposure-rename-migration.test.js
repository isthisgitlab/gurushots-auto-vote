/**
 * Tests for the "last hour exposure" → "final window exposure" key rename in
 * loadSettings() (`_finalWindowExposureRenamedV1`).
 *
 * A pure per-scope key rename that MUST run before cleanupObsoleteSettings
 * (which would otherwise delete the now-schemaless legacy keys and lose the
 * user's persisted values). Renames, across globalDefaults / every
 * perChallenge map / every non-reserved profile:
 *   useLastHourExposure        → useFinalWindowExposure
 *   lastHourExposure           → finalWindowExposure
 *   lastHourExposureTarget     → finalWindowExposureTarget
 *   voteBeforeLastHour         → voteBeforeFinalWindow
 *   voteBeforeLastHourLeadMin  → voteBeforeFinalWindowLeadMin
 * An existing new-key value in the same scope is never overwritten; the legacy
 * key is always deleted. The new finalWindowDuration setting needs no
 * migration (absent → schema default 3600, one hour).
 */

const { buildSettingsFixture: buildFixture } = require('../helpers/challengeFixtures');

// Every migration flag set, so a fully-migrated on-disk file triggers no
// further writes (used by the idempotency / already-migrated cases).
const ALL_MIGRATION_FLAGS = {
    _timeUnitMigratedV1: true,
    _emergencyFillTimeMigratedV1: true,
    _autoFillScheduleMigratedV1: true,
    _autoFillScheduleBoundsV1: true,
    _scheduledFillListsMigratedV1: true,
    _scheduledFillListBoundsV1: true,
    _finalWindowExposureRenamedV1: true,
    _challengeRulesOrderedV1: true,
};

describe('last-hour → final-window key rename migration in loadSettings', () => {
    let settings;
    let fs;

    const setSettingsFile = (payload) => {
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(JSON.stringify(payload));
    };

    beforeEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
        fs = require('node:fs');
        settings = require('../../src/js/settings');
    });

    test('renames every legacy key in globalDefaults, deletes the old keys, sets the flag', () => {
        setSettingsFile(
            buildFixture({
                globalDefaults: {
                    useLastHourExposure: true,
                    lastHourExposure: 70,
                    lastHourExposureTarget: 85,
                    voteBeforeLastHour: true,
                    voteBeforeLastHourLeadMin: 20,
                },
            }),
        );

        const loaded = settings.loadSettings();
        const g = loaded.challengeSettings.globalDefaults;

        // New keys carry the user's persisted values.
        expect(g.useFinalWindowExposure).toBe(true);
        expect(g.finalWindowExposure).toBe(70);
        expect(g.finalWindowExposureTarget).toBe(85);
        expect(g.voteBeforeFinalWindow).toBe(true);
        expect(g.voteBeforeFinalWindowLeadMin).toBe(20);

        // Legacy keys are gone.
        for (const oldKey of [
            'useLastHourExposure',
            'lastHourExposure',
            'lastHourExposureTarget',
            'voteBeforeLastHour',
            'voteBeforeLastHourLeadMin',
        ]) {
            expect(Object.prototype.hasOwnProperty.call(g, oldKey)).toBe(false);
        }

        expect(loaded._finalWindowExposureRenamedV1).toBe(true);
    });

    test('renames legacy keys in a per-challenge override scope', () => {
        setSettingsFile(
            buildFixture({
                perChallenge: { 42: { lastHourExposure: 55, lastHourExposureTarget: 90 } },
            }),
        );

        const loaded = settings.loadSettings();
        const override = loaded.challengeSettings.perChallenge[42];

        expect(override.finalWindowExposure).toBe(55);
        expect(override.finalWindowExposureTarget).toBe(90);
        expect(Object.prototype.hasOwnProperty.call(override, 'lastHourExposure')).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(override, 'lastHourExposureTarget')).toBe(false);
    });

    test('renames legacy keys inside a named profile, skipping reserved profile names', () => {
        setSettingsFile(
            buildFixture({
                profiles: {
                    aggressive: { useLastHourExposure: true, lastHourExposure: 40 },
                    // Reserved name must never be walked (prototype-pollution guard).
                    __proto__: { lastHourExposure: 1 },
                },
            }),
        );

        const loaded = settings.loadSettings();
        const profile = loaded.challengeSettings.profiles.aggressive;

        expect(profile.useFinalWindowExposure).toBe(true);
        expect(profile.finalWindowExposure).toBe(40);
        expect(Object.prototype.hasOwnProperty.call(profile, 'useLastHourExposure')).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(profile, 'lastHourExposure')).toBe(false);
    });

    test('does not clobber an existing new-key value but still deletes the legacy key', () => {
        setSettingsFile(
            buildFixture({
                // Both old and new present (partial migration / new write alongside
                // a stale legacy key): the new value wins, the old key is dropped.
                globalDefaults: { lastHourExposure: 30, finalWindowExposure: 65 },
            }),
        );

        const loaded = settings.loadSettings();
        const g = loaded.challengeSettings.globalDefaults;

        expect(g.finalWindowExposure).toBe(65);
        expect(Object.prototype.hasOwnProperty.call(g, 'lastHourExposure')).toBe(false);
    });

    test('is idempotent: a second load of the fully-migrated file writes nothing new', () => {
        setSettingsFile(
            buildFixture({
                globalDefaults: { lastHourExposure: 70 },
            }),
        );
        settings.loadSettings();
        const firstWrites = fs.writeFileSync.mock.calls.length;

        setSettingsFile({
            challengeSettings: {
                globalDefaults: { finalWindowExposure: 70 },
                perChallenge: {},
            },
            ...ALL_MIGRATION_FLAGS,
        });

        settings.loadSettings();
        const secondWrites = fs.writeFileSync.mock.calls.length;

        expect(secondWrites).toBe(firstWrites); // no new migration writes
    });

    test('does not re-rename when the flag is already true even if a legacy key is present', () => {
        setSettingsFile({
            challengeSettings: {
                globalDefaults: { lastHourExposure: 70 },
                perChallenge: {},
            },
            ...ALL_MIGRATION_FLAGS,
        });

        const loaded = settings.loadSettings();
        const g = loaded.challengeSettings.globalDefaults;

        // Flag already set → migration is a no-op: the legacy key survives untouched.
        expect(g.lastHourExposure).toBe(70);
        expect(g.finalWindowExposure).toBeUndefined();
    });

    test('persists the rename result (flag + new key) via writeFileSync', () => {
        setSettingsFile(
            buildFixture({
                globalDefaults: { lastHourExposure: 70 },
            }),
        );

        settings.loadSettings();

        const calls = fs.writeFileSync.mock.calls;
        let persisted = null;
        for (let i = calls.length - 1; i >= 0; i -= 1) {
            const [, body] = calls[i];
            if (typeof body === 'string' && body.includes('_finalWindowExposureRenamedV1')) {
                persisted = JSON.parse(body);
                break;
            }
        }
        expect(persisted).not.toBeNull();
        expect(persisted._finalWindowExposureRenamedV1).toBe(true);
        expect(persisted.challengeSettings.globalDefaults.finalWindowExposure).toBe(70);
        expect(persisted.challengeSettings.globalDefaults.lastHourExposure).toBeUndefined();
    });
});
