/**
 * WebView (IPC) resolvers the AutovoteContext injects into the shared cadence
 * chain. Each batches its per-challenge keys over getEffectiveSetting and
 * applies the same enablement gate as the Node resolvers.
 */

import {
    resolveThreshold,
    resolveScheduledFill,
    resolveFinalWindowTopUp,
    resolveBoostPrefill,
    resolveCurrencyAuto,
    resolveScenarioWake,
    computeNextCycleDelayMs,
} from '@/contexts/autovoteScheduler';
import { mockApi } from './helpers/setup';

const withSettings = (values) => mockApi.getEffectiveSetting.mockImplementation((key) => Promise.resolve(values[key]));

describe('autovoteScheduler resolvers', () => {
    beforeEach(() => {
        window.api = mockApi;
    });

    it('resolveThreshold reads the per-challenge lastMinuteThreshold', async () => {
        withSettings({ lastMinuteThreshold: 12 });
        await expect(resolveThreshold('c1')).resolves.toBe(12);
        expect(mockApi.getEffectiveSetting).toHaveBeenCalledWith('lastMinuteThreshold', 'c1');
    });

    it('resolveScheduledFill passes list values through raw and gates on a strict true', async () => {
        withSettings({ useScheduledFill: true, scheduledFillTime: ['08:00', '20:00'], scheduledFillBeforeEnd: [600] });
        await expect(resolveScheduledFill('c1')).resolves.toEqual({
            enabled: true,
            timesOfDay: ['08:00', '20:00'],
            beforeEndSecs: [600],
        });
        withSettings({ useScheduledFill: 'yes' });
        await expect(resolveScheduledFill('c1')).resolves.toMatchObject({ enabled: false });
    });

    it.each([
        [true, true, true],
        [true, false, false],
        [false, true, false],
    ])(
        'resolveFinalWindowTopUp: voteBeforeFinalWindow=%s useFinalWindowExposure=%s → enabled=%s',
        async (before, exposure, enabled) => {
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
        const scenario = { name: 'Plan', start: 'main', phases: { main: {} } };
        mockApi.getScenarioStatus.mockResolvedValueOnce({
            success: true,
            scenario,
            state: null,
            corrupt: false,
            timezone: 'UTC',
        });
        await expect(resolveScenarioWake('c1')).resolves.toEqual({ scenario, state: null, timezone: 'UTC' });
        expect(mockApi.getScenarioStatus).toHaveBeenCalledWith('c1');
        mockApi.getScenarioStatus.mockResolvedValueOnce({ success: true, scenario, state: null, corrupt: true });
        await expect(resolveScenarioWake('c1')).resolves.toBeNull();
        mockApi.getScenarioStatus.mockResolvedValueOnce({ success: true, scenario: null });
        await expect(resolveScenarioWake('c1')).resolves.toBeNull();
        mockApi.getScenarioStatus.mockResolvedValueOnce({ success: false });
        await expect(resolveScenarioWake('c1')).resolves.toBeNull();
        mockApi.getScenarioStatus.mockResolvedValueOnce(undefined);
        await expect(resolveScenarioWake('c1')).resolves.toBeNull();
    });

    it('resolveCurrencyAuto: an enabled rule passes its timing through; a disabled one is null', async () => {
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

    it('computeNextCycleDelayMs defaults the timezone and falls back to the normal delay', async () => {
        withSettings({});
        const now = Math.floor(Date.now() / 1000);
        const result = await computeNextCycleDelayMs([], now, {
            normalDelayMs: 180_000,
            lastMinuteCheckMinutes: 1,
            minGapMs: 5_000,
        });
        expect(result).toMatchObject({ mode: 'normal', delayMs: 180_000 });
    });
});
