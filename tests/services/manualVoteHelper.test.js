/**
 * Direct unit tests for submitVotesForChallenge — the shared per-
 * challenge mechanic that BaseMiddleware.cliVoteManual and the IPC
 * vote-all-challenges-manual handler both route through. Three
 * outcomes need explicit coverage so a future refactor of either
 * caller can rely on the contract.
 */

const { submitVotesForChallenge, STAGGER_MS } = require('../../src/js/services/manualVote');

jest.mock('../../src/js/settings');

const NOW = () => Math.floor(Date.now() / 1000);

const challengeWithExposure = (exposureFactor) => ({
    id: '777',
    title: 'Helper Test Challenge',
    type: 'regular',
    start_time: NOW() - 3600,
    close_time: NOW() + 7200,
    member: { ranking: { exposure: { exposure_factor: exposureFactor } } },
});

describe('submitVotesForChallenge', () => {
    test('STAGGER_MS is exported as a positive number', () => {
        expect(typeof STAGGER_MS).toBe('number');
        expect(STAGGER_MS).toBeGreaterThan(0);
    });

    test('returns voted outcome when eligible and images returned', async () => {
        const challenge = challengeWithExposure(50);
        const strategy = {
            getVoteImages: jest.fn().mockResolvedValue({ images: [{ id: 'i1' }, { id: 'i2' }] }),
            submitVotes: jest.fn().mockResolvedValue({ ok: true }),
        };

        const result = await submitVotesForChallenge(challenge, strategy, 'tok', NOW());

        expect(result.outcome).toBe('voted');
        expect(result.targetExposure).toBe(100);
        expect(result.imageCount).toBe(2);
        expect(strategy.getVoteImages).toHaveBeenCalledWith(challenge, 'tok');
        expect(strategy.submitVotes).toHaveBeenCalledWith({ images: [{ id: 'i1' }, { id: 'i2' }] }, 'tok', 100);
    });

    test('returns no-images outcome and skips submitVotes when image list is empty', async () => {
        const challenge = challengeWithExposure(50);
        const strategy = {
            getVoteImages: jest.fn().mockResolvedValue({ images: [] }),
            submitVotes: jest.fn(),
        };

        const result = await submitVotesForChallenge(challenge, strategy, 'tok', NOW());

        expect(result.outcome).toBe('no-images');
        expect(result.targetExposure).toBe(100);
        expect(strategy.submitVotes).not.toHaveBeenCalled();
    });

    test('returns no-images outcome when getVoteImages returns null', async () => {
        const challenge = challengeWithExposure(50);
        const strategy = {
            getVoteImages: jest.fn().mockResolvedValue(null),
            submitVotes: jest.fn(),
        };

        const result = await submitVotesForChallenge(challenge, strategy, 'tok', NOW());

        expect(result.outcome).toBe('no-images');
        expect(strategy.submitVotes).not.toHaveBeenCalled();
    });

    test('returns not-eligible outcome when challenge already at 100% exposure', async () => {
        const challenge = challengeWithExposure(100);
        const strategy = {
            getVoteImages: jest.fn(),
            submitVotes: jest.fn(),
        };

        const result = await submitVotesForChallenge(challenge, strategy, 'tok', NOW());

        expect(result.outcome).toBe('not-eligible');
        expect(result.errorMessage).toContain('100% exposure');
        expect(strategy.getVoteImages).not.toHaveBeenCalled();
        expect(strategy.submitVotes).not.toHaveBeenCalled();
    });

    test('returns not-eligible when the challenge has not started yet', async () => {
        const now = NOW();
        const challenge = {
            id: '888',
            title: 'Future',
            type: 'regular',
            start_time: now + 3600, // not started
            close_time: now + 7200,
            member: { ranking: { exposure: { exposure_factor: 50 } } },
        };
        const strategy = { getVoteImages: jest.fn(), submitVotes: jest.fn() };

        const result = await submitVotesForChallenge(challenge, strategy, 'tok', now);

        expect(result.outcome).toBe('not-eligible');
        expect(result.errorMessage).toContain('has not started');
    });
});
