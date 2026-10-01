/**
 * Node-host delivery for the deadline notifications (CLI scheduler). The pure
 * decision math is covered in deadlineNotifications.test.ts; here we pin the
 * Node glue: transport-specific escaping (AppleScript / Pango), early-exit when
 * off, direct describeDeadlineActions use with per-challenge fault isolation,
 * cross-cycle dedupe and coalescing — all with injected seams so no real
 * process is spawned.
 */

import type * as nodeNotifyModule from '../../src/ts/services/notify/nodeNotify';
import type { Challenge } from '../../src/ts/types/gurushots';
import { invalid } from '../helpers/invalid';

const { createNodeDeadlineNotifier, escapeAppleScript, escapePango } =
    require('../../src/ts/services/notify/nodeNotify') as typeof nodeNotifyModule;

const NOW = 1_000_000;
const describeWith =
    (...actions: ReturnType<typeof act>[]) =>
    () => ({ actions });
const act = (action: string, secondsUntil: number) => ({ action, dueAt: NOW + secondsUntil });
const settingGetter = (store: Record<string, unknown>) => (key: string) => store[key];

describe('escaping helpers', () => {
    test('escapeAppleScript escapes backslash then double-quote (order matters)', () => {
        expect(escapeAppleScript('a"b\\c')).toBe('a\\"b\\\\c');
    });

    test('escapePango neutralizes markup-significant chars', () => {
        expect(escapePango('<b>&"x"</b>')).toBe('&lt;b&gt;&amp;"x"&lt;/b&gt;');
    });
});

describe('createNodeDeadlineNotifier', () => {
    const boostOn = { notifyOnBoost: true, notifyLeadTime: 5 };

    test('feature off → never calls describeDeadlineActions or deliver', async () => {
        const describeDeadlineActions = jest.fn();
        const deliver = jest.fn();
        const notify = createNodeDeadlineNotifier({
            getSetting: settingGetter({ notifyLeadTime: 5 }),
            describeDeadlineActions,
            translate: (k) => k,
            deliver,
        });

        await notify(invalid([{ id: '1', title: 'A' }]), NOW);

        expect(describeDeadlineActions).not.toHaveBeenCalled();
        expect(deliver).not.toHaveBeenCalled();
    });

    test('delivers once for an enabled, in-window action', async () => {
        const deliver = jest.fn();
        const notify = createNodeDeadlineNotifier({
            getSetting: settingGetter(boostOn),
            describeDeadlineActions: describeWith(act('boost', 120)),
            translate: (k) => k,
            deliver,
        });

        await notify(invalid([{ id: '1', title: 'Sunset' }]), NOW);
        expect(deliver).toHaveBeenCalledTimes(1);
    });

    test('a throwing describeDeadlineActions for one challenge does not sink the batch', async () => {
        const deliver = jest.fn();
        const describeDeadlineActions = jest.fn((c: Challenge) => {
            if (c.id === 'bad') throw new Error('boom');
            return { actions: [act('boost', 60)] };
        });
        const notify = createNodeDeadlineNotifier({
            getSetting: settingGetter(boostOn),
            describeDeadlineActions,
            translate: (k) => k,
            deliver,
        });

        await notify(
            invalid([
                { id: 'bad', title: 'Broken' },
                { id: 'good', title: 'Fine' },
            ]),
            NOW,
        );

        expect(describeDeadlineActions).toHaveBeenCalledTimes(2);
        expect(deliver).toHaveBeenCalledTimes(1);
    });

    test('dedupes across cycles', async () => {
        const deliver = jest.fn();
        const notify = createNodeDeadlineNotifier({
            getSetting: settingGetter(boostOn),
            describeDeadlineActions: describeWith(act('boost', 120)),
            translate: (k) => k,
            deliver,
        });

        await notify(invalid([{ id: '1', title: 'Sunset' }]), NOW);
        await notify(invalid([{ id: '1', title: 'Sunset' }]), NOW + 1);
        expect(deliver).toHaveBeenCalledTimes(1);
    });

    test('coalesces multiple simultaneously-due actions into a single delivery', async () => {
        const deliver = jest.fn();
        const notify = createNodeDeadlineNotifier({
            getSetting: settingGetter(boostOn),
            describeDeadlineActions: (c) => ({ actions: [act('boost', c.id === '1' ? 60 : 90)] }),
            translate: (k) => k,
            deliver,
        });

        await notify(
            invalid([
                { id: '1', title: 'A' },
                { id: '2', title: 'B' },
            ]),
            NOW,
        );
        expect(deliver).toHaveBeenCalledTimes(1);
    });
});
