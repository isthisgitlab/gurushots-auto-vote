/**
 * Node-side resolvers feeding the cadence math. The gates must mirror the rule
 * engine exactly: pre-final-window top-up needs BOTH its opt-in and the
 * final-window feature; pre-boost fill needs its opt-in AND autoBoost AND
 * onlyBoost off.
 */

jest.mock('../../src/js/settings', () => ({ getEffectiveSetting: jest.fn() }));

const settings = require('../../src/js/settings');
const {
    resolveThreshold,
    resolveScheduledFill,
    resolveFinalWindowTopUp,
    resolveBoostPrefill,
    resolveCurrencyAuto,
} = require('../../src/js/scheduling/nodeResolvers');

const withSettings = (values) => {
    settings.getEffectiveSetting.mockImplementation((key) => values[key]);
};

test('resolveThreshold reads the per-challenge lastMinuteThreshold', () => {
    withSettings({ lastMinuteThreshold: 12 });
    expect(resolveThreshold('c1')).toBe(12);
    expect(settings.getEffectiveSetting).toHaveBeenCalledWith('lastMinuteThreshold', 'c1');
});

test('resolveScheduledFill passes the lists through raw', () => {
    withSettings({ useScheduledFill: true, scheduledFillTime: ['08:00'], scheduledFillBeforeEnd: [14400, 36000] });
    expect(resolveScheduledFill('c1')).toEqual({
        enabled: true,
        timesOfDay: ['08:00'],
        beforeEndSecs: [14400, 36000],
    });
});

describe('resolveFinalWindowTopUp', () => {
    test.each([
        [true, true, true],
        [true, false, false],
        [false, true, false],
    ])('voteBeforeFinalWindow=%s useFinalWindowExposure=%s → enabled=%s', (opt, feature, enabled) => {
        withSettings({
            voteBeforeFinalWindow: opt,
            useFinalWindowExposure: feature,
            voteBeforeFinalWindowLeadMin: 15,
            finalWindowDuration: 3600,
        });
        expect(resolveFinalWindowTopUp('c1')).toEqual({ enabled, leadSec: 900, durationSec: 3600 });
    });

    test('a missing lead yields NaN for thresholdWindow to re-guard', () => {
        withSettings({ voteBeforeFinalWindow: true, useFinalWindowExposure: true });
        expect(resolveFinalWindowTopUp('c1').leadSec).toBeNaN();
    });
});

describe('resolveBoostPrefill', () => {
    test.each([
        [{ voteBeforeBoost: true, autoBoost: true, onlyBoost: false }, true],
        [{ voteBeforeBoost: true, autoBoost: false, onlyBoost: false }, false],
        [{ voteBeforeBoost: true, autoBoost: true, onlyBoost: true }, false],
        [{ voteBeforeBoost: false, autoBoost: true, onlyBoost: false }, false],
    ])('%o → enabled=%s', (gates, enabled) => {
        withSettings({ ...gates, voteBeforeBoostLeadMin: 10, boostTime: 600, keyUnlockedBoostTime: 900 });
        expect(resolveBoostPrefill('c1')).toEqual({
            enabled,
            leadSec: 600,
            boostTimeSec: 600,
            keyUnlockedBoostTimeSec: 900,
        });
    });
});

describe('resolveCurrencyAuto', () => {
    test('an enabled rule passes its timing through; a disabled one is null', () => {
        withSettings({
            autoKeyUnlock: true,
            autoKeyAfterStart: 39600,
            autoKeyBeforeEnd: 0,
            autoKeyAfterPercent: 0,
            autoSwap: false,
            autoExposureFill: true,
            autoExposureFillAfterStart: 0,
            autoExposureFillBeforeEnd: 25200,
            autoExposureFillAfterPercent: 50,
        });
        expect(resolveCurrencyAuto('c1')).toEqual({
            key: { afterStartSec: 39600, beforeEndSec: 0, afterPercent: 0 },
            swap: null,
            fill: { afterStartSec: 0, beforeEndSec: 25200, afterPercent: 50 },
        });
    });
});
