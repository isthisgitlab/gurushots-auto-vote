/**
 * authenticate: a login whose token could not be saved (the settings refuse every write, as they do while the stored
 * settings are unreadable) is answered `token-not-saved`, never success: a session that is gone at the next start
 * must not look like a login.
 */

jest.mock('../../src/ts/settings');
jest.mock('../../src/ts/apiFactory');
jest.mock('../../src/ts/windows/quitGuard', () => ({ rememberChallenges: jest.fn() }));

import { invalid } from '../helpers/invalid';

import settingsModule = require('../../src/ts/settings');
const settings = jest.mocked(settingsModule);
import apiFactoryModule = require('../../src/ts/apiFactory');
const apiFactory = jest.mocked(apiFactoryModule);
import loggerModule = require('../../src/ts/logger');
const logger = jest.mocked(loggerModule);
import type * as actions_handlersModule from '../../src/ts/ipc/actions.handlers';
const { buildHandlers } = require('../../src/ts/ipc/actions.handlers') as typeof actions_handlersModule;

describe('authenticate with settings that cannot be written', () => {
    const authenticate = jest.fn();

    beforeEach(() => {
        jest.clearAllMocks();
        authenticate.mockResolvedValue({ token: 'fresh-token' });
        apiFactory.getApiStrategy = invalid(jest.fn(() => ({ authenticate })));
        settings.getSetting.mockReturnValue('old-token');
    });

    test('answers token-not-saved, without the token, when the write is refused', async () => {
        settings.setSetting.mockReturnValue(false);

        const result = await buildHandlers().authenticate({}, 'user@example.com', 'pw', false);

        expect(result).toEqual({ success: false, error: 'token-not-saved' });
        expect(settings.setSetting).toHaveBeenCalledWith('token', 'fresh-token');
        expect(JSON.stringify(logger.withCategory.mock.results)).not.toContain('fresh-token');
    });

    test('answers success when the write lands', async () => {
        settings.setSetting.mockReturnValue(true);

        const result = await buildHandlers().authenticate({}, 'user@example.com', 'pw', false);

        expect(result).toEqual({ success: true });
    });
});
