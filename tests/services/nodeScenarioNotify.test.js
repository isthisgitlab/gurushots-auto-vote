/**
 * The CLI scheduler's scenario notifier: the notifyOnScenario gate and the
 * outbox read, over the injectable seams.
 */

jest.mock('../../src/js/services/scenarioStatus', () => ({ getScenarioStatus: jest.fn() }));
jest.mock('../../src/js/settings', () => ({ getSetting: jest.fn() }));

const settings = require('../../src/js/settings');
const { getScenarioStatus } = require('../../src/js/services/scenarioStatus');
const { createNodeScenarioNotifier } = require('../../src/js/services/notify/nodeNotify');

const future = () => [{ id: 'n', at: Math.floor(Date.now() / 1000) + 60, message: 'Boost now' }];

test('delivers outbox notices through the injected seams', async () => {
    const deliver = jest.fn();
    const notify = createNodeScenarioNotifier({
        getSetting: () => undefined,
        getStatus: () => ({ state: { outbox: future() } }),
        translate: (key) => key,
        deliver,
    });
    await notify([{ id: 7, title: 'Show' }]);
    expect(deliver).toHaveBeenCalledWith({ title: 'app.scenarioNotifyTitle', body: 'Boost now' });
});

test('the default seams read the facade; notifyOnScenario false turns it off', async () => {
    settings.getSetting.mockReturnValue(false);
    const deliver = jest.fn();
    await createNodeScenarioNotifier({ deliver })([{ id: 7 }]);
    expect(settings.getSetting).toHaveBeenCalledWith('notifyOnScenario');
    expect(getScenarioStatus).not.toHaveBeenCalled();

    settings.getSetting.mockReturnValue(true);
    getScenarioStatus.mockReturnValue({ state: null });
    await createNodeScenarioNotifier({ deliver })([{ id: 7 }]);
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
    await expect(notify([{ id: 7 }])).resolves.toBeUndefined();
});
