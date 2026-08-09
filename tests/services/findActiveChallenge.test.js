/**
 * Tests for the shared challenge-lookup helper. The API is not consistent
 * about the id type (number vs string), so the helper must match across
 * types via String comparison — the parseInt-based strict equality it
 * replaced silently missed string ids and accepted garbage suffixes.
 */

const { findActiveChallenge } = require('../../src/js/services/findActiveChallenge');

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
        // parseInt('111abc') === 111 — the old comparison accepted this.
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
        expect(findActiveChallenge({ challenges }, '111')).toBeNull();
    });
});
