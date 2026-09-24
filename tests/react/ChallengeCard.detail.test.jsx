/**
 * Behaviour tests for the detailed ChallengeCard driven through the real hooks
 * (useChallengeSettings, useTurbo, useFillChallenge, useDeadlineActions,
 * useSwapBacks) and real Vote/Run buttons, all backed by window.api mocks.
 * EntryBadge is stubbed to expose the props the card hands it.
 * `t(key)` returns the key (see tests/react setup).
 */

import { signal } from '@preact/signals';
import { render, screen, fireEvent, waitFor, act } from './helpers/test-utils';
import { ChallengeCard } from '@/components/app/ChallengeCard';
import { buildChallenge } from '../helpers/challengeFixtures';

jest.mock('@/components/app/EntryBadge', () => ({
    EntryBadge: ({ entry, swapBack, swapAvailable, boostAvailable, turboAvailable }) => (
        <span data-testid={`entry-${entry.id}`}>
            {JSON.stringify({ swapBack, swapAvailable, boostAvailable, turboAvailable })}
        </span>
    ),
}));

const nowSec = () => Math.floor(Date.now() / 1000);

const makeChallenge = (overrides = {}) =>
    buildChallenge({
        id: 101,
        title: 'Sunset',
        url: 'sunset',
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
        member: {
            boost: { state: 'UNAVAILABLE', timeout: 0 },
            turbo: { state: 'UNAVAILABLE', time_to_open: null },
            ranking: {
                entries: [],
                exposure: { exposure_factor: 80 },
                total: { votes: 0, rank: 0, level: 0, percent: 0, next_message: '' },
            },
        },
        ...overrides,
    });

