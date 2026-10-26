/**
 * Tests for the shared challenge-lookup helper. The API is not consistent
 * about the id type (number vs string), so the helper must match across
 * types via String comparison — the parseInt-based strict equality it
 * replaced silently missed string ids and accepted garbage suffixes.
 */

import type * as findActiveChallengeModule from '../../src/ts/services/findActiveChallenge';
import type { ActiveChallengesResponse } from '../../src/ts/types/gurushots';

const { findActiveChallenge, findActionableChallenge } =
    require('../../src/ts/services/findActiveChallenge') as typeof findActiveChallengeModule;
import { invalid } from '../helpers/invalid';

describe('findActiveChallenge', () => {
    const challenges = [
        { id: 111, title: 'Numeric id' },
        { id: '222', title: 'String id' },
        { id: '333abc', title: 'Non-numeric id' },
    ];

    test('matches a numeric id with a string query', () => {
        expect(findActiveChallenge(challenges, '111')).toEqual({ id: 111, title: 'Numeric id' });
    });

    test('matches a string id with a numeric query', () => {
        expect(findActiveChallenge(challenges, 222)).toEqual({ id: '222', title: 'String id' });
    });

    test('matches same-type ids', () => {
        expect(findActiveChallenge(challenges, 111)).toEqual({ id: 111, title: 'Numeric id' });
        expect(findActiveChallenge(challenges, '222')).toEqual({ id: '222', title: 'String id' });
    });

    test('does NOT match a garbage-suffixed query against a numeric id (parseInt would have)', () => {
        // parseInt('111abc') === 111 — a parseInt comparison would accept this.
        expect(findActiveChallenge(challenges, '111abc')).toBeNull();
    });

    test('matches fully non-numeric ids exactly (parseInt would have produced NaN)', () => {
        expect(findActiveChallenge(challenges, '333abc')).toEqual({ id: '333abc', title: 'Non-numeric id' });
    });

    test('returns null when not found', () => {
        expect(findActiveChallenge(challenges, '999')).toBeNull();
    });

    test('treats non-array input as an empty list', () => {
        expect(findActiveChallenge(null, '111')).toBeNull();
        expect(findActiveChallenge(undefined, '111')).toBeNull();
        expect(findActiveChallenge(invalid<{ id?: unknown }[]>({ challenges }), '111')).toBeNull();
    });
});

describe('findActionableChallenge', () => {
    const clean = { id: 111, title: 'Clean' };
    const marked = { id: 222, title: 'Marked', dataIssues: ['close_time'] };
    const response = (challenges: object[], pruneUnsafe = false): ActiveChallengesResponse =>
        invalid<ActiveChallengesResponse>({ challenges, pruneUnsafe });

    test('a clean challenge resolves', () => {
        expect(findActionableChallenge(response([marked, clean]), '111')).toEqual({ challenge: clean });
    });

    test('a found-and-marked challenge is refused as data-incomplete', () => {
        expect(findActionableChallenge(response([marked]), 222)).toEqual({ refused: 'data-incomplete' });
    });

    test('a challenge missing from a safe read is not-found', () => {
        expect(findActionableChallenge(response([clean]), '999')).toEqual({ refused: 'not-found' });
    });

    test('a challenge missing from a prune-unsafe read is refused as data-incomplete (it may be the dropped one)', () => {
        expect(findActionableChallenge(response([clean], true), '999')).toEqual({ refused: 'data-incomplete' });
    });

    test('an empty dataIssues array does not refuse', () => {
        expect(findActionableChallenge(response([{ id: 1, dataIssues: [] }]), 1)).toEqual({
            challenge: { id: 1, dataIssues: [] },
        });
    });

    test('a null response answers not-found', () => {
        expect(findActionableChallenge(null, '111')).toEqual({ refused: 'not-found' });
        expect(findActionableChallenge(undefined, '111')).toEqual({ refused: 'not-found' });
    });
});
