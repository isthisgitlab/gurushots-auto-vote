/**
 * Leftover edge branches of settings/schema.ts (validation fallbacks) and
 * settings/intentProfiles.ts (name lookup / bundle comparison guards).
 */

import type * as zodModule from 'zod';
import type * as schemaModule from '../../src/js/settings/schema';
import type * as intentProfilesModule from '../../src/js/settings/intentProfiles';
import { invalid } from '../helpers/invalid';

const { z } = require('zod') as typeof zodModule;
const { SETTINGS_SCHEMA, validateSetting, getValidationError } =
    require('../../src/js/settings/schema') as typeof schemaModule;
const { INTENT_PROFILES, getIntentByName, intentValuesMatch } =
    require('../../src/js/settings/intentProfiles') as typeof intentProfilesModule;

describe('schema validation fallbacks', () => {
    test('an unknown key is always valid and has no error', () => {
        expect(validateSetting('noSuchKey', 'anything')).toBe(true);
        expect(getValidationError('noSuchKey', 'anything', { exposure: 1 })).toBeNull();
    });

    test('finalWindowExposureTarget falls back to the schema trigger when the context trigger is unusable', () => {
        const fallbackTrigger = SETTINGS_SCHEMA.finalWindowExposure.default;
        for (const badTrigger of ['90', 0, 101, null]) {
            const ctx = { finalWindowExposure: badTrigger };
            expect(validateSetting('finalWindowExposureTarget', fallbackTrigger, ctx)).toBe(true);
            if (fallbackTrigger > 1) {
                expect(validateSetting('finalWindowExposureTarget', fallbackTrigger - 1, ctx)).toBe(false);
                expect(getValidationError('finalWindowExposureTarget', fallbackTrigger - 1, ctx)).toBe(
                    `VALIDATION_GREATER_OR_EQUAL|app.finalWindowExposure|${fallbackTrigger}`,
                );
            }
        }
        // A usable trigger is honoured as-is.
        expect(getValidationError('finalWindowExposureTarget', 40, { finalWindowExposure: 50 })).toBe(
            'VALIDATION_GREATER_OR_EQUAL|app.finalWindowExposure|50',
        );
    });

    describe('generic messages for schema entries without specific ones', () => {
        // Every shipped entry carries a descriptive zod message and a
        // getContextError, so the generic fallbacks are exercised through a
        // temporary entry registered for the duration of each test.
        const KEY = '__coverageProbe__';
        afterEach(() => {
            delete invalid<Record<string, unknown>>(SETTINGS_SCHEMA)[KEY];
        });

        test("zod's generic 'Invalid input' refine message is reported as 'Invalid value'", () => {
            invalid<Record<string, unknown>>(SETTINGS_SCHEMA)[KEY] = {
                default: 1,
                validation: z.number().refine((v) => v > 0),
            };
            expect(getValidationError(KEY, -1)).toBe('Invalid value');
            expect(getValidationError(KEY, 'x')).not.toBe('Invalid value');
            expect(getValidationError(KEY, 5)).toBeNull();
        });

        test('a failing contextValidation without getContextError reports a generic context error', () => {
            invalid<Record<string, unknown>>(SETTINGS_SCHEMA)[KEY] = {
                default: 1,
                contextValidation: (value: number, all: { limit: number }) => value <= all.limit,
            };
            expect(getValidationError(KEY, 5, { limit: 3 })).toBe('Invalid value in current context');
            expect(getValidationError(KEY, 2, { limit: 3 })).toBeNull();
            // No context supplied → context rules are skipped.
            expect(getValidationError(KEY, 5)).toBeNull();
        });
    });
});

describe('intentProfiles helpers', () => {
    test('getIntentByName is trim/case-insensitive and rejects blanks, non-strings and unknown names', () => {
        const first = INTENT_PROFILES[0];
        expect(getIntentByName(`  ${first.name.toUpperCase()} `)).toBe(first);
        expect(getIntentByName('')).toBeNull();
        expect(getIntentByName('   ')).toBeNull();
        expect(getIntentByName(invalid(42))).toBeNull();
        expect(getIntentByName(undefined)).toBeNull();
        expect(getIntentByName('No Such Intent')).toBeNull();
    });

    test('intentValuesMatch guards missing arguments and detects added/removed/changed keys', () => {
        const intent = INTENT_PROFILES[0];
        expect(intentValuesMatch(null, intent.values)).toBe(false);
        expect(intentValuesMatch(intent, null)).toBe(false);
        expect(intentValuesMatch(intent, invalid('values'))).toBe(false);
        expect(intentValuesMatch(intent, { ...intent.values })).toBe(true);
        expect(intentValuesMatch(intent, { ...intent.values, extraKey: 1 })).toBe(false);

        const [firstKey] = Object.keys(intent.values);
        const missing = { ...intent.values };
        delete missing[firstKey];
        expect(intentValuesMatch(intent, missing)).toBe(false);
    });
});
