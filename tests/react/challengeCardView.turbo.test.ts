/**
 * The card offers the play-turbo button (canPlayAutoTurbo) for an open challenge whose turbo can be earned now — and
 * never for a Snap-mode turbo, which the bot does not play.
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
    ])('a %s turbo is playable with no mode and in classic mode', (state, extra) => {
        expect(canPlay({ state, ...extra })).toBe(true);
        expect(canPlay({ state, mode: 'classic', ...extra })).toBe(true);
    });

    test.each([
        ['FREE', {}],
        ['IN_PROGRESS', {}],
        ['TIMER', { time_to_open: NOW - 1 }],
    ])('a Snap-mode %s turbo is not playable', (state, extra) => {
        expect(canPlay({ state, mode: 'snap', ...extra })).toBe(false);
    });

    test('a TIMER turbo is not playable before its cooldown elapses, nor on a closed challenge', () => {
        expect(canPlay({ state: 'TIMER', time_to_open: NOW + 60 })).toBe(false);
        expect(canPlay({ state: 'FREE' }, NOW)).toBe(false);
    });
});
