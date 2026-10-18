/**
 * The tone helpers behind the coloured challenge stats, the live-window predicate they share with the low-exposure
 * flag, and the exposure tone the card view derives from them.
 */

import { exposureBand, statusBadgeClass, timeLeftTone, toneBadgeClass } from '@/utils/statTone';
import { isChallengeLive } from '@/utils/challengeAlerts';
import { deriveChallengeCardView } from '@/utils/challengeCardView';
import { getBoostStatus, getTurboStatus } from '@/utils/formatters';
import { invalid } from '../helpers/invalid';
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
        ['success', 'md', 'badge h-auto badge-success'],
        ['warning', 'md', 'badge h-auto badge-warning'],
        ['error', 'md', 'badge h-auto badge-error'],
        ['success', 'sm', 'badge badge-sm badge-success'],
        ['warning', 'sm', 'badge badge-sm badge-warning'],
        ['error', 'sm', 'badge badge-sm badge-error'],
    ] as const)('%s at %s', (tone, size, expected) => {
        expect(toneBadgeClass(tone, size)).toBe(expected);
    });

    test('no tone is no class', () => {
        expect(toneBadgeClass(null, 'md')).toBe('');
        expect(toneBadgeClass(null, 'sm')).toBe('');
    });
});

describe('statusBadgeClass', () => {
    test.each([
        ['text-info', 'md', 'badge h-auto badge-info'],
        ['text-success', 'md', 'badge h-auto badge-success'],
        ['text-warning', 'md', 'badge h-auto badge-warning'],
        ['text-error', 'md', 'badge h-auto badge-error'],
        ['text-info', 'sm', 'badge badge-sm badge-info'],
        ['text-success', 'sm', 'badge badge-sm badge-success'],
        ['text-warning', 'sm', 'badge badge-sm badge-warning'],
        ['text-error', 'sm', 'badge badge-sm badge-error'],
    ] as const)('%s at %s is a badge', (colorClass, size, expected) => {
        expect(statusBadgeClass(colorClass, size)).toBe(expected);
    });

    test('a name from the object prototype stays as it is', () => {
        expect(statusBadgeClass('constructor', 'md')).toBe('constructor');
    });

    test('a muted colour stays as it is', () => {
        expect(statusBadgeClass('text-base-content/70', 'md')).toBe('text-base-content/70');
        expect(statusBadgeClass('text-base-content/70', 'sm')).toBe('text-base-content/70');
    });
});

describe('formatter colour classes', () => {
    const inFuture = Math.floor(Date.now() / 1000) + 600;
    const boosts = [
        null,
        { state: '' },
        { state: 'AVAILABLE', timeout: inFuture },
        { state: 'AVAILABLE', timeout: 0 },
        { state: 'AVAILABLE_KEY', timeout: 0 },
        { state: 'USED' },
        { state: 'UNAVAILABLE' },
        { state: 'LOCKED' },
        { state: 'SOMETHING_NEW' },
    ];
    const turbos = [
        null,
        ...['FREE', 'TIMER', 'IN_PROGRESS', 'WON', 'USED', 'UNAVAILABLE', 'LOCKED', 'SOMETHING_NEW'],
    ].map((state) => (state === null ? null : { state }));

    // A new colour class from the formatters must either become a badge in statusBadgeClass or be the muted one.
    test.each([
        ...boosts.map((boost) => [`boost ${JSON.stringify(boost)}`, getBoostStatus(invalid(boost)).colorClass]),
        ...turbos.map((turbo) => [`turbo ${JSON.stringify(turbo)}`, getTurboStatus(invalid(turbo)).colorClass]),
    ])('%s', (_name, colorClass) => {
        const rendered = statusBadgeClass(colorClass, 'md');
        expect(rendered.startsWith('badge ') || rendered === 'text-base-content/70').toBe(true);
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
    const toneOf = (factor: number | undefined, times: { start_time?: number; close_time?: number } = {}) =>
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

    test('has no tone when the exposure figure is missing', () => {
        expect(toneOf(undefined)).toBeNull();
    });

    test('has no tone before the start or after the close', () => {
        expect(toneOf(80, { start_time: NOW + 100 })).toBeNull();
        expect(toneOf(80, { close_time: NOW - 100 })).toBeNull();
    });
});
