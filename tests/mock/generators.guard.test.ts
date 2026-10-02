/**
 * mock/challenges.ts + mock/voting.ts + mock/endpoints/join.ts — strict-equal
 * guards over the generated mock payloads and the open-join rows, with the clock and Math.random pinned to a seeded sequence so
 * every branch of the generators is exercised and any change in the output
 * values, or in the order of random calls, fails.
 *
 * Expected generator output lives in tests/mock/__data__/*.json; the join rows are inline.
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

    test('generateMockVoteImages(...) output is unchanged across every url and challenge branch', () => {
        pinClockAndRandom(1);
        const [first, second] = generateMockChallenges().challenges;
        const noExposure = invalid<Challenge>({ id: 9, title: 'No Exposure', url: 'no-exposure' });

        const cases: { label: string; url: string; challenge: Challenge | null }[] = [
            { label: 'street, no challenge', url: 'street-photography-2024', challenge: null },
            { label: 'portrait, no challenge', url: 'portrait-photography-2024', challenge: null },
            { label: 'landscape, no challenge', url: 'landscape-photography-2024', challenge: null },
            { label: 'macro, no challenge', url: 'macro-photography-2024', challenge: null },
            { label: 'wildlife, no challenge', url: 'wildlife-photography-2024', challenge: null },
            { label: 'architecture, no challenge', url: 'architecture-photography-2024', challenge: null },
            { label: 'unknown url, no challenge', url: 'no-such-challenge', challenge: null },
            { label: 'real challenge with exposure', url: 'street-photography-2024', challenge: first },
            { label: 'second real challenge', url: 'macro-photography-2024', challenge: second },
            { label: 'challenge without exposure', url: 'wildlife-photography-2024', challenge: noExposure },
        ];

        const actual = cases.map(({ label, url, challenge }, index) => {
            jest.spyOn(Math, 'random').mockImplementation(seededRandom(1000 + index));
            return { label, output: generateMockVoteImages(url, challenge) };
        });

        const expected: unknown = require('./__data__/mockVoteImages.json');
        expect(actual).toStrictEqual(expected);
    });

    test('getMemberChallenges() open rows are unchanged', async () => {
        jest.useFakeTimers({ now: PINNED_NOW_MS });
        const pending = getMemberChallenges('token', 'open');
        await jest.advanceTimersByTimeAsync(400);
        await expect(pending).resolves.toStrictEqual([
            {
                id: 900001,
                type: 'default',
                join_coins: 0,
                title: 'Mock Free Challenge',
                url: 'mock-free',
                start_time: 1768046400,
                close_time: 1768489200,
                entries: 40,
                players: 25,
            },
            {
                id: 900002,
                type: 'flash',
                join_coins: 100,
                title: 'Mock Flash Challenge',
                url: 'mock-flash',
                start_time: 1768392000,
                close_time: 1768651200,
                entries: 80,
                players: 50,
            },
            {
                id: 900003,
                type: 'default',
                join_coins: 250,
                title: 'Mock Paid Challenge',
                url: 'mock-paid',
                start_time: 1768305600,
                close_time: 1768910400,
                entries: 120,
                players: 75,
            },
            {
                id: 900004,
                type: 'flash',
                join_coins: 100,
                title: 'Mock Unlock-Fails Challenge',
                url: 'mock-fail',
                start_time: 1768219200,
                close_time: 1768737600,
                entries: 160,
                players: 100,
            },
            {
                id: 900005,
                type: 'flash',
                join_coins: 100,
                title: 'Mock Submit-Fails Challenge',
                url: 'mock-submitfail',
                start_time: 1768132800,
                close_time: 1768824000,
                entries: 200,
                players: 125,
            },
        ]);
    });
});
