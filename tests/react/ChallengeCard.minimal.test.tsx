/**
 * The minimal challenge card: what a marked challenge (the boundary's
 * `dataIssues`) or one whose member standing never arrived renders instead of
 * the full card — the title, the end time and countdown when the close time is
 * readable, a status notice with an icon, and the per-challenge settings button
 * alone — plus the hand-off when a card turns minimal while one of its modals
 * is open: the modal closes and focus returns to the card heading.
 * `t(key)` returns the key (see tests/react setup).
 */

import { render, screen, fireEvent, act } from './helpers/test-utils';
import { ChallengesProvider } from '@/contexts/ChallengesContext';
import { ChallengesSection } from '@/components/app/ChallengesSection';
import { ChallengeCard } from '@/components/app/ChallengeCard';
import { useActiveChallenges } from '@/api/useActiveChallenges';
import { buildChallenge } from '../helpers/challengeFixtures';
import { invalid } from '../helpers/invalid';
import type { Challenge } from '../../src/ts/types/gurushots';

jest.mock('@/api/useActiveChallenges', () => ({ useActiveChallenges: jest.fn() }));

const nowSec = () => Math.floor(Date.now() / 1000);

// A running, fully ranked challenge (the fixture default's member standing);
// each test names what it breaks. The merge keeps every key not named here.
const makeChallenge = (overrides = {}) =>
    buildChallenge({
        id: 301,
        title: 'Broken data',
        type: 'default',
        max_photo_submits: 3,
        start_time: nowSec() - 3600,
        close_time: nowSec() + 3600,
        entries: 1200,
        players: 50,
        votes: 2000,
        prizes_worth: '$100',
        tags: [],
        welcome_message: '',
        ...overrides,
    });

const renderCard = (challenge: Challenge, props: Partial<Parameters<typeof ChallengeCard>[0]> = {}) => {
    const handlers = { onVoteComplete: jest.fn(), onSettingsClick: jest.fn(), onCurrencySpent: jest.fn() };
    const utils = render(
        <ChallengeCard
            challenge={challenge}
            timeRemaining="2h"
            timezone="local"
            autovoteRunning={false}
            {...handlers}
            {...props}
        />,
    );
    return { ...utils, ...handlers };
};

describe('the minimal card for a marked challenge', () => {
    test('shows the title, the notice with icon and status role, and the settings button alone', () => {
        const { onSettingsClick } = renderCard(makeChallenge({ dataIssues: ['ranking.exposure.exposure_factor'] }));
        expect(screen.getByText('Broken data')).toBeTruthy();
        const note = screen.getByText('app.challengeDataUnreadable');
        expect(note.getAttribute('role')).toBe('status');
        expect(note.querySelector('svg')).not.toBeNull();
        fireEvent.click(screen.getByText('app.settings'));
        expect(onSettingsClick).toHaveBeenCalledWith(301, 'Broken data');
        for (const label of ['app.vote', 'app.run', '+1', 'app.fillPick', 'app.earnTurbo', 'app.compact']) {
            expect(screen.queryByText(label)).toBeNull();
        }
    });

    test('a flash challenge stays without the settings button', () => {
        renderCard(makeChallenge({ type: 'flash', dataIssues: ['member'] }));
        expect(screen.queryByText('app.settings')).toBeNull();
    });

    test('shows end time and countdown for a readable close time, neither for an unreadable one', () => {
        const { container, unmount } = renderCard(makeChallenge({ dataIssues: ['member'] }));
        expect(screen.getByText('2h')).toBeTruthy();
        expect(container.textContent).not.toContain('Invalid Date');
        unmount();
        const broken = makeChallenge({
            dataIssues: ['close_time'],
            close_time: invalid<Challenge['close_time']>(null),
        });
        const { container: brokenContainer } = renderCard(broken);
        expect(screen.queryByText('2h')).toBeNull();
        expect(brokenContainer.textContent).not.toContain('Invalid Date');
    });
});

describe('the minimal card for a challenge without ranking data', () => {
    test.each([
        ['without a member', { member: undefined }],
        ['without member.ranking', { member: { ranking: undefined } }],
        ['without ranking.exposure', { member: { ranking: { exposure: undefined } } }],
    ])('a challenge %s shows the pending notice, unmarked, with the settings button', (_name, overrides) => {
        const { onSettingsClick } = renderCard(makeChallenge(overrides));
        expect(screen.getByText('app.rankingDataPending')).toBeTruthy();
        expect(screen.queryByText('app.challengeDataUnreadable')).toBeNull();
        fireEvent.click(screen.getByText('app.settings'));
        expect(onSettingsClick).toHaveBeenCalledWith(301, 'Broken data');
    });
});

describe('the section around a minimal card', () => {
    const settle = () =>
        act(async () => {
            for (let i = 0; i < 10; i++) await Promise.resolve();
        });

    test('the list and the autovote controls still render around a minimal card', async () => {
        type HookState = ReturnType<typeof useActiveChallenges>;
        const refetch = jest.fn<ReturnType<HookState['refetch']>, Parameters<HookState['refetch']>>();
        jest.mocked(useActiveChallenges).mockImplementation(
            () =>
                ({
                    data: [makeChallenge({ dataIssues: ['member'] })],
                    loading: false,
                    error: null,
                    refetch,
                }) as HookState,
        );
        render(
            <ChallengesProvider autovoteRunning={false}>
                <ChallengesSection
                    isLoggedIn
                    timezone="local"
                    autovoteRunning={false}
                    onChallengeSettingsClick={jest.fn()}
                />
            </ChallengesProvider>,
        );
        await settle();
        expect(screen.getByText('app.voteAll')).toBeTruthy();
        expect(screen.getByText('app.run')).toBeTruthy();
        expect(screen.getByText('app.compact')).toBeTruthy();
        // The nav chip and the minimal card both carry the title.
        expect(screen.getAllByText('Broken data').length).toBe(2);
        expect(screen.getByText('app.challengeDataUnreadable')).toBeTruthy();
    });
});

