/**
 * The card offers the play-turbo button (canPlayAutoTurbo) for an open challenge whose turbo can be earned now — and
 * only when its mode is known (classic or Snap): one with no mode (GuruShots web data unavailable) is never offered.
 */

import { deriveChallengeCardView } from '@/utils/challengeCardView';
import { buildChallenge } from '../helpers/challengeFixtures';

const NOW = 500_000;

const canPlay = (turbo: Record<string, unknown>, closeTime = NOW + 3600) =>
    deriveChallengeCardView(buildChallenge({ close_time: closeTime, member: { turbo } }), {
        now: NOW,
        bankroll: null,
        autovoteRunning: false,
        autoSubmitEnabled: false,
        manualPhotosOnly: false,
    }).canPlayAutoTurbo;

describe('canPlayAutoTurbo', () => {
    test.each([
        ['FREE', {}],
        ['IN_PROGRESS', {}],
        ['TIMER', { time_to_open: NOW - 1 }],
    ])('a classic-mode %s turbo is playable', (state, extra) => {
        expect(canPlay({ state, mode: 'classic', ...extra })).toBe(true);
    });

    test.each([
        ['FREE', {}],
        ['IN_PROGRESS', {}],
        ['TIMER', { time_to_open: NOW - 1 }],
    ])('a %s turbo with no mode is not playable', (state, extra) => {
        expect(canPlay({ state, ...extra })).toBe(false);
    });

    test.each([
        ['FREE', {}],
        ['IN_PROGRESS', {}],
        ['TIMER', { time_to_open: NOW - 1 }],
    ])('a Snap-mode %s turbo is playable', (state, extra) => {
        expect(canPlay({ state, mode: 'snap', ...extra })).toBe(true);
    });

    test('a TIMER turbo is not playable before its cooldown elapses, nor on a closed challenge', () => {
        expect(canPlay({ state: 'TIMER', mode: 'classic', time_to_open: NOW + 60 })).toBe(false);
        expect(canPlay({ state: 'FREE', mode: 'classic' }, NOW)).toBe(false);
    });
});
