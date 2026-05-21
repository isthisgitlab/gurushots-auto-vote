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

// Requiring the entry installs globalThis.GS.
require('../../src/js/headless/index');

describe('headless runOneCycle', () => {
    let onCycleComplete;

    beforeEach(() => {
        jest.clearAllMocks();
        onCycleComplete = jest.fn();
        globalThis.AndroidHeadlessBridge = { onCycleComplete };
        settings.loadSettings.mockReturnValue({ checkFrequencyMin: 2, checkFrequencyMax: 2 });
        settings.getEffectiveSetting.mockImplementation((key) => (key === 'lastMinuteThreshold' ? 10 : 1));
        settings.getSetting.mockImplementation((key) => (key === 'token' ? 'tok' : key === 'mock' ? false : undefined));
    });

    afterEach(() => {
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

    test('reports ok:false and a fallback delay when the cycle throws', async () => {
        const fetchChallengesAndVote = jest.fn().mockRejectedValue(new Error('boom'));
        apiFactory.getApiStrategy.mockReturnValue({ fetchChallengesAndVote, getActiveChallenges: jest.fn() });

        await globalThis.GS.runOneCycle();

        const payload = lastPayload();
        expect(payload.ok).toBe(false);
        expect(payload.error).toBe('boom');
        expect(typeof payload.nextDelayMs).toBe('number');
    });
});
