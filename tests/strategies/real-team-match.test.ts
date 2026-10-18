/**
 * Tests for strategies/real/teamMatch.ts — the one-slot team-match cache.
 * refreshTeamMatch refreshes the cache in the background at most once per
 * minute, whatever the outcome, and settledTeamMatch reads it; a different or empty
 * token never sees (or keeps) another token's result.
 */

import type * as teamMatchModule from '../../src/ts/strategies/real/teamMatch';
import type * as teamsModule from '../../src/ts/api/teams';
import type { TeamMatch } from '../../src/ts/types/gurushots';

jest.mock('../../src/ts/api/teams', () => ({ fetchActiveTeamMatch: jest.fn() }));

type Read = Awaited<ReturnType<typeof teamsModule.fetchActiveTeamMatch>>;

let refreshTeamMatch: typeof teamMatchModule.refreshTeamMatch;
let settledTeamMatch: typeof teamMatchModule.settledTeamMatch;
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
    refreshTeamMatch(token);
    await settle();
};
// Reads the cache without waiting and without starting a refresh.
const cached = (token: string) => settledTeamMatch(token, 0);
const nextMinute = () => jest.advanceTimersByTime(MINUTE + 1);

beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-19T12:00:00Z'));
    jest.resetModules();
    ({ refreshTeamMatch, settledTeamMatch } =
        require('../../src/ts/strategies/real/teamMatch') as typeof teamMatchModule);
    fetchActiveTeamMatch = jest.mocked((require('../../src/ts/api/teams') as typeof teamsModule).fetchActiveTeamMatch);
});

afterEach(() => jest.useRealTimers());

