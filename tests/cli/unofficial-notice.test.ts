/**
 * The CLI's unofficial-tool notice: on stderr, once per notice version, then the version is stored.
 */

jest.mock('../../src/ts/settings', () => ({ getSetting: jest.fn(), setSetting: jest.fn(() => true) }));
jest.mock('../../src/ts/logger', () => ({ printStderr: jest.fn() }));

import loggerModule = require('../../src/ts/logger');
import settingsModule = require('../../src/ts/settings');
import type * as noticeModule from '../../src/ts/cli/commands/unofficialNotice';
import { CURRENT_NOTICE_VERSION } from '../../src/ts/noticeVersion';

const logger = jest.mocked(loggerModule);
const settings = jest.mocked(settingsModule);
const { showUnofficialNotice, UNOFFICIAL_NOTICE } =
    require('../../src/ts/cli/commands/unofficialNotice') as typeof noticeModule;

beforeEach(() => jest.clearAllMocks());

describe('showUnofficialNotice', () => {
    test('the text says what the notice must: unofficial, not affiliated or endorsed, trademark, terms, GitHub', () => {
        expect(UNOFFICIAL_NOTICE).toContain('unofficial');
        expect(UNOFFICIAL_NOTICE).toContain('not affiliated with or endorsed by GuruShots');
        expect(UNOFFICIAL_NOTICE).toContain('GuruShots is a trademark of its owner');
        expect(UNOFFICIAL_NOTICE).toContain("may violate GuruShots' terms");
        expect(UNOFFICIAL_NOTICE).toContain('account suspension');
        expect(UNOFFICIAL_NOTICE).toContain('contacts GitHub to check for updates');
    });

    test.each([0, CURRENT_NOTICE_VERSION - 1, 'garbage'])(
        'with %j stored it prints on stderr, then stores the current version',
        (stored) => {
            settings.getSetting.mockReturnValue(stored);

            showUnofficialNotice();

            expect(logger.printStderr).toHaveBeenCalledTimes(1);
            expect(logger.printStderr).toHaveBeenCalledWith(UNOFFICIAL_NOTICE);
            expect(settings.setSetting).toHaveBeenCalledWith('noticeAcknowledgedVersion', CURRENT_NOTICE_VERSION);
        },
    );

    test.each([CURRENT_NOTICE_VERSION, CURRENT_NOTICE_VERSION + 1])(
        'with %i stored it says and stores nothing',
        (stored) => {
            settings.getSetting.mockReturnValue(stored);

            showUnofficialNotice();

            expect(logger.printStderr).not.toHaveBeenCalled();
            expect(settings.setSetting).not.toHaveBeenCalled();
        },
    );

    test('a second run after the first prints nothing', () => {
        let stored = 0;
        settings.getSetting.mockImplementation(() => stored);
        settings.setSetting.mockImplementation((_key, value) => {
            stored = Number(value);
            return true;
        });

        showUnofficialNotice();
        showUnofficialNotice();

        expect(logger.printStderr).toHaveBeenCalledTimes(1);
    });
});
