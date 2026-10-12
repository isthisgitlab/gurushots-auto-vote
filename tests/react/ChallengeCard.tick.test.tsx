/**
 * A challenge card re-renders once a second only while something on it counts down (a turbo cooldown, a timed boost
 * window). Every other card stays still: its countdown text is the Countdown leaf's own signal binding.
 */

import { signal } from '@preact/signals';
import { act, render, screen } from './helpers/test-utils';
import { ChallengeCard } from '@/components/app/ChallengeCard';
import { Countdown } from '@/components/app/Countdown';
import { needsSecondTick } from '@/utils/challengeCardView';
import { buildChallenge } from '../helpers/challengeFixtures';
import { invalid } from '../helpers/invalid';
import type { Challenge } from '../../src/ts/types/gurushots';

const mockRenders = { count: 0 };

jest.mock('@/hooks/useChallengeSettings', () => ({
    useChallengeSettings: () => ({
        hasCustomSettings: false,
        autoFillEnabled: false,
        isCompact: false,
        hasCompactOverride: false,
        toggleCompact: jest.fn(),
    }),
}));
jest.mock('@/api/useDeadlineActions', () => ({
    // Called once per card render: the count is how often the card renders.
    useDeadlineActions: () => {
        mockRenders.count += 1;
        return { actions: [], boostBlocked: false, loading: false, error: false };
    },
}));
jest.mock('@/api/useTurbo', () => ({
    useTurbo: () => ({ playAutoTurbo: jest.fn(), loading: false, error: null, clearError: jest.fn() }),
}));
jest.mock('@/api/useFillChallenge', () => ({
    useFillChallenge: () => ({ fillNow: jest.fn(), loading: false, error: null, clearError: jest.fn() }),
}));
jest.mock('@/components/app/EntryBadge', () => ({ EntryBadge: () => null }));

const BASE_MS = 1_700_000_000_000;
const nowSec = () => Math.floor(Date.now() / 1000);

const challengeWith = (member: Record<string, unknown>): Challenge =>
    buildChallenge({
        id: 101,
        title: 'Sunset',
        url: 'sunset',
        type: 'speed',
        max_photo_submits: 4,
        start_time: 0,
        close_time: nowSec() + 100_000,
        entries: 100,
        players: 50,
        votes: 2000,
        prizes_worth: '$100',
        tags: [],
        welcome_message: '',
        member: {
            ranking: {
                entries: [],
                exposure: { exposure_factor: 50 },
                total: { votes: 0, rank: 0, level: 0, percent: 0, next_message: '' },
            },
            ...member,
        },
    });

const renderCard = (challenge: Challenge, timeRemaining: Parameters<typeof ChallengeCard>[0]['timeRemaining']) =>
    render(
        <ChallengeCard
            challenge={challenge}
            timeRemaining={timeRemaining}
            timezone="local"
            autovoteRunning={false}
            onVoteComplete={jest.fn()}
            onSettingsClick={jest.fn()}
            onCurrencySpent={jest.fn()}
        />,
    );

beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(BASE_MS);
    mockRenders.count = 0;
});
afterEach(() => jest.useRealTimers());

describe('needsSecondTick', () => {
    const now = nowSec();
    const tick = (member: Record<string, unknown> | undefined) =>
        needsSecondTick(invalid<Challenge>({ id: 1, member }), now);

    test('a turbo cooldown still running ticks; an elapsed or unnumbered one does not', () => {
        expect(tick({ turbo: { state: 'TIMER', time_to_open: now + 30 } })).toBe(true);
        expect(tick({ turbo: { state: 'TIMER', time_to_open: now } })).toBe(false);
        expect(tick({ turbo: { state: 'TIMER', time_to_open: now - 5 } })).toBe(false);
        expect(tick({ turbo: { state: 'TIMER', time_to_open: null } })).toBe(false);
        expect(tick({ turbo: { state: 'FREE', time_to_open: now + 30 } })).toBe(false);
    });

    test('a timed boost window with time left ticks; a key-unlocked or expired one does not', () => {
        expect(tick({ boost: { state: 'AVAILABLE', timeout: now + 60 } })).toBe(true);
        expect(tick({ boost: { state: 'AVAILABLE', timeout: now - 1 } })).toBe(false);
        expect(tick({ boost: { state: 'AVAILABLE', timeout: null } })).toBe(false);
        expect(tick({ boost: { state: 'AVAILABLE_KEY', timeout: now + 60 } })).toBe(false);
    });

    test('a card with neither (or no member data) does not', () => {
        expect(tick({})).toBe(false);
        expect(tick(undefined)).toBe(false);
    });
});

