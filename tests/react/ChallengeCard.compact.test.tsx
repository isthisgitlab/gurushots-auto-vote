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
 * Hooks are stubbed the same way as ChallengeCard.badges.test.tsx; the action
 * buttons are NOT mocked here, so their absence in compact mode is real.
 * `t(key)` returns the key (see tests/react setup).
 */

import { render, screen, fireEvent, waitFor } from './helpers/test-utils';
import { ChallengeCard } from '@/components/app/ChallengeCard';
import { getEntryStatus } from '@/utils/formatters';
import { buildChallenge } from '../helpers/challengeFixtures';
import type { useTurbo } from '@/api/useTurbo';
import type { useFillChallenge } from '@/api/useFillChallenge';
import { invalid } from '../helpers/invalid';

const mockChallengeSettings = {
    hasCustomSettings: false,
    autoSubmitEnabled: false,
    isCompact: true,
    hasCompactOverride: false,
    toggleCompact: jest.fn(),
};

jest.mock('@/hooks/useChallengeSettings', () => ({
    useChallengeSettings: () => mockChallengeSettings,
}));
const mockTurbo: Pick<ReturnType<typeof useTurbo>, 'playAutoTurbo' | 'loading' | 'error' | 'clearError'> = {
    playAutoTurbo: jest.fn(),
    loading: false,
    error: null,
    clearError: jest.fn(),
};
const mockFill: ReturnType<typeof useFillChallenge> = {
    fillNow: jest.fn(),
    loading: false,
    error: null,
    clearError: jest.fn(),
};

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
const makeChallenge = (overrides = {}) =>
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
            turbo: { state: 'FREE', mode: 'classic', time_to_open: null },
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
        ...overrides,
    });

const renderCard = (
    challenge = makeChallenge(),
    timeRemaining: Parameters<typeof ChallengeCard>[0]['timeRemaining'] = '2h 30m',
    props: Partial<Parameters<typeof ChallengeCard>[0]> = {},
) =>
    render(
        <ChallengeCard
            challenge={challenge}
            timeRemaining={timeRemaining}
            timezone="local"
            autovoteRunning={false}
            onVoteComplete={jest.fn()}
            onSettingsClick={jest.fn()}
            onCurrencySpent={() => {}}
            {...props}
        />,
    );

beforeEach(() => {
    Object.assign(mockChallengeSettings, { isCompact: true, hasCompactOverride: false, toggleCompact: jest.fn() });
    Object.assign(mockTurbo, { playAutoTurbo: jest.fn().mockResolvedValue(null), loading: false, error: null });
    Object.assign(mockFill, { fillNow: jest.fn().mockResolvedValue(null), loading: false, error: null });
});

