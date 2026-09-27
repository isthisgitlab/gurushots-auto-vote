/**
 * Every schema default is a valid value for its key, which is what lets
 * schemaDefault() type a default as that key's value.
 */

import type * as schemaModule from '../../src/js/settings/schema';
import type { SettingKey } from '../../src/js/settings/schema';
import type * as defaultsModule from '../../src/js/settings/defaults';

const { SETTINGS_SCHEMA, schemaDefault }: typeof schemaModule = require('../../src/js/settings/schema');

describe('schema defaults', () => {
    test.each(Object.keys(SETTINGS_SCHEMA) as SettingKey[])('%s: the default passes its own validation', (key) => {
        const { validation, default: fallback } = SETTINGS_SCHEMA[key];
        expect(validation.safeParse(fallback).success).toBe(true);
        expect(schemaDefault(key)).toBe(fallback);
    });

    test('an unknown key has no default', () => {
        expect(schemaDefault('noSuchSetting')).toBeUndefined();
    });
});

describe('challengeValueSetIsValid', () => {
    const {
        challengeValueSetIsValid,
        getDefaultSettings,
    }: typeof defaultsModule = require('../../src/js/settings/defaults');

    test('a candidate key the schema does not know is not validated', () => {
        const values = getDefaultSettings().challengeSettings.globalDefaults;
        expect(challengeValueSetIsValid({ ...values, noSuchSetting: 'x' }, { noSuchSetting: 'x' })).toBe(true);
    });
});
