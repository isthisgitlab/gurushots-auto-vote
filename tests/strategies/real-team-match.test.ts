/**
 * Tests for strategies/real/teamMatch.ts — the one-slot team-match cache.
 * latestTeamMatch answers synchronously from the cache and refreshes it in the
 * background at most once per minute, whatever the outcome; a different or empty
 * token never sees (or keeps) another token's result.
 */

import type * as teamMatchModule from '../../src/ts/strategies/real/teamMatch';
import type * as teamsModule from '../../src/ts/api/teams';
import type { TeamMatch } from '../../src/ts/types/gurushots';

jest.mock('../../src/ts/api/teams', () => ({ fetchActiveTeamMatch: jest.fn() }));

type Read = Awaited<ReturnType<typeof teamsModule.fetchActiveTeamMatch>>;

let latestTeamMatch: typeof teamMatchModule.latestTeamMatch;
let fetchActiveTeamMatch: jest.MockedFunction<typeof teamsModule.fetchActiveTeamMatch>;

const MINUTE = 60_000;
const teamMatch = (us: number, them: number): TeamMatch => ({
    us: { name: 'Home Team', votes: us },
    them: { name: 'Poland Gurus', votes: them },
});
const matched = (us = 10, them = 20): Read => ({
    kind: 'match',
    challengeId: '135938',
    teamMatch: teamMatch(us, them),
});
const none: Read = { kind: 'none' };
const failed: Read = { kind: 'failed' };

// A fetch the test settles by hand.
const deferred = () => {
    let resolve!: (read: Read) => void;
    const promise = new Promise<Read>((r) => {
        resolve = r;
    });
    return { promise, resolve };
};

// Lets the background refresh settle.
const settle = () => jest.advanceTimersByTimeAsync(0);

// One settled refresh per answer, with a minute between them so each call starts the next.
const refreshWith = async (token: string, read: Read) => {
    fetchActiveTeamMatch.mockResolvedValueOnce(read);
    latestTeamMatch(token);
    await settle();
};
const nextMinute = () => jest.advanceTimersByTime(MINUTE + 1);

beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-19T12:00:00Z'));
    jest.resetModules();
    ({ latestTeamMatch } = require('../../src/ts/strategies/real/teamMatch') as typeof teamMatchModule);
    fetchActiveTeamMatch = jest.mocked((require('../../src/ts/api/teams') as typeof teamsModule).fetchActiveTeamMatch);
});

afterEach(() => jest.useRealTimers());

