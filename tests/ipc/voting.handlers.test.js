/**
 * Tests for voting.handlers — the IPC entry points the renderer drives
 * voting through. Focuses on the boundary: input validation, token gating,
 * fetch-failure fallbacks, and the three submitVotesForChallenge outcomes
 * funnelled through vote-on-challenge / vote-all-challenges-manual.
 *
 * The middleware passthroughs (gui-vote, run-voting-cycle,
 * run-voting-cycle-for-challenge) are tested at the surface only — their
 * inner mechanic lives in BaseMiddleware and has its own coverage.
 */

jest.mock('../../src/js/settings');
jest.mock('../../src/js/apiFactory');
jest.mock('../../src/js/voting/cancellation');
jest.mock('../../src/js/services/manualVote', () => ({
    submitVotesForChallenge: jest.fn(),
    STAGGER_MS: 0, // make the manual-vote-all loop not actually wait
}));

const settings = require('../../src/js/settings');
const apiFactory = require('../../src/js/apiFactory');
const cancellation = require('../../src/js/voting/cancellation');
const manualVote = require('../../src/js/services/manualVote');
const { buildHandlers } = require('../../src/js/ipc/voting.handlers');

const buildChallenge = ({ id, title = 'C', startInPast = true } = {}) => {
    const now = Math.floor(Date.now() / 1000);
    return {
        id,
        title,
        start_time: startInPast ? now - 3600 : now + 3600,
        close_time: now + 7200,
    };
};

const setToken = (token) => {
    settings.loadSettings = jest.fn().mockReturnValue({ token });
};

const stubStrategy = (challenges) => {
    const strategy = {
        getActiveChallenges: jest.fn().mockResolvedValue(challenges == null ? null : { challenges }),
    };
    apiFactory.getApiStrategy = jest.fn().mockReturnValue(strategy);
    return strategy;
};

describe('gui-vote', () => {
    beforeEach(() => jest.clearAllMocks());

    test('rejects when no token', async () => {
        setToken(null);
        const handlers = buildHandlers();
        const result = await handlers['gui-vote']();
        expect(result).toEqual({ success: false, error: 'No authentication token found' });
    });

    test('delegates to middleware.guiVote when token present', async () => {
        setToken('tok');
        const guiVote = jest.fn().mockResolvedValue({ success: true, message: 'ok' });
        apiFactory.getMiddleware = jest.fn().mockReturnValue({ guiVote });
        const handlers = buildHandlers();
        const result = await handlers['gui-vote']();
        expect(guiVote).toHaveBeenCalled();
        expect(result).toEqual({ success: true, message: 'ok' });
    });

    test('returns formatted error when middleware throws', async () => {
        setToken('tok');
        apiFactory.getMiddleware = jest
            .fn()
            .mockReturnValue({ guiVote: jest.fn().mockRejectedValue(new Error('mw blew up')) });
        const handlers = buildHandlers();
        const result = await handlers['gui-vote']();
        expect(result).toEqual({ success: false, error: 'mw blew up' });
    });
});

describe('run-voting-cycle and run-voting-cycle-for-challenge', () => {
    beforeEach(() => jest.clearAllMocks());

    test('run-voting-cycle delegates to middleware with null challengeId', async () => {
        const runVotingCycle = jest.fn().mockResolvedValue({ success: true });
        apiFactory.getMiddleware = jest.fn().mockReturnValue({ runVotingCycle });
        const handlers = buildHandlers();
        await handlers['run-voting-cycle']();
        expect(runVotingCycle).toHaveBeenCalledWith(null);
    });

    test('run-voting-cycle-for-challenge rejects empty challengeId', async () => {
        const handlers = buildHandlers();
        const empty = await handlers['run-voting-cycle-for-challenge']({}, '');
        expect(empty).toEqual({ success: false, error: 'challengeId is required' });

        const nullId = await handlers['run-voting-cycle-for-challenge']({}, null);
        expect(nullId).toEqual({ success: false, error: 'challengeId is required' });
    });

    test('run-voting-cycle-for-challenge passes challengeId to middleware', async () => {
        const runVotingCycle = jest.fn().mockResolvedValue({ success: true });
        apiFactory.getMiddleware = jest.fn().mockReturnValue({ runVotingCycle });
        const handlers = buildHandlers();
        await handlers['run-voting-cycle-for-challenge']({}, 42);
        expect(runVotingCycle).toHaveBeenCalledWith(42);
    });
});

