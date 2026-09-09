/**
 * Renderer-side notifier that the cadence chain calls each cycle. The decision
 * math is tested in tests/services/deadlineNotifications.test.js; here we pin
 * the renderer glue: early-exit when the feature is off (no IPC fan-out), the
 * get-deadline-actions {success,actions} unwrap (skip {success:false} without
 * breaking), cross-cycle dedupe, coalescing, and the re-entrancy guard.
 */

import {
    createDeadlineNotifier,
    deliverElectronNotification,
    resolveRendererDelivery,
} from '@/notifications/deadlineNotifier';

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

    test('a rejecting getSettings is caught, logged, and releases the guard (self-contained)', async () => {
        const deliver = jest.fn();
        const log = jest.fn();
        let fail = true;
        const getSettings = jest.fn(async () => {
            if (fail) throw new Error('settings down');
            return settingsBoostOn;
        });
        const notify = makeNotifier({ getSettings, deliver, log });

        // First cycle: getSettings throws → must resolve (not reject), log, deliver nothing.
        await expect(notify([{ id: '1', title: 'A' }], NOW)).resolves.toBeUndefined();
        expect(log).toHaveBeenCalledTimes(1);
        expect(deliver).not.toHaveBeenCalled();

        // Guard released → a later healthy cycle still works.
        fail = false;
        await notify([{ id: '1', title: 'A' }], NOW);
        expect(deliver).toHaveBeenCalledTimes(1);
    });
});

describe('deliverElectronNotification', () => {
    const originalNotification = globalThis.Notification;
    afterEach(() => {
        globalThis.Notification = originalNotification;
    });

    const stubNotification = (permission) => {
        const ctor = jest.fn(function () {
            this.onclick = null;
        });
        ctor.permission = permission;
        ctor.requestPermission = jest.fn();
        globalThis.Notification = ctor;
        return ctor;
    };

    test('no Notification API → silent no-op, never throws', () => {
        delete globalThis.Notification;
        expect(() => deliverElectronNotification({ title: 'x', body: 'y' })).not.toThrow();
    });

    test('permission denied → skipped (does not construct)', () => {
        const ctor = stubNotification('denied');
        deliverElectronNotification({ title: 'x', body: 'y' });
        expect(ctor).not.toHaveBeenCalled();
    });

    test('permission default → requests permission and still attempts', () => {
        const ctor = stubNotification('default');
        deliverElectronNotification({ title: 'Boost', body: 'in 5 min' });
        expect(ctor.requestPermission).toHaveBeenCalledTimes(1);
        expect(ctor).toHaveBeenCalledWith('Boost', { body: 'in 5 min' });
    });

    test('permission granted → constructs and wires onclick to focus the window', () => {
        const ctor = stubNotification('granted');
        const focus = jest.spyOn(window, 'focus').mockImplementation(() => {});
        deliverElectronNotification({ title: 'Boost', body: 'in 5 min' });
        expect(ctor).toHaveBeenCalledTimes(1);
        const instance = ctor.mock.instances[0];
        expect(typeof instance.onclick).toBe('function');
        instance.onclick();
        expect(focus).toHaveBeenCalled();
        focus.mockRestore();
    });

    test('a throwing Notification constructor is swallowed', () => {
        const ctor = jest.fn(() => {
            throw new Error('OS blocked');
        });
        ctor.permission = 'granted';
        globalThis.Notification = ctor;
        expect(() => deliverElectronNotification({ title: 'x', body: 'y' })).not.toThrow();
    });
});

describe('resolveRendererDelivery — platform gate', () => {
    test('native platform → null (notifier not wired there)', () => {
        expect(resolveRendererDelivery(true)).toBeNull();
    });

    test('non-native (Electron) → the Web Notification deliverer', () => {
        expect(resolveRendererDelivery(false)).toBe(deliverElectronNotification);
    });
});