describe('ChallengeCard rendering', () => {
    test('a card with nothing counting down does not re-render as time passes', () => {
        renderCard(challengeWith({ turbo: { state: 'FREE' }, boost: { state: 'USED' } }), '2h 0m');
        const afterMount = mockRenders.count;
        act(() => {
            jest.advanceTimersByTime(10_000);
        });
        expect(mockRenders.count).toBe(afterMount);
    });

    test('a card in a turbo cooldown re-renders every second, so the Earn turbo button appears when it elapses', () => {
        renderCard(challengeWith({ turbo: { state: 'TIMER', time_to_open: nowSec() + 3 } }), '2h 0m');
        expect(screen.queryByText(/app\.earnTurbo/)).toBeNull();
        const afterMount = mockRenders.count;
        act(() => {
            jest.advanceTimersByTime(2000);
        });
        expect(mockRenders.count).toBeGreaterThan(afterMount);
        act(() => {
            jest.advanceTimersByTime(2000);
        });
        expect(screen.getByText(/app\.earnTurbo/)).toBeTruthy();

        // The cooldown is over: the card stops ticking.
        const afterElapsed = mockRenders.count;
        act(() => {
            jest.advanceTimersByTime(10_000);
        });
        expect(mockRenders.count).toBe(afterElapsed);
    });

    test('a timed boost window keeps its time left live, and the card stops ticking once it closes', () => {
        const challenge = challengeWith({ boost: { state: 'AVAILABLE', timeout: nowSec() + 125 } });
        const { container } = renderCard(challenge, '2h 0m');
        expect(container.textContent).toContain('⏳ 2m');
        act(() => {
            jest.advanceTimersByTime(65_000);
        });
        expect(container.textContent).toContain('⏳ 1m');
        act(() => {
            jest.advanceTimersByTime(65_000);
        });
        expect(screen.queryByText('app.boostOpenBadge')).toBeNull();
        const afterClosed = mockRenders.count;
        act(() => {
            jest.advanceTimersByTime(10_000);
        });
        expect(mockRenders.count).toBe(afterClosed);
    });

    test('the countdown text updates through its signal without re-rendering the card', () => {
        const time = signal<string | null>('5m 0s');
        renderCard(challengeWith({ turbo: { state: 'FREE' }, boost: { state: 'USED' } }), time);
        expect(screen.getByText('5m 0s').className).toBe('text-success');
        const afterMount = mockRenders.count;

        act(() => {
            time.value = '4m 59s';
        });
        expect(screen.getByText('4m 59s')).toBeTruthy();
        act(() => {
            time.value = null;
        });
        expect(screen.getByText('app.ended').className).toBe('text-error');
        expect(mockRenders.count).toBe(afterMount);
    });
});

describe('Countdown', () => {
    test.each([
        ['a plain value', '3h', 'text-success', '3h'],
        ['no value yet', undefined, 'text-success', 'common.loading'],
        ['an empty value', '', 'text-success', 'common.loading'],
        ['an ended challenge', null, 'text-error', 'app.ended'],
    ])('%s', (_name, source, className, text) => {
        render(<Countdown source={source} className="font-medium" />);
        const el = screen.getByText(text);
        expect(el.className).toBe(`${className} font-medium`);
    });

    test('without extra classes the span carries only its colour', () => {
        render(<Countdown source="1h" />);
        expect(screen.getByText('1h').className).toBe('text-success');
    });
});
