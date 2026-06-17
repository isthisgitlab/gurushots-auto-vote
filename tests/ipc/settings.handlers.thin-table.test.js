/**
 * Integrity test for the THIN_HANDLERS table in settings.handlers.js.
 *
 * The table bulk-registers passthrough handlers that delegate to a
 * settings.<method>(...args) call. Two things can go wrong silently:
 *   1. A channel in the table points at a method that doesn't exist on
 *      settings — the handler then throws on every call.
 *   2. A channel's expected fallback drifts from what the renderer relies
 *      on when an error occurs.
 *
 * One loop test asserts both: every thin channel is registered, dispatches
 * to a real settings method, and returns the documented fallback on error.
 */

jest.mock('../../src/js/settings');
jest.mock('../../src/js/apiFactory', () => ({
    refreshApi: jest.fn(),
    getApiStrategy: jest.fn(),
    getMiddleware: jest.fn(),
}));

const settings = require('../../src/js/settings');
const { buildHandlers } = require('../../src/js/ipc/settings.handlers');

// Mirror of the THIN_HANDLERS table in src/js/ipc/settings.handlers.js.
// Kept hand-authored on purpose: if a row changes there, this test must
// be updated too — that's the contract.
const EXPECTED_THIN_HANDLERS = [
    ['get-validation-error', 'getValidationError', 'Validation error'],
    ['get-global-default', 'getGlobalDefault', null],
    ['set-global-default', 'setGlobalDefault', false],
    ['get-challenge-override', 'getChallengeOverride', false],
    ['set-challenge-override', 'setChallengeOverride', false],
    ['set-challenge-overrides', 'setChallengeOverrides', false],
    ['remove-challenge-override', 'removeChallengeOverride', false],
    ['get-effective-setting', 'getEffectiveSetting', null],
    ['get-title-rules', 'getTitleRules', null],
    ['set-title-rules', 'setTitleRules', false],
    ['cleanup-stale-challenge-setting', 'cleanupStaleChallengeSetting', false],
    ['cleanup-obsolete-settings', 'cleanupObsoleteSettings', false],
    ['reset-setting', 'resetSetting', false],
    ['reset-global-default', 'resetGlobalDefault', false],
    ['reset-all-global-defaults', 'resetAllGlobalDefaults', false],
    ['reset-all-settings', 'resetAllSettings', false],
    ['is-setting-modified', 'isSettingModified', false],
    ['is-global-default-modified', 'isGlobalDefaultModified', false],
];

describe('settings.handlers THIN_HANDLERS table', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test.each(EXPECTED_THIN_HANDLERS)(
        'channel "%s" delegates to settings.%s and returns its result',
        async (channel, method) => {
            settings[method] = jest.fn().mockReturnValue('delegate-result');
            const handlers = buildHandlers();
            expect(handlers[channel]).toBeDefined();

            const result = await handlers[channel]({}, 'arg1', 'arg2');

            expect(settings[method]).toHaveBeenCalledWith('arg1', 'arg2');
            expect(result).toBe('delegate-result');
        },
    );

    test.each(EXPECTED_THIN_HANDLERS)(
        'channel "%s" returns documented fallback when settings.%s throws',
        async (channel, method, fallback) => {
            settings[method] = jest.fn().mockImplementation(() => {
                throw new Error('boom');
            });
            const handlers = buildHandlers();

            const result = await handlers[channel]({}, 'arg');

            expect(result).toBe(fallback);
        },
    );
});