const renderCard = (challenge, props = {}) => {
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

const deferred = () => {
    let resolve;
    const promise = new Promise((r) => (resolve = r));
    return { promise, resolve };
};

beforeEach(() => {
    window.api.getSettingsSchema = jest.fn().mockResolvedValue({ schema: {}, defaults: {} });
    window.api.getEffectiveSetting = jest.fn().mockResolvedValue(null);
    window.api.getChallengeOverride = jest.fn().mockResolvedValue(null);
    window.api.getDeadlineActions = jest.fn().mockResolvedValue({ success: true, actions: [], boostBlocked: false });
    window.api.getSwapBacks = jest.fn().mockResolvedValue({ success: true, items: [] });
    window.api.playAutoTurbo = jest.fn().mockResolvedValue({ success: true });
    window.api.fillChallengeNow = jest.fn().mockResolvedValue({ success: true });
    window.api.voteOnChallengeManual = jest.fn().mockResolvedValue({ success: true });
    window.api.runVotingCycleForChallenge = jest.fn().mockResolvedValue({ success: true });
    window.api.openExternalUrl = jest.fn().mockResolvedValue(undefined);
});

describe('header', () => {
    test('opens the challenge URL and the settings modal', async () => {
        const { onSettingsClick } = renderCard(makeChallenge());
        fireEvent.click(screen.getByText('gurushots.com/challenge/sunset'));
        await waitFor(() =>
            expect(window.api.openExternalUrl).toHaveBeenCalledWith('https://gurushots.com/challenge/sunset'),
        );
        fireEvent.click(screen.getByText('app.settings'));
        expect(onSettingsClick).toHaveBeenCalledWith(101, 'Sunset');
    });

    test('flash challenges have no settings button, no URL row without a url', () => {
        renderCard(makeChallenge({ type: 'flash', url: '' }));
        expect(screen.queryByText('app.settings')).toBeNull();
        expect(screen.queryByText(/^gurushots\.com\/challenge\//)).toBeNull();
    });

    test('Vote and Run buttons invoke their IPC and report completion', async () => {
        const { onVoteComplete } = renderCard(makeChallenge());
        fireEvent.click(screen.getByText('app.vote'));
        await waitFor(() => expect(window.api.voteOnChallengeManual).toHaveBeenCalledWith(101, 'Sunset'));
        await waitFor(() => expect(onVoteComplete).toHaveBeenCalledTimes(1));
        fireEvent.click(screen.getByText('app.run'));
        await waitFor(() => expect(window.api.runVotingCycleForChallenge).toHaveBeenCalledWith(101));
        await waitFor(() => expect(onVoteComplete).toHaveBeenCalledTimes(2));
    });

    test('Run is hidden while autovote runs', () => {
        renderCard(makeChallenge(), { autovoteRunning: true });
        expect(screen.queryByText('app.run')).toBeNull();
        expect(screen.getByText('app.vote')).toBeTruthy();
    });

    test('density toggle writes a per-card override', async () => {
        window.api.setChallengeOverride = jest.fn().mockResolvedValue(true);
        const { container } = renderCard(makeChallenge());
        await waitFor(() => expect(window.api.getEffectiveSetting).toHaveBeenCalled());
        const toggle = screen.getByText('app.compact');
        expect(toggle.querySelector('svg').getAttribute('fill')).toBe('none');
        window.api.getChallengeOverride = jest.fn(async (key) => (key === 'compactCards' ? false : null));
        fireEvent.click(toggle);
        await waitFor(() => expect(window.api.setChallengeOverride).toHaveBeenCalledWith('compactCards', '101', true));
        // The reload now sees an override, so the icon fills in.
        await waitFor(() =>
            expect(container.querySelector('#challenge-101 button svg[fill="currentColor"]')).toBeTruthy(),
        );
    });

    test('renders the compact tile when the effective compactCards is on', async () => {
        window.api.getEffectiveSetting = jest.fn(async (key) => key === 'compactCards');
        const { container } = renderCard(makeChallenge());
        await waitFor(() => expect(screen.getByText('app.details')).toBeTruthy());
        expect(container.querySelector('#challenge-101').className).not.toContain('col-span-full');
    });
});

describe('time text', () => {
    test('reads a signal value', () => {
        renderCard(makeChallenge(), { timeRemaining: signal('5m') });
        expect(screen.getByText('5m').className).toBe('text-success');
    });

    test('marks Ended in red', () => {
        renderCard(makeChallenge(), { timeRemaining: 'Ended' });
        expect(screen.getByText('Ended').className).toBe('text-error');
    });

    test('falls back to the loading label', () => {
        renderCard(makeChallenge(), { timeRemaining: undefined });
        expect(screen.getByText('common.loading')).toBeTruthy();
    });
});

describe('progress', () => {
    const withTotal = (total, extra = {}) =>
        makeChallenge({
            ranking_levels: { level_2: 500, level_7: 9000 },
            ...extra,
            member: { ranking: { total } },
        });

    test('shows rank, next message and the next named level', () => {
        renderCard(
            withTotal({
                votes: 120,
                rank: 7,
                level: 1,
                level_name: 'POPULAR',
                percent: 40,
                next_message: 'Keep going',
            }),
        );
        expect(screen.getByText('Keep going')).toBeTruthy();
        expect(screen.getByText(/SKILLED \(380/)).toBeTruthy();
        expect(screen.getByText('POPULAR 1').className).toContain('badge-popular');
    });

    test('levels past the named table fall back to LEVEL n', () => {
        renderCard(withTotal({ votes: 5, rank: 1, level: 6, level_name: 'X', percent: 1, next_message: '' }));
        expect(screen.getByText(/LEVEL 7 \(8995/)).toBeTruthy();
    });

    test('no next-level line when the next level is unknown or undefined', () => {
        const { unmount } = renderCard(
            withTotal({ votes: 5, rank: 1, level: 4, level_name: 'ELITE', percent: 1, next_message: '' }),
        );
        expect(screen.queryByText(/app\.next/)).toBeNull();
        unmount();
        renderCard(withTotal({ votes: 5, rank: 1, level_name: 'ELITE', percent: 1, next_message: '' }));
        expect(screen.queryByText(/app\.next/)).toBeNull();
    });

    test('flash challenges hide the next message and next level', () => {
        renderCard(
            withTotal(
                { votes: 5, rank: 1, level: 1, level_name: 'POPULAR', percent: 1, next_message: 'flash-msg' },
                { type: 'flash' },
            ),
        );
        expect(screen.queryByText('flash-msg')).toBeNull();
        expect(screen.queryByText(/app\.next/)).toBeNull();
    });

    test('no progress block without a ranking total or ranking levels', () => {
        renderCard(makeChallenge({ member: { ranking: { total: undefined } } }));
        expect(screen.queryByText('app.yourProgress')).toBeNull();
    });

    test('progress without ranking_levels shows no next level', () => {
        renderCard(
            makeChallenge({
                member: { ranking: { total: { votes: 3, rank: 1, level: 1, level_name: 'POPULAR', percent: 1 } } },
            }),
        );
        expect(screen.getByText('app.yourProgress')).toBeTruthy();
        expect(screen.queryByText(/app\.next/)).toBeNull();
    });
});

describe('earn turbo', () => {
    const turboChallenge = (turbo, extra = {}) => makeChallenge({ member: { turbo }, ...extra });

    test('plays turbo and refreshes on success; spinner while in flight', async () => {
        const d = deferred();
        window.api.playAutoTurbo = jest.fn(() => d.promise);
        const { onVoteComplete } = renderCard(turboChallenge({ state: 'FREE' }));
        fireEvent.click(screen.getByText(/app\.earnTurbo/));
        await waitFor(() => expect(screen.queryByText(/app\.earnTurbo/)).toBeNull());
        expect(window.api.playAutoTurbo).toHaveBeenCalledWith(101, 'Sunset');
        await act(async () => d.resolve({ success: true }));
        await waitFor(() => expect(onVoteComplete).toHaveBeenCalled());
    });

    test('a failed play shows the error and does not refresh', async () => {
        window.api.playAutoTurbo = jest.fn().mockResolvedValue({ success: false, error: 'turbo broke' });
        const { onVoteComplete } = renderCard(turboChallenge({ state: 'IN_PROGRESS' }));
        fireEvent.click(screen.getByText(/app\.earnTurbo/));
        await waitFor(() => expect(screen.getByText('turbo broke')).toBeTruthy());
        expect(screen.getByText(/app\.earnTurbo/).closest('button').className).toContain('btn-error');
        expect(onVoteComplete).not.toHaveBeenCalled();
    });

    test('offered once a TIMER cooldown has elapsed, not before', () => {
        const { unmount } = renderCard(turboChallenge({ state: 'TIMER', time_to_open: nowSec() - 5 }));
        expect(screen.getByText(/app\.earnTurbo/)).toBeTruthy();
        unmount();
        renderCard(turboChallenge({ state: 'TIMER', time_to_open: nowSec() + 500 }));
        expect(screen.queryByText(/app\.earnTurbo/)).toBeNull();
    });

    test('TIMER without a numeric open time is not offered', () => {
        renderCard(turboChallenge({ state: 'TIMER', time_to_open: null }));
        expect(screen.queryByText(/app\.earnTurbo/)).toBeNull();
    });

    test('while autovote runs the button is disabled with a hint', () => {
        renderCard(turboChallenge({ state: 'FREE' }), { autovoteRunning: true });
        expect(screen.getByText(/app\.earnTurbo/).closest('button').disabled).toBe(true);
        expect(screen.getByText('app.autoTurboRunsWithAutovote')).toBeTruthy();
    });

    test('closed challenges and missing turbo data offer nothing', () => {
        const { unmount } = renderCard(turboChallenge({ state: 'FREE' }, { close_time: nowSec() - 10 }));
        expect(screen.queryByText(/app\.earnTurbo/)).toBeNull();
        unmount();
        renderCard(makeChallenge({ member: { turbo: undefined, boost: undefined } }));
        expect(screen.queryByText(/app\.earnTurbo/)).toBeNull();
    });
});

describe('fill', () => {
    test('+1 and +N fill the requested mode and refresh on success', async () => {
        const { onVoteComplete } = renderCard(makeChallenge());
        fireEvent.click(screen.getByText('+1'));
        await waitFor(() => expect(window.api.fillChallengeNow).toHaveBeenCalledWith(101, 'one'));
        await waitFor(() => expect(onVoteComplete).toHaveBeenCalledTimes(1));
        fireEvent.click(screen.getByText('+3'));
        await waitFor(() => expect(window.api.fillChallengeNow).toHaveBeenCalledWith(101, 'all'));
        await waitFor(() => expect(onVoteComplete).toHaveBeenCalledTimes(2));
    });

    test('both buttons spin while a fill is in flight', async () => {
        const d = deferred();
        window.api.fillChallengeNow = jest.fn(() => d.promise);
        const { container } = renderCard(makeChallenge());
        fireEvent.click(screen.getByText('+1'));
        await waitFor(() => expect(container.querySelectorAll('.loading-spinner')).toHaveLength(2));
        await act(async () => d.resolve({ success: true }));
    });

    test('a failed fill shows the error and does not refresh', async () => {
        window.api.fillChallengeNow = jest.fn().mockResolvedValue({ success: false, error: 'no photos' });
        const { onVoteComplete } = renderCard(makeChallenge());
        fireEvent.click(screen.getByText('+1'));
        await waitFor(() => expect(screen.getByText('no photos')).toBeTruthy());
        expect(screen.getByText('+1').className).toContain('btn-error');
        expect(onVoteComplete).not.toHaveBeenCalled();
    });

    test('+1 and +N are hidden while autovote runs', () => {
        renderCard(makeChallenge(), { autovoteRunning: true });
        expect(screen.queryByText('+1')).toBeNull();
        expect(screen.queryByText('+3')).toBeNull();
    });

    test('a single open slot offers only +1; no slots or unknown max offers none', () => {
        const oneSlot = makeChallenge({
            max_photo_submits: 2,
            member: { ranking: { entries: [{ id: 1 }] } },
        });
        const { unmount } = renderCard(oneSlot);
        expect(screen.getByText('+1')).toBeTruthy();
        expect(screen.queryByText(/^\+2$/)).toBeNull();
        unmount();
        renderCard(makeChallenge({ max_photo_submits: undefined, member: { ranking: { entries: undefined } } }));
        expect(screen.queryByText('+1')).toBeNull();
        expect(screen.getByText('0/')).toBeTruthy();
    });
});

describe('entries, tags and alerts', () => {
    test('hands each entry its swap-back offer and the availability flags', async () => {
        window.api.getSwapBacks = jest.fn().mockResolvedValue({
            success: true,
            items: [{ currentId: '2', previousId: '9', previousMemberId: 'm', kind: 'turbo' }],
        });
        renderCard(
            makeChallenge({
                tags: ['night', 'city'],
                member: {
                    boost: { state: 'AVAILABLE', timeout: nowSec() + 600 },
                    turbo: { state: 'WON' },
                    ranking: { entries: [{ id: 1 }, { id: 2 }] },
                },
            }),
        );
        expect(screen.getByText('night')).toBeTruthy();
        expect(screen.getByText('city')).toBeTruthy();
        await waitFor(() => expect(JSON.parse(screen.getByTestId('entry-2').textContent).swapBack).not.toBeNull());
        expect(JSON.parse(screen.getByTestId('entry-2').textContent)).toEqual({
            swapBack: { currentId: '2', previousId: '9', previousMemberId: 'm', kind: 'turbo' },
            swapAvailable: false,
            boostAvailable: true,
            turboAvailable: true,
        });
        expect(JSON.parse(screen.getByTestId('entry-1').textContent).swapBack).toBeNull();
    });

    test('a settings change refreshes the deadline preview in place, without remounting the card', async () => {
        const challenge = makeChallenge();
        const { container, rerender } = renderCard(challenge, { settingsVersion: 0 });
        await waitFor(() => expect(window.api.getDeadlineActions).toHaveBeenCalledTimes(1));
        expect(screen.queryByRole('alert')).toBeNull();
        const root = container.firstChild;

        window.api.getDeadlineActions.mockResolvedValue({ success: true, actions: [], boostBlocked: true });
        rerender(
            <ChallengeCard
                challenge={challenge}
                settingsVersion={1}
                timeRemaining="2h"
                timezone="local"
                autovoteRunning={false}
                onVoteComplete={jest.fn()}
                onSettingsClick={jest.fn()}
                onCurrencySpent={jest.fn()}
            />,
        );

        await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('app.boostConflictWarning'));
        expect(window.api.getDeadlineActions).toHaveBeenCalledTimes(2);
        expect(container.firstChild).toBe(root);
    });

    test('shows the boost/turbo conflict warning from the deadline preview', async () => {
        window.api.getDeadlineActions = jest.fn().mockResolvedValue({ success: true, actions: [], boostBlocked: true });
        renderCard(makeChallenge());
        await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('app.boostConflictWarning'));
    });

    test('low exposure turns the border and exposure figure red; an open boost adds a ring', () => {
        const { container } = renderCard(
            makeChallenge({
                member: {
                    boost: { state: 'AVAILABLE_KEY', timeout: 0 },
                    ranking: { exposure: { exposure_factor: 5 } },
                },
            }),
        );
        const card = container.querySelector('#challenge-101');
        expect(card.className).toContain('border-2 border-error');
        expect(card.className).toContain('ring-2 ring-info');
        expect(screen.getByText('5%').className).toBe('text-error font-bold');
    });

    test('a healthy card has a plain border and no ring', () => {
        const { container } = renderCard(makeChallenge());
        const card = container.querySelector('#challenge-101');
        expect(card.className).toMatch(/^border rounded-lg/);
        expect(card.className).not.toContain('ring-2');
        expect(screen.getByText('80%').className).toBe('');
    });

    test('renders the sanitized welcome message', () => {
        renderCard(makeChallenge({ welcome_message: 'Hello <b>world</b>' }));
        expect(screen.getByText('world').tagName).toBe('B');
    });
});
