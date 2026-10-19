/**
 * Integrity test for the thin-handler rows (thinRows) in settings.handlers.ts.
 *
 * The rows bulk-register passthrough handlers that delegate to a
 * settings.<method>(...args) call, looked up on each call. Two things can go wrong silently:
 *   1. A channel in the table points at a method that doesn't exist on
 *      settings — the handler then throws on every call.
 *   2. A channel's expected fallback drifts from what the renderer relies
 *      on when an error occurs.
 *
 * One loop test asserts both: every thin channel is registered, dispatches
 * to a real settings method, and returns the documented fallback on error.
 */

jest.mock('../../src/ts/settings');
jest.mock('../../src/ts/apiFactory', () => ({
    refreshApi: jest.fn(),
    getApiStrategy: jest.fn(),
    getMiddleware: jest.fn(),
}));

import { invalid } from '../helpers/invalid';

import settingsModule = require('../../src/ts/settings');
const settings = jest.mocked(settingsModule);
import type * as settings_handlersModule from '../../src/ts/ipc/settings.handlers';
const { buildHandlers } = require('../../src/ts/ipc/settings.handlers') as typeof settings_handlersModule;

// The table addresses settings methods and handler channels by name.
type MockTable = Record<string, jest.Mock<unknown, unknown[]>>;
type HandlerTable = Record<string, (...args: unknown[]) => unknown>;

// Mirror of the thinRows() rows in src/ts/ipc/settings.handlers.ts.
// Kept hand-authored on purpose: if a row changes there, this test must
// be updated too — that's the contract.
const EXPECTED_THIN_HANDLERS: [string, string, string | boolean | null][] = [
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
    ['get-title-profile', 'getTitleProfile', null],
    ['get-entry-pins', 'getEntryPins', null],
    ['get-challenge-overrides', 'getChallengeOverrides', null],
    ['replace-challenge-overrides', 'replaceChallengeOverrides', false],
    ['get-challenge-profiles', 'getChallengeProfiles', null],
    ['save-challenge-profile', 'saveChallengeProfile', false],
    ['delete-challenge-profile', 'deleteChallengeProfile', false],
    ['apply-challenge-profile', 'applyChallengeProfile', false],
    ['reset-setting', 'resetSetting', false],
    ['reset-global-default', 'resetGlobalDefault', false],
    ['reset-all-global-defaults', 'resetAllGlobalDefaults', false],
    ['reset-all-settings', 'resetAllSettings', false],
    ['is-setting-modified', 'isSettingModified', false],
    ['is-global-default-modified', 'isGlobalDefaultModified', false],
];

const CHANGE_BROADCAST_CHANNELS = [
    'set-global-default',
    'set-challenge-override',
    'set-challenge-overrides',
    'remove-challenge-override',
    'set-title-rules',
    'replace-challenge-overrides',
    'save-challenge-profile',
    'delete-challenge-profile',
    'apply-challenge-profile',
    'reset-setting',
    'reset-global-default',
    'reset-all-global-defaults',
    'reset-all-settings',
];

describe('settings.handlers thin-handler rows', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test.each(EXPECTED_THIN_HANDLERS)(
        'channel "%s" delegates to settings.%s and returns its result',
        async (channel, method) => {
            invalid<MockTable>(settings)[method] = jest.fn().mockReturnValue('delegate-result');
            const handlers = buildHandlers();
            expect(invalid<HandlerTable>(handlers)[channel]).toBeDefined();

            const result = await invalid<HandlerTable>(handlers)[channel]({}, 'arg1', 'arg2');

            expect(invalid<MockTable>(settings)[method]).toHaveBeenCalledWith('arg1', 'arg2');
            expect(result).toBe('delegate-result');
        },
    );

    test.each(EXPECTED_THIN_HANDLERS)(
        'channel "%s" returns documented fallback when settings.%s throws',
        async (channel, method, fallback) => {
            invalid<MockTable>(settings)[method] = jest.fn().mockImplementation(() => {
                throw new Error('boom');
            });
            const handlers = buildHandlers();

            const result = await invalid<HandlerTable>(handlers)[channel]({}, 'arg', 'arg');

            expect(result).toBe(fallback);
        },
    );

    test('a thin handler reaches the facade method current at call time, not at build time', async () => {
        invalid<MockTable>(settings).getTitleRules = jest.fn().mockReturnValue('built-with');
        const handlers = buildHandlers();
        const swapped = jest.fn().mockReturnValue('swapped-in');
        invalid<MockTable>(settings).getTitleRules = swapped;

        const result = await invalid<HandlerTable>(handlers)['get-title-rules']({}, 'arg');

        expect(swapped).toHaveBeenCalledWith('arg');
        expect(result).toBe('swapped-in');
    });

    test.each(CHANGE_BROADCAST_CHANNELS)('channel "%s" broadcasts a successful mutation', async (channel) => {
        const row = EXPECTED_THIN_HANDLERS.find(([candidate]) => candidate === channel);
        const method = row![1];
        const snapshot = { auth: { token: 'secret' }, defaults: { changed: true } };
        const broadcastSettingsChange = jest.fn();
        invalid<MockTable>(settings)[method] = jest.fn().mockReturnValue(true);
        settings.loadSettings.mockReturnValue(invalid(snapshot));

        const handlers = buildHandlers({ broadcastSettingsChange });
        await invalid<HandlerTable>(handlers)[channel]({}, 'arg', 'arg');

        expect(broadcastSettingsChange).toHaveBeenCalledWith({ defaults: { changed: true }, hasToken: true });
    });
});

