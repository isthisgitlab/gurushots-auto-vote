/**
 * The CLI scheduler's scenario notifier: the notifyOnScenario gate and the
 * outbox read, over the injectable seams.
 */

jest.mock('../../src/ts/core/services/scenarioStatus', () => ({ getScenarioStatus: jest.fn() }));
jest.mock('../../src/ts/core/settings', () => ({ getGlobalDefault: jest.fn() }));

import settingsModule = require('../../src/ts/core/settings');
const settings = jest.mocked(settingsModule);
import type * as scenarioStatusModule from '../../src/ts/core/services/scenarioStatus';
import type * as nodeNotifyModule from '../../src/ts/shells/cli/nodeNotify';
import { invalid } from '../helpers/invalid';
const { getScenarioStatus } = jest.mocked(
    require('../../src/ts/core/services/scenarioStatus') as typeof scenarioStatusModule,
);
const { createNodeScenarioNotifier } = require('../../src/ts/shells/cli/nodeNotify') as typeof nodeNotifyModule;

const future = () => [{ id: 'n', at: Math.floor(Date.now() / 1000) + 60, message: 'Boost now' }];

test('delivers outbox notices through the injected seams', async () => {
    const deliver = jest.fn();
    const notify = createNodeScenarioNotifier({
        getSetting: () => undefined,
        getStatus: () => ({ state: { outbox: future() } }),
        translate: (key) => key,
        deliver,
    });
    await notify(invalid([{ id: 7, title: 'Show' }]));
    expect(deliver).toHaveBeenCalledWith({ title: 'app.scenarioNotifyTitle', body: 'Boost now' });
});

test('the default seams read the facade; notifyOnScenario false turns it off', async () => {
    settings.getGlobalDefault.mockReturnValue(false);
    const deliver = jest.fn();
    await createNodeScenarioNotifier({ deliver })(invalid([{ id: 7 }]));
    expect(settings.getGlobalDefault).toHaveBeenCalledWith('notifyOnScenario');
    expect(getScenarioStatus).not.toHaveBeenCalled();

    settings.getGlobalDefault.mockReturnValue(true);
    getScenarioStatus.mockReturnValue(invalid({ state: null }));
    await createNodeScenarioNotifier({ deliver })(invalid([{ id: 7 }]));
    expect(getScenarioStatus).toHaveBeenCalledWith('7');
    expect(deliver).not.toHaveBeenCalled();
});

test('a failing read is logged at debug, not thrown', async () => {
    const notify = createNodeScenarioNotifier({
        getSetting: () => true,
        getStatus: () => {
            throw new Error('boom');
        },
        deliver: jest.fn(),
    });
    await expect(notify(invalid([{ id: 7 }]))).resolves.toBeUndefined();
});