describe('latestTeamMatch', () => {
    test('the first call starts one refresh and answers nothing yet; the next call has the result', async () => {
        fetchActiveTeamMatch.mockResolvedValueOnce(matched());

        expect(latestTeamMatch('tok')).toBeUndefined();
        expect(fetchActiveTeamMatch).toHaveBeenCalledTimes(1);
        expect(fetchActiveTeamMatch).toHaveBeenCalledWith('tok');
        await settle();

        expect(latestTeamMatch('tok')).toEqual({ challengeId: '135938', teamMatch: teamMatch(10, 20) });
        expect(fetchActiveTeamMatch).toHaveBeenCalledTimes(1);
    });

    test.each([
        ['match', matched()],
        ['none', none],
        ['failed', failed],
    ])('after a %s result there is no new request within a minute, then exactly one', async (_name, read) => {
        await refreshWith('tok', read);

        jest.advanceTimersByTime(MINUTE - 1);
        latestTeamMatch('tok');
        latestTeamMatch('tok');
        expect(fetchActiveTeamMatch).toHaveBeenCalledTimes(1);

        jest.advanceTimersByTime(2);
        fetchActiveTeamMatch.mockResolvedValueOnce(read);
        latestTeamMatch('tok');
        latestTeamMatch('tok');
        expect(fetchActiveTeamMatch).toHaveBeenCalledTimes(2);
    });

    test('concurrent callers share one in-flight refresh', async () => {
        const refresh = deferred();
        fetchActiveTeamMatch.mockReturnValueOnce(refresh.promise);

        latestTeamMatch('tok');
        latestTeamMatch('tok');
        nextMinute();
        latestTeamMatch('tok');

        expect(fetchActiveTeamMatch).toHaveBeenCalledTimes(1);
        refresh.resolve(matched());
        await settle();
    });

    test('none is cached as a value: it clears a previous match and is not re-requested', async () => {
        await refreshWith('tok', matched());
        nextMinute();
        await refreshWith('tok', none);

        expect(latestTeamMatch('tok')).toBeUndefined();
        expect(fetchActiveTeamMatch).toHaveBeenCalledTimes(2);
    });

    test('a failed refresh keeps the last result; three in a row drop it', async () => {
        await refreshWith('tok', matched());

        for (const kept of [true, true, false]) {
            nextMinute();
            await refreshWith('tok', failed);
            expect(latestTeamMatch('tok') !== undefined).toBe(kept);
        }
    });

    test('a match in between resets the failure count: fail, fail, match, fail, fail still keeps the match', async () => {
        await refreshWith('tok', failed);
        nextMinute();
        await refreshWith('tok', failed);
        nextMinute();
        await refreshWith('tok', matched());
        nextMinute();
        await refreshWith('tok', failed);
        nextMinute();
        await refreshWith('tok', failed);

        expect(latestTeamMatch('tok')).toEqual({ challengeId: '135938', teamMatch: teamMatch(10, 20) });
    });

    test('a first refresh that fails leaves nothing and waits out the minute', async () => {
        await refreshWith('tok', failed);

        expect(latestTeamMatch('tok')).toBeUndefined();
        expect(fetchActiveTeamMatch).toHaveBeenCalledTimes(1);
    });

    test('a different token replaces the slot and never sees the previous token result', async () => {
        await refreshWith('A', matched());
        fetchActiveTeamMatch.mockResolvedValueOnce(none);

        expect(latestTeamMatch('B')).toBeUndefined();
        expect(fetchActiveTeamMatch).toHaveBeenLastCalledWith('B');
        await settle();

        expect(latestTeamMatch('B')).toBeUndefined();
        // A's result is gone, not parked: A refreshes from scratch.
        fetchActiveTeamMatch.mockResolvedValueOnce(none);
        expect(latestTeamMatch('A')).toBeUndefined();
        expect(fetchActiveTeamMatch).toHaveBeenLastCalledWith('A');
        await settle();
    });

    test('a token change mid-refresh discards the old result and does not wait for it', async () => {
        const a = deferred();
        const b = deferred();
        fetchActiveTeamMatch.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);

        latestTeamMatch('A');
        expect(latestTeamMatch('B')).toBeUndefined();
        expect(fetchActiveTeamMatch).toHaveBeenCalledTimes(2);
        expect(fetchActiveTeamMatch).toHaveBeenLastCalledWith('B');

        a.resolve(matched(1, 2));
        await settle();
        expect(latestTeamMatch('B')).toBeUndefined();
        // A settling neither cleared B's in-flight refresh nor started another.
        expect(fetchActiveTeamMatch).toHaveBeenCalledTimes(2);

        b.resolve(matched(3, 4));
        await settle();
        expect(latestTeamMatch('B')).toEqual({ challengeId: '135938', teamMatch: teamMatch(3, 4) });
        expect(fetchActiveTeamMatch).toHaveBeenCalledTimes(2);
    });

    test('an empty token drops the slot and sends no request, however often it is asked', async () => {
        await refreshWith('tok', matched());

        expect(latestTeamMatch('')).toBeUndefined();
        nextMinute();
        expect(latestTeamMatch('')).toBeUndefined();
        expect(latestTeamMatch('')).toBeUndefined();
        expect(fetchActiveTeamMatch).toHaveBeenCalledTimes(1);

        // Signing back in starts from nothing.
        fetchActiveTeamMatch.mockResolvedValueOnce(none);
        expect(latestTeamMatch('tok')).toBeUndefined();
        expect(fetchActiveTeamMatch).toHaveBeenCalledTimes(2);
        await settle();
    });

    test('a rejecting fetch never rejects out and counts as a failed refresh', async () => {
        fetchActiveTeamMatch.mockRejectedValueOnce(new Error('boom'));

        expect(latestTeamMatch('tok')).toBeUndefined();
        await settle();

        expect(latestTeamMatch('tok')).toBeUndefined();
        expect(fetchActiveTeamMatch).toHaveBeenCalledTimes(1);
    });

    test('a team read that never settles does not hold the caller: the answer is synchronous', () => {
        fetchActiveTeamMatch.mockReturnValueOnce(new Promise<Read>(() => {}));

        expect(latestTeamMatch('tok')).toBeUndefined();
        expect(latestTeamMatch('tok')).toBeUndefined();
    });

    test('a stuck refresh blocks new ones only until it settles', async () => {
        const stuck = deferred();
        fetchActiveTeamMatch.mockReturnValueOnce(stuck.promise);
        latestTeamMatch('tok');

        jest.advanceTimersByTime(10 * MINUTE);
        latestTeamMatch('tok');
        expect(fetchActiveTeamMatch).toHaveBeenCalledTimes(1);

        stuck.resolve(none);
        await settle();
        nextMinute();
        fetchActiveTeamMatch.mockResolvedValueOnce(none);
        latestTeamMatch('tok');
        expect(fetchActiveTeamMatch).toHaveBeenCalledTimes(2);
        await settle();
    });
});
