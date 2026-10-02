/**
 * Tests for the at-a-glance attention cues added for quick morning scanning:
 *   - utils/challengeAlerts: which running challenges count as low exposure or
 *     as a missed boost a key can recover
 *   - LowExposureBanner: lists them lowest-first, hides when none
 *   - ChallengeCard: open boost → blue ring + pulsing badge; low exposure →
 *     red border + badge
 *   - ChallengeNav: status dots for boost-open / low-exposure challenges
 * `t(key)` returns the key in the react test setup, so labels assert as 'app.*'.
 */

import { render, screen } from './helpers/test-utils';
import {
    isLowExposure,
    isMissedBoost,
    lowExposureChallenges,
    missedBoostChallenges,
    LOW_EXPOSURE_THRESHOLD,
} from '@/utils/challengeAlerts';
import { LowExposureBanner } from '@/components/app/LowExposureBanner';
import { ChallengeNav } from '@/components/app/ChallengeNav';
import { ChallengeCard } from '@/components/app/ChallengeCard';
import { buildChallenge } from '../helpers/challengeFixtures';
import { invalid } from '../helpers/invalid';
import type { Challenge } from '../../src/ts/types/gurushots';
import type { ComponentProps } from 'preact';

type BoostFixture = { state: string; timeout?: number | null };

jest.mock('@/hooks/useChallengeSettings', () => ({
    useChallengeSettings: () => ({
        hasCustomSettings: false,
        autoFillEnabled: false,
        isCompact: false,
        hasCompactOverride: false,
        toggleCompact: jest.fn(),
    }),
}));
jest.mock('@/api/useTurbo', () => ({
    useTurbo: () => ({ playAutoTurbo: jest.fn(), loading: false, error: null, clearError: jest.fn() }),
}));
jest.mock('@/api/useFillChallenge', () => ({
    useFillChallenge: () => ({ fillNow: jest.fn(), loading: false, error: null, clearError: jest.fn() }),
}));
jest.mock('@/components/app/VoteButton', () => ({ VoteButton: () => null }));
jest.mock('@/components/app/RunButton', () => ({ RunButton: () => null }));
jest.mock('@/components/app/EntryBadge', () => ({ EntryBadge: () => null }));

const nowSec = () => Math.floor(Date.now() / 1000);

// Minimal running challenge for the pure helpers / chip lists.
const running = (id: number, title: string, exposure: number, boost: BoostFixture = { state: 'UNAVAILABLE' }) =>
    invalid<Challenge>({
        id,
        title,
        start_time: nowSec() - 3600,
        close_time: nowSec() + 3600,
        member: { boost, ranking: { exposure: { exposure_factor: exposure } } },
    });

const fullChallenge = ({
    exposure = 50,
    boost = { state: 'UNAVAILABLE', timeout: null },
}: { exposure?: number; boost?: BoostFixture } = {}) =>
    buildChallenge({
        id: 7,
        title: 'Card',
        type: 'flash',
        max_photo_submits: 1,
        start_time: 0,
        close_time: nowSec() + 3600,
        entries: 1,
        players: 1,
        votes: 1,
        prizes_worth: '$1',
        tags: [],
        welcome_message: '',
        member: {
            boost,
            turbo: { state: 'UNAVAILABLE', time_to_open: null },
            ranking: {
                entries: [],
                exposure: { exposure_factor: exposure },
                total: { votes: 0, rank: 0, level: 0, percent: 0, next_message: '' },
            },
        },
    });

const renderCard = (challenge: Challenge) =>
    render(
        <ChallengeCard
            {...invalid<ComponentProps<typeof ChallengeCard>>({
                challenge,
                timeRemaining: '1h',
                timezone: 'local',
                autovoteRunning: false,
                onVoteComplete: jest.fn(),
                onSettingsClick: jest.fn(),
            })}
        />,
    );

