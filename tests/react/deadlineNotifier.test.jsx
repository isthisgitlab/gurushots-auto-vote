/**
 * Renderer-side notifier that the cadence chain calls each cycle. The decision
 * math is tested in tests/services/deadlineNotifications.test.js; here we pin
 * the renderer glue: early-exit when the feature is off (no IPC fan-out), the
 * get-deadline-actions {success,actions} unwrap (skip {success:false} without
 * breaking), cross-cycle dedupe, coalescing, and the re-entrancy guard.
 */

import { createDeadlineNotifier } from '@/notifications/deadlineNotifier';

const NOW = 1_000_000;
const okActions = (...actions) => ({ success: true, actions });
const act = (action, secondsUntil) => ({ action, dueAt: NOW + secondsUntil });

const settingsAllOff = { notifyLeadTime: 5 };
const settingsBoostOn = { notifyOnBoost: true, notifyLeadTime: 5 };

const makeNotifier = (over = {}) =>
    createDeadlineNotifier({
        getSettings: jest.fn(async () => settingsBoostOn),
        getDeadlineActions: jest.fn(async () => okActions(act('boost', 120))),
        translate: (key) => key,
        deliver: jest.fn(),
        ...over,
    });

describe('createDeadlineNotifier', () => {
    test('feature off → no per-challenge IPC and no delivery', async () => {
        const getDeadlineActions = jest.fn();
        const deliver = jest.fn();
        const notify = makeNotifier({
            getSettings: jest.fn(async () => settingsAllOff),
            getDeadlineActions,
            deliver,
        });

        await notify([{ id: '1', title: 'A' }], NOW);

        expect(getDeadlineActions).not.toHaveBeenCalled();
        expect(deliver).not.toHaveBeenCalled();
    });

    test('delivers once for an enabled action inside the lead window', async () => {
        const deliver = jest.fn();
        const notify = makeNotifier({ deliver });

        await notify([{ id: '1', title: 'Sunset' }], NOW);

        expect(deliver).toHaveBeenCalledTimes(1);
        expect(deliver.mock.calls[0][0]).toMatchObject({ title: expect.any(String), body: expect.any(String) });
    });

    test('skips a {success:false} deadline-actions response without breaking the loop', async () => {
        const deliver = jest.fn();
        const getDeadlineActions = jest.fn(async (c) =>
            c.id === 'bad' ? { success: false, error: 'x' } : okActions(act('boost', 60)),
        );
        const notify = makeNotifier({ getDeadlineActions, deliver });

        await notify(
            [
                { id: 'bad', title: 'Broken' },
                { id: 'good', title: 'Fine' },
            ],
            NOW,
        );

        // Both challenges probed; only the good one contributes → one toast.
        expect(getDeadlineActions).toHaveBeenCalledTimes(2);
        expect(deliver).toHaveBeenCalledTimes(1);
    });

    test('dedupes across cycles — the same pending window fires only once', async () => {
        const deliver = jest.fn();
        const notify = makeNotifier({ deliver });

        await notify([{ id: '1', title: 'Sunset' }], NOW);
        await notify([{ id: '1', title: 'Sunset' }], NOW + 1);

        expect(deliver).toHaveBeenCalledTimes(1);
    });

    test('coalesces multiple simultaneously-due actions into one delivery', async () => {
        const deliver = jest.fn();
        const getDeadlineActions = jest.fn(async (c) =>
            c.id === '1' ? okActions(act('boost', 60)) : okActions(act('boost', 90)),
        );
        const notify = makeNotifier({
            getSettings: jest.fn(async () => settingsBoostOn),
            getDeadlineActions,
            deliver,
        });

        await notify(
            [
                { id: '1', title: 'A' },
                { id: '2', title: 'B' },
            ],
            NOW,
        );

        expect(deliver).toHaveBeenCalledTimes(1);
    });

    test('re-entrancy guard: an overlapping call returns early without re-delivering', async () => {
        const deliver = jest.fn();
        let releaseSettings;
        const gate = new Promise((resolve) => {
            releaseSettings = resolve;
        });
        // First call blocks inside getSettings; the second call arrives while it
        // is still in flight and must no-op.
        let calls = 0;
        const getSettings = jest.fn(async () => {
            calls += 1;
            if (calls === 1) await gate;
            return settingsBoostOn;
        });
        const notify = makeNotifier({ getSettings, deliver });

        const first = notify([{ id: '1', title: 'A' }], NOW);
        const second = notify([{ id: '1', title: 'A' }], NOW); // overlaps first
        await second; // returns immediately (guard)
        expect(deliver).not.toHaveBeenCalled();

        releaseSettings();
        await first;
        expect(deliver).toHaveBeenCalledTimes(1);
    });

    test('non-array challenges input is handled gracefully', async () => {
        const deliver = jest.fn();
        const notify = makeNotifier({ deliver });
        await expect(notify(null, NOW)).resolves.toBeUndefined();
        expect(deliver).not.toHaveBeenCalled();
    });
});
