/**
 * The tone helpers behind the coloured challenge stats, the live-window predicate they share with the low-exposure
 * flag, and the exposure tone the card view derives from them.
 */

import { exposureBand, timeLeftTone, toneBadgeClass } from '@/utils/statTone';
import { isChallengeLive } from '@/utils/challengeAlerts';
import { deriveChallengeCardView } from '@/utils/challengeCardView';
import { buildChallenge } from '../helpers/challengeFixtures';

const NOW = 500_000;

describe('timeLeftTone', () => {
    test.each([
        [-5, 'error'],
        [0, 'error'],
        [3599, 'error'],
        [3600, 'warning'],
        [21599, 'warning'],
        [21600, 'success'],
        [100_000, 'success'],
    ])('%s seconds left is %s', (remaining, tone) => {
        expect(timeLeftTone(NOW + remaining, NOW)).toBe(tone);
    });
});

describe('exposureBand', () => {
    test('is yellow under 50 and green from 50', () => {
        expect(exposureBand(49)).toBe('warning');
        expect(exposureBand(50)).toBe('success');
    });
});

describe('toneBadgeClass', () => {
    test.each([
        ['success', 'sm', 'badge badge-sm h-auto badge-success'],
        ['warning', 'sm', 'badge badge-sm h-auto badge-warning'],
        ['error', 'sm', 'badge badge-sm h-auto badge-error'],
        ['success', 'xs', 'badge badge-xs badge-success'],
        ['warning', 'xs', 'badge badge-xs badge-warning'],
        ['error', 'xs', 'badge badge-xs badge-error'],
    ] as const)('%s at %s', (tone, size, expected) => {
        expect(toneBadgeClass(tone, size)).toBe(expected);
    });

    test('no tone is no class', () => {
        expect(toneBadgeClass(null, 'sm')).toBe('');
        expect(toneBadgeClass(null, 'xs')).toBe('');
    });
});

describe('isChallengeLive', () => {
    const live = (start: number, close: number) =>
        isChallengeLive(buildChallenge({ start_time: start, close_time: close }), NOW);

    test('is false before the start and exactly at it, true while open, false exactly at the close', () => {
        expect(live(NOW + 1, NOW + 100)).toBe(false);
        expect(live(NOW, NOW + 100)).toBe(false);
        expect(live(NOW - 1, NOW + 100)).toBe(true);
        expect(live(NOW - 100, NOW)).toBe(false);
    });
});

describe('deriveChallengeCardView exposureTone', () => {
    const toneOf = (factor: number, times: { start_time?: number; close_time?: number } = {}) =>
        deriveChallengeCardView(
            buildChallenge({
                start_time: NOW - 100,
                close_time: NOW + 100,
                ...times,
                member: { ranking: { entries: [], exposure: { exposure_factor: factor } } },
            }),
            { now: NOW, bankroll: null, autovoteRunning: false, autoSubmitEnabled: false, manualPhotosOnly: false },
        ).exposureTone;

    test('a low figure is error, below 50 warning, from 50 success', () => {
        expect(toneOf(10)).toBe('error');
        expect(toneOf(10.5)).toBe('warning');
        expect(toneOf(50)).toBe('success');
    });

    test('has no tone before the start or after the close', () => {
        expect(toneOf(80, { start_time: NOW + 100 })).toBeNull();
        expect(toneOf(80, { close_time: NOW - 100 })).toBeNull();
    });
});
