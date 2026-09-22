/**
 * Tests for the Android headless background entry (src/js/headless/index.js).
 * It runs one full voting cycle via the existing orchestrator and reports
 * the result + next cadence back to the native service through
 * AndroidHeadlessBridge.onCycleComplete.
 */

jest.mock('../../src/js/apiFactory', () => ({ getApiStrategy: jest.fn() }));
jest.mock('../../src/js/settings', () => ({
    getSetting: jest.fn(),
    loadSettings: jest.fn(() => ({ checkFrequencyMin: 2, checkFrequencyMax: 2 })),
    getEffectiveSetting: jest.fn(),
}));

const apiFactory = require('../../src/js/apiFactory');
const settings = require('../../src/js/settings');
const { OFFLINE_RETRY_MS } = require('../../src/js/scheduling/randomDelay');

// Requiring the entry installs globalThis.GS.
const { computeNextDelayMs } = require('../../src/js/headless/index');

describe('headless runOneCycle', () => {
    let onCycleComplete;

    // The delay assertions below are exact (`toBe(60000)`), and they compare a
    // close_time the test derives from Date.now() against a delay the production
    // code computes from its OWN Date.now() a moment later. With a live clock the
    // two can land on opposite sides of a second boundary, which turns an
    // expected 60000 into 59000 and fails the suite roughly one run in six.
    // Freezing the clock makes both reads agree, so these tests measure the
    // cadence logic rather than how long the setup happened to take.
    const FIXED_NOW_MS = 1_700_000_000_000;

    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(Date, 'now').mockReturnValue(FIXED_NOW_MS);
        onCycleComplete = jest.fn();
        globalThis.AndroidHeadlessBridge = { onCycleComplete };
        settings.loadSettings.mockReturnValue({ checkFrequencyMin: 2, checkFrequencyMax: 2 });
        settings.getEffectiveSetting.mockImplementation((key) => (key === 'lastMinuteThreshold' ? 10 : 1));
        settings.getSetting.mockImplementation((key) => (key === 'token' ? 'tok' : key === 'mock' ? false : undefined));
    });

    afterEach(() => {
        // Guarded: if beforeEach ever threw before the spy was installed, an
        // unconditional restore would throw on the real Date.now and bury the
        // original failure.
        Date.now.mockRestore?.();
        delete globalThis.AndroidHeadlessBridge;
    });

    const lastPayload = () => JSON.parse(onCycleComplete.mock.calls[0][0]);

    test('runs the full cycle and reports ok with a numeric nextDelayMs', async () => {
        const fetchChallengesAndVote = jest.fn().mockResolvedValue({ success: true, message: 'done' });
        const getActiveChallenges = jest.fn().mockResolvedValue({ challenges: [] });
        apiFactory.getApiStrategy.mockReturnValue({ fetchChallengesAndVote, getActiveChallenges });

        await globalThis.GS.runOneCycle();

        expect(fetchChallengesAndVote).toHaveBeenCalledWith('tok');
        expect(onCycleComplete).toHaveBeenCalledTimes(1);
        const payload = lastPayload();
        expect(payload.ok).toBe(true);
        expect(typeof payload.nextDelayMs).toBe('number');
        expect(payload.nextDelayMs).toBeGreaterThan(0);
    });

    test('with no token, reports not-ok and does not vote', async () => {
        settings.getSetting.mockImplementation((key) => (key === 'token' ? '' : undefined));
        const fetchChallengesAndVote = jest.fn();
        apiFactory.getApiStrategy.mockReturnValue({ fetchChallengesAndVote, getActiveChallenges: jest.fn() });

        await globalThis.GS.runOneCycle();

        expect(fetchChallengesAndVote).not.toHaveBeenCalled();
        const payload = lastPayload();
        expect(payload.ok).toBe(false);
        expect(payload.error).toBe('no-token');
    });

    test('in mock mode, skips the cycle (native loop is real-only)', async () => {
        settings.getSetting.mockImplementation((key) => (key === 'token' ? 'tok' : key === 'mock' ? true : undefined));
        const fetchChallengesAndVote = jest.fn();
        apiFactory.getApiStrategy.mockReturnValue({ fetchChallengesAndVote, getActiveChallenges: jest.fn() });

        await globalThis.GS.runOneCycle();

        expect(fetchChallengesAndVote).not.toHaveBeenCalled();
        expect(lastPayload().skipped).toBe('mock');
    });

    test('reports ok:false when the cycle returns a falsy result', async () => {
        const fetchChallengesAndVote = jest.fn().mockResolvedValue(null);
        const getActiveChallenges = jest.fn().mockResolvedValue({ challenges: [] });
        apiFactory.getApiStrategy.mockReturnValue({ fetchChallengesAndVote, getActiveChallenges });

        await globalThis.GS.runOneCycle();

        const payload = lastPayload();
        expect(payload.ok).toBe(false);
        expect(typeof payload.nextDelayMs).toBe('number');
    });

    test('uses the fixed last-minute cadence when a challenge is inside its threshold window', async () => {
        const now = Math.floor(Date.now() / 1000);
        const fetchChallengesAndVote = jest.fn().mockResolvedValue({ success: true });
        const getActiveChallenges = jest
            .fn()
            .mockResolvedValue({ challenges: [{ id: 1, type: 'default', close_time: now + 60 }] });
        apiFactory.getApiStrategy.mockReturnValue({ fetchChallengesAndVote, getActiveChallenges });
        // lastMinuteThreshold=10min → a challenge closing in 60s is in-window;
        // lastMinuteCheckFrequency=1min → next cadence is 60000ms.
        settings.getEffectiveSetting.mockImplementation((key) => (key === 'lastMinuteThreshold' ? 10 : 1));

        await globalThis.GS.runOneCycle();

        expect(lastPayload().nextDelayMs).toBe(60000);
    });

    test('caps the next delay to an upcoming boundary instead of the normal random delay', async () => {
        const now = Math.floor(Date.now() / 1000);
        // threshold 10min → window opens at close-600s; closing in 660s puts the
        // boundary 60s out. The normal random delay is 2min (min=max=2), so the
        // next tick must be capped to the 60s boundary, not the 120s random.
        const approaching = { id: 1, type: 'default', close_time: now + 660 };
        const fetchChallengesAndVote = jest.fn().mockResolvedValue({ success: true, challenges: [approaching] });
        const getActiveChallenges = jest.fn().mockResolvedValue({ challenges: [] });
        apiFactory.getApiStrategy.mockReturnValue({ fetchChallengesAndVote, getActiveChallenges });
        settings.getEffectiveSetting.mockImplementation((key) => (key === 'lastMinuteThreshold' ? 10 : 1));

        await globalThis.GS.runOneCycle();

        expect(lastPayload().nextDelayMs).toBe(60000);
    });

    test('caps the next delay to an upcoming scheduled-fill window start', async () => {
        const now = Math.floor(Date.now() / 1000);
        // Challenge closes in 1h; scheduled-fill before-end window opens 90s
        // out — sooner than the 2-min random delay and the 50-min threshold
        // boundary, so the reported delay must be the 90s cap.
        const scheduled = { id: 7, type: 'default', close_time: now + 3600 };
        const fetchChallengesAndVote = jest.fn().mockResolvedValue({ success: true, challenges: [scheduled] });
        const getActiveChallenges = jest.fn().mockResolvedValue({ challenges: [] });
        apiFactory.getApiStrategy.mockReturnValue({ fetchChallengesAndVote, getActiveChallenges });
        settings.getEffectiveSetting.mockImplementation(
            (key) =>
                ({
                    lastMinuteThreshold: 10,
                    lastMinuteCheckFrequency: 1,
                    useScheduledFill: true,
                    scheduledFillTime: [],
                    scheduledFillBeforeEnd: [3600 - 90],
                })[key],
        );

        await globalThis.GS.runOneCycle();

        expect(lastPayload().nextDelayMs).toBe(90_000);
    });

    test('reports ok:false and a fallback delay when the cycle throws', async () => {
        const fetchChallengesAndVote = jest.fn().mockRejectedValue(new Error('boom'));
        apiFactory.getApiStrategy.mockReturnValue({ fetchChallengesAndVote, getActiveChallenges: jest.fn() });

        await globalThis.GS.runOneCycle();

        const payload = lastPayload();
        expect(payload.ok).toBe(false);
        expect(payload.error).toBe('boom');
        expect(typeof payload.nextDelayMs).toBe('number');
    });

    test('reuses the cycle challenge list for the cadence decision (no second fetch)', async () => {
        const now = Math.floor(Date.now() / 1000);
        const inWindow = { id: 1, type: 'default', close_time: now + 60 };
        // The cycle now hands back the list it fetched; computeNextDelayMs must
        // reuse it instead of issuing its own getActiveChallenges request.
        const fetchChallengesAndVote = jest.fn().mockResolvedValue({ success: true, challenges: [inWindow] });
        const getActiveChallenges = jest.fn().mockResolvedValue({ challenges: [] });
        apiFactory.getApiStrategy.mockReturnValue({ fetchChallengesAndVote, getActiveChallenges });
        settings.getEffectiveSetting.mockImplementation((key) => (key === 'lastMinuteThreshold' ? 10 : 1));

        await globalThis.GS.runOneCycle();

        // No redundant fetch...
        expect(getActiveChallenges).not.toHaveBeenCalled();
        // ...and the reused list still drives the in-window 1-minute cadence.
        expect(lastPayload().nextDelayMs).toBe(60000);
    });

    test('falls back to fetching when the cycle returns no challenge list', async () => {
        const now = Math.floor(Date.now() / 1000);
        const inWindow = { id: 1, type: 'default', close_time: now + 60 };
        const fetchChallengesAndVote = jest.fn().mockResolvedValue({ success: true }); // no challenges field
        const getActiveChallenges = jest.fn().mockResolvedValue({ challenges: [inWindow] });
        apiFactory.getApiStrategy.mockReturnValue({ fetchChallengesAndVote, getActiveChallenges });
        settings.getEffectiveSetting.mockImplementation((key) => (key === 'lastMinuteThreshold' ? 10 : 1));

        await globalThis.GS.runOneCycle();

        expect(getActiveChallenges).toHaveBeenCalledWith('tok');
        expect(lastPayload().nextDelayMs).toBe(60000);
    });

    // Network-outage recovery: on Android the headless loop schedules its own
    // AlarmManager ticks and does NOT use the cadence chain, so it carries its
    // own copy of the offline-retry cap. Without it a reconnection mid-cadence
    // leaves the service idle-but-online for the full (user-settable, unbounded)
    // interval — the Android analogue of the GUI badge stuck on 'Error'.
    describe('offline-retry cap on fetchFailed', () => {
        test('a failed cycle re-fetches, sees fetchFailed, and caps the next delay', async () => {
            // The vote step failed (outage) → the cycle returns success:false with
            // an empty list. runOneCycle must NOT reuse that []; it passes null so
            // computeNextDelayMs re-fetches, and the re-fetch is still down
            // (fetchFailed:true) → normal-mode wait capped to the offline retry.
            const fetchChallengesAndVote = jest.fn().mockResolvedValue({ success: false, challenges: [] });
            const getActiveChallenges = jest.fn().mockResolvedValue({ challenges: [], fetchFailed: true });
            apiFactory.getApiStrategy.mockReturnValue({ fetchChallengesAndVote, getActiveChallenges });

            await globalThis.GS.runOneCycle();

            // Fresh fetch happened (the [] was not reused as prefetched)...
            expect(getActiveChallenges).toHaveBeenCalledWith('tok');
            const payload = lastPayload();
            expect(payload.ok).toBe(false);
            // ...and the 2-min normal random delay was capped to the 30s retry.
            expect(payload.nextDelayMs).toBe(OFFLINE_RETRY_MS);
        });

        test('computeNextDelayMs caps a fresh-fetch outage to OFFLINE_RETRY_MS', async () => {
            const getActiveChallenges = jest.fn().mockResolvedValue({ challenges: [], fetchFailed: true });
            apiFactory.getApiStrategy.mockReturnValue({ getActiveChallenges });

            // Non-array prefetched → fresh fetch → fetchFailed → capped.
            const delay = await computeNextDelayMs('tok', null);

            expect(delay).toBe(OFFLINE_RETRY_MS);
        });

        test('a successful re-fetch with an empty list is NOT capped (only outages retry fast)', async () => {
            // Same empty list, but the account genuinely has no active challenges
            // (fetchFailed falsy). The normal 2-min random cadence must stand — a
            // short retry loop against an idle-but-reachable API would be wrong.
            const getActiveChallenges = jest.fn().mockResolvedValue({ challenges: [], fetchFailed: false });
            apiFactory.getApiStrategy.mockReturnValue({ getActiveChallenges });

            const delay = await computeNextDelayMs('tok', null);

            expect(delay).toBe(120_000); // checkFrequencyMin=max=2 → 2 min, uncapped
        });
    });

    describe('defensive fallbacks', () => {
        const logger = require('../../src/js/logger');
        let info;

        beforeEach(() => {
            info = jest.fn();
            logger.withCategory.mockReturnValue({ info });
        });

        afterEach(() => {
            logger.withCategory.mockReturnValue({
                info: jest.fn(),
                error: jest.fn(),
                debug: jest.fn(),
                warning: jest.fn(),
            });
        });

        test('treats a null fetch result as an empty list and a non-numeric last-minute setting as 1 min', async () => {
            const getActiveChallenges = jest.fn().mockResolvedValue(null);
            apiFactory.getApiStrategy.mockReturnValue({ getActiveChallenges });
            settings.getEffectiveSetting.mockReturnValue('not-a-number');

            await expect(computeNextDelayMs('tok')).resolves.toBe(120_000);
            expect(getActiveChallenges).toHaveBeenCalledWith('tok');
        });

        test('falls back to the normal cadence and logs when the cadence computation throws', async () => {
            apiFactory.getApiStrategy.mockReturnValue({
                getActiveChallenges: jest.fn().mockRejectedValue(new Error('socket hang up')),
            });
            await expect(computeNextDelayMs('tok', null)).resolves.toBe(120_000);
            expect(info).toHaveBeenCalledWith(
                '[headless] next-delay computation failed; using normal cadence',
                'socket hang up',
            );

            apiFactory.getApiStrategy.mockReturnValue({ getActiveChallenges: jest.fn().mockRejectedValue('offline') });
            await expect(computeNextDelayMs('tok', null)).resolves.toBe(120_000);
            expect(info).toHaveBeenCalledWith(
                '[headless] next-delay computation failed; using normal cadence',
                'offline',
            );
        });

        test('reports cycle-failed when the thrown value carries no message', async () => {
            apiFactory.getApiStrategy.mockReturnValue({
                fetchChallengesAndVote: jest.fn().mockRejectedValue({}),
                getActiveChallenges: jest.fn(),
            });

            await globalThis.GS.runOneCycle();

            expect(lastPayload()).toEqual({ ok: false, error: 'cycle-failed', nextDelayMs: 120_000 });
        });

        test('a throwing native bridge callback is logged, never rethrown', async () => {
            onCycleComplete.mockImplementation(() => {
                throw new Error('bridge detached');
            });
            settings.getSetting.mockReturnValue(undefined); // no token → immediate report

            await expect(globalThis.GS.runOneCycle()).resolves.toBeUndefined();
            expect(info).toHaveBeenCalledWith('[headless] onCycleComplete failed', 'bridge detached');
        });
    });
});
