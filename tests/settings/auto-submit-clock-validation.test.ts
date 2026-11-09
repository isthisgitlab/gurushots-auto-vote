import type * as schemaModule from '../../src/ts/core/settings/schema';

const { SETTINGS_SCHEMA, validateSetting } = require('../../src/ts/core/settings/schema') as typeof schemaModule;

describe('Auto-Submit clock settings', () => {
    test('are per-challenge settings with the approved defaults and editor types', () => {
        expect(SETTINGS_SCHEMA.autoSubmitTime).toMatchObject({
            type: 'timeOfDayList',
            default: [],
            perChallenge: true,
            group: 'autoSubmit',
        });
        expect(SETTINGS_SCHEMA.autoSubmitWindowMinutes).toMatchObject({
            type: 'number',
            default: 60,
            min: 5,
            max: 720,
            perChallenge: true,
            group: 'autoSubmit',
        });
    });

    test('validates the reusable HH:MM list and window bounds', () => {
        expect(validateSetting('autoSubmitTime', ['08:20', '23:59'])).toBe(true);
        expect(validateSetting('autoSubmitTime', ['08:20', '08:20'])).toBe(false);
        expect(validateSetting('autoSubmitTime', ['8:20'])).toBe(false);
        expect(validateSetting('autoSubmitWindowMinutes', 5)).toBe(true);
        expect(validateSetting('autoSubmitWindowMinutes', 720)).toBe(true);
        expect(validateSetting('autoSubmitWindowMinutes', 4)).toBe(false);
        expect(validateSetting('autoSubmitWindowMinutes', 721)).toBe(false);
    });
});
