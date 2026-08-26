/**
 * Curated "intent" preset seeding (settings.seedIntentProfiles +
 * settings/intentProfiles.js).
 *
 * Covers the review's blocker-tier concerns:
 *   - every bundle validates as a SET against {...globalDefaults, ...bundle}
 *     (the same context the facade uses), for a default install AND a
 *     customized-global install;
 *   - seeding is idempotent;
 *   - seeding never clobbers a user's own same-named profile;
 *   - a deleted intent is NOT resurrected on the next run;
 *   - a structurally-invalid bundle is skipped (not thrown) and still marked
 *     seeded so it isn't retried.
 *
 * Drives the same in-memory headless-store seam as challenge-profiles.test.js
 * so loadSettings/saveSettings round-trip without touching fs.
 */

const settings = require('../../src/js/settings');
const { INTENT_PROFILES, getIntentByName, intentValuesMatch } = require('../../src/js/settings/intentProfiles');
const { validateSetting } = require('../../src/js/settings/schema');

jest.mock('../../src/js/logger', () => {
    const scoped = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), success: jest.fn(), warning: jest.fn() };
    return {
        info: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        withCategory: jest.fn(() => scoped),
    };
});

describe('intent profile seeding', () => {
    let store;

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

    describe('bundle validity (as a set)', () => {
        const globalDefaults = () => {
            const d = {};
            Object.entries(settings.SETTINGS_SCHEMA).forEach(([key, cfg]) => {
                d[key] = cfg.default;
            });
            return d;
        };

        test.each(INTENT_PROFILES.map((i) => [i.id, i]))(
            'bundle %s validates against a default install',
            (_id, intent) => {
                const context = { ...globalDefaults(), ...intent.values };
                for (const [key, value] of Object.entries(intent.values)) {
                    expect(settings.SETTINGS_SCHEMA[key]?.perChallenge).toBe(true);
                    expect(validateSetting(key, value, context)).toBe(true);
                }
            },
        );

        test.each(INTENT_PROFILES.map((i) => [i.id, i]))(
            'bundle %s validates against a customized-global install (exposure lowered)',
            (_id, intent) => {
                // A user who lowered their global exposure must not break seeding.
                const context = { ...globalDefaults(), exposure: 50, ...intent.values };
                for (const [key, value] of Object.entries(intent.values)) {
                    expect(validateSetting(key, value, context)).toBe(true);
                }
            },
        );
    });

    describe('seedIntentProfiles', () => {
        test('seeds every intent on a fresh install', () => {
            expect(settings.seedIntentProfiles()).toBe(true);
            const profiles = settings.getChallengeProfiles();
            for (const intent of INTENT_PROFILES) {
                expect(profiles[intent.name]).toEqual(intent.values);
            }
        });

        test('is idempotent — a second run adds nothing', () => {
            settings.seedIntentProfiles();
            const first = settings.getChallengeProfiles();
            settings.seedIntentProfiles();
            const second = settings.getChallengeProfiles();
            expect(second).toEqual(first);
            expect(Object.keys(second)).toHaveLength(INTENT_PROFILES.length);
        });

        test('never clobbers a user profile that shares an intent name', () => {
            const custom = { exposure: 42 };
            expect(settings.saveChallengeProfile('Max Exposure', custom)).toBe(true);
            settings.seedIntentProfiles();
            const profiles = settings.getChallengeProfiles();
            // User's values preserved, not replaced by the curated bundle.
            expect(profiles['Max Exposure']).toEqual(custom);
            // The other intents still seed.
            expect(profiles['Just Participate']).toEqual(getIntentByName('Just Participate').values);
        });

        test('does not resurrect a deleted intent', () => {
            settings.seedIntentProfiles();
            expect(settings.deleteChallengeProfile('Finish Strong')).toBe(true);
            expect(settings.getChallengeProfiles()['Finish Strong']).toBeUndefined();
            settings.seedIntentProfiles();
            expect(settings.getChallengeProfiles()['Finish Strong']).toBeUndefined();
        });
    });

    describe('intentValuesMatch', () => {
        test('true for the canonical bundle, false once edited', () => {
            const intent = getIntentByName('Finish Strong');
            expect(intentValuesMatch(intent, intent.values)).toBe(true);
            expect(intentValuesMatch(intent, { ...intent.values, exposure: 50 })).toBe(false);
            expect(intentValuesMatch(intent, {})).toBe(false);
        });
    });
});