describe('vote-on-challenge — voteOnSingleChallenge input validation', () => {
    beforeEach(() => jest.clearAllMocks());

    test.each([
        ['null id', null, 'Title'],
        ['empty id', '', 'Title'],
        ['NaN id', 'abc', 'Title'],
    ])('rejects invalid challengeId (%s)', async (_label, id, title) => {
        const handlers = buildHandlers();
        const result = await handlers['vote-on-challenge']({}, id, title);
        expect(result).toEqual({ success: false, error: 'Invalid challenge ID' });
    });

    test('rejects empty challenge title', async () => {
        const handlers = buildHandlers();
        const result = await handlers['vote-on-challenge']({}, '123', '');
        expect(result).toEqual({ success: false, error: 'Challenge title is required' });
    });

    test('rejects non-string challenge title', async () => {
        const handlers = buildHandlers();
        const result = await handlers['vote-on-challenge']({}, '123', null);
        expect(result).toEqual({ success: false, error: 'Challenge title is required' });
    });

    test('rejects when no token configured', async () => {
        setToken(null);
        const handlers = buildHandlers();
        const result = await handlers['vote-on-challenge']({}, '123', 'Title');
        expect(result).toEqual({ success: false, error: 'No authentication token found' });
    });
});

describe('vote-on-challenge — full flow outcomes', () => {
    beforeEach(() => jest.clearAllMocks());

    test('returns failure when challenges fetch returns null', async () => {
        setToken('tok');
        stubStrategy(null);
        const handlers = buildHandlers();
        const result = await handlers['vote-on-challenge']({}, '123', 'Title');
        expect(result).toEqual({ success: false, error: 'Failed to fetch challenges' });
    });

    test('returns "not found" when challenge ID missing from response', async () => {
        setToken('tok');
        stubStrategy([buildChallenge({ id: 999 })]);
        const handlers = buildHandlers();
        const result = await handlers['vote-on-challenge']({}, '123', 'Missing');
        expect(result).toEqual({ success: false, error: 'Challenge "Missing" not found' });
    });

    test('returns "not started" when challenge start_time is in future', async () => {
        setToken('tok');
        stubStrategy([buildChallenge({ id: 123, title: 'Future', startInPast: false })]);
        const handlers = buildHandlers();
        const result = await handlers['vote-on-challenge']({}, '123', 'Future');
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/has not started/);
    });

    test('returns failure when submitVotesForChallenge says not-eligible', async () => {
        setToken('tok');
        stubStrategy([buildChallenge({ id: 123, title: 'C' })]);
        manualVote.submitVotesForChallenge.mockResolvedValue({
            outcome: 'not-eligible',
            errorMessage: 'already 100%',
        });
        const handlers = buildHandlers();
        const result = await handlers['vote-on-challenge']({}, '123', 'C');
        expect(result).toEqual({ success: false, error: 'already 100%' });
    });

    test('returns success when submitVotesForChallenge says voted', async () => {
        setToken('tok');
        stubStrategy([buildChallenge({ id: 123, title: 'C' })]);
        manualVote.submitVotesForChallenge.mockResolvedValue({
            outcome: 'voted',
            targetExposure: 100,
            imageCount: 4,
        });
        const handlers = buildHandlers();
        const result = await handlers['vote-on-challenge']({}, '123', 'C');
        expect(result).toEqual({ success: true, message: 'Successfully voted on challenge "C"' });
    });

    test('returns success even when no images returned (no-images is not an error)', async () => {
        setToken('tok');
        stubStrategy([buildChallenge({ id: 123, title: 'C' })]);
        manualVote.submitVotesForChallenge.mockResolvedValue({ outcome: 'no-images' });
        const handlers = buildHandlers();
        const result = await handlers['vote-on-challenge']({}, '123', 'C');
        expect(result.success).toBe(true);
    });

    test('manual variant produces "manually" suffix in success message', async () => {
        setToken('tok');
        stubStrategy([buildChallenge({ id: 123, title: 'C' })]);
        manualVote.submitVotesForChallenge.mockResolvedValue({
            outcome: 'voted',
            targetExposure: 100,
            imageCount: 4,
        });
        const handlers = buildHandlers();
        const result = await handlers['vote-on-challenge-manual']({}, '123', 'C');
        expect(result).toEqual({ success: true, message: 'Successfully voted on challenge "C" manually' });
    });
});

