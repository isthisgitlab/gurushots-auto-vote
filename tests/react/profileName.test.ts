/**
 * checkProfileName: the save path's check order (required → tooLong →
 * reserved → existing → limit → ok), the stored name and bound each object
 * result carries, and the cap semantics shared with the backend — at the cap
 * an existing name (any casing) still passes. profileNameCheckMessage turns
 * the error results into the translated message; CONFIRM_TIMEOUT_MS is the
 * shared armed-confirm lifetime.
 */

import {
    CONFIRM_TIMEOUT_MS,
    checkProfileName,
    normalizeProfileName,
    profileNameCheckMessage,
} from '@/utils/profileName';

const LIMITS = { maxChallengeProfiles: 3, maxProfileNameLength: 10 };

describe('normalizeProfileName', () => {
    test('trims and lowercases', () => {
        expect(normalizeProfileName('  Foo Bar  ')).toBe('foo bar');
    });
});

describe('profileNameCheckMessage', () => {
    const t = (key: string): string => key;

    test('an error result carries its translated message, the bounds filled in', () => {
        expect(profileNameCheckMessage('required', t)).toBe('app.profileNameRequired');
        expect(
            profileNameCheckMessage({ tooLong: 10 }, (key) =>
                key === 'app.profileNameTooLong' ? 'too long (max {0})' : key,
            ),
        ).toBe('too long (max 10)');
        expect(profileNameCheckMessage('reserved', t)).toBe('app.profileNameReserved');
        expect(
            profileNameCheckMessage({ limit: 3 }, (key) => (key === 'app.profileLimitReached' ? 'cap {0}' : key)),
        ).toBe('cap 3');
    });

    test('existing and ok are decisions the caller acts on, not messages', () => {
        expect(profileNameCheckMessage({ existing: 'a' }, t)).toBeNull();
        expect(profileNameCheckMessage('ok', t)).toBeNull();
    });
});

describe('CONFIRM_TIMEOUT_MS', () => {
    test('matches the challenge modal bar’s confirm lifetime', () => {
        expect(CONFIRM_TIMEOUT_MS).toBe(4000);
    });
});

describe('checkProfileName', () => {
    test('an empty name is required', () => {
        expect(checkProfileName('', ['a'], LIMITS)).toBe('required');
    });

    test('an over-long name carries the bound', () => {
        expect(checkProfileName('x'.repeat(11), [], LIMITS)).toEqual({ tooLong: 10 });
    });

    test('tooLong is checked before reserved', () => {
        expect(checkProfileName('__proto__', [], { maxProfileNameLength: 5 })).toEqual({ tooLong: 5 });
    });

    test('reserved names are refused in any casing', () => {
        expect(checkProfileName('__proto__', [], LIMITS)).toBe('reserved');
        expect(checkProfileName('Constructor', [], { maxChallengeProfiles: 3, maxProfileNameLength: 20 })).toBe(
            'reserved',
        );
        expect(checkProfileName('PROTOTYPE', [], LIMITS)).toBe('reserved');
    });

    test('an existing name comes back as stored, matched in any casing', () => {
        expect(checkProfileName('TACTIC', ['other', 'tactic'], LIMITS)).toEqual({ existing: 'tactic' });
    });

    test('at the cap an existing name (any casing) is existing, not limit', () => {
        expect(checkProfileName('A', ['a', 'b', 'c'], LIMITS)).toEqual({ existing: 'a' });
    });

    test('at the cap a new name carries the cap', () => {
        expect(checkProfileName('d', ['a', 'b', 'c'], LIMITS)).toEqual({ limit: 3 });
    });

    test('a new name under the cap is ok', () => {
        expect(checkProfileName('d', ['a', 'b'], LIMITS)).toBe('ok');
    });

    test('without limits the caps are skipped', () => {
        expect(checkProfileName('x'.repeat(200), ['a', 'b', 'c'])).toBe('ok');
        expect(checkProfileName('new', ['a', 'b', 'c'])).toBe('ok');
    });
});
