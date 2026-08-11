/**
 * Scalar→list migration for the scheduled-fill triggers
 * (_scheduledFillListsMigratedV1) plus the one-time bounds pass
 * (_scheduledFillListBoundsV1).
 *
 * The off-sentinel handling is scope-dependent and load-bearing:
 * globalDefaults may delete ''/0 (getGlobalDefault falls back to the []
 * schema default), but perChallenge overrides and profiles must convert
 * ''/0 to [] IN PLACE — deleting an explicit opt-out would let the global
 * default shine through and silently re-enable filling. Drives the
 * in-memory headless-store seam so loadSettings round-trips without fs.
 */

const settings = require('../../src/js/settings');

jest.mock('../../src/js/logger', () => ({
    info: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    isDevMode: jest.fn(() => false),
    isSourceCode: jest.fn(() => true),
    getAppName: jest.fn(() => 'gurushots-auto-vote-dev'),
    withCategory: jest.fn(() => ({
        info: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        success: jest.fn(),
        warning: jest.fn(),
    })),
}));

describe('scheduled-fill scalar→list migration', () => {
    let store;

    const seed = (challengeSettings) => {
        store.value = JSON.stringify({ challengeSettings });
    };
    const loaded = () => settings.loadSettings();

    beforeEach(() => {
        globalThis.__GS_HEADLESS__ = true;
        store = {
            value: null,
            read: jest.fn(() => store.value),
            write: jest.fn((d) => {
                store.value = d;
            }),
        };
        globalThis.AndroidHeadlessStore = store;
    });

    afterEach(() => {
        delete globalThis.__GS_HEADLESS__;
        delete globalThis.AndroidHeadlessStore;
    });

    test('valid scalars become one-element arrays in all three scope families', () => {
        seed({
            globalDefaults: { scheduledFillTime: '21:30', scheduledFillBeforeEnd: 7200 },
            perChallenge: { 123: { scheduledFillTime: '09:00', scheduledFillBeforeEnd: 14400 } },
            profiles: { 'night tactic': { scheduledFillTime: '22:15', scheduledFillBeforeEnd: 36000 } },
        });
        const merged = loaded();

        expect(merged.challengeSettings.globalDefaults.scheduledFillTime).toEqual(['21:30']);
        expect(merged.challengeSettings.globalDefaults.scheduledFillBeforeEnd).toEqual([7200]);
        expect(merged.challengeSettings.perChallenge['123'].scheduledFillTime).toEqual(['09:00']);
        expect(merged.challengeSettings.perChallenge['123'].scheduledFillBeforeEnd).toEqual([14400]);
        expect(merged.challengeSettings.profiles['night tactic'].scheduledFillTime).toEqual(['22:15']);
        expect(merged.challengeSettings.profiles['night tactic'].scheduledFillBeforeEnd).toEqual([36000]);
        expect(merged._scheduledFillListsMigratedV1).toBe(true);
    });

    test('off-sentinels: deleted in globalDefaults, [] IN PLACE in perChallenge and profiles', () => {
        seed({
            globalDefaults: { scheduledFillTime: '', scheduledFillBeforeEnd: 0 },
            perChallenge: { 123: { scheduledFillTime: '', scheduledFillBeforeEnd: 0 } },
            profiles: { off: { scheduledFillTime: '', scheduledFillBeforeEnd: 0 } },
        });
        const merged = loaded();

        expect('scheduledFillTime' in merged.challengeSettings.globalDefaults).toBe(false);
        expect('scheduledFillBeforeEnd' in merged.challengeSettings.globalDefaults).toBe(false);
        expect(merged.challengeSettings.perChallenge['123'].scheduledFillTime).toEqual([]);
        expect(merged.challengeSettings.perChallenge['123'].scheduledFillBeforeEnd).toEqual([]);
        expect(merged.challengeSettings.profiles.off.scheduledFillTime).toEqual([]);
        expect(merged.challengeSettings.profiles.off.scheduledFillBeforeEnd).toEqual([]);
    });

    test('regression lock: a per-challenge opt-out under a global time must NOT start filling', () => {
        seed({
            globalDefaults: { scheduledFillTime: '21:30' },
            perChallenge: { 123: { scheduledFillTime: '' } },
        });
        loaded();

        // The override survives as an explicit [] — so the effective value for
        // challenge 123 is "off", not the migrated global ['21:30'].
        expect(settings.getChallengeOverride('scheduledFillTime', '123')).toEqual([]);
        expect(settings.getEffectiveSetting('scheduledFillTime', '123')).toEqual([]);
        // Unrelated challenges still inherit the migrated global.
        expect(settings.getEffectiveSetting('scheduledFillTime', '999')).toEqual(['21:30']);
    });

    test("a profile's explicit off keeps enforcing off when applied after migration", () => {
        seed({
            globalDefaults: { scheduledFillTime: '21:30' },
            profiles: { 'no-times': { scheduledFillTime: '' } },
        });
        loaded();

        expect(settings.getChallengeProfiles()['no-times'].scheduledFillTime).toEqual([]);
        expect(settings.applyChallengeProfile('no-times', '123')).toBe(true);
        expect(settings.getEffectiveSetting('scheduledFillTime', '123')).toEqual([]);
    });

    test('corrupt scalars are deleted in every scope (they never expressed working intent)', () => {
        seed({
            globalDefaults: { scheduledFillTime: '25:99' },
            perChallenge: { 123: { scheduledFillTime: 'tomorrow', scheduledFillBeforeEnd: -5 } },
            profiles: { bad: { scheduledFillBeforeEnd: 3.7 } },
        });
        const merged = loaded();

        expect('scheduledFillTime' in merged.challengeSettings.globalDefaults).toBe(false);
        expect('scheduledFillTime' in merged.challengeSettings.perChallenge['123']).toBe(false);
        expect('scheduledFillBeforeEnd' in merged.challengeSettings.perChallenge['123']).toBe(false);
        expect('scheduledFillBeforeEnd' in merged.challengeSettings.profiles.bad).toBe(false);
    });

    test('already-array values are untouched and the migration is idempotent', () => {
        seed({
            globalDefaults: { scheduledFillTime: ['09:00', '21:30'], scheduledFillBeforeEnd: [14400, 36000] },
        });
        const first = loaded();
        expect(first.challengeSettings.globalDefaults.scheduledFillTime).toEqual(['09:00', '21:30']);
        expect(first._scheduledFillListsMigratedV1).toBe(true);
        expect(first._scheduledFillListBoundsV1).toBe(true);

        // Second load: flags short-circuit, values stable.
        const second = loaded();
        expect(second.challengeSettings.globalDefaults.scheduledFillTime).toEqual(['09:00', '21:30']);
        expect(second.challengeSettings.globalDefaults.scheduledFillBeforeEnd).toEqual([14400, 36000]);
    });

    test('prototype-shaped profile names are skipped by the walk', () => {
        seed({
            profiles: { constructor: { scheduledFillTime: '21:30' }, ok: { scheduledFillTime: '21:30' } },
        });
        const merged = loaded();
        // The reserved name's values are left untouched (never visited)...
        expect(merged.challengeSettings.profiles.constructor.scheduledFillTime).toBe('21:30');
        // ...while the normal profile migrates.
        expect(merged.challengeSettings.profiles.ok.scheduledFillTime).toEqual(['21:30']);
    });
});

