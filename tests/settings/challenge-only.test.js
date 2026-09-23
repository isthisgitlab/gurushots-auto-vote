/**
 * challengeOnly settings (the currency automation toggles): they have NO global
 * value. A stored global value is ignored, setGlobalDefault refuses them, and
 * only a per-challenge override or a title profile can turn them on — spending
 * currency is always an explicit per-challenge / per-profile choice.
 *
 * Drives the in-memory headless-store seam (same as override-auto-clear.test.js)
 * so the facade's loadSettings/saveSettings round-trip without touching fs.
 */

const settings = require('../../src/js/settings');

describe('challengeOnly settings', () => {
    let store;
    const challengeId = '4242';

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
        settings.rememberChallengeTitles([]);
    });

    afterEach(() => {
        delete globalThis.__GS_HEADLESS__;
        delete globalThis.AndroidHeadlessStore;
    });

    test('the schema marks every currency-automation toggle challengeOnly, and reserves global-only', () => {
        const { SETTINGS_SCHEMA } = settings;
        for (const key of ['autoKeyUnlock', 'autoSwap', 'autoExposureFill', 'autoSwapImageIndex']) {
            expect(SETTINGS_SCHEMA[key]).toMatchObject({ perChallenge: true, challengeOnly: true });
        }
        expect(SETTINGS_SCHEMA.currencyReserveKeys.perChallenge).toBe(false);
        expect(SETTINGS_SCHEMA.currencyReserveKeys.challengeOnly).toBeUndefined();
    });

    test('setGlobalDefault refuses a challengeOnly key', () => {
        expect(settings.setGlobalDefault('autoKeyUnlock', true)).toBe(false);
        expect(settings.getGlobalDefault('autoKeyUnlock')).toBe(false);
        expect(settings.getEffectiveSetting('autoKeyUnlock', challengeId)).toBe(false);
    });

    test('a stored global value (hand-edited / older build) is ignored everywhere', () => {
        settings.setGlobalDefault('exposure', 90);
        const raw = JSON.parse(store.value);
        raw.challengeSettings.globalDefaults.autoKeyUnlock = true;
        store.value = JSON.stringify(raw);

        expect(settings.getGlobalDefault('autoKeyUnlock')).toBe(false);
        expect(settings.getEffectiveSetting('autoKeyUnlock', challengeId)).toBe(false);
        expect(settings.getEffectiveSetting('autoKeyUnlock')).toBe(false);
        // Setting it on the challenge stores a real override (the inherited
        // baseline is the schema default, not the ignored global value).
        expect(settings.setChallengeOverride('autoKeyUnlock', challengeId, true)).toBe(true);
        expect(settings.getChallengeOverride('autoKeyUnlock', challengeId)).toBe(true);
    });

    test('a per-challenge override turns it on for that challenge only', () => {
        expect(settings.setChallengeOverride('autoSwap', challengeId, true)).toBe(true);
        expect(settings.getEffectiveSetting('autoSwap', challengeId)).toBe(true);
        expect(settings.getEffectiveSetting('autoSwap', '9999')).toBe(false);
    });

    test('a title profile turns it on for its title', () => {
        expect(settings.saveChallengeProfile('Flash Fill', { autoExposureFill: true, autoExposureFillBelow: 40 })).toBe(
            true,
        );
        expect(
            settings.setTitleRules([
                { title: 'Flash Frenzy', profile: 'Flash Fill', mustIncludeTags: [], shouldIncludeTags: [] },
            ]),
        ).toBe(true);
        settings.rememberChallengeTitles([{ id: challengeId, title: 'Flash Frenzy' }]);

        expect(settings.getEffectiveSetting('autoExposureFill', challengeId)).toBe(true);
        expect(settings.getEffectiveSetting('autoExposureFillBelow', challengeId)).toBe(40);
        expect(settings.getEffectiveSetting('autoExposureFill', '9999')).toBe(false);
    });
});
