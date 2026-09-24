/**
 * Tests for the compact ChallengeCard tile and its grid span.
 *
 * By default the compact tile only shows state (time, exposure, rank,
 * boost/turbo, entries, per-entry boost/turbo glyphs) and its only control is
 * the density toggle. With `compactActions` (the compactCardActions setting) it
 * adds a row of the challenge-level actions; per-entry actions stay in the
 * detailed card either way. A detailed card spans the full grid row; a compact
 * tile does not, so several share a row.
 *
 * Hooks are stubbed the same way as ChallengeCard.badges.test.jsx; the action
 * buttons are NOT mocked here, so their absence in compact mode is real.
 * `t(key)` returns the key (see tests/react setup).
 */

import { render, screen, fireEvent } from './helpers/test-utils';
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
const mockTurbo = { playAutoTurbo: jest.fn(), loading: false, error: null, clearError: jest.fn() };
const mockFill = { fillNow: jest.fn(), loading: false, error: null, clearError: jest.fn() };

jest.mock('@/api/useTurbo', () => ({
    useTurbo: () => mockTurbo,
}));
jest.mock('@/api/useFillChallenge', () => ({
    useFillChallenge: () => mockFill,
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

const renderCard = (challenge = makeChallenge(), timeRemaining = '2h 30m', props = {}) =>
    render(
        <ChallengeCard
            challenge={challenge}
            timeRemaining={timeRemaining}
            timezone="local"
            autovoteRunning={false}
            onVoteComplete={jest.fn()}
            onSettingsClick={jest.fn()}
            {...props}
        />,
    );

beforeEach(() => {
    Object.assign(mockChallengeSettings, { isCompact: true, hasCompactOverride: false, toggleCompact: jest.fn() });
    Object.assign(mockTurbo, { playAutoTurbo: jest.fn().mockResolvedValue(null), loading: false, error: null });
    Object.assign(mockFill, { fillNow: jest.fn().mockResolvedValue(null), loading: false, error: null });
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

describe('compact ChallengeCard tile with compactActions', () => {
    const renderWithActions = (challenge = makeChallenge(), props = {}) =>
        renderCard(challenge, '2h 30m', { compactActions: true, ...props });
    const buttonTexts = () => screen.getAllByRole('button').map((b) => b.textContent);

    test('offers the challenge-level actions, but no per-entry ones', () => {
        renderWithActions();
        const texts = buttonTexts();
        expect(texts).toEqual(
            expect.arrayContaining(['app.details', 'app.vote', 'app.run', '🎯 app.earnTurbo', '🖼 +1', 'app.settings']),
        );
        // One open slot → no "+N" button; no per-entry Boost / Turbo / swap.
        expect(texts).toHaveLength(6);
    });

    test('offers "+N" when several slots are open', () => {
        const challenge = makeChallenge();
        challenge.member.ranking.entries = challenge.member.ranking.entries.slice(0, 1);
        renderWithActions(challenge);
        expect(buttonTexts()).toEqual(expect.arrayContaining(['🖼 +1', '🖼 +3']));
    });

    test('hides Run, Earn turbo and "+1" / "+N" while autovote runs', () => {
        const challenge = makeChallenge();
        challenge.member.ranking.entries = challenge.member.ranking.entries.slice(0, 1);
        renderWithActions(challenge, { autovoteRunning: true });
        const texts = buttonTexts();
        expect(texts).not.toContain('app.run');
        expect(texts).not.toContain('🎯 app.earnTurbo');
        expect(texts.some((text) => text.startsWith('🖼'))).toBe(false);
        expect(texts).toContain('app.vote');
    });

    test('the actions fire the same handlers as in the detailed card', async () => {
        const onSettingsClick = jest.fn();
        const challenge = makeChallenge();
        challenge.member.ranking.entries = challenge.member.ranking.entries.slice(0, 1);
        renderWithActions(challenge, { onSettingsClick });

        fireEvent.click(screen.getByText('🎯 app.earnTurbo'));
        expect(mockTurbo.playAutoTurbo).toHaveBeenCalledWith(202, 'Harbour Lights');
        fireEvent.click(screen.getByText('🖼 +1'));
        expect(mockFill.fillNow).toHaveBeenCalledWith(202, 'one');
        fireEvent.click(screen.getByText('🖼 +3'));
        expect(mockFill.fillNow).toHaveBeenCalledWith(202, 'all');
        fireEvent.click(screen.getByText('app.settings'));
        expect(onSettingsClick).toHaveBeenCalledWith(202, 'Harbour Lights');
    });

    test('offers the currency spends the balance and challenge allow', () => {
        const challenge = {
            ...makeChallenge(),
            boost_enable: true,
            fill_enable: true,
            fill_locked: false,
        };
        challenge.member.boost = { state: 'LOCKED', timeout: null };
        renderWithActions(challenge, { bankroll: { keys: 3, swaps: 2, fills: 5, coins: 0 } });
        expect(screen.getByText(/app\.currencyKeyUnlock$/)).toBeTruthy();
        expect(screen.getByText(/app\.currencyFillExposure$/)).toBeTruthy();
    });

    test('shows turbo and submit errors under the row', () => {
        mockTurbo.error = 'turbo failed';
        mockFill.error = 'submit failed';
        renderWithActions();
        expect(screen.getByText('turbo failed')).toBeTruthy();
        expect(screen.getByText('submit failed')).toBeTruthy();
    });

    test('omits the row when no action is offered', () => {
        // Flash (no settings), ended (no turbo / submit), fully exposed and not
        // started (no vote / run), no bankroll (no currency spends).
        const challenge = {
            ...makeChallenge(),
            type: 'flash',
            start_time: nowSec() + 600,
            close_time: nowSec() - 60,
        };
        challenge.member.ranking.exposure.exposure_factor = 100;
        renderWithActions(challenge);
        expect(buttonTexts()).toEqual(['app.details']);
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