describe('scheduled-fill list bounds pass', () => {
    let store;

    const seed = (challengeSettings, extra = {}) => {
        store.value = JSON.stringify({ challengeSettings, ...extra });
    };

    beforeEach(() => {
        globalThis.__GS_HEADLESS__ = true;
        store = {
            value: null,
            read: jest.fn(() => store.value),
            write: jest.fn((d) => {
                store.value = d;
            }),
        };
        globalThis.AndroidHeadlessStore = store;
    });

    afterEach(() => {
        delete globalThis.__GS_HEADLESS__;
        delete globalThis.AndroidHeadlessStore;
    });

    test('heals a profile array with one invalid entry instead of losing the key (the silent-vanish bug)', () => {
        seed({
            profiles: { tactic: { scheduledFillBeforeEnd: [3600, -5] } },
        });
        const merged = settings.loadSettings();

        expect(merged.challengeSettings.profiles.tactic.scheduledFillBeforeEnd).toEqual([3600]);
        // And the profile read path (which drops schema-invalid values) now
        // sees a valid array, so the key survives into the profile view.
        expect(settings.getChallengeProfiles().tactic.scheduledFillBeforeEnd).toEqual([3600]);
    });

    test('dedupes, sorts, and caps with the earliest/smallest surviving', () => {
        seed({
            globalDefaults: {
                scheduledFillTime: ['23:00', '22:00', '21:00', '20:00', '19:00', '18:00', '01:00', '21:00'],
                scheduledFillBeforeEnd: [700, 600, 500, 400, 300, 200, 100],
            },
        });
        const merged = settings.loadSettings();

        expect(merged.challengeSettings.globalDefaults.scheduledFillTime).toEqual([
            '01:00',
            '18:00',
            '19:00',
            '20:00',
            '21:00',
            '22:00',
        ]);
        expect(merged.challengeSettings.globalDefaults.scheduledFillBeforeEnd).toEqual([100, 200, 300, 400, 500, 600]);
    });

    test('pre-flag, a non-string/number/array corrupt value is deleted by the lists migration', () => {
        seed({
            globalDefaults: { scheduledFillTime: true },
        });
        const merged = settings.loadSettings();
        expect('scheduledFillTime' in merged.challengeSettings.globalDefaults).toBe(false);
    });

    test('steady state: with both flags set, an out-of-order list is NOT re-sorted on load', () => {
        // The sanitizer must stay a one-time flag-gated pass, never a
        // standing per-load invariant — a regression re-running it on every
        // load would silently reorder user-saved values.
        seed(
            { globalDefaults: { scheduledFillTime: ['21:30', '09:00'] } },
            { _scheduledFillListsMigratedV1: true, _scheduledFillListBoundsV1: true },
        );
        const merged = settings.loadSettings();
        expect(merged.challengeSettings.globalDefaults.scheduledFillTime).toEqual(['21:30', '09:00']);
    });

    test('post-flag, a hand-edited non-array value is left as-is (documented gap — write path rejects it)', () => {
        // Both flags already set: neither migration runs again, and the
        // sanitizer's non-array contract returns null (untouched). This is
        // the accepted-risk class the sanitizer comment documents.
        seed(
            { globalDefaults: { scheduledFillTime: true } },
            { _scheduledFillListsMigratedV1: true, _scheduledFillListBoundsV1: true },
        );
        const merged = settings.loadSettings();
        expect(merged.challengeSettings.globalDefaults.scheduledFillTime).toBe(true);
    });
});