describe('refreshTeamMatch', () => {
    test('the first call starts one refresh and answers nothing yet; the next call has the result', async () => {
        fetchActiveTeamMatch.mockResolvedValueOnce(matched());

        refreshTeamMatch('tok');
        expect(await cached('tok')).toBeUndefined();
        expect(fetchActiveTeamMatch).toHaveBeenCalledTimes(1);
        expect(fetchActiveTeamMatch).toHaveBeenCalledWith('tok');
        await settle();

        refreshTeamMatch('tok');
        expect(await cached('tok')).toEqual({ challengeId: '135938', teamMatch: teamMatch(10, 20) });
        expect(fetchActiveTeamMatch).toHaveBeenCalledTimes(1);
    });

    test('returns true only for the call that started a refresh', async () => {
        fetchActiveTeamMatch.mockResolvedValueOnce(matched());

        expect(refreshTeamMatch('tok')).toBe(true);
        expect(refreshTeamMatch('tok')).toBe(false);
        await settle();
        expect(refreshTeamMatch('tok')).toBe(false);
        nextMinute();
        fetchActiveTeamMatch.mockResolvedValueOnce(matched());
        expect(refreshTeamMatch('tok')).toBe(true);
        expect(refreshTeamMatch('')).toBe(false);
        await settle();
    });

    test.each([
        ['match', matched()],
        ['none', none],
        ['failed', failed],
    ])('after a %s result there is no new request within a minute, then exactly one', async (_name, read) => {
        await refreshWith('tok', read);

        jest.advanceTimersByTime(MINUTE - 1);
        refreshTeamMatch('tok');
        refreshTeamMatch('tok');
        expect(fetchActiveTeamMatch).toHaveBeenCalledTimes(1);

        jest.advanceTimersByTime(2);
        fetchActiveTeamMatch.mockResolvedValueOnce(read);
        refreshTeamMatch('tok');
        refreshTeamMatch('tok');
        expect(fetchActiveTeamMatch).toHaveBeenCalledTimes(2);
    });

    test('concurrent callers share one in-flight refresh', async () => {
        const refresh = deferred();
        fetchActiveTeamMatch.mockReturnValueOnce(refresh.promise);

        refreshTeamMatch('tok');
        refreshTeamMatch('tok');
        nextMinute();
        refreshTeamMatch('tok');

        expect(fetchActiveTeamMatch).toHaveBeenCalledTimes(1);
        refresh.resolve(matched());
        await settle();
    });

    test('none is cached as a value: it clears a previous match and is not re-requested', async () => {
        await refreshWith('tok', matched());
        nextMinute();
        await refreshWith('tok', none);

        refreshTeamMatch('tok');
        expect(await cached('tok')).toBeUndefined();
        expect(fetchActiveTeamMatch).toHaveBeenCalledTimes(2);
    });

    test('a failed refresh keeps the last result; three in a row drop it', async () => {
        await refreshWith('tok', matched());

        for (const kept of [true, true, false]) {
            nextMinute();
            await refreshWith('tok', failed);
            refreshTeamMatch('tok');
            expect((await cached('tok')) !== undefined).toBe(kept);
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

        refreshTeamMatch('tok');
        expect(await cached('tok')).toEqual({ challengeId: '135938', teamMatch: teamMatch(10, 20) });
    });

    test('a first refresh that fails leaves nothing and waits out the minute', async () => {
        await refreshWith('tok', failed);

        refreshTeamMatch('tok');
        expect(await cached('tok')).toBeUndefined();
        expect(fetchActiveTeamMatch).toHaveBeenCalledTimes(1);
    });

    test('a different token replaces the slot and never sees the previous token result', async () => {
        await refreshWith('A', matched());
        fetchActiveTeamMatch.mockResolvedValueOnce(none);

        refreshTeamMatch('B');
        expect(await cached('B')).toBeUndefined();
        expect(fetchActiveTeamMatch).toHaveBeenLastCalledWith('B');
        await settle();

        refreshTeamMatch('B');
        expect(await cached('B')).toBeUndefined();
        // A's result is gone, not parked: A refreshes from scratch.
        fetchActiveTeamMatch.mockResolvedValueOnce(none);
        refreshTeamMatch('A');
        expect(await cached('A')).toBeUndefined();
        expect(fetchActiveTeamMatch).toHaveBeenLastCalledWith('A');
        await settle();
    });

    test('a token change mid-refresh discards the old result and does not wait for it', async () => {
        const a = deferred();
        const b = deferred();
        fetchActiveTeamMatch.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);

        refreshTeamMatch('A');
        refreshTeamMatch('B');
        expect(await cached('B')).toBeUndefined();
        expect(fetchActiveTeamMatch).toHaveBeenCalledTimes(2);
        expect(fetchActiveTeamMatch).toHaveBeenLastCalledWith('B');

        a.resolve(matched(1, 2));
        await settle();
        refreshTeamMatch('B');
        expect(await cached('B')).toBeUndefined();
        // A settling neither cleared B's in-flight refresh nor started another.
        expect(fetchActiveTeamMatch).toHaveBeenCalledTimes(2);

        b.resolve(matched(3, 4));
        await settle();
        refreshTeamMatch('B');
        expect(await cached('B')).toEqual({ challengeId: '135938', teamMatch: teamMatch(3, 4) });
        expect(fetchActiveTeamMatch).toHaveBeenCalledTimes(2);
    });

    test('an empty token drops the slot and sends no request, however often it is asked', async () => {
        await refreshWith('tok', matched());

        refreshTeamMatch('');
        expect(await cached('')).toBeUndefined();
        nextMinute();
        refreshTeamMatch('');
        expect(await cached('')).toBeUndefined();
        refreshTeamMatch('');
        expect(await cached('')).toBeUndefined();
        expect(fetchActiveTeamMatch).toHaveBeenCalledTimes(1);

        // Signing back in starts from nothing.
        fetchActiveTeamMatch.mockResolvedValueOnce(none);
        refreshTeamMatch('tok');
        expect(await cached('tok')).toBeUndefined();
        expect(fetchActiveTeamMatch).toHaveBeenCalledTimes(2);
        await settle();
    });

    test('a rejecting fetch never rejects out and counts as a failed refresh', async () => {
        fetchActiveTeamMatch.mockRejectedValueOnce(new Error('boom'));

        refreshTeamMatch('tok');
        expect(await cached('tok')).toBeUndefined();
        await settle();

        refreshTeamMatch('tok');
        expect(await cached('tok')).toBeUndefined();
        expect(fetchActiveTeamMatch).toHaveBeenCalledTimes(1);
    });

    test('a team read that never settles does not hold the caller: the answer is synchronous', async () => {
        fetchActiveTeamMatch.mockReturnValueOnce(new Promise<Read>(() => {}));

        refreshTeamMatch('tok');
        expect(await cached('tok')).toBeUndefined();
        refreshTeamMatch('tok');
        expect(await cached('tok')).toBeUndefined();
    });

    test('a stuck refresh blocks new ones only until it settles', async () => {
        const stuck = deferred();
        fetchActiveTeamMatch.mockReturnValueOnce(stuck.promise);
        refreshTeamMatch('tok');

        jest.advanceTimersByTime(10 * MINUTE);
        refreshTeamMatch('tok');
        expect(fetchActiveTeamMatch).toHaveBeenCalledTimes(1);

        stuck.resolve(none);
        await settle();
        nextMinute();
        fetchActiveTeamMatch.mockResolvedValueOnce(none);
        refreshTeamMatch('tok');
        expect(fetchActiveTeamMatch).toHaveBeenCalledTimes(2);
        await settle();
    });
});

