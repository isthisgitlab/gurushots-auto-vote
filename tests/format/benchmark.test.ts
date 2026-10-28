/**
 * format/benchmark: the ranking total's benchmark rows in the shape the server sends
 * (`benchmark: "1" | "10" | "100"`, `score` the vote count AT that rank, as text), and the gap
 * of votes still needed to PASS it.
 */

import { benchmarkGap, parseBenchmarkScores } from '../../src/ts/format/benchmark';
import { invalid } from '../helpers/invalid';

describe('parseBenchmarkScores', () => {
    test('parses the rows the live server sends: groups "1" / "10" / "100" with text scores', () => {
        expect(
            parseBenchmarkScores([
                { benchmark: '1', score: '1437' },
                { benchmark: '10', score: '1187' },
                { benchmark: '100', score: '782' },
            ]),
        ).toEqual({ 1: 1437, 10: 1187, 100: 782 });
    });

    test('a group or score the server left unreadable drops out, and whitespace is trimmed', () => {
        expect(
            parseBenchmarkScores(
                invalid<Parameters<typeof parseBenchmarkScores>[0]>([
                    { benchmark: ' 100 ', score: ' 782 ' },
                    { benchmark: '10', score: '' },
                    { benchmark: '1', score: 'garbage' },
                    { benchmark: '5', score: '9' },
                    { benchmark: 'Top 10', score: '9' },
                    {},
                    { score: '7' },
                    null,
                ]),
            ),
        ).toEqual({ 100: 782 });
    });

    test('a fractional score, and a block that is not a list, are no scores at all', () => {
        expect(parseBenchmarkScores([{ benchmark: '100', score: '782.5' }])).toEqual({});
        expect(parseBenchmarkScores(invalid(5))).toEqual({});
        expect(parseBenchmarkScores(undefined)).toEqual({});
    });
});

describe('benchmarkGap', () => {
    test.each([
        ['past the top 100 chases the 100 benchmark', 214, { 100: 312 }, { target: 100, n: 214 }],
        ['inside the top 100 chases the 10 benchmark', 45, { 10: 200 }, { target: 10, n: 102 }],
        ['inside the top 10 chases the 1 benchmark', 7, { 1: 300 }, { target: 1, n: 202 }],
    ])('%s', (_name, rank, scores, expected) => {
        expect(benchmarkGap(rank, 99, scores)).toEqual(expected);
    });

    test('votes equal to the score sit AT the rank: one more vote passes it', () => {
        expect(benchmarkGap(42, 120, { 10: 120 })).toEqual({ target: 10, n: 1 });
    });

    test.each([
        ['rank 1 has no group left to chase', 1, 50, { 1: 300 }],
        ['a benchmark already passed is no gap', 42, 200, { 10: 120 }],
        ['the benchmark row was unreadable', 42, 99, {}],
        ['the votes past the score', 214, 500, { 100: 312 }],
    ])('%s', (_name, rank, votes, scores) => {
        expect(benchmarkGap(rank, votes, scores)).toBeNull();
    });
});
