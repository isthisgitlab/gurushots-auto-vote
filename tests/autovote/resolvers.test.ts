/**
 * The autovote controller's IPC resolvers (src/ts/core/autovote/resolvers.ts) over a
 * hand-built host. Each resolver batches its per-challenge keys over
 * getEffectiveSetting and applies the same enablement gate as the Node
 * resolvers; the decision cases compose the factory resolvers over the real
 * computeNextCycleDelayMs.
 */

import type * as resolversModule from '../../src/ts/core/autovote/resolvers';
import type { Challenge } from '../../src/ts/core/types/gurushots';
import { computeNextCycleDelayMs } from '../../src/ts/core/scheduling/thresholdWindow';
import { invalid } from '../helpers/invalid';

const { createResolvers } = require('../../src/ts/core/autovote/resolvers') as typeof resolversModule;

describe('autovote resolvers', () => {
    let host: Parameters<typeof createResolvers>[0];

    const withSettings = (values: Record<string, unknown>) =>
        jest.mocked(host.getEffectiveSetting).mockImplementation(async (key) => values[key]);

    beforeEach(() => {
        host = {
            getEffectiveSetting: jest.fn(),
            getScenarioStatus: jest.fn(),
        };
    });

    it('resolveThreshold reads the per-challenge lastMinuteThreshold', async () => {
        const { resolveThreshold } = createResolvers(host);
        withSettings({ lastMinuteThreshold: 12 });
        await expect(resolveThreshold('c1')).resolves.toBe(12);
        expect(host.getEffectiveSetting).toHaveBeenCalledWith('lastMinuteThreshold', 'c1');
    });

    it('resolveScheduledFill passes list values through raw and gates on a strict true', async () => {
        const { resolveScheduledFill } = createResolvers(host);
        withSettings({ useScheduledFill: true, scheduledFillTime: ['08:00', '20:00'], scheduledFillBeforeEnd: [600] });
        await expect(resolveScheduledFill('c1')).resolves.toEqual({
            enabled: true,
            timesOfDay: ['08:00', '20:00'],
            beforeEndSecs: [600],
        });
        withSettings({ useScheduledFill: 'yes' });
        await expect(resolveScheduledFill('c1')).resolves.toMatchObject({ enabled: false });
    });

    it('resolveAutoSubmitClock passes the per-challenge clock settings through raw', async () => {
        const { resolveAutoSubmitClock } = createResolvers(host);
        withSettings({
            autoSubmit: true,
            manualPhotosOnly: false,
            autoSubmitTime: ['08:00', '20:00'],
            autoSubmitWindowMinutes: 60,
        });
        await expect(resolveAutoSubmitClock('c1')).resolves.toEqual({
            enabled: true,
            manualPhotosOnly: false,
            times: ['08:00', '20:00'],
            windowMinutes: 60,
        });
        expect(host.getEffectiveSetting).toHaveBeenCalledWith('autoSubmit', 'c1');
        expect(host.getEffectiveSetting).toHaveBeenCalledWith('manualPhotosOnly', 'c1');
        expect(host.getEffectiveSetting).toHaveBeenCalledWith('autoSubmitTime', 'c1');
        expect(host.getEffectiveSetting).toHaveBeenCalledWith('autoSubmitWindowMinutes', 'c1');
    });

    it('resolveAutoSubmitSchedule reads the effective relative schedule', async () => {
        const { resolveAutoSubmitSchedule } = createResolvers(host);
        withSettings({
            autoSubmit: true,
            manualPhotosOnly: false,
            autoSubmitSchedule: [{ count: 2, seconds: 540 }],
        });
        await expect(resolveAutoSubmitSchedule('c1')).resolves.toEqual({
            enabled: true,
            manualPhotosOnly: false,
            schedule: [{ count: 2, seconds: 540 }],
        });
        expect(host.getEffectiveSetting).toHaveBeenCalledWith('autoSubmit', 'c1');
        expect(host.getEffectiveSetting).toHaveBeenCalledWith('manualPhotosOnly', 'c1');
        expect(host.getEffectiveSetting).toHaveBeenCalledWith('autoSubmitSchedule', 'c1');
    });

    it.each([
        [true, true, true],
        [true, false, false],
        [false, true, false],
    ])(
        'resolveFinalWindowTopUp: voteBeforeFinalWindow=%s useFinalWindowExposure=%s → enabled=%s',
        async (before, exposure, enabled) => {
            const { resolveFinalWindowTopUp } = createResolvers(host);
            withSettings({
                voteBeforeFinalWindow: before,
                useFinalWindowExposure: exposure,
                voteBeforeFinalWindowLeadMin: '3',
                finalWindowDuration: '900',
            });
            await expect(resolveFinalWindowTopUp('c1')).resolves.toEqual({
                enabled,
                leadSec: 180,
                durationSec: 900,
            });
        },
    );

    it.each([
        [true, true, false, true],
        [true, true, true, false],
        [true, false, false, false],
        [false, true, false, false],
    ])(
        'resolveBoostPrefill: voteBeforeBoost=%s autoBoost=%s onlyBoost=%s → enabled=%s',
        async (voteBeforeBoost, autoBoost, onlyBoost, enabled) => {
            const { resolveBoostPrefill } = createResolvers(host);
            withSettings({
                voteBeforeBoost,
                autoBoost,
                onlyBoost,
                voteBeforeBoostLeadMin: 2,
                boostTime: 600,
                keyUnlockedBoostTime: 0,
            });
            await expect(resolveBoostPrefill('c1')).resolves.toEqual({
                enabled,
                leadSec: 120,
                boostTimeSec: 600,
                keyUnlockedBoostTimeSec: 0,
            });
        },
    );

    it('resolveScenarioWake: a known scenario with readable state, else null', async () => {
        const { resolveScenarioWake } = createResolvers(host);
        const scenario = { name: 'Plan', start: 'main', phases: { main: {} } };
        jest.mocked(host.getScenarioStatus).mockResolvedValueOnce(
            invalid({
                success: true,
                scenario,
                state: null,
                corrupt: false,
                timezone: 'UTC',
            }),
        );
        await expect(resolveScenarioWake('c1')).resolves.toEqual({ scenario, state: null, timezone: 'UTC' });
        expect(host.getScenarioStatus).toHaveBeenCalledWith('c1');
        // Manual Only keeps the scheduler's boundaries: the flag does not change what it reads.
        jest.mocked(host.getScenarioStatus).mockResolvedValueOnce(
            invalid({ success: true, scenario, state: null, corrupt: false, timezone: 'UTC', manualOnly: true }),
        );
        await expect(resolveScenarioWake('c1')).resolves.toEqual({ scenario, state: null, timezone: 'UTC' });
        jest.mocked(host.getScenarioStatus).mockResolvedValueOnce(
            invalid({ success: true, scenario, state: null, corrupt: true }),
        );
        await expect(resolveScenarioWake('c1')).resolves.toBeNull();
        jest.mocked(host.getScenarioStatus).mockResolvedValueOnce(invalid({ success: true, scenario: null }));
        await expect(resolveScenarioWake('c1')).resolves.toBeNull();
        jest.mocked(host.getScenarioStatus).mockResolvedValueOnce(invalid({ success: false }));
        await expect(resolveScenarioWake('c1')).resolves.toBeNull();
        jest.mocked(host.getScenarioStatus).mockResolvedValueOnce(invalid(undefined));
        await expect(resolveScenarioWake('c1')).resolves.toBeNull();
    });

    it('resolveCurrencyAuto: an enabled rule passes its timing through; a disabled one is null', async () => {
        const { resolveCurrencyAuto } = createResolvers(host);
        withSettings({
            autoKeyUnlock: true,
            autoKeyAfterStart: 39600,
            autoKeyBeforeEnd: 0,
            autoKeyAfterPercent: 0,
            autoSwap: false,
            autoExposureFill: 'true',
        });
        await expect(resolveCurrencyAuto('c1')).resolves.toEqual({
            key: { afterStartSec: 39600, beforeEndSec: 0, afterPercent: 0 },
            swap: null,
            fill: null,
        });
    });

    it('resolveCurrencyAuto: Manual Only leaves the swap with no wake, as the Node resolver does', async () => {
        const { resolveCurrencyAuto } = createResolvers(host);
        const values = {
            autoKeyUnlock: true,
            autoKeyAfterStart: 60,
            autoSwap: true,
            autoSwapAfterStart: 60,
            autoExposureFill: true,
            autoExposureFillAfterStart: 60,
        };
        withSettings({ ...values, autoKeyBeforeEnd: 0, autoKeyAfterPercent: 0, manualPhotosOnly: true });
        await expect(resolveCurrencyAuto('c1')).resolves.toMatchObject({ swap: null, key: { afterStartSec: 60 } });
        expect(host.getEffectiveSetting).toHaveBeenCalledWith('manualPhotosOnly', 'c1');
        withSettings({ ...values, autoSwapBeforeEnd: 0, autoSwapAfterPercent: 0, manualPhotosOnly: false });
        await expect(resolveCurrencyAuto('c1')).resolves.toMatchObject({ swap: { afterStartSec: 60 } });
    });

    describe('computeNextCycleDelayMs over the factory resolvers', () => {
        const decide = (
            challenges: Challenge[],
            now: number,
            opts?: { lastMinuteCheckMinutes?: number; timezone?: string },
        ) => {
            const resolvers = createResolvers(host);
            return computeNextCycleDelayMs(challenges, now, {
                normalDelayMs: 3 * 60_000,
                lastMinuteCheckMinutes: opts?.lastMinuteCheckMinutes ?? 1,
                minGapMs: 5_000,
                timezone: opts?.timezone ?? null,
                resolveThreshold: resolvers.resolveThreshold,
                resolveScheduledFill: resolvers.resolveScheduledFill,
                resolveAutoSubmitClock: resolvers.resolveAutoSubmitClock,
                resolveAutoSubmitSchedule: resolvers.resolveAutoSubmitSchedule,
                resolveFinalWindowTopUp: resolvers.resolveFinalWindowTopUp,
                resolveBoostPrefill: resolvers.resolveBoostPrefill,
                resolveCurrencyAuto: resolvers.resolveCurrencyAuto,
                resolveScenarioWake: resolvers.resolveScenarioWake,
            });
        };

        it('defaults the timezone and falls back to the normal delay', async () => {
            withSettings({});
            const now = Math.floor(Date.now() / 1000);
            const result = await decide([], now, { lastMinuteCheckMinutes: 1 });
            expect(result).toMatchObject({ mode: 'normal', delayMs: 180_000 });
        });

        it('caps the delay to an upcoming boundary resolved over IPC', async () => {
            const now = Math.floor(Date.now() / 1000);
            withSettings({ lastMinuteThreshold: 16 }); // per-challenge threshold via IPC
            // closes in 17 min, threshold 16 → boundary 60s out, under the 3-min delay
            const challenges = invalid<Challenge[]>([
                { id: 126202, title: 'Cats', type: 'regular', close_time: now + 17 * 60 },
            ]);
            const result = await decide(challenges, now);
            expect(result.mode).toBe('approaching');
            expect(result.delayMs).toBe(60_000);
        });

        it('uses the fixed fast cadence when already in-window', async () => {
            const now = Math.floor(Date.now() / 1000);
            withSettings({ lastMinuteThreshold: 10 });
            const challenges = invalid<Challenge[]>([
                { id: 1, title: 'Closing', type: 'regular', close_time: now + 120 },
            ]);
            const result = await decide(challenges, now, { lastMinuteCheckMinutes: 2 });
            expect(result.mode).toBe('last-minute');
            expect(result.delayMs).toBe(2 * 60_000);
        });

        it('caps the delay to a scheduled-fill window start resolved over IPC when timezone is passed', async () => {
            const now = Math.floor(Date.now() / 1000);
            // Per-key async resolution: threshold far away, scheduled-fill
            // before-end window opening 120s out.
            withSettings({
                lastMinuteThreshold: 5,
                useScheduledFill: true,
                scheduledFillTime: [],
                scheduledFillBeforeEnd: [3600 - 120],
            });
            const challenges = invalid<Challenge[]>([
                { id: 9, title: 'Sched', type: 'regular', close_time: now + 3600 },
            ]);
            const result = await decide(challenges, now, { timezone: 'UTC' });
            expect(result.mode).toBe('scheduled');
            expect(result.delayMs).toBe(120_000);
            expect(result.nextScheduled).toMatchObject({ challengeId: 9, form: 'before-end' });
        });

        it('caps the delay to an upcoming relative schedule threshold resolved over IPC', async () => {
            const now = Math.floor(Date.now() / 1000);
            withSettings({
                lastMinuteThreshold: 0,
                autoSubmit: true,
                manualPhotosOnly: false,
                autoSubmitSchedule: [{ count: 2, seconds: 9 * 60 }],
            });
            const result = await decide(
                invalid([
                    {
                        id: 9,
                        title: 'Relative IPC',
                        type: 'regular',
                        close_time: now + 10 * 60,
                        max_photo_submits: 2,
                        member: { ranking: { entries: [] } },
                    },
                ]),
                now,
            );
            expect(result).toMatchObject({ mode: 'auto-submit-schedule', delayMs: 60_000 });
        });

        it('omitting timezone makes no scheduled-fill IPC reads', async () => {
            const now = Math.floor(Date.now() / 1000);
            withSettings({ lastMinuteThreshold: 5 });
            const challenges = invalid<Challenge[]>([
                { id: 9, title: 'Sched', type: 'regular', close_time: now + 3600 },
            ]);
            const result = await decide(challenges, now);
            expect(result.mode).toBe('normal');
            expect(result.nextScheduled).toBeNull();
            // No scheduled-fill keys are resolved without a timezone (that cap stays
            // gated). The threshold key is always resolved; the pre-final-window top-up
            // cap is always active (as on Node) and resolves its own keys regardless.
            const keysRead = jest.mocked(host.getEffectiveSetting).mock.calls.map(([key]) => key);
            expect(keysRead).toContain('lastMinuteThreshold');
            expect(keysRead).not.toContain('useScheduledFill');
            expect(keysRead).not.toContain('scheduledFillTime');
            expect(keysRead).not.toContain('scheduledFillBeforeEnd');
        });
    });
});
