/**
 * Direct unit tests for submitVotesForChallenge — the shared per-
 * challenge mechanic that BaseMiddleware.cliVoteManual and the IPC
 * vote-all-challenges-manual handler both route through. Three
 * outcomes need explicit coverage so a future refactor of either
 * caller can rely on the contract.
 */

const { submitVotesForChallenge, voteAllChallengesManual, STAGGER_MS } = require('../../src/js/services/manualVote');

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

describe('voteAllChallengesManual', () => {
    test('aggregates voted/skipped counts and staggers successful votes', async () => {
        const challenges = [challengeWithExposure(50), challengeWithExposure(100), challengeWithExposure(50)];
        const strategy = {
            // First eligible challenge has images, the last has none.
            getVoteImages: jest
                .fn()
                .mockResolvedValueOnce({ images: [{ id: 'i1' }] })
                .mockResolvedValueOnce({ images: [] }),
            submitVotes: jest.fn().mockResolvedValue({ ok: true }),
        };
        const progress = jest.fn();

        const result = await voteAllChallengesManual(challenges, strategy, 'tok', {
            onProgress: progress,
            staggerMs: 0,
        });

        // challenge 1: voted; challenge 2: not-eligible (100%); challenge 3: no-images.
        expect(result).toEqual({ voted: 1, skipped: 2, total: 3 });
        expect(strategy.submitVotes).toHaveBeenCalledTimes(1);
        expect(progress).toHaveBeenCalledTimes(3);
        expect(progress).toHaveBeenNthCalledWith(1, 1, 3, challenges[0]);
    });

    test('continues processing remaining challenges after one throws', async () => {
        const challenges = [challengeWithExposure(50), challengeWithExposure(50)];
        const strategy = {
            getVoteImages: jest
                .fn()
                .mockRejectedValueOnce(new Error('boom'))
                .mockResolvedValueOnce({ images: [{ id: 'i1' }] }),
            submitVotes: jest.fn().mockResolvedValue({ ok: true }),
        };

        const result = await voteAllChallengesManual(challenges, strategy, 'tok', { staggerMs: 0 });

        expect(result).toEqual({ voted: 1, skipped: 1, total: 2 });
        expect(strategy.submitVotes).toHaveBeenCalledTimes(1);
    });
});