describe('compact ChallengeCard tile', () => {
    test('the compact jump target accepts focus and shows a blue outline', () => {
        const { container } = renderCard(makeChallenge());
        const card = container.querySelector('#challenge-202')!;
        expect(card.getAttribute('tabindex')).toBe('-1');
        expect(card.className).toContain('focus:outline-base-content');
        expect(card.className).toContain('focus:outline-4');
        expect(card.className).toContain('focus:outline-offset-4');
    });

    test('offers no actions — the density toggle is the only button', () => {
        renderCard();
        const buttons = screen.getAllByRole('button');
        expect(buttons).toHaveLength(1);
        // Action label: a compact card offers to expand to details.
        expect(buttons[0].textContent).toContain('app.details');
    });

    test('an ended countdown is a red badge, a running one a green, yellow or red badge by time left', () => {
        // null is the countdown of a challenge that has ended; the card words it in the UI's language.
        const { unmount } = renderCard(makeChallenge(), null);
        expect(screen.getByText('app.ended').className).toBe('badge badge-sm badge-error font-medium');
        unmount();
        const cases: Array<[number, string]> = [
            [30_000, 'badge-success'],
            [7_200, 'badge-warning'],
            [600, 'badge-error'],
        ];
        for (const [secondsLeft, tone] of cases) {
            const view = renderCard(makeChallenge({ close_time: nowSec() + secondsLeft }));
            expect(screen.getByText('2h 30m').className).toBe(`badge badge-sm ${tone} font-medium`);
            view.unmount();
        }
    });

    test('boost and turbo statuses are badges in their tone, and a muted state stays plain text', () => {
        const states = (boost: string, turbo: string) => ({
            member: {
                boost: { state: boost, timeout: 0 },
                turbo: { state: turbo, mode: 'classic', time_to_open: null },
                ranking: {
                    entries: [],
                    exposure: { exposure_factor: 55 },
                    total: { votes: 0, rank: 0, level: 0, percent: 0, next_message: '' },
                },
            },
        });
        const cases: Array<[string, string, string, string, string, string]> = [
            [
                'AVAILABLE_KEY',
                'app.available',
                'IN_PROGRESS',
                'app.stateInProgress',
                'badge badge-sm badge-info',
                'badge badge-sm badge-warning',
            ],
            ['USED', 'app.used', 'FREE', 'app.stateFree', 'badge badge-sm badge-success', 'badge badge-sm badge-info'],
            [
                'LOCKED',
                'app.stateLocked',
                'UNAVAILABLE',
                'app.unavailable',
                'text-base-content/60',
                'text-base-content/60',
            ],
        ];
        for (const [boost, boostText, turbo, turboText, boostClass, turboClass] of cases) {
            const view = renderCard(makeChallenge(states(boost, turbo)));
            expect(screen.getByText(boostText).parentElement!.className).toBe(`${boostClass} max-w-full`);
            expect(screen.getByText(turboText).parentElement!.className).toBe(`${turboClass} max-w-full`);
            view.unmount();
        }
    });

    test('a long boost status shrinks inside its cell: the badge caps its width, the text truncates, the full text is the title', () => {
        renderCard(
            makeChallenge({
                member: {
                    boost: { state: 'AVAILABLE', timeout: nowSec() + 3_540 },
                    turbo: { state: 'WON', mode: 'classic', time_to_open: null },
                    ranking: {
                        entries: [],
                        exposure: { exposure_factor: 55 },
                        total: { votes: 0, rank: 0, level: 0, percent: 0, next_message: '' },
                    },
                },
            }),
        );
        const text = screen.getByText('app.stateAvailableMinutes');
        expect(text.className).toBe('truncate');
        expect(text.parentElement!.className).toBe('badge badge-sm badge-info max-w-full');
        expect(text.parentElement!.getAttribute('title')).toBe('app.stateAvailableMinutes');
        expect(screen.getByText('app.stateWon').parentElement!.className).toBe(
            'badge badge-sm badge-success max-w-full',
        );
    });

    test('the exposure figure is a badge by its band, and plain before the start or after the close', () => {
        const exposureOf = (factor: number) => ({
            member: { ranking: { entries: [], exposure: { exposure_factor: factor } } },
        });
        const cases: Array<[number, string]> = [
            [5, 'badge badge-sm badge-error'],
            [30, 'badge badge-sm badge-warning'],
            [55, 'badge badge-sm badge-success'],
        ];
        for (const [factor, className] of cases) {
            const view = renderCard(makeChallenge(exposureOf(factor)));
            expect(screen.getByText(`${factor}%`).className).toBe(className);
            view.unmount();
        }
        const notStarted = renderCard(makeChallenge({ ...exposureOf(55), start_time: nowSec() + 600 }));
        expect(screen.getByText('55%').className).toBe('');
        notStarted.unmount();
        renderCard(makeChallenge({ ...exposureOf(55), close_time: nowSec() - 600 }));
        expect(screen.getByText('55%').className).toBe('');
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
        const card = container.querySelector('#challenge-202')!;
        expect(card).not.toBeNull();
        expect(card.classList.contains('col-span-full')).toBe(false);
    });
});