describe('challengeAlerts helpers', () => {
    test('flags running challenges at or below the threshold only', () => {
        const now = nowSec();
        expect(isLowExposure(running(1, 'a', 0), now)).toBe(true);
        expect(isLowExposure(running(1, 'a', LOW_EXPOSURE_THRESHOLD), now)).toBe(true);
        expect(isLowExposure(running(1, 'a', LOW_EXPOSURE_THRESHOLD + 1), now)).toBe(false);
    });

    test('ignores not-started, closed and malformed challenges', () => {
        const now = nowSec();
        expect(isLowExposure({ ...running(1, 'a', 0), start_time: now + 60 }, now)).toBe(false);
        expect(isLowExposure({ ...running(1, 'a', 0), close_time: now - 60 }, now)).toBe(false);
        expect(isLowExposure(invalid({ id: 1, member: {} }), now)).toBe(false);
        expect(isLowExposure(invalid(null), now)).toBe(false);
    });

    test('lowExposureChallenges sorts lowest exposure first', () => {
        const list = lowExposureChallenges(
            [running(1, 'Five', 5), running(2, 'High', 80), running(3, 'Zero', 0)],
            nowSec(),
        );
        expect(list.map((c) => c.title)).toEqual(['Zero', 'Five']);
    });
});

// Running, boost-enabled challenge whose boost state is configurable.
const missed = (id: number, title: string, closeIn = 3600, state = 'MISSED') =>
    invalid<Challenge>({
        id,
        title,
        boost_enable: true,
        start_time: nowSec() - 3600,
        close_time: nowSec() + closeIn,
        member: { boost: { state } },
    });

describe('isMissedBoost', () => {
    test('is true for a running, boost-enabled challenge with a MISSED boost', () => {
        expect(isMissedBoost(missed(1, 'a'), nowSec())).toBe(true);
    });

    test('is false for any other boost state', () => {
        const now = nowSec();
        expect(isMissedBoost(missed(1, 'a', 3600, 'LOCKED'), now)).toBe(false);
        expect(isMissedBoost(missed(1, 'a', 3600, 'AVAILABLE'), now)).toBe(false);
    });

    test('is false when boost is not enabled for the challenge', () => {
        const now = nowSec();
        expect(isMissedBoost({ ...missed(1, 'a'), boost_enable: false }, now)).toBe(false);
        expect(isMissedBoost(invalid({ ...missed(1, 'a'), boost_enable: undefined }), now)).toBe(false);
    });

    test('is false before start, after close, and for unreadable times', () => {
        const now = nowSec();
        expect(isMissedBoost({ ...missed(1, 'a'), start_time: now + 60 }, now)).toBe(false);
        expect(isMissedBoost({ ...missed(1, 'a'), close_time: now - 60 }, now)).toBe(false);
        expect(isMissedBoost({ ...missed(1, 'a'), close_time: now }, now)).toBe(false);
        expect(isMissedBoost({ ...missed(1, 'a'), close_time: NaN }, now)).toBe(false);
        expect(isMissedBoost(invalid({ ...missed(1, 'a'), close_time: undefined }), now)).toBe(false);
    });

    test('a challenge starting exactly now counts as running', () => {
        const now = nowSec();
        expect(isMissedBoost({ ...missed(1, 'a'), start_time: now }, now)).toBe(true);
    });

    test('is false without a member or a challenge', () => {
        const now = nowSec();
        expect(isMissedBoost(invalid({ ...missed(1, 'a'), member: undefined }), now)).toBe(false);
        expect(isMissedBoost(invalid(null), now)).toBe(false);
    });
});

describe('missedBoostChallenges', () => {
    test('lists only missed boosts, soonest close first, ties kept in input order', () => {
        const list = missedBoostChallenges(
            [
                missed(1, 'Late', 7200),
                missed(2, 'Fine', 100, 'LOCKED'),
                missed(3, 'TieA', 600),
                missed(4, 'Soon', 60),
                missed(5, 'TieB', 600),
            ],
            nowSec(),
        );
        expect(list).toEqual([
            { id: 4, title: 'Soon' },
            { id: 3, title: 'TieA' },
            { id: 5, title: 'TieB' },
            { id: 1, title: 'Late' },
        ]);
    });

    test('null and undefined input give an empty list', () => {
        expect(missedBoostChallenges(null, nowSec())).toEqual([]);
        expect(missedBoostChallenges(undefined, nowSec())).toEqual([]);
    });
});

