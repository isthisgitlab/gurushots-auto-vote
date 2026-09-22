/**
 * Tests for the at-a-glance attention cues added for quick morning scanning:
 *   - utils/challengeAlerts: which running challenges count as low exposure
 *   - LowExposureBanner: lists them lowest-first, hides when none
 *   - ChallengeCard: open boost → blue ring + pulsing badge; low exposure →
 *     red border + badge
 *   - ChallengeNav: status dots for boost-open / low-exposure challenges
 * `t(key)` returns the key in the react test setup, so labels assert as 'app.*'.
 */

import { render, screen } from './helpers/test-utils';
import { isLowExposure, lowExposureChallenges, LOW_EXPOSURE_THRESHOLD } from '@/utils/challengeAlerts';
import { LowExposureBanner } from '@/components/app/LowExposureBanner';
import { ChallengeNav } from '@/components/app/ChallengeNav';
import { ChallengeCard } from '@/components/app/ChallengeCard';
import { buildChallenge } from '../helpers/challengeFixtures';

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
const running = (id, title, exposure, boost = { state: 'UNAVAILABLE' }) => ({
    id,
    title,
    start_time: nowSec() - 3600,
    close_time: nowSec() + 3600,
    member: { boost, ranking: { exposure: { exposure_factor: exposure } } },
});

const fullChallenge = ({ exposure = 50, boost = { state: 'UNAVAILABLE', timeout: null } } = {}) =>
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

const renderCard = (challenge) =>
    render(
        <ChallengeCard
            challenge={challenge}
            timeRemaining="1h"
            timezone="local"
            autovoteRunning={false}
            onVoteComplete={jest.fn()}
            onSettingsClick={jest.fn()}
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
        expect(isLowExposure({ id: 1, member: {} }, now)).toBe(false);
        expect(isLowExposure(null, now)).toBe(false);
    });

    test('lowExposureChallenges sorts lowest exposure first', () => {
        const list = lowExposureChallenges(
            [running(1, 'Five', 5), running(2, 'High', 80), running(3, 'Zero', 0)],
            nowSec(),
        );
        expect(list.map((c) => c.title)).toEqual(['Zero', 'Five']);
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
        expect(container.querySelector('#challenge-7').className).toMatch(/ring-info/);
        expect(screen.getByText(/app\.boostOpenBadge/)).toBeTruthy();
    });

    test('low exposure gives a red border and an exposure badge', () => {
        const { container } = renderCard(fullChallenge({ exposure: 0 }));
        const card = container.querySelector('#challenge-7');
        expect(card.className).toMatch(/border-error/);
        expect(card.className).not.toMatch(/ring-info/);
        expect(container.querySelector('.badge-error').textContent).toMatch(/0%/);
    });

    test('a healthy card carries no attention cues', () => {
        const { container } = renderCard(fullChallenge());
        const card = container.querySelector('#challenge-7');
        expect(card.className).not.toMatch(/border-error|ring-info/);
        expect(screen.queryByText(/app\.boostOpenBadge/)).toBeNull();
    });
});

describe('ChallengeNav status dots', () => {
    beforeEach(() => {
        window.api.getChallengeOverrides.mockReset();
        window.api.getChallengeOverrides.mockResolvedValue({});
        window.api.onSettingsChanged.mockReset();
        window.api.onSettingsChanged.mockReturnValue(undefined);
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
