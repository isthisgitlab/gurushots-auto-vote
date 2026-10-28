/**
 * mock/challenges.ts + mock/voting.ts + mock/endpoints/join.ts — strict-equal
 * guards over the generated mock payloads, with the clock and Math.random
 * pinned to a seeded sequence so every branch of the generators is exercised
 * and any change in the output values, or in the order of random calls, fails.
 *
 * Expected generator output lives in tests/mock/__data__/*.json; only the
 * upcoming join rows stay inline.
 */

import type * as challengesModule from '../../src/ts/mock/challenges';
import type * as votingModule from '../../src/ts/mock/voting';
import type * as joinModule from '../../src/ts/mock/endpoints/join';

import type { Challenge } from '../../src/ts/types/gurushots';
import { invalid } from '../helpers/invalid';

const { generateMockChallenges } = require('../../src/ts/mock/challenges') as typeof challengesModule;
const { generateMockVoteImages } = require('../../src/ts/mock/voting') as typeof votingModule;
const { getMemberChallenges } = require('../../src/ts/mock/endpoints/join') as typeof joinModule;

const PINNED_NOW_MS = Date.UTC(2026, 0, 15, 12, 0, 0);

/** mulberry32: a small seeded generator, so the random stream varies but is reproducible. */
const seededRandom = (seed: number): (() => number) => {
    let state = seed;
    return () => {
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
};

const pinClockAndRandom = (seed: number): void => {
    jest.useFakeTimers({ now: PINNED_NOW_MS });
    jest.spyOn(Math, 'random').mockImplementation(seededRandom(seed));
};

afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
});

describe('generated mock payload guards', () => {
    test('generateMockChallenges() output is unchanged', () => {
        pinClockAndRandom(20260115);
        const expected: unknown = require('./__data__/mockChallenges.json');
        expect(generateMockChallenges()).toStrictEqual(expected);
    });

    test('generateMockVoteImages(...) output is unchanged across every remaining branch', () => {
        pinClockAndRandom(1);
        const [first] = generateMockChallenges().challenges;
        const noExposure = invalid<Challenge>({ id: 9, title: 'No Exposure', url: 'no-exposure' });

        // Urls no longer branch (the per-url title tables are gone): one case
        // per remaining branch — no challenge, a real challenge with exposure,
        // and one without.
        const cases: { label: string; url: string; challenge: Challenge | null }[] = [
            { label: 'street, no challenge', url: 'mock-street', challenge: null },
            { label: 'real challenge with exposure', url: 'mock-exposure', challenge: first },
            { label: 'challenge without exposure', url: 'mock-no-exposure', challenge: noExposure },
        ];

        const actual = cases.map(({ label, url, challenge }, index) => {
            jest.spyOn(Math, 'random').mockImplementation(seededRandom(1000 + index));
            return { label, output: generateMockVoteImages(url, challenge) };
        });

        const expected: unknown = require('./__data__/mockVoteImages.json');
        expect(actual).toStrictEqual(expected);
    });

    test('getMemberChallenges() upcoming rows are pinned', async () => {
        jest.useFakeTimers({ now: PINNED_NOW_MS });
        const pending = getMemberChallenges('token', 'upcoming');
        await jest.advanceTimersByTimeAsync(400);
        const rows = (await pending) ?? [];
        expect(
            rows.map(({ id, status, join_coins, start_time, close_time }) => ({
                id,
                status,
                join_coins,
                start_time,
                close_time,
            })),
        ).toMatchInlineSnapshot(`
            [
              {
                "close_time": 1768737600,
                "id": 900101,
                "join_coins": 0,
                "start_time": 1768485600,
                "status": "upcoming",
              },
              {
                "close_time": 1768824000,
                "id": 900102,
                "join_coins": 150,
                "start_time": 1768550400,
                "status": "upcoming",
              },
              {
                "close_time": 1768910400,
                "id": 900103,
                "join_coins": 100,
                "start_time": 1768737600,
                "status": "upcoming",
              },
            ]
        `);
    });

    test('getMemberChallenges() upcoming rows carry the tags, badge and photo count a listing shows', async () => {
        jest.useFakeTimers({ now: PINNED_NOW_MS });
        const pending = getMemberChallenges('token', 'upcoming');
        await jest.advanceTimersByTimeAsync(400);
        const rows = (await pending) ?? [];
        expect(
            rows.map(({ id, type, badge, tags, max_photo_submits }) => ({ id, type, badge, tags, max_photo_submits })),
        ).toStrictEqual([
            { id: 900101, type: 'default', badge: undefined, tags: ['Exhibition', 'Default'], max_photo_submits: 2 },
            { id: 900102, type: '', badge: 'Team match', tags: ['Comm'], max_photo_submits: 4 },
            { id: 900103, type: 'flash', badge: undefined, tags: undefined, max_photo_submits: undefined },
        ]);
    });

    test('getMemberChallenges() open rows are pinned', async () => {
        jest.useFakeTimers({ now: PINNED_NOW_MS });
        const pending = getMemberChallenges('token', 'open');
        await jest.advanceTimersByTimeAsync(400);
        const rows = (await pending) ?? [];
        const expected: unknown = require('./__data__/mockOpenRows.json');
        expect(rows).toStrictEqual(expected);
    });
});
