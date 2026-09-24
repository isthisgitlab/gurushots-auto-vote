/**
 * The declared min/max on number settings must agree with their zod validators.
 *
 * The IPC schema projection forwards min, max and unit, and SettingInput renders them as
 * the input's bounds. They are declared by hand alongside the validator, which means they
 * can drift from it. This suite pins them together: whatever a setting advertises as its
 * range must be exactly what saving actually accepts.
 */

const { SETTINGS_SCHEMA, validateSetting } = require('../../src/js/settings/schema');

const numberSettings = Object.entries(SETTINGS_SCHEMA).filter(([, config]) => config.type === 'number');

describe('number settings advertise bounds', () => {
    test('there is at least one, so the suite cannot silently pass on an empty list', () => {
        expect(numberSettings.length).toBeGreaterThan(0);
    });

    test.each(numberSettings)('%s declares a numeric min', (_key, config) => {
        expect(typeof config.min).toBe('number');
    });

    // The entry-slot indexes are deliberately unitless — "slot 2" needs no suffix. Every
    // other number setting is a percentage or a duration and is unreadable without one.
    const UNITLESS = new Set(['boostImageIndex', 'turboImageIndex', 'autoSwapImageIndex']);

    test.each(numberSettings.filter(([key]) => !UNITLESS.has(key)))('%s declares a unit', (_key, config) => {
        expect(typeof config.unit).toBe('string');
    });

    test.each(numberSettings.filter(([key]) => UNITLESS.has(key)))(
        '%s stays unitless and bounded to the four real entry slots',
        (_key, config) => {
            expect(config.unit).toBeUndefined();
            // 0 is the "last entry" sentinel; 1-4 are the only slots a challenge can have.
            expect(config.min).toBe(0);
            expect(config.max).toBe(4);
        },
    );
});

describe('declared bounds match what validation accepts', () => {
    test.each(numberSettings)('%s accepts its own min and max', (key, config) => {
        expect(validateSetting(key, config.min)).toBe(true);
        if (typeof config.max === 'number') {
            expect(validateSetting(key, config.max)).toBe(true);
        }
    });

    test.each(numberSettings)('%s rejects one step outside its declared range', (key, config) => {
        expect(validateSetting(key, config.min - 1)).toBe(false);
        if (typeof config.max === 'number') {
            expect(validateSetting(key, config.max + 1)).toBe(false);
        }
    });

    test.each(numberSettings)('%s accepts its own default', (key, config) => {
        // A default the UI would immediately flag as out of range would be a contradiction.
        expect(validateSetting(key, config.default)).toBe(true);
        expect(config.default).toBeGreaterThanOrEqual(config.min);
        if (typeof config.max === 'number') {
            expect(config.default).toBeLessThanOrEqual(config.max);
        }
    });
});
