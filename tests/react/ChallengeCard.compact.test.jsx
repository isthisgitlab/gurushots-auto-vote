/**
 * Tests for the compact ChallengeCard tile and its grid span.
 *
 * The compact tile is READ-ONLY: it shows state (time, exposure, rank,
 * boost/turbo, entries, per-entry boost/turbo glyphs) and its only control is
 * the density toggle — every action lives in the detailed card. A detailed card
 * spans the full grid row; a compact tile does not, so several share a row.
 *
 * Hooks are stubbed the same way as ChallengeCard.badges.test.jsx; the action
 * buttons are NOT mocked here, so their absence in compact mode is real.
 * `t(key)` returns the key (see tests/react setup).
 */

import { render, screen } from './helpers/test-utils';
import { ChallengeCard } from '@/components/app/ChallengeCard';
import { getEntryStatus } from '@/utils/formatters';
import { buildChallenge } from '../helpers/challengeFixtures';

const mockChallengeSettings = {
    hasCustomSettings: false,
    autoFillEnabled: false,
    isCompact: true,
    hasCompactOverride: false,
    toggleCompact: jest.fn(),
};

jest.mock('@/hooks/useChallengeSettings', () => ({
    useChallengeSettings: () => mockChallengeSettings,
}));
jest.mock('@/api/useTurbo', () => ({
    useTurbo: () => ({ playAutoTurbo: jest.fn(), loading: false, error: null, clearError: jest.fn() }),
}));
jest.mock('@/api/useFillChallenge', () => ({
    useFillChallenge: () => ({ fillNow: jest.fn(), loading: false, error: null, clearError: jest.fn() }),
}));

const nowSec = () => Math.floor(Date.now() / 1000);

// A running challenge where every action would be offered in detailed mode:
// started, exposure < 100 (Vote), free turbo (Earn turbo), open slots (+1),
// available boost + an un-actioned entry (per-entry Boost).
const makeChallenge = () =>
    buildChallenge({
        id: 202,
        title: 'Harbour Lights',
        url: 'harbour',
        type: 'speed',
        max_photo_submits: 4,
        start_time: 0,
        close_time: nowSec() + 3600,
        entries: 100,
        players: 1234,
        votes: 2000,
        prizes_worth: '$100',
        tags: ['night'],
        welcome_message: 'Show us the harbour at night',
        member: {
            boost: { state: 'AVAILABLE', timeout: nowSec() + 600 },
            turbo: { state: 'FREE', time_to_open: null },
            ranking: {
                entries: [
                    { id: 'e1', rank: 12, votes: 40, boosted: true },
                    { id: 'e2', rank: 88, votes: 5, turbo: true },
                    { id: 'e3', rank: 300, votes: 1 },
                ],
                exposure: { exposure_factor: 55 },
                total: { votes: 46, rank: 17, level: 1, level_name: 'POPULAR', percent: 30, next_message: '' },
            },
        },
    });

const renderCard = (challenge = makeChallenge(), timeRemaining = '2h 30m') =>
    render(
        <ChallengeCard
            challenge={challenge}
            timeRemaining={timeRemaining}
            timezone="local"
            autovoteRunning={false}
            onVoteComplete={jest.fn()}
            onSettingsClick={jest.fn()}
        />,
    );

beforeEach(() => {
    Object.assign(mockChallengeSettings, { isCompact: true, hasCompactOverride: false, toggleCompact: jest.fn() });
});

describe('compact ChallengeCard tile', () => {
    test('offers no actions — the density toggle is the only button', () => {
        renderCard();
        const buttons = screen.getAllByRole('button');
        expect(buttons).toHaveLength(1);
        // Action label: a compact card offers to expand to details.
        expect(buttons[0].textContent).toContain('app.details');
    });

    test('an ended countdown is shown in red, a running one in green', () => {
        const { unmount } = renderCard(makeChallenge(), 'Ended');
        expect(screen.getByText('Ended').className).toContain('text-error');
        unmount();
        renderCard();
        expect(screen.getByText('2h 30m').className).toContain('text-success');
    });

    test('toggle calls toggleCompact', () => {
        renderCard();
        screen.getByRole('button').click();
        expect(mockChallengeSettings.toggleCompact).toHaveBeenCalledTimes(1);
    });

    test('shows the state data', () => {
        const { container } = renderCard();
        const text = container.textContent;
        expect(text).toContain('Harbour Lights');
        expect(text).toContain('2h 30m');
        expect(text).toContain('55%');
        expect(text).toContain(`17 / ${(1234).toLocaleString()}`);
        expect(text).toContain('3/4');
        expect(text).toContain('SPEED');
    });

    test('drops description, url, tags and the photo-count badge', () => {
        const { container } = renderCard();
        const text = container.textContent;
        expect(text).not.toContain('Show us the harbour');
        expect(text).not.toContain('gurushots.com/challenge/harbour');
        expect(text).not.toContain('night');
        expect(text).not.toContain('app.photos');
    });

    test('marks each entry with its boost/turbo state glyph', () => {
        const { container } = renderCard();
        const text = container.textContent;
        expect(text).toContain('🚀 #12');
        expect(text).toContain('⚡ #88');
        expect(text).toContain('📷 #300');
    });

    test('is not full-width, so tiles share a grid row', () => {
        const { container } = renderCard();
        const card = container.querySelector('#challenge-202');
        expect(card).not.toBeNull();
        expect(card.classList.contains('col-span-full')).toBe(false);
    });
});

describe('detailed ChallengeCard', () => {
    test('spans the full grid row and keeps its actions', () => {
        mockChallengeSettings.isCompact = false;
        const { container } = renderCard();
        expect(container.querySelector('#challenge-202').classList.contains('col-span-full')).toBe(true);
        // Toggle now offers the compact view; actions are back.
        expect(screen.getByRole('button', { name: /app\.compact/ })).toBeTruthy();
        expect(screen.getAllByRole('button').length).toBeGreaterThan(1);
    });
});

describe('getEntryStatus', () => {
    test('boost wins, then turbo, then guru pick, else plain', () => {
        expect(getEntryStatus({ boosted: true, turbo: true }).icon).toBe('🚀');
        expect(getEntryStatus({ turbo: true }).icon).toBe('⚡');
        expect(getEntryStatus({ guru_pick: true }).icon).toBe('⭐');
        expect(getEntryStatus({}).icon).toBe('📷');
    });

    test('entry.boost (eligibility) does not count as boosted', () => {
        const status = getEntryStatus({ boost: true });
        expect(status.isBoosted).toBe(false);
        expect(status.icon).toBe('📷');
    });
});
