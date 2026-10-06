/**
 * The CLI side of Chosen Photos ownership: a list saved from the CLI records
 * the signed-in account (resolved the way a fill resolves it), warns when lists
 * saved under another account will now apply to this one, and
 * `clear-chosen-photos` removes every list.
 */

jest.mock('../../src/ts/logger', () => {
    const calls: { level: string; msg: unknown }[] = [];
    const rec = (level: string) => (msg: unknown) => calls.push({ level, msg });
    const cat = { info: rec('info'), error: rec('error'), success: rec('success'), warning: rec('warning') };
    return { __calls: calls, withCategory: jest.fn(() => cat) };
});
jest.mock('../../src/ts/settings', () => ({
    __esModule: true,
    loadSettings: jest.fn(),
    getSetting: jest.fn(),
    setSetting: jest.fn(),
    clearChosenPhotos: jest.fn(),
}));
jest.mock('../../src/ts/apiFactory', () => ({ getApiStrategy: jest.fn() }));
jest.mock('../../src/ts/services/autoFill', () => ({ resolveMemberId: jest.fn(), peekMemberId: jest.fn() }));

import { invalid } from '../helpers/invalid';
import loggerModule = require('../../src/ts/logger');
const logger = invalid<typeof loggerModule & { __calls: { level: string; msg: unknown }[] }>(loggerModule);
import settingsModule = require('../../src/ts/settings');
const settings = jest.mocked(settingsModule);
import apiFactoryModule = require('../../src/ts/apiFactory');
const apiFactory = jest.mocked(apiFactoryModule);
import autoFillModule = require('../../src/ts/services/autoFill');
const autoFill = jest.mocked(autoFillModule);
import type * as commandsModule from '../../src/ts/cli/commands/settings/chosenPhotos';
const { beforeChosenPhotosWrite, clearChosenPhotos } =
    require('../../src/ts/cli/commands/settings/chosenPhotos') as typeof commandsModule;

const getCurrentMemberProfile = jest.fn<Promise<null>, [string]>(async () => null);
const msgs = (level: string) => logger.__calls.filter((c) => c.level === level).map((c) => String(c.msg));
const stored = (savedBy: string) =>
    settings.getSetting.mockImplementation((key: string) => (key === 'chosenPhotosMemberId' ? savedBy : undefined));

beforeEach(() => {
    logger.__calls.length = 0;
    jest.clearAllMocks();
    settings.loadSettings.mockReturnValue(invalid({ token: 'tok' }));
    apiFactory.getApiStrategy.mockReturnValue(invalid({ getCurrentMemberProfile }));
    autoFill.resolveMemberId.mockResolvedValue('member-B');
    stored('');
});

describe('beforeChosenPhotosWrite', () => {
    // The check runs before the write; what it returns runs after a write that landed.
    const stampAfterWrite = async (key: string, value: string) => (await beforeChosenPhotosWrite(key, value))();

    test("records the signed-in account after the write, resolved through the fill path's member lookup", async () => {
        const stamp = await beforeChosenPhotosWrite('chosenPhotos', '["a"]');
        expect(autoFill.resolveMemberId).toHaveBeenCalledWith(
            'tok',
            getCurrentMemberProfile,
            expect.anything(),
            'settings',
        );
        // Nothing is written until the caller says the write landed.
        expect(settings.setSetting).not.toHaveBeenCalled();
        stamp();
        expect(settings.setSetting).toHaveBeenCalledWith('chosenPhotosMemberId', 'member-B');
        expect(msgs('warning')).toEqual([]);
    });

    test('an owner that is already this account is left alone', async () => {
        stored('member-B');
        await stampAfterWrite('chosenPhotos', '["a"]');
        expect(settings.setSetting).not.toHaveBeenCalled();
        expect(msgs('warning')).toEqual([]);
    });

    test('lists saved under another account: the warning comes first and names the remedy and its cost', async () => {
        stored('member-A');
        const stamp = await beforeChosenPhotosWrite('chosenPhotos', '["a"]');
        // Printed before anything is written.
        expect(settings.setSetting).not.toHaveBeenCalled();
        expect(msgs('warning')).toHaveLength(1);
        const [warning] = msgs('warning');
        expect(warning).toContain('run clear-chosen-photos');
        expect(warning).toContain('also removes the list you are setting now');
        expect(warning).toContain('then set this list again');
        expect(warning).not.toContain('member-');
        stamp();
        expect(settings.setSetting).toHaveBeenCalledWith('chosenPhotosMemberId', 'member-B');
    });

    test('a write that did not land is not stamped', async () => {
        const stamp = await beforeChosenPhotosWrite('chosenPhotos', '["a"]');
        void stamp;
        expect(settings.setSetting).not.toHaveBeenCalled();
    });

    test.each([
        ['another setting', 'exposure', '50'],
        ['an empty list', 'chosenPhotos', '[]'],
        ['a value that is not a list', 'chosenPhotos', 'yes'],
    ])('%s records nothing, warns of nothing and looks nobody up', async (_name, key, value) => {
        stored('member-A');
        await stampAfterWrite(key, value);
        expect(autoFill.resolveMemberId).not.toHaveBeenCalled();
        expect(settings.setSetting).not.toHaveBeenCalled();
        expect(msgs('warning')).toEqual([]);
    });

    test('a signed-out CLI leaves the owner unchanged', async () => {
        settings.loadSettings.mockReturnValue(invalid({ token: '' }));
        await stampAfterWrite('chosenPhotos', '["a"]');
        expect(autoFill.resolveMemberId).not.toHaveBeenCalled();
        expect(settings.setSetting).not.toHaveBeenCalled();
    });

    test('an account that cannot be resolved leaves the owner unchanged, with no warning', async () => {
        stored('member-A');
        autoFill.resolveMemberId.mockResolvedValue(null);
        await stampAfterWrite('chosenPhotos', '["a"]');
        expect(settings.setSetting).not.toHaveBeenCalled();
        expect(msgs('warning')).toEqual([]);
    });
});

describe('clearChosenPhotos', () => {
    test('reports how many lists went', () => {
        settings.clearChosenPhotos.mockReturnValue(3);
        expect(clearChosenPhotos()).toBe(true);
        expect(msgs('success')).toEqual([
            'Removed 3 chosen-photo list(s) from settings, rules, profiles and scenarios',
        ]);
    });

    test('a save that failed is an error', () => {
        settings.clearChosenPhotos.mockReturnValue(null);
        expect(clearChosenPhotos()).toBe(false);
        expect(msgs('error')[0]).toContain('could not be saved');
    });

    test('a throwing facade is reported, not thrown', () => {
        settings.clearChosenPhotos.mockImplementation(() => {
            throw new Error('boom');
        });
        expect(clearChosenPhotos()).toBe(false);
        expect(msgs('error')).toEqual(['Error removing the chosen-photo lists']);
    });
});
