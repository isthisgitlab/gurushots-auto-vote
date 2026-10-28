/**
 * The shared boundary-mark predicate (src/ts/challengeMarks.ts): one
 * null-safe, structural check used by every refusal, filter and skip.
 */

import type * as challengeMarksModule from '../src/ts/challengeMarks';
import { invalid } from './helpers/invalid';

const { isMarkedChallenge } = require('../src/ts/challengeMarks') as typeof challengeMarksModule;

describe('isMarkedChallenge', () => {
    test('a non-empty dataIssues array marks', () => {
        expect(isMarkedChallenge(invalid({ id: 1, dataIssues: ['start_time'] }))).toBe(true);
        expect(isMarkedChallenge(invalid({ id: 1, title: 'x', dataIssues: ['close_time'] }))).toBe(true);
    });

    test('a missing or empty dataIssues array does not mark', () => {
        expect(isMarkedChallenge({})).toBe(false);
        expect(isMarkedChallenge({ dataIssues: [] })).toBe(false);
    });

    test('the null-safe signature answers both directions', () => {
        expect(isMarkedChallenge(null)).toBe(false);
        expect(isMarkedChallenge(undefined)).toBe(false);
    });
});