describe('vote-all-challenges-manual', () => {
    beforeEach(() => jest.clearAllMocks());

    test('rejects when no token', async () => {
        setToken(null);
        const handlers = buildHandlers();
        const result = await handlers['vote-all-challenges-manual']();
        expect(result).toEqual({ success: false, error: 'No authentication token found' });
    });

    test('rejects when challenges fetch fails', async () => {
        setToken('tok');
        stubStrategy(null);
        const handlers = buildHandlers();
        const result = await handlers['vote-all-challenges-manual']();
        expect(result).toEqual({ success: false, error: 'Failed to fetch challenges' });
    });

    test('aggregates voted/skipped counts across multiple challenges', async () => {
        setToken('tok');
        stubStrategy([
            buildChallenge({ id: 1, title: 'A' }),
            buildChallenge({ id: 2, title: 'B' }),
            buildChallenge({ id: 3, title: 'C' }),
        ]);
        manualVote.submitVotesForChallenge
            .mockResolvedValueOnce({ outcome: 'voted', targetExposure: 100, imageCount: 2 })
            .mockResolvedValueOnce({ outcome: 'no-images', targetExposure: 100 })
            .mockResolvedValueOnce({ outcome: 'not-eligible', errorMessage: 'closed' });
        const handlers = buildHandlers();
        const result = await handlers['vote-all-challenges-manual']();
        expect(result.success).toBe(true);
        expect(result.stats).toEqual({ total: 3, voted: 1, skipped: 2 });
    });

    test('continues processing remaining challenges after one throws', async () => {
        setToken('tok');
        stubStrategy([buildChallenge({ id: 1, title: 'A' }), buildChallenge({ id: 2, title: 'B' })]);
        manualVote.submitVotesForChallenge
            .mockRejectedValueOnce(new Error('boom'))
            .mockResolvedValueOnce({ outcome: 'voted', targetExposure: 100, imageCount: 1 });
        const handlers = buildHandlers();
        const result = await handlers['vote-all-challenges-manual']();
        expect(result.stats).toEqual({ total: 2, voted: 1, skipped: 1 });
    });
});

describe('should-cancel-voting and set-cancel-voting', () => {
    beforeEach(() => jest.clearAllMocks());

    test('should-cancel-voting returns cancellation.isCancelled() value', () => {
        cancellation.isCancelled = jest.fn().mockReturnValue(true);
        const handlers = buildHandlers();
        expect(handlers['should-cancel-voting']()).toBe(true);
        expect(cancellation.isCancelled).toHaveBeenCalled();
    });

    test('set-cancel-voting writes the flag and returns the new state', () => {
        cancellation.setCancelled = jest.fn();
        cancellation.isCancelled = jest.fn().mockReturnValue(true);
        const handlers = buildHandlers();
        const result = handlers['set-cancel-voting']({}, true);
        expect(cancellation.setCancelled).toHaveBeenCalledWith(true);
        expect(result).toBe(true);
    });
});
