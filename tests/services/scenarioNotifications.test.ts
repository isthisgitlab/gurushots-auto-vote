/**
 * Scenario notices → OS notifications: only new notices since the host
 * started, each once, coalesced per cycle; never throws.
 */

import type * as scenarioNotificationsModule from '../../src/ts/services/scenarioNotifications';
import type { OutboxItem } from '../../src/ts/services/scenarioNotifications';
import { invalid } from '../helpers/invalid';

const { createNoticeTracker, formatScenarioNotification, createScenarioNotifier } =
    require('../../src/ts/services/scenarioNotifications') as typeof scenarioNotificationsModule;

const T = (key: string) =>
    (
        ({
            'app.scenarioNotifyTitle': 'Scenario — {title}',
            'app.scenarioNotifyGroupTitle': '{count} updates',
        }) as Record<string, string>
    )[key];
const START = 1000;

describe('createNoticeTracker', () => {
    test('shows notices created since start, once each, and forgets vanished ones', () => {
        const tracker = createNoticeTracker(START);
        const outboxes = [
            {
                challengeId: 7,
                challengeTitle: 'Show',
                outbox: [
                    { id: 'old', at: START - 1, message: 'before start' },
                    { id: 'a', at: START, message: 'held photo is out' },
                    { id: 'bad', at: START + 1 },
                ],
            },
        ];
        expect(tracker.fresh(outboxes)).toEqual([{ challengeTitle: 'Show', message: 'held photo is out' }]);
        expect(tracker.fresh(outboxes)).toEqual([]);
        tracker.fresh([]);
        expect(tracker.fresh(outboxes)).toHaveLength(1);
    });
});

describe('formatScenarioNotification', () => {
    test('one notice names its challenge; several coalesce', () => {
        expect(formatScenarioNotification([], T)).toBeNull();
        expect(formatScenarioNotification([{ challengeTitle: 'Show', message: 'Boost\nnow' }], T)).toEqual({
            title: 'Scenario — Show',
            body: 'Boost now',
        });
        expect(
            formatScenarioNotification(
                [
                    { challengeTitle: 'A', message: 'one' },
                    { challengeTitle: 'B', message: 'two' },
                ],
                T,
            ),
        ).toEqual({ title: '2 updates', body: 'A: one · B: two' });
    });
});

describe('createScenarioNotifier', () => {
    const outbox = [{ id: 'n1', at: START + 5, message: 'hello' }];

    test('delivers new notices when enabled', async () => {
        const deliver = jest.fn();
        const notify = createScenarioNotifier({
            isEnabled: async () => true,
            readOutbox: async (c) => (c.id === 1 ? outbox : c.id === 2 ? [] : null),
            translate: T,
            deliver,
            startedAt: START,
        });
        await notify(invalid([{ id: 1, title: 'Show' }, { id: 2 }, { id: 3 }]));
        expect(deliver).toHaveBeenCalledWith({ title: 'Scenario — Show', body: 'hello' });
        await notify(invalid([{ id: 1, title: 'Show' }]));
        expect(deliver).toHaveBeenCalledTimes(1);
    });

    test('falls back to the id for an untitled challenge, and handles a non-list', async () => {
        const deliver = jest.fn();
        const notify = createScenarioNotifier({
            isEnabled: () => true,
            readOutbox: () => outbox,
            translate: T,
            deliver,
            startedAt: START,
        });
        await notify(invalid('not a list'));
        await notify(invalid([{ id: 4 }]));
        expect(deliver).toHaveBeenCalledWith({ title: 'Scenario — challenge 4', body: 'hello' });
    });

    test('disabled means no reads at all', async () => {
        const readOutbox = jest.fn();
        await createScenarioNotifier({ isEnabled: () => false, readOutbox, translate: T, deliver: jest.fn() })(
            invalid([{ id: 1 }]),
        );
        expect(readOutbox).not.toHaveBeenCalled();
    });

    test('a failure is logged, a failing log is swallowed, and runs never overlap', async () => {
        const log = jest.fn();
        const failing = createScenarioNotifier({
            isEnabled: () => true,
            readOutbox: () => {
                throw new Error('ipc down');
            },
            translate: T,
            deliver: jest.fn(),
            log,
        });
        await failing(invalid([{ id: 1 }]));
        expect(log).toHaveBeenCalledWith('scenario notification cycle failed: ipc down');

        const quiet = createScenarioNotifier({
            isEnabled: () => {
                throw 'plain';
            },
            readOutbox: jest.fn(),
            translate: T,
            deliver: jest.fn(),
            log: () => {
                throw new Error('sink down');
            },
        });
        await expect(quiet([])).resolves.toBeUndefined();
        await createScenarioNotifier({
            isEnabled: () => {
                throw null;
            },
            readOutbox: jest.fn(),
            translate: T,
            deliver: jest.fn(),
        })([]);

        let release!: (value: OutboxItem[] | null) => void;
        const readOutbox = jest.fn(() => new Promise<OutboxItem[] | null>((r) => (release = r)));
        const slow = createScenarioNotifier({ isEnabled: () => true, readOutbox, translate: T, deliver: jest.fn() });
        const first = slow(invalid([{ id: 1 }]));
        await Promise.resolve();
        await slow(invalid([{ id: 1 }]));
        release(null);
        await first;
        expect(readOutbox).toHaveBeenCalledTimes(1);
    });

    test('defaults the start to now', async () => {
        const deliver = jest.fn();
        const notify = createScenarioNotifier({
            isEnabled: () => true,
            readOutbox: () => outbox,
            translate: T,
            deliver,
        });
        await notify(invalid([{ id: 1 }]));
        expect(deliver).not.toHaveBeenCalled();
    });
});
