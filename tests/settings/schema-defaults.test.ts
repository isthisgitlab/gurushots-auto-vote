/**
 * Every schema default is a valid value for its key, which is what lets
 * schemaDefault() type a default as that key's value.
 */

import type * as schemaModule from '../../src/ts/core/settings/schema';
import type { SettingKey } from '../../src/ts/core/settings/schema';
import type * as defaultsModule from '../../src/ts/core/settings/defaults';

const { SETTINGS_SCHEMA, schemaDefault } = require('../../src/ts/core/settings/schema') as typeof schemaModule;

describe('schema defaults', () => {
    test('short challenge immediate join is a global boolean that defaults to false', () => {
        const entry = SETTINGS_SCHEMA.autoJoinShortChallengesImmediately;
        expect(entry.default).toBe(false);
        expect(entry.perChallenge).toBe(false);
        expect(entry.validation.safeParse(true).success).toBe(true);
        expect(entry.validation.safeParse(false).success).toBe(true);
        expect(entry.validation.safeParse('true').success).toBe(false);
        expect(entry.validation.safeParse(1).success).toBe(false);
    });
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
    const { challengeValueSetIsValid, schemaDefaults } =
        require('../../src/ts/core/settings/defaults') as typeof defaultsModule;

    test('a candidate key the schema does not know is not validated', () => {
        const values = schemaDefaults();
        expect(challengeValueSetIsValid({ ...values, noSuchSetting: 'x' }, { noSuchSetting: 'x' })).toBe(true);
    });
});