describe('a card that turns minimal while its modal is open', () => {
    const cardProps = (challenge: Challenge) => ({
        challenge,
        timeRemaining: '2h',
        timezone: 'local',
        autovoteRunning: false,
        onVoteComplete: jest.fn(),
        onSettingsClick: jest.fn(),
        onCurrencySpent: jest.fn(),
    });
    const headingOf = (container: Element) => container.querySelector('#challenge-301 h3')!;
    const elsewhere = () => (
        <button type="button" data-testid="elsewhere">
            elsewhere
        </button>
    );

    test('the Pick modal closes and focus returns to the card heading', async () => {
        const { container, rerender } = render(
            <>
                <ChallengeCard {...cardProps(makeChallenge())} />
                {elsewhere()}
            </>,
        );
        fireEvent.click(screen.getByText('app.fillPick'));
        await screen.findByRole('dialog');
        rerender(
            <>
                <ChallengeCard {...cardProps(makeChallenge({ dataIssues: ['member'] }))} />
                {elsewhere()}
            </>,
        );
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(document.activeElement).toBe(headingOf(container));
    });

    test('focus the user moved to a live element while the modal was open is not taken', async () => {
        const { container, rerender, getByTestId } = render(
            <>
                <ChallengeCard {...cardProps(makeChallenge())} />
                {elsewhere()}
            </>,
        );
        fireEvent.click(screen.getByText('app.fillPick'));
        await screen.findByRole('dialog');
        // happy-dom focuses detached nodes, so Modal's own focus return (the removed
        // trigger) would read as live focus; the spy says where focus really is —
        // the same way the useFocusRestore suite pins its edge cases down.
        const live = getByTestId('elsewhere');
        const active = jest.spyOn(document, 'activeElement', 'get').mockReturnValue(live);
        rerender(
            <>
                <ChallengeCard {...cardProps(makeChallenge({ dataIssues: ['member'] }))} />
                {elsewhere()}
            </>,
        );
        active.mockRestore();
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(document.activeElement === headingOf(container)).toBe(false);
    });

    test('a modal closed while focus sits on the page itself moves it to the heading', async () => {
        const { container, rerender } = render(<ChallengeCard {...cardProps(makeChallenge())} />);
        fireEvent.click(screen.getByText('app.fillPick'));
        await screen.findByRole('dialog');
        const active = jest.spyOn(document, 'activeElement', 'get').mockReturnValue(document.body);
        rerender(<ChallengeCard {...cardProps(makeChallenge({ dataIssues: ['member'] }))} />);
        active.mockRestore();
        expect(document.activeElement).toBe(headingOf(container));
    });

    test('a modal closed while nothing holds focus (null active element) still moves it to the heading', async () => {
        const { container, rerender } = render(<ChallengeCard {...cardProps(makeChallenge())} />);
        fireEvent.click(screen.getByText('app.fillPick'));
        await screen.findByRole('dialog');
        const active = jest.spyOn(document, 'activeElement', 'get').mockReturnValue(null);
        rerender(<ChallengeCard {...cardProps(makeChallenge({ dataIssues: ['member'] }))} />);
        active.mockRestore();
        expect(document.activeElement).toBe(headingOf(container));
    });

    test('a modal closed onto an element the page dropped moves focus to the heading too', async () => {
        const { container, rerender } = render(<ChallengeCard {...cardProps(makeChallenge())} />);
        fireEvent.click(screen.getByText('app.fillPick'));
        await screen.findByRole('dialog');
        const active = jest.spyOn(document, 'activeElement', 'get').mockReturnValue(document.createElement('div'));
        rerender(<ChallengeCard {...cardProps(makeChallenge({ dataIssues: ['member'] }))} />);
        active.mockRestore();
        expect(document.activeElement).toBe(headingOf(container));
    });

    test('focus on a control of the full card (no modal open) is not moved to the heading', () => {
        const full = makeChallenge();
        const { container, rerender } = render(<ChallengeCard {...cardProps(full)} />);
        // Record the focused control at a render, then take it away: the settings
        // button goes with a full card that turns minimal, but no dialog was open.
        screen.getByText('app.settings').focus();
        rerender(<ChallengeCard {...cardProps(full)} />);
        rerender(<ChallengeCard {...cardProps(makeChallenge({ dataIssues: ['member'] }))} />);
        expect(document.activeElement).not.toBe(headingOf(container));
    });

    test('focus on a control that survives the minimal turn stays there', () => {
        const minimal = makeChallenge({ dataIssues: ['member'] });
        const { rerender } = render(<ChallengeCard {...cardProps(minimal)} />);
        const settings = screen.getByText('app.settings');
        settings.focus();
        rerender(<ChallengeCard {...cardProps(minimal)} />);
        expect(document.activeElement).toBe(settings);
    });
});
