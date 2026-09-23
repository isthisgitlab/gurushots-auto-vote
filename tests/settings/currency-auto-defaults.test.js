/**
 * Currency automation inherits global defaults, with title profiles and
 * challenge overrides taking precedence. Use the in-memory headless store so
 * reads and writes exercise the real settings facade without touching disk.
 */

const settings = require('../../src/js/settings');
const { resolveCurrencyAuto } = require('../../src/js/scheduling/nodeResolvers');

describe('currency automation defaults', () => {
    let store;
    const challengeId = '4242';

    beforeEach(() => {
        globalThis.__GS_HEADLESS__ = true;
        store = {
            value: null,
            read: jest.fn(() => store.value),
            write: jest.fn((data) => {
                store.value = data;
            }),
        };
        globalThis.AndroidHeadlessStore = store;
        settings.rememberChallengeTitles([]);
    });

    afterEach(() => {
        delete globalThis.__GS_HEADLESS__;
        delete globalThis.AndroidHeadlessStore;
    });

    test('every currency rule has a global default and a per-challenge override', () => {
        const currencyRules = Object.entries(settings.SETTINGS_SCHEMA).filter(
            ([, config]) => config.group === 'currencyAuto' && config.perChallenge,
        );
        expect(currencyRules).toHaveLength(19);
        for (const [, config] of currencyRules) {
            expect(config.challengeOnly).not.toBe(true);
        }
        for (const key of ['currencyReserveKeys', 'currencyReserveSwaps', 'currencyReserveFills']) {
            expect(settings.SETTINGS_SCHEMA[key].perChallenge).toBe(false);
        }
    });

    test.each(['autoKeyUnlock', 'autoSwap', 'autoExposureFill'])(
        '%s can be enabled globally and disabled for one challenge',
        (key) => {
            expect(settings.getEffectiveSetting(key, challengeId)).toBe(false);
            expect(settings.setGlobalDefault(key, true)).toBe(true);
            expect(settings.getGlobalDefault(key)).toBe(true);
            expect(settings.getEffectiveSetting(key, challengeId)).toBe(true);
            expect(settings.getEffectiveSetting(key, '9999')).toBe(true);

            expect(settings.setChallengeOverride(key, challengeId, false)).toBe(true);
            expect(settings.getEffectiveSetting(key, challengeId)).toBe(false);
            expect(settings.getEffectiveSetting(key, '9999')).toBe(true);

            expect(settings.removeChallengeOverride(key, challengeId)).toBe(true);
            expect(settings.getEffectiveSetting(key, challengeId)).toBe(true);
        },
    );

    test('global timing and action limits reach the scheduler and can be overridden', () => {
        expect(settings.setGlobalDefault('autoSwap', true)).toBe(true);
        expect(settings.setGlobalDefault('autoSwapAfterStart', 3600)).toBe(true);
        expect(settings.setGlobalDefault('autoSwapMax', 2)).toBe(true);

        expect(resolveCurrencyAuto(challengeId).swap).toEqual({
            afterStartSec: 3600,
            beforeEndSec: 0,
            afterPercent: 0,
        });
        expect(settings.getEffectiveSetting('autoSwapMax', challengeId)).toBe(2);

        expect(settings.setChallengeOverride('autoSwapAfterStart', challengeId, 7200)).toBe(true);
        expect(resolveCurrencyAuto(challengeId).swap.afterStartSec).toBe(7200);
        expect(resolveCurrencyAuto('9999').swap.afterStartSec).toBe(3600);
    });

    test('a title profile takes precedence over globals, and a challenge override takes precedence over it', () => {
        expect(settings.setGlobalDefault('autoExposureFill', true)).toBe(true);
        expect(settings.setGlobalDefault('autoExposureFillBelow', 50)).toBe(true);
        expect(
            settings.saveChallengeProfile('Flash Fill', { autoExposureFill: false, autoExposureFillBelow: 40 }),
        ).toBe(true);
        expect(
            settings.setTitleRules([
                { title: 'Flash Frenzy', profile: 'Flash Fill', mustIncludeTags: [], shouldIncludeTags: [] },
            ]),
        ).toBe(true);
        settings.rememberChallengeTitles([{ id: challengeId, title: 'Flash Frenzy' }]);

        expect(settings.getEffectiveSetting('autoExposureFill', challengeId)).toBe(false);
        expect(settings.getEffectiveSetting('autoExposureFillBelow', challengeId)).toBe(40);
        expect(settings.getEffectiveSetting('autoExposureFill', '9999')).toBe(true);
        expect(resolveCurrencyAuto(challengeId).fill).toBeNull();

        expect(settings.setChallengeOverride('autoExposureFill', challengeId, true)).toBe(true);
        expect(settings.getEffectiveSetting('autoExposureFill', challengeId)).toBe(true);
        expect(resolveCurrencyAuto(challengeId).fill).not.toBeNull();
    });
});
