/**
 * The challengeOnly schema flag: a flagged key has NO global value. A stored
 * global value is ignored, setGlobalDefault refuses it, and only a
 * per-challenge override or a title profile can change it. No shipped key
 * carries the flag today, so each case temporarily flags `autoSwap`.
 *
 * Drives the in-memory headless-store seam (same as override-auto-clear.test.js)
 * so the facade's loadSettings/saveSettings round-trip without touching fs.
 */

const settings = require('../../src/js/settings');

describe('challengeOnly settings', () => {
    const { SETTINGS_SCHEMA } = settings;
    const challengeId = '4242';
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
        settings.rememberChallengeTitles([]);
        SETTINGS_SCHEMA.autoSwap.challengeOnly = true;
    });
    afterEach(() => {
        delete SETTINGS_SCHEMA.autoSwap.challengeOnly;
        delete globalThis.__GS_HEADLESS__;
        delete globalThis.AndroidHeadlessStore;
    });

    test('setGlobalDefault refuses a challengeOnly key', () => {
        expect(settings.setGlobalDefault('autoSwap', true)).toBe(false);
        expect(settings.getGlobalDefault('autoSwap')).toBe(false);
        expect(settings.getEffectiveSetting('autoSwap', challengeId)).toBe(false);
    });

    test('a stored global value (hand-edited / older build) is ignored everywhere', () => {
        settings.setGlobalDefault('exposure', 90);
        const raw = JSON.parse(store.value);
        raw.challengeSettings.globalDefaults.autoSwap = true;
        store.value = JSON.stringify(raw);
        expect(settings.getGlobalDefault('autoSwap')).toBe(false);
        expect(settings.getEffectiveSetting('autoSwap', challengeId)).toBe(false);
        expect(settings.getEffectiveSetting('autoSwap')).toBe(false);
        // The inherited baseline is the schema default, not the ignored global
        // value, so enabling it on the challenge stores a real override.
        expect(settings.setChallengeOverride('autoSwap', challengeId, true)).toBe(true);
        expect(settings.getChallengeOverride('autoSwap', challengeId)).toBe(true);
        expect(settings.getEffectiveSetting('autoSwap', '9999')).toBe(false);
    });
});
