/**
 * Validates the schema split (settings/schema.js + settings/storage.js
 * + settings.js facade) didn't regress the public re-export contract.
 *
 * Internal precedence (per-challenge > global > schema default) is
 * exercised end-to-end by the existing api/last-hour-exposure and
 * exposureTarget service tests against real settings; this file focuses
 * on what's specific to the split — the facade re-exports stay
 * referentially identical to the underlying modules.
 */

const settings = require('../../src/js/settings');
const schemaModule = require('../../src/js/settings/schema');
const storageModule = require('../../src/js/settings/storage');

jest.mock('../../src/js/logger', () => ({
    info: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    api: jest.fn(),
    startOperation: jest.fn(),
    endOperation: jest.fn(),
    apiRequest: jest.fn(),
    apiResponse: jest.fn(),
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

describe('settings facade re-exports the schema module', () => {
    test('SETTINGS_SCHEMA is the same object reference', () => {
        expect(settings.SETTINGS_SCHEMA).toBe(schemaModule.SETTINGS_SCHEMA);
    });

    test('getValidationError is the same function reference', () => {
        expect(settings.getValidationError).toBe(schemaModule.getValidationError);
    });

    test('getSettingsSchema is the same function reference', () => {
        expect(settings.getSettingsSchema).toBe(schemaModule.getSettingsSchema);
    });

    test('exposure schema entry survives the split', () => {
        expect(settings.SETTINGS_SCHEMA.exposure).toBeDefined();
        expect(settings.SETTINGS_SCHEMA.exposure.default).toBe(100);
        expect(settings.SETTINGS_SCHEMA.exposure.perChallenge).toBe(true);
    });

    test('lastMinuteCheckFrequency is still global-only', () => {
        expect(settings.SETTINGS_SCHEMA.lastMinuteCheckFrequency.perChallenge).toBe(false);
    });

    test('autovoteRunning persists as a non-perChallenge boolean', () => {
        expect(settings.SETTINGS_SCHEMA.autovoteRunning).toBeDefined();
        expect(settings.SETTINGS_SCHEMA.autovoteRunning.default).toBe(false);
        expect(settings.SETTINGS_SCHEMA.autovoteRunning.perChallenge).toBe(false);
    });

    test('exposureTarget sentinel default 0 survives the split', () => {
        // 0 means "follow the trigger" — load-bearing for legacy behavior.
        expect(settings.SETTINGS_SCHEMA.exposureTarget.default).toBe(0);
    });
});

describe('settings facade re-exports the storage module', () => {
    test('initializeAsync is the same function reference', () => {
        expect(settings.initializeAsync).toBe(storageModule.initializeAsync);
    });

    test('getUserDataPath is the same function reference', () => {
        expect(settings.getUserDataPath).toBe(storageModule.getUserDataPath);
    });

    test('getEnvironmentInfo is the same function reference', () => {
        expect(settings.getEnvironmentInfo).toBe(storageModule.getEnvironmentInfo);
    });
});

describe('schema validation behavior', () => {
    test('validateSetting accepts in-range exposure', () => {
        expect(schemaModule.validateSetting('exposure', 50)).toBe(true);
    });

    test('validateSetting rejects out-of-range exposure', () => {
        expect(schemaModule.validateSetting('exposure', 0)).toBe(false);
        expect(schemaModule.validateSetting('exposure', 101)).toBe(false);
    });

    test('validateSetting accepts unknown keys (treated as opaque)', () => {
        // The schema only validates keys it knows about; unknown keys
        // pass through so callers can store free-form values.
        expect(schemaModule.validateSetting('totallyUnknownKey', 'anything')).toBe(true);
    });

    test('getValidationError returns null for valid input', () => {
        expect(schemaModule.getValidationError('exposure', 50)).toBeNull();
    });

    test('getValidationError surfaces context-aware errors via getContextError', () => {
        // lastHourExposure must be <= exposure. Pass an invalid pair to
        // exercise the dedicated contextValidation/getContextError pair.
        const err = schemaModule.getValidationError('lastHourExposure', 90, { exposure: 50 });
        expect(err).toContain('VALIDATION_LESS_OR_EQUAL');
        expect(err).toContain('app.exposure');
        expect(err).toContain('50');
    });
});
