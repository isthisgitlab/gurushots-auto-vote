/**
 * The renderer's scenario notifier over IPC: the setting gate and the status
 * read.
 */

import { createRendererScenarioNotifier } from '@/notifications/scenarioNotifier';

const outbox = () => [{ id: 'n', at: Math.floor(Date.now() / 1000) + 60, message: 'Boost now' }];

test('reads each challenge status and delivers new notices', async () => {
    const deliver = jest.fn();
    const getScenarioStatus = jest.fn(async (id) =>
        id === 1 ? { success: true, state: { outbox: outbox() } } : { success: false },
    );
    const notify = createRendererScenarioNotifier({
        getSetting: async () => undefined,
        getScenarioStatus,
        translate: (key) => key,
        deliver,
    });
    await notify([{ id: 1, title: 'Show' }, { id: 2 }]);
    expect(getScenarioStatus).toHaveBeenCalledWith(2);
    expect(deliver).toHaveBeenCalledWith({ title: 'app.scenarioNotifyTitle', body: 'Boost now' });
});

test('notifyOnScenario false turns it off; an unset value does not', async () => {
    const getScenarioStatus = jest.fn(async () => ({ success: true, state: null }));
    await createRendererScenarioNotifier({
        getSetting: async (key) => (key === 'notifyOnScenario' ? false : undefined),
        getScenarioStatus,
        translate: (key) => key,
        deliver: jest.fn(),
    })([{ id: 1 }]);
    expect(getScenarioStatus).not.toHaveBeenCalled();
    await createRendererScenarioNotifier({
        getSetting: async () => null,
        getScenarioStatus,
        translate: (key) => key,
        deliver: jest.fn(),
    })([{ id: 1 }]);
    expect(getScenarioStatus).toHaveBeenCalled();
});
