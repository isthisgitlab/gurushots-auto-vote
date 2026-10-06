/**
 * Recording which account a Chosen Photos list belongs to: only a write that
 * carries a non-empty list stamps, only a known signed-in member is recorded,
 * and the settings IPC and the scenario save both go through it.
 */

jest.mock('electron', () => ({ BrowserWindow: { getAllWindows: jest.fn(() => []) } }));
jest.mock('../../src/ts/settings');
jest.mock('../../src/ts/services/autoFill');
jest.mock('../../src/ts/metadata', () => ({ cleanupStaleMetadata: jest.fn() }));
jest.mock('../../src/ts/apiFactory', () => ({
    refreshApi: jest.fn(),
    getApiStrategy: jest.fn(),
    getMiddleware: jest.fn(),
}));

import { invalid } from '../helpers/invalid';
import settingsModule = require('../../src/ts/settings');
const settings = jest.mocked(settingsModule);
import autoFillModule = require('../../src/ts/services/autoFill');
const autoFill = jest.mocked(autoFillModule);
import type * as ownerModule from '../../src/ts/ipc/chosenPhotosOwner';
import type * as settings_handlersModule from '../../src/ts/ipc/settings.handlers';
const { stampChosenPhotosOwner } = require('../../src/ts/ipc/chosenPhotosOwner') as typeof ownerModule;
const { buildHandlers } = require('../../src/ts/ipc/settings.handlers') as typeof settings_handlersModule;

let saved: unknown;

beforeEach(() => {
    jest.clearAllMocks();
    saved = '';
    settings.loadSettings = jest.fn().mockReturnValue({ token: 'tok' });
    settings.getSetting = jest.fn(() => saved) as never;
    autoFill.peekMemberId = jest.fn().mockReturnValue('member-1');
});

describe('stampChosenPhotosOwner', () => {
    test.each([
        ['a single-key write', ['chosenPhotos', ['a']]],
        ['a single-key per-challenge write', ['chosenPhotos', '77', ['a']]],
        ['a challenge override batch', ['77', { exposure: 50, chosenPhotos: ['a'] }]],
        ['a rule list', [[{ title: 'Big show', chosenPhotos: ['a'] }]]],
        ['a profile', ['Mine', { chosenPhotos: ['a'] }]],
        ['a scenario document', [{ name: 'Plan', phases: { main: { settings: { chosenPhotos: ['a'] } } } }]],
    ])('%s that carries a list records the signed-in member', (_name, args) => {
        stampChosenPhotosOwner(args);
        expect(settings.setSetting).toHaveBeenCalledWith('chosenPhotosMemberId', 'member-1');
    });

    test.each([
        ['an unrelated write', ['exposure', 50]],
        ['an empty list', ['chosenPhotos', []]],
        ['an empty list in a batch', ['77', { chosenPhotos: [] }]],
        ['the Only flag alone', ['chosenPhotosOnly', true]],
        [
            'a list buried deeper than any real write',
            [{ a: { b: { c: { d: { e: { f: { g: { chosenPhotos: ['a'] } } } } } } } }],
        ],
        ['a non-object argument', ['chosenPhotos', 5]],
    ])('%s records nothing', (_name, args) => {
        stampChosenPhotosOwner(args);
        expect(settings.setSetting).not.toHaveBeenCalled();
        expect(settings.loadSettings).not.toHaveBeenCalled();
    });

    test('an unknown member or no token leaves the record alone', () => {
        autoFill.peekMemberId = jest.fn().mockReturnValue(null);
        stampChosenPhotosOwner(['chosenPhotos', ['a']]);
        settings.loadSettings = jest.fn().mockReturnValue({ token: '' });
        stampChosenPhotosOwner(['chosenPhotos', ['a']]);
        expect(settings.setSetting).not.toHaveBeenCalled();
        expect(autoFill.peekMemberId).toHaveBeenCalledTimes(1);
    });

    test('the same member is not written again', () => {
        saved = 'member-1';
        stampChosenPhotosOwner(['chosenPhotos', ['a']]);
        expect(settings.setSetting).not.toHaveBeenCalled();
        saved = 'member-0';
        stampChosenPhotosOwner(['chosenPhotos', ['a']]);
        expect(settings.setSetting).toHaveBeenCalledWith('chosenPhotosMemberId', 'member-1');
    });
});

describe('the settings IPC records the owner after a successful write only', () => {
    test.each([
        'set-global-default',
        'set-challenge-override',
        'set-challenge-overrides',
        'replace-challenge-overrides',
        'set-title-rules',
        'save-challenge-profile',
    ])('%s', async (channel) => {
        const method = {
            'set-global-default': 'setGlobalDefault',
            'set-challenge-override': 'setChallengeOverride',
            'set-challenge-overrides': 'setChallengeOverrides',
            'replace-challenge-overrides': 'replaceChallengeOverrides',
            'set-title-rules': 'setTitleRules',
            'save-challenge-profile': 'saveChallengeProfile',
        }[channel] as keyof typeof settings;
        const handlers = buildHandlers() as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
        const args = [{ chosenPhotos: ['a'] }];
        invalid<jest.Mock<boolean, unknown[]>>(settings[method]).mockReturnValueOnce(false).mockReturnValueOnce(true);
        await handlers[channel]({}, ...args);
        expect(settings.setSetting).not.toHaveBeenCalled();
        await handlers[channel]({}, ...args);
        expect(settings.setSetting).toHaveBeenCalledWith('chosenPhotosMemberId', 'member-1');
    });

    test('a channel that cannot carry a list never looks', async () => {
        const handlers = buildHandlers() as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
        settings.removeChallengeOverride = jest.fn().mockReturnValue(true);
        await handlers['remove-challenge-override']({}, 'chosenPhotos', '77');
        expect(settings.loadSettings).not.toHaveBeenCalled();
    });
});