describe('LowExposureBanner', () => {
    test('renders nothing when no challenge is low', () => {
        render(<LowExposureBanner challenges={[running(1, 'Fine', 60)]} />);
        expect(screen.queryByRole('button')).toBeNull();
    });

    test('lists low-exposure challenges with their percentage', () => {
        render(<LowExposureBanner challenges={[running(1, 'Five', 5), running(2, 'Zero', 0)]} />);
        const buttons = screen.getAllByRole('button');
        expect(buttons).toHaveLength(2);
        expect(buttons[0].textContent).toMatch(/Zero.*0%/);
        expect(buttons[1].textContent).toMatch(/Five.*5%/);
        expect(screen.getByText(/app\.lowExposure/)).toBeTruthy();
    });
});

describe('ChallengeCard attention cues', () => {
    test('open boost window rings the card and shows the boost badge', () => {
        const { container } = renderCard(fullChallenge({ boost: { state: 'AVAILABLE_KEY' } }));
        expect(container.querySelector('#challenge-7')!.className).toMatch(/ring-info/);
        expect(screen.getByText(/app\.boostOpenBadge/)).toBeTruthy();
    });

    test('timed boost badge shows how long the window stays open', () => {
        renderCard(fullChallenge({ boost: { state: 'AVAILABLE', timeout: nowSec() + 25 * 60 + 30 } }));
        expect(screen.getByText(/app\.boostOpenBadge/).textContent).toMatch(/⏳ 25m/);
    });

    test('key-unlocked boost badge shows no countdown', () => {
        renderCard(fullChallenge({ boost: { state: 'AVAILABLE_KEY' } }));
        expect(screen.getByText(/app\.boostOpenBadge/).textContent).not.toMatch(/⏳/);
    });

    test('low exposure gives a red border and an exposure badge', () => {
        const { container } = renderCard(fullChallenge({ exposure: 0 }));
        const card = container.querySelector('#challenge-7')!;
        expect(card.className).toMatch(/border-error/);
        expect(card.className).not.toMatch(/ring-info/);
        expect(container.querySelector('.badge-error')!.textContent).toMatch(/0%/);
    });

    test('a healthy card carries no attention cues', () => {
        const { container } = renderCard(fullChallenge());
        const card = container.querySelector('#challenge-7')!;
        expect(card.className).not.toMatch(/border-error|ring-info/);
        expect(screen.queryByText(/app\.boostOpenBadge/)).toBeNull();
    });
});

describe('ChallengeNav status dots', () => {
    beforeEach(() => {
        jest.mocked(window.api.getChallengeOverrides).mockReset();
        jest.mocked(window.api.getChallengeOverrides).mockResolvedValue({});
        jest.mocked(window.api.onSettingsChanged).mockReset();
        jest.mocked(window.api.onSettingsChanged).mockReturnValue(invalid(undefined));
    });

    test('marks boost-open and low-exposure chips, leaves others plain', () => {
        render(
            <ChallengeNav
                challenges={[
                    running(1, 'Boosty', 50, { state: 'AVAILABLE_KEY' }),
                    running(2, 'Starved', 3),
                    running(3, 'Plain', 70),
                ]}
            />,
        );
        const [boosty, starved, plain] = screen.getAllByRole('button');
        expect(boosty.querySelector('[data-testid="pulse-dot-info"]')).not.toBeNull();
        expect(boosty.textContent).toMatch(/app\.boostOpenBadge/);
        expect(starved.querySelector('[data-testid="pulse-dot-error"]')).not.toBeNull();
        expect(starved.textContent).toMatch(/app\.lowExposure/);
        expect(plain.querySelector('[data-testid^="pulse-dot"]')).toBeNull();
    });
});
