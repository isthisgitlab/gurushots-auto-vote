/**
 * The CLI scheduler's scenario notifier: the notifyOnScenario gate and the
 * outbox read, over the injectable seams.
 */

jest.mock('../../src/ts/core/services/scenarioStatus', () => ({ getScenarioStatus: jest.fn() }));
jest.mock('../../src/ts/core/settings', () => ({ captureInstallationSettings: jest.fn() }));
jest.mock('../../src/ts/core/logger', () => {
    const warning = jest.fn();
    const category = { warning, debug: jest.fn(), info: jest.fn(), error: jest.fn() };
    return { __esModule: true, withCategory: () => category, __warning: warning };
});

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

// The installation's effective switch, as the facade captures it.
const switchIs = (value: boolean) =>
    settings.captureInstallationSettings.mockReturnValue({ ok: true, values: { notifyOnScenario: value } });

test('the default seams read the installation switch; notifyOnScenario false turns it off', async () => {
    switchIs(false);
    const deliver = jest.fn();
    await createNodeScenarioNotifier({ deliver })(invalid([{ id: 7 }]));
    expect(settings.captureInstallationSettings).toHaveBeenCalledWith(['notifyOnScenario']);
    expect(getScenarioStatus).not.toHaveBeenCalled();

    switchIs(true);
    getScenarioStatus.mockReturnValue(invalid({ state: null }));
    await createNodeScenarioNotifier({ deliver })(invalid([{ id: 7 }]));
    expect(getScenarioStatus).toHaveBeenCalledWith('7');
    expect(deliver).not.toHaveBeenCalled();
});

test('a switch the installation cannot read is off, said once while it lasts, never the saved switch', async () => {
    const warning = (
        require('../../src/ts/core/logger') as { __warning: jest.Mock<void, [message: unknown, data?: unknown]> }
    ).__warning;
    warning.mockClear();
    settings.captureInstallationSettings.mockReturnValue({
        ok: false,
        key: 'notifyOnScenario',
        reason: 'the published settings of this phase have expired',
    });
    getScenarioStatus.mockClear();
    const notify = createNodeScenarioNotifier({ deliver: jest.fn() });
    await notify(invalid([{ id: 7 }]));
    await notify(invalid([{ id: 8 }]));
    expect(getScenarioStatus).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(
        'notifications are off while notifyOnScenario is unavailable (the published settings of this phase have expired)',
        null,
    );
    // readable again: it follows the switch, and a later outage is said again
    switchIs(true);
    getScenarioStatus.mockReturnValue(invalid({ state: null }));
    await notify(invalid([{ id: 9 }]));
    expect(getScenarioStatus).toHaveBeenCalledWith('9');
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
