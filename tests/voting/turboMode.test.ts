/**
 * Unit tests for the shared turbo helpers (voting/turboMode.ts): the state →
 * status-code mapping the renderer words (getTurboStatus) and the CLI listing
 * prints, and the can-play predicate the card's play-turbo button and the
 * CLI's `challenges` turbo line share — playable states in both known modes,
 * and every way a turbo is not playable.
 */

import { buildChallenge } from '../helpers/challengeFixtures';
import { canPlayTurbo, isKnownTurboMode, turboStatusCode } from '../../src/ts/voting/turboMode';

const NOW = 500_000;
const canPlay = (turbo: Record<string, unknown>, closeTime = NOW + 3600) =>
    canPlayTurbo(buildChallenge({ close_time: closeTime, member: { turbo } }), NOW);

describe('turboStatusCode', () => {
    test.each([
        [undefined, 'unavailable'],
        [null, 'unavailable'],
        [{ state: '' }, 'unavailable'],
        [{ state: 'FREE' }, 'free'],
        [{ state: 'TIMER' }, 'timer'],
        [{ state: 'IN_PROGRESS' }, 'inProgress'],
        [{ state: 'WON' }, 'won'],
        [{ state: 'USED' }, 'used'],
        [{ state: 'UNAVAILABLE' }, 'unavailable'],
        [{ state: 'LOCKED' }, 'locked'],
        [{ state: 'NEW_STATE' }, 'other'],
    ])('%j → %s', (turbo, code) => {
        expect(turboStatusCode(turbo)).toBe(code);
    });
});

describe('canPlayTurbo', () => {
    test.each([
        ['FREE', {}],
        ['IN_PROGRESS', {}],
        ['TIMER', { time_to_open: NOW - 1 }],
    ])('a classic-mode %s turbo on an open challenge is playable', (state, extra) => {
        expect(canPlay({ state, mode: 'classic', ...extra })).toBe(true);
        expect(canPlay({ state, mode: 'snap', ...extra })).toBe(true);
    });

    test.each([
        ['FREE', {}],
        ['IN_PROGRESS', {}],
        ['TIMER', { time_to_open: NOW - 1 }],
        ['WON', {}],
    ])('a %s turbo with no known mode is not playable', (state, extra) => {
        expect(canPlay({ state, ...extra })).toBe(false);
    });

    test('a TIMER turbo is not playable before its cooldown elapses', () => {
        expect(canPlay({ state: 'TIMER', mode: 'classic', time_to_open: NOW + 60 })).toBe(false);
    });

    test('nothing is playable on a closed challenge', () => {
        expect(canPlay({ state: 'FREE', mode: 'classic' }, NOW)).toBe(false);
    });

    test('a challenge without a turbo (or unreadable) is not playable', () => {
        expect(canPlayTurbo(buildChallenge({ member: { turbo: null } }), NOW)).toBe(false);
        expect(canPlayTurbo(null, NOW)).toBe(false);
    });

    test('a WON turbo is not playable — it is applied to a photo, not played', () => {
        expect(canPlay({ state: 'WON', mode: 'classic' })).toBe(false);
    });

    test('isKnownTurboMode accepts only the two playable game modes', () => {
        expect(isKnownTurboMode({ mode: 'classic' })).toBe(true);
        expect(isKnownTurboMode({ mode: 'snap' })).toBe(true);
        expect(isKnownTurboMode({ mode: 'NEW_MODE' })).toBe(false);
        expect(isKnownTurboMode({})).toBe(false);
        expect(isKnownTurboMode(null)).toBe(false);
    });
});