describe('compact ChallengeCard tile with compactActions', () => {
    const renderWithActions = (challenge = makeChallenge(), props: Partial<Parameters<typeof ChallengeCard>[0]> = {}) =>
        renderCard(challenge, '2h 30m', { compactActions: true, ...props });
    const buttonTexts = () => screen.getAllByRole('button').map((b) => b.textContent);

    test('offers the challenge-level actions, but no per-entry ones', () => {
        renderWithActions();
        const texts = buttonTexts();
        expect(texts).toEqual(
            expect.arrayContaining([
                'app.details',
                'app.vote',
                'app.run',
                '🎯 app.earnTurbo',
                '🖼 +1',
                '🖼 app.fillPick',
                'app.settings',
            ]),
        );
        // One open slot → no "+N" button; no per-entry Boost / Turbo / swap.
        expect(texts).toHaveLength(7);
    });

    test('a failed Vote shows its translated error under the action row', async () => {
        window.api.voteOnChallengeManual = jest.fn().mockResolvedValue({ success: false, error: 'nope' });
        renderWithActions();
        fireEvent.click(screen.getByRole('button', { name: 'app.vote' }));
        const error = await screen.findByText('errors.actionFailed');
        expect(error.closest('[role="alert"]')).not.toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'errors.dismiss' }));
        expect(screen.queryByText('errors.actionFailed')).toBeNull();
    });

    test('"Pick…" carries the image prefix of +1 / +N, is described by what it does in text (not only a title), and opens the picker', async () => {
        const challenge = makeChallenge();
        challenge.member!.ranking!.entries = challenge.member!.ranking!.entries!.slice(0, 1);
        renderWithActions(challenge);
        const pick = screen.getByRole('button', { name: 'app.fillPick' });
        expect(pick.textContent).toBe('🖼 app.fillPick');
        expect(pick.querySelector('[aria-hidden="true"]')?.textContent).toBe('🖼 ');
        expect(pick.hasAttribute('aria-label')).toBe(false);
        expect(pick.getAttribute('title')).toBe('app.fillPickLabel');
        const description = document.getElementById(pick.getAttribute('aria-describedby') as string);
        expect(description?.textContent).toBe('app.fillPickLabel');
        fireEvent.click(pick);
        expect(await screen.findByText('app.pickTitle')).toBeTruthy();
        // Opening reads nothing; Load all does.
        expect(window.api.getLibraryPhotos).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'app.pickLoadAll' }));
        await waitFor(() => expect(window.api.getLibraryPhotos).toHaveBeenCalledWith(202, undefined, 'cached'));
    });

    test('the picker stays open, with its listing, when the card switches layout', async () => {
        const challenge = makeChallenge();
        challenge.member!.ranking!.entries = challenge.member!.ranking!.entries!.slice(0, 1);
        const props = {
            challenge,
            timeRemaining: '2h 30m',
            timezone: 'local',
            autovoteRunning: false,
            compactActions: true,
            onVoteComplete: jest.fn(),
            onSettingsClick: jest.fn(),
            onCurrencySpent: () => {},
        };
        jest.mocked(window.api.getLibraryPhotos).mockResolvedValue({
            success: true,
            photos: [{ id: 'a'.repeat(32), labels: ['harbour'], allowed: true, message: null, uploadDate: 1 }],
            memberId: 'm',
            truncated: false,
            wonIds: [],
            wonCount: 0,
            preview: false,
            readAtMs: 1_700_000_000_000,
            allowedKnown: true,
        });
        const { rerender } = render(<ChallengeCard {...props} />);
        fireEvent.click(screen.getByRole('button', { name: 'app.fillPick' }));
        await screen.findByText('app.pickTitle');
        fireEvent.click(screen.getByRole('button', { name: 'app.pickLoadAll' }));
        await waitFor(() => expect(window.api.getLibraryPhotos).toHaveBeenCalledTimes(2));
        const dialog = screen.getByRole('dialog');
        mockChallengeSettings.isCompact = false;
        rerender(<ChallengeCard {...props} />);
        expect(screen.getByRole('dialog')).toBe(dialog);
        // A remounted body would start idle and read nothing, so the count alone cannot show there was none.
        expect(window.api.getLibraryPhotos).toHaveBeenCalledTimes(2);
        expect(screen.queryByText('app.pickIdle')).toBeNull();
        expect(screen.getAllByRole('button', { name: /photoChooserTileLabel/ }).length).toBeGreaterThan(0);
    });

    test('a fill in flight disables Pick… along with +1 / +N', () => {
        Object.assign(mockFill, { loading: true });
        const challenge = makeChallenge();
        challenge.member!.ranking!.entries = challenge.member!.ranking!.entries!.slice(0, 1);
        renderWithActions(challenge);
        expect(screen.getByRole('button', { name: 'app.fillPick' }).hasAttribute('disabled')).toBe(true);
        expect(screen.getAllByRole('button', { name: /\+/ }).every((b) => b.hasAttribute('disabled'))).toBe(true);
    });

    test('offers "+N" when several slots are open', () => {
        const challenge = makeChallenge();
        challenge.member!.ranking!.entries = challenge.member!.ranking!.entries!.slice(0, 1);
        renderWithActions(challenge);
        expect(buttonTexts()).toEqual(expect.arrayContaining(['🖼 +1', '🖼 +3']));
    });

    test('keeps Earn turbo and "+1" / "+N" while hiding Run during autovote', () => {
        const challenge = makeChallenge();
        challenge.member!.ranking!.entries = challenge.member!.ranking!.entries!.slice(0, 1);
        renderWithActions(challenge, { autovoteRunning: true });
        const texts = buttonTexts();
        expect(texts).not.toContain('app.run');
        expect(texts).toContain('🎯 app.earnTurbo');
        expect(texts).toEqual(expect.arrayContaining(['🖼 +1', '🖼 +3']));
        expect(texts).toContain('app.vote');
    });

    test('the actions fire the same handlers as in the detailed card', async () => {
        const onSettingsClick = jest.fn();
        const challenge = makeChallenge();
        challenge.member!.ranking!.entries = challenge.member!.ranking!.entries!.slice(0, 1);
        renderWithActions(challenge, { onSettingsClick });

        fireEvent.click(screen.getByText('🎯 app.earnTurbo'));
        expect(mockTurbo.playAutoTurbo).toHaveBeenCalledWith(202, 'Harbour Lights');
        fireEvent.click(screen.getByRole('button', { name: '+1' }));
        expect(mockFill.fillNow).toHaveBeenCalledWith(202, 'one');
        fireEvent.click(screen.getByRole('button', { name: '+3' }));
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
        challenge.member!.boost = { state: 'LOCKED', timeout: null };
        renderWithActions(challenge, { bankroll: { keys: 3, swaps: 2, fills: 5, coins: 0 } });
        expect(screen.getByText(/app\.currencyKeyUnlock$/)).toBeTruthy();
        expect(screen.getByText(/app\.currencyFillExposure$/)).toBeTruthy();
    });

    test('shows turbo and submit errors under the row, announced, translated and dismissable', () => {
        mockTurbo.error = 'turbo failed';
        mockFill.error = 'submit failed';
        renderWithActions();
        // Neither raw text reaches the user: unlisted failures read as the generic translated one.
        expect(screen.queryByText('turbo failed')).toBeNull();
        expect(screen.queryByText('submit failed')).toBeNull();
        expect(screen.getAllByText('errors.actionFailed')).toHaveLength(2);
        expect(screen.getAllByRole('alert')).toHaveLength(2);

        const [dismissTurbo, dismissFill] = screen.getAllByRole('button', { name: 'errors.dismiss' });
        fireEvent.click(dismissTurbo);
        fireEvent.click(dismissFill);
        expect(mockTurbo.clearError).toHaveBeenCalledTimes(1);
        expect(mockFill.clearError).toHaveBeenCalledTimes(1);
    });

    test('shows the translated text for an invalid-args refusal, not the machine code', () => {
        mockTurbo.error = 'invalid-args';
        mockFill.error = 'invalid-args';
        renderWithActions();
        expect(screen.getAllByText('errors.actionInvalidArgs')).toHaveLength(2);
        expect(screen.queryByText('invalid-args')).toBeNull();
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
        challenge.member!.ranking!.exposure!.exposure_factor = 100;
        renderWithActions(challenge);
        expect(buttonTexts()).toEqual(['app.details']);
    });
});

describe('detailed ChallengeCard', () => {
    test('spans the full grid row and keeps its actions', () => {
        mockChallengeSettings.isCompact = false;
        const { container } = renderCard();
        expect(container.querySelector('#challenge-202')!.classList.contains('col-span-full')).toBe(true);
        // Toggle now offers the compact view; actions are back.
        expect(screen.getByRole('button', { name: /app\.compact/ })).toBeTruthy();
        expect(screen.getAllByRole('button').length).toBeGreaterThan(1);
    });
});

describe('getEntryStatus', () => {
    test('boost wins, then turbo, then guru pick, else plain', () => {
        expect(getEntryStatus(invalid({ boosted: true, turbo: true })).icon).toBe('🚀');
        expect(getEntryStatus(invalid({ turbo: true })).icon).toBe('⚡');
        expect(getEntryStatus(invalid({ guru_pick: true })).icon).toBe('⭐');
        expect(getEntryStatus(invalid({})).icon).toBe('📷');
    });

    test('entry.boost (eligibility) does not count as boosted', () => {
        const status = getEntryStatus(invalid({ boost: true }));
        expect(status.isBoosted).toBe(false);
        expect(status.icon).toBe('📷');
    });
});