describe('settledTeamMatch', () => {
    const MAX_WAIT = 2000;
    const fresh = { challengeId: '135938', teamMatch: teamMatch(30, 40) };
    const previous = { challengeId: '135938', teamMatch: teamMatch(10, 20) };

    test('a refresh that settles inside the cap gives the fresh result, with no timer left behind', async () => {
        await refreshWith('tok', matched(10, 20));
        nextMinute();
        const refresh = deferred();
        fetchActiveTeamMatch.mockReturnValueOnce(refresh.promise);
        refreshTeamMatch('tok');

        const waiting = settledTeamMatch('tok', MAX_WAIT);
        jest.advanceTimersByTime(MAX_WAIT - 1);
        refresh.resolve(matched(30, 40));

        await expect(waiting).resolves.toEqual(fresh);
        expect(jest.getTimerCount()).toBe(0);
    });

    test('a refresh slower than the cap gives the previous slot at the cap; the late settle lands for the next call', async () => {
        await refreshWith('tok', matched(10, 20));
        nextMinute();
        const refresh = deferred();
        fetchActiveTeamMatch.mockReturnValueOnce(refresh.promise);
        refreshTeamMatch('tok');

        const waiting = settledTeamMatch('tok', MAX_WAIT);
        await jest.advanceTimersByTimeAsync(MAX_WAIT);
        await expect(waiting).resolves.toEqual(previous);

        refresh.resolve(matched(30, 40));
        await settle();
        refreshTeamMatch('tok');
        expect(await cached('tok')).toEqual(fresh);
        await expect(settledTeamMatch('tok', MAX_WAIT)).resolves.toEqual(fresh);
    });

    test('a zero wait takes the slot as it is while a refresh is in flight, with no timer', async () => {
        await refreshWith('tok', matched(10, 20));
        nextMinute();
        fetchActiveTeamMatch.mockReturnValueOnce(deferred().promise);
        refreshTeamMatch('tok');

        await expect(settledTeamMatch('tok', 0)).resolves.toEqual(previous);
        expect(jest.getTimerCount()).toBe(0);
    });

    test('nothing in flight resolves at once with the slot, and starts no refresh', async () => {
        await refreshWith('tok', matched(10, 20));

        await expect(settledTeamMatch('tok', MAX_WAIT)).resolves.toEqual(previous);
        expect(jest.getTimerCount()).toBe(0);
        nextMinute();
        await expect(settledTeamMatch('tok', MAX_WAIT)).resolves.toEqual(previous);
        expect(fetchActiveTeamMatch).toHaveBeenCalledTimes(1);
    });

    test('no slot and nothing in flight resolves undefined', async () => {
        await expect(settledTeamMatch('tok', MAX_WAIT)).resolves.toBeUndefined();
        expect(fetchActiveTeamMatch).not.toHaveBeenCalled();
    });

    test('a none result reads as undefined', async () => {
        fetchActiveTeamMatch.mockResolvedValueOnce(none);
        refreshTeamMatch('tok');

        await expect(settledTeamMatch('tok', MAX_WAIT)).resolves.toBeUndefined();
    });

    test('an empty token resolves undefined at once and sends no request', async () => {
        await expect(settledTeamMatch('', MAX_WAIT)).resolves.toBeUndefined();
        expect(fetchActiveTeamMatch).not.toHaveBeenCalled();
        expect(jest.getTimerCount()).toBe(0);
    });

    test('never rejects, even when the fetch does', async () => {
        fetchActiveTeamMatch.mockRejectedValueOnce(new Error('boom'));
        refreshTeamMatch('tok');

        await expect(settledTeamMatch('tok', MAX_WAIT)).resolves.toBeUndefined();
        expect(jest.getTimerCount()).toBe(0);
    });

    test("a token that changed during the wait does not see the other token's result", async () => {
        const refresh = deferred();
        fetchActiveTeamMatch.mockReturnValueOnce(refresh.promise);
        refreshTeamMatch('A');
        const waiting = settledTeamMatch('A', MAX_WAIT);

        fetchActiveTeamMatch.mockReturnValueOnce(new Promise<Read>(() => {}));
        refreshTeamMatch('B');
        refresh.resolve(matched());

        await expect(waiting).resolves.toBeUndefined();
    });
});