describe('settings.handlers hidden setting keys', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    const KEY_CHANNELS: [string, string][] = [
        ['reset-setting', 'resetSetting'],
        ['is-setting-modified', 'isSettingModified'],
    ];

    test.each(
        KEY_CHANNELS.flatMap(([channel, method]) =>
            ['auth', 'token', 'hasToken', 'apiHeaders'].map((key) => [channel, method, key] as const),
        ),
    )('"%s" refuses the hidden key %s without touching settings.%s', async (channel, method, key) => {
        invalid<MockTable>(settings)[method] = jest.fn().mockReturnValue(true);
        const broadcastSettingsChange = jest.fn();

        const result = await invalid<HandlerTable>(buildHandlers({ broadcastSettingsChange }))[channel]({}, key);

        expect(result).toBe(false);
        expect(invalid<MockTable>(settings)[method]).not.toHaveBeenCalled();
        expect(broadcastSettingsChange).not.toHaveBeenCalled();
    });

    test.each(KEY_CHANNELS)('"%s" still serves an ordinary key', async (channel, method) => {
        invalid<MockTable>(settings)[method] = jest.fn().mockReturnValue(true);

        await expect(invalid<HandlerTable>(buildHandlers())[channel]({}, 'language')).resolves.toBe(true);
        expect(invalid<MockTable>(settings)[method]).toHaveBeenCalledWith('language');
    });
});

// The channels that name a challenge, with where its id sits among the arguments: a value that is not a plain id
// (a non-blank string of bounded length, or a number) never reaches the settings, and the row's fallback comes back.
const CHALLENGE_ID_CHANNELS: [string, string, number][] = [
    ['get-challenge-override', 'getChallengeOverride', 1],
    ['set-challenge-override', 'setChallengeOverride', 1],
    ['set-challenge-overrides', 'setChallengeOverrides', 0],
    ['remove-challenge-override', 'removeChallengeOverride', 1],
    ['get-effective-setting', 'getEffectiveSetting', 1],
    ['get-challenge-overrides', 'getChallengeOverrides', 0],
    ['replace-challenge-overrides', 'replaceChallengeOverrides', 0],
    ['apply-challenge-profile', 'applyChallengeProfile', 1],
    ['get-entry-pins', 'getEntryPins', 0],
];

describe('settings.handlers challenge id arguments', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    const argsWithId = (index: number, id: unknown): unknown[] => {
        const args: unknown[] = ['key', 'value', 'extra'];
        args[index] = id;
        return args;
    };

    test.each(
        CHALLENGE_ID_CHANNELS.flatMap(([channel, method, index]) =>
            [
                ['an object', {}],
                ['an empty string', ''],
                ['a blank string', '   '],
                ['an over-long string', '9'.repeat(65)],
                ['NaN', Number.NaN],
                ['a list', ['1']],
            ].map(([what, id]) => [channel, method, index, what, id] as const),
        ),
    )('"%s" refuses %s (id at %s) without touching settings.%s', async (channel, method, index, _what, id) => {
        invalid<MockTable>(settings)[method] = jest.fn().mockReturnValue('delegate-result');
        const expected = EXPECTED_THIN_HANDLERS.find(([candidate]) => candidate === channel)![2];

        const result = await invalid<HandlerTable>(buildHandlers())[channel]({}, ...argsWithId(index, id));

        expect(result).toBe(expected);
        expect(invalid<MockTable>(settings)[method]).not.toHaveBeenCalled();
    });

    test.each(CHALLENGE_ID_CHANNELS.map(([channel, method, index]) => [channel, method, index] as const))(
        '"%s" passes a numeric or string id through to settings.%s',
        async (channel, method, index) => {
            invalid<MockTable>(settings)[method] = jest.fn().mockReturnValue('delegate-result');
            const handlers = invalid<HandlerTable>(buildHandlers());

            await expect(handlers[channel]({}, ...argsWithId(index, 123))).resolves.toBe('delegate-result');
            await expect(handlers[channel]({}, ...argsWithId(index, ' 123 '))).resolves.toBe('delegate-result');

            expect(invalid<MockTable>(settings)[method]).toHaveBeenCalledTimes(2);
        },
    );

    test('get-effective-setting may be asked without a challenge', async () => {
        invalid<MockTable>(settings).getEffectiveSetting = jest.fn().mockReturnValue(80);
        const handlers = invalid<HandlerTable>(buildHandlers());

        await expect(handlers['get-effective-setting']({}, 'exposure')).resolves.toBe(80);
        await expect(handlers['get-effective-setting']({}, 'exposure', null)).resolves.toBe(80);
        await expect(handlers['get-effective-setting']({}, 'exposure', undefined)).resolves.toBe(80);
    });

    test('a refused id is logged as a refused request, not an error', async () => {
        const logger = jest.requireMock<{ withCategory: jest.Mock<unknown, [string]> }>('../../src/ts/logger');
        invalid<MockTable>(settings).setChallengeOverride = jest.fn();

        await invalid<HandlerTable>(buildHandlers())['set-challenge-override']({}, 'exposure', '', 55);

        expect(logger.withCategory).toHaveBeenCalledWith('settings');
    });
});
