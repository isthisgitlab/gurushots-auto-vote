/**
 * The `reset-data` and `licenses` CLI commands: reset-data needs an explicit --yes, says
 * what it removed (or why nothing was), and licenses prints the notices or says why not.
 */

jest.mock('../../src/ts/settings/localData', () => ({ wipeLocalData: jest.fn() }));
jest.mock('../../src/ts/thirdPartyNotices', () => ({ loadThirdPartyNotices: jest.fn() }));
jest.mock('../../src/ts/logger', () => {
    const cat = { info: jest.fn(), error: jest.fn() };
    return {
        withCategory: jest.fn(() => cat),
        printDocument: jest.fn(),
        printLine: jest.fn(),
        printStderr: jest.fn(),
        __cat: cat,
    };
});

import type * as localDataCommandsModule from '../../src/ts/cli/commands/localData';
import type * as commandTableModule from '../../src/ts/cli/commandTable';
import loggerModule = require('../../src/ts/logger');
import localDataModule = require('../../src/ts/settings/localData');
import noticesModule = require('../../src/ts/thirdPartyNotices');
import { invalid } from '../helpers/invalid';

const logger = jest.mocked(loggerModule);
const cat = invalid<{
    __cat: { info: jest.Mock<void, [string, ...unknown[]]>; error: jest.Mock<void, [string, ...unknown[]]> };
}>(loggerModule).__cat;
const localData = jest.mocked(localDataModule);
const notices = jest.mocked(noticesModule);
const { resetDataCmd, licensesCmd } = require('../../src/ts/cli/commands/localData') as typeof localDataCommandsModule;
const { COMMANDS } = require('../../src/ts/cli/commandTable') as typeof commandTableModule;

beforeEach(() => jest.clearAllMocks());

describe('reset-data', () => {
    test.each([[[]], [['--no']], [['--yes', '--yes']], [['yes']], [['--yes', 'extra']]])(
        'refuses %p without deleting anything',
        async (argv) => {
            await expect(resetDataCmd(argv)).resolves.toBe(1);
            expect(localData.wipeLocalData).not.toHaveBeenCalled();
            expect(cat.error).toHaveBeenCalledWith(expect.stringContaining('needs --yes'));
            expect(cat.info).toHaveBeenCalledWith('Usage: reset-data --yes');
        },
    );

    test('with --yes it deletes and lists what went', async () => {
        localData.wipeLocalData.mockResolvedValue({ success: true, removed: ['/u/settings.json', '/u/logs'] });

        await expect(resetDataCmd(['--yes'])).resolves.toBe(0);

        // Console only: a log line would re-create the log directory the wipe just removed.
        expect(logger.printLine).toHaveBeenCalledWith('Deleted all local data:');
        expect(logger.printLine).toHaveBeenCalledWith('  /u/settings.json');
        expect(logger.printLine).toHaveBeenCalledWith('  /u/logs');
        expect(cat.info).not.toHaveBeenCalled();
    });

    test('while auto-vote runs it says why nothing was deleted, and exits 1', async () => {
        localData.wipeLocalData.mockResolvedValue({ success: false, error: 'busy' });

        await expect(resetDataCmd(['--yes'])).resolves.toBe(1);

        expect(logger.printStderr).toHaveBeenCalledWith(expect.stringContaining('Auto-vote is running'));
    });

    test('a partial failure is reported with its reason, and exits 1', async () => {
        localData.wipeLocalData.mockResolvedValue({ success: false, error: 'Could not delete: /u/logs (EBUSY)' });

        await expect(resetDataCmd(['--yes'])).resolves.toBe(1);

        expect(logger.printStderr).toHaveBeenCalledWith(
            'Nothing was deleted completely: Could not delete: /u/logs (EBUSY)',
        );
    });

    test('is registered in the command table', async () => {
        localData.wipeLocalData.mockResolvedValue({ success: true, removed: [] });
        await expect(COMMANDS['reset-data'](['--yes'])).resolves.toBe(0);
        await expect(COMMANDS['reset-data']([])).resolves.toBe(1);
    });
});

describe('licenses', () => {
    test('prints the notices, without the trailing newline', async () => {
        notices.loadThirdPartyNotices.mockResolvedValue('A\nB\n');

        await expect(licensesCmd()).resolves.toBe(0);

        expect(logger.printDocument).toHaveBeenCalledWith('A\nB');
    });

    test('says why when they cannot be read, and exits 1', async () => {
        notices.loadThirdPartyNotices.mockRejectedValue(new Error('ENOENT'));

        await expect(licensesCmd()).resolves.toBe(1);

        expect(cat.error).toHaveBeenCalledWith('The third-party notices could not be read: ENOENT');
        expect(logger.printDocument).not.toHaveBeenCalled();
    });

    test('a failure with no message is still said', async () => {
        notices.loadThirdPartyNotices.mockRejectedValue(null);

        await expect(licensesCmd()).resolves.toBe(1);

        expect(cat.error).toHaveBeenCalledWith('The third-party notices could not be read: unknown error');
    });

    test('is registered in the command table and passes its exit code on', async () => {
        notices.loadThirdPartyNotices.mockResolvedValue('X');
        await expect(COMMANDS.licenses([])).resolves.toBe(0);
        notices.loadThirdPartyNotices.mockRejectedValue(new Error('no'));
        await expect(COMMANDS.licenses([])).resolves.toBe(1);
    });
});
