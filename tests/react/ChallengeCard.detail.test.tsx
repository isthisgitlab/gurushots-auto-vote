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
import { scrollToChallenge } from '@/utils/scrollToChallenge';
import { formatEndTime } from '@/utils/formatters';
import { LEVEL_BADGE_CLASS, LEVEL_PROGRESS_CLASS } from '@/utils/levelBadge';
import { buildChallenge } from '../helpers/challengeFixtures';
import type { EntryBadge as RealEntryBadge } from '@/components/app/EntryBadge';
import type { Challenge, MemberTurbo, RankingTotal } from '../../src/ts/types/gurushots';
import type { WindowApi } from '../../src/ts/types/ipc';
import { invalid } from '../helpers/invalid';
import { parseJson, parseJsonObject } from '../helpers/parseJson';
import { mockTranslator } from './helpers/setup';
import { app, errors } from '../../src/ts/translations/english';

jest.mock('@/components/app/EntryBadge', () => ({
    EntryBadge: ({
        entry,
        swapBack,
        swapAvailable,
        boostAvailable,
        turboAvailable,
        timezone,
    }: Parameters<typeof RealEntryBadge>[0]) => (
        <span data-testid={`entry-${entry.id}`} data-timezone={timezone}>
            {JSON.stringify({ swapBack, swapAvailable, boostAvailable, turboAvailable })}
        </span>
    ),
}));

const nowSec = () => Math.floor(Date.now() / 1000);

// A get-deadline-actions answer's block fields: each feature blocked by a flag or a pin (and when the pin gives way).
type Block = { by: 'flag' | 'pin'; releaseAt?: number };
const blocked = ({ boost, turbo }: { boost?: Block; turbo?: Block }) => ({
    boostBlocked: boost !== undefined,
    turboBlocked: turbo !== undefined,
    boostBlockedBy: boost?.by ?? null,
    turboBlockedBy: turbo?.by ?? null,
    boostReleaseAt: boost?.releaseAt ?? null,
    turboReleaseAt: turbo?.releaseAt ?? null,
});

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

const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
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

describe('a scenario whose progress can be reset from the card', () => {
    const scenario = { name: 'Plan', start: 'main', phases: { main: { rules: [{ id: 'r', if: [], do: [] }] } } };
    const statusOf = (state: object | null, corrupt: false | 'file' | 'record' = false) =>
        invalid({
            success: true,
            assigned: 'Plan',
            scenario,
            corrupt,
            timezone: 'UTC',
            state: corrupt
                ? null
                : {
                      phase: 'main',
                      phaseEnteredAt: nowSec(),
                      fired: {},
                      memory: {},
                      lastError: null,
                      inFlight: null,
                      ...state,
                  },
        });
    const stopped = () => ({ fired: { r: { at: nowSec(), phaseEnteredAt: nowSec(), unclearHalt: 'swap' } } });

    test('a stopped rule offers the reset: the dialog says what it costs, and confirming resets and reads the status again', async () => {
        window.api.getScenarioStatus = jest.fn().mockResolvedValue(statusOf(stopped()));
        window.api.resetScenarioState = jest.fn().mockResolvedValue({ success: true });
        renderCard(makeChallenge());
        fireEvent.click(await screen.findByText('app.scenarioReset'));
        expect(screen.getByText('app.scenarioResetBody')).toBeTruthy();
        fireEvent.click(screen.getByText('app.scenarioResetConfirm'));
        await waitFor(() => expect(window.api.resetScenarioState).toHaveBeenCalledWith(101));
        await waitFor(() => expect(window.api.getScenarioStatus).toHaveBeenCalledTimes(2));
        await waitFor(() => expect(screen.queryByText('app.scenarioResetTitle')).toBeNull());
        expect(window.api.resetAllScenarioState).not.toHaveBeenCalled();
    });

    test('unreadable progress offers the reset of every challenge, and the dialog says that', async () => {
        window.api.getScenarioStatus = jest.fn().mockResolvedValue(statusOf(null, 'file'));
        window.api.resetAllScenarioState = jest.fn().mockResolvedValue({ success: true });
        renderCard(makeChallenge());
        fireEvent.click(await screen.findByText('app.scenarioResetAll'));
        expect(screen.getByText('app.scenarioResetAllBody')).toBeTruthy();
        fireEvent.click(screen.getByText('app.scenarioResetConfirm'));
        await waitFor(() => expect(window.api.resetAllScenarioState).toHaveBeenCalledTimes(1));
        expect(window.api.resetScenarioState).not.toHaveBeenCalled();
    });

    test('a bad record of this challenge alone is reset for this challenge alone', async () => {
        window.api.getScenarioStatus = jest.fn().mockResolvedValue(statusOf(null, 'record'));
        window.api.resetScenarioState = jest.fn().mockResolvedValue({ success: true });
        renderCard(makeChallenge());
        fireEvent.click(await screen.findByText('app.scenarioReset'));
        expect(screen.getByText('app.scenarioResetBody')).toBeTruthy();
        fireEvent.click(screen.getByText('app.scenarioResetConfirm'));
        await waitFor(() => expect(window.api.resetScenarioState).toHaveBeenCalledWith(101));
    });

    test('cancelling resets nothing', async () => {
        window.api.getScenarioStatus = jest.fn().mockResolvedValue(statusOf(stopped()));
        window.api.resetScenarioState = jest.fn();
        renderCard(makeChallenge());
        fireEvent.click(await screen.findByText('app.scenarioReset'));
        fireEvent.click(screen.getByText('app.cancel'));
        await waitFor(() => expect(screen.queryByText('app.scenarioResetTitle')).toBeNull());
        expect(window.api.resetScenarioState).not.toHaveBeenCalled();
    });

    test('a plan with nothing stopped offers no reset', async () => {
        window.api.getScenarioStatus = jest.fn().mockResolvedValue(statusOf({}));
        renderCard(makeChallenge());
        await waitFor(() => expect(window.api.getScenarioStatus).toHaveBeenCalled());
        await screen.findByText(/app\.scenarioStatusPhase/);
        expect(screen.queryByText('app.scenarioReset')).toBeNull();
    });
});

describe('header', () => {
    test('the jump target accepts focus and shows an outline for keyboard focus and for a landed jump', () => {
        const { container } = renderCard(makeChallenge());
        const card = container.querySelector('#challenge-101')!;
        expect(card.getAttribute('tabindex')).toBe('-1');
        expect(card.className).toContain('focus-visible:outline-base-content');
        expect(card.className).toContain('focus-visible:outline-4');
        expect(card.className).toContain('focus-visible:outline-offset-4');
        // a pointer jump sets data-landed (see scrollToChallenge), which draws the same outline
        expect(card.className).toContain('data-[landed]:outline-base-content');
        expect(card.className).toContain('data-[landed]:outline-4');
        expect(card.className).toContain('data-[landed]:outline-offset-4');
        expect(card.className).not.toMatch(/(^|\s)focus:/);
    });

    test('opens the challenge URL and the settings modal', async () => {
        const { onSettingsClick } = renderCard(makeChallenge());
        fireEvent.click(screen.getByText('gurushots.com/challenge/sunset'));
        await waitFor(() =>
            expect(window.api.openExternalUrl).toHaveBeenCalledWith('https://gurushots.com/challenge/sunset'),
        );
        fireEvent.click(screen.getByText('app.settings'));
        expect(onSettingsClick).toHaveBeenCalledWith(101, 'Sunset');
    });

    test.each([
        ['a path walk', '../../account'],
        ['a query', 'x?next=//evil.example'],
        ['a fragment', 'x#y'],
        ['another host', '@evil.example'],
        ['a slash', 'a/b'],
    ])('a challenge slug with %s opens the generic challenges page, not an attacker-shaped URL', async (_name, url) => {
        renderCard(makeChallenge({ url }));
        fireEvent.click(screen.getByText('gurushots.com/challenges'));
        await waitFor(() =>
            expect(window.api.openExternalUrl).toHaveBeenCalledWith('https://gurushots.com/challenges'),
        );
    });

    test('the statistics show the counts, and 0 votes when the challenge carries none', () => {
        const { unmount } = renderCard(makeChallenge());
        expect(screen.getByText((2000).toLocaleString())).toBeTruthy();
        unmount();
        renderCard(makeChallenge({ votes: undefined }));
        expect(screen.getByText('0')).toBeTruthy();
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

    test.each([
        ['Vote', 'app.vote', 'voteOnChallengeManual'],
        ['Run', 'app.run', 'runVotingCycleForChallenge'],
    ] as const)(
        'a failed %s shows a translated error below the buttons until it is dismissed or retried',
        async (_name, label, method) => {
            jest.mocked(window.api[method])
                .mockResolvedValueOnce({ success: false, error: 'Challenge no longer active' })
                .mockResolvedValueOnce({ success: false, error: 'raw handler text' })
                .mockResolvedValueOnce(invalid({ success: true }));
            const { onVoteComplete } = renderCard(makeChallenge());

            fireEvent.click(screen.getByText(label));
            const error = await screen.findByText('errors.challengeNoLongerActive');
            expect(error.closest('[role="alert"]')).not.toBeNull();
            expect(onVoteComplete).not.toHaveBeenCalled();

            fireEvent.click(screen.getByRole('button', { name: 'errors.dismiss' }));
            expect(screen.queryByText('errors.challengeNoLongerActive')).toBeNull();

            fireEvent.click(screen.getByText(label));
            expect(await screen.findByText('errors.actionFailed')).toBeTruthy();
            expect(screen.queryByText('raw handler text')).toBeNull();

            // The next press clears it, and a success leaves none.
            fireEvent.click(screen.getByText(label));
            await waitFor(() => expect(onVoteComplete).toHaveBeenCalledTimes(1));
            expect(screen.queryByText('errors.actionFailed')).toBeNull();
        },
    );

    test('Vote and Run are main actions (neutral): they cost nothing', () => {
        renderCard(makeChallenge());
        expect(screen.getByText('app.vote').closest('button')!.className).toContain('btn-neutral');
        expect(screen.getByText('app.run').closest('button')!.className).toContain('btn-neutral');
    });

    test('Compact and Settings are ghost view controls, grouped to the right of Vote and Run', () => {
        renderCard(makeChallenge());
        const compact = screen.getByText('app.compact').closest('button')!;
        const settings = screen.getByText('app.settings').closest('button')!;
        expect(compact.className).toContain('btn-ghost');
        expect(settings.className).toContain('btn-ghost');
        const group = compact.parentElement!;
        expect(group).toBe(settings.parentElement);
        expect(group.className).toContain('ml-auto');
        expect(group.contains(screen.getByText('app.vote'))).toBe(false);
        expect(group.contains(screen.getByText('app.run'))).toBe(false);
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
        expect(toggle.querySelector('svg')!.getAttribute('fill')).toBe('none');
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
        expect(container.querySelector('#challenge-101')!.className).not.toContain('col-span-full');
    });
});

describe('time text', () => {
    test('reads a signal value, in a green badge with more than six hours left', () => {
        renderCard(makeChallenge({ close_time: nowSec() + 30_000 }), { timeRemaining: signal('5m') });
        expect(screen.getByText('5m').className).toBe('badge h-auto badge-success');
    });

    test('marks an ended challenge (null) with the red badge, worded in the UI language', () => {
        renderCard(makeChallenge(), { timeRemaining: null });
        expect(screen.getByText('app.ended').className).toBe('badge h-auto badge-error');
    });

    test('a plain countdown string is a yellow badge between one and six hours left', () => {
        renderCard(makeChallenge({ close_time: nowSec() + 7_200 }), { timeRemaining: '1h 2m' });
        expect(screen.getByText('1h 2m').className).toBe('badge h-auto badge-warning');
    });

    test('the countdown is a red badge under an hour left', () => {
        renderCard(makeChallenge({ close_time: nowSec() + 600 }), { timeRemaining: '9m' });
        expect(screen.getByText('9m').className).toBe('badge h-auto badge-error');
    });

    test('falls back to the loading label', () => {
        renderCard(makeChallenge(), { timeRemaining: undefined });
        expect(screen.getByText('common.loading')).toBeTruthy();
    });
});

describe('progress', () => {
    const withTotal = (total: RankingTotal, extra = {}) =>
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
        expect(screen.getByText('POPULAR 1').className).toContain(LEVEL_BADGE_CLASS.popular);
    });

    test('the progress bar carries the level colour, and the Latvian look for an unknown level', () => {
        const { container, unmount } = renderCard(
            withTotal({ votes: 5, rank: 1, level: 2, level_name: 'SKILLED', percent: 1, next_message: '' }),
        );
        const bar = container.querySelector('progress');
        expect(bar?.className).toContain(LEVEL_PROGRESS_CLASS.skilled);
        expect(bar?.className).not.toContain('progress-latvian');
        unmount();
        const unknown = renderCard(withTotal({ votes: 5, rank: 1, percent: 1, next_message: '' }));
        expect(unknown.container.querySelector('progress')?.className).toContain('progress-latvian');
    });

    test('the percentage is visible text, and the bar is named by the "Your progress" caption', () => {
        const { container } = renderCard(
            withTotal({ votes: 5, rank: 1, level: 5, level_name: 'ALL STAR', percent: 42.4, next_message: '' }),
        );
        const bar = container.querySelector('progress')!;
        expect(screen.getByText('42%')).toBeTruthy();
        const caption = screen.getByText('app.yourProgress');
        expect(bar.getAttribute('aria-labelledby')).toBe(caption.id);
        expect(caption.id).not.toBe('');
    });

    test('a ranking total without a percentage shows no percentage text', () => {
        const { container } = renderCard(
            withTotal({ votes: 5, rank: 1, level: 5, level_name: 'ALL STAR', next_message: '' }),
        );
        expect(container.querySelector('progress')!.parentElement!.textContent).toBe('');
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

    test('no progress block when the ranking total carries no vote count', () => {
        renderCard(withTotal({ rank: 1, level: 1, level_name: 'POPULAR', percent: 1 }));
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
    const turboChallenge = (turbo: MemberTurbo, extra = {}) =>
        makeChallenge({ member: { turbo: { mode: 'classic', ...turbo } }, ...extra });

    test('plays turbo and refreshes on success; spinner while in flight', async () => {
        const d = deferred<Awaited<ReturnType<WindowApi['playAutoTurbo']>>>();
        window.api.playAutoTurbo = jest.fn(() => d.promise);
        const { onVoteComplete } = renderCard(turboChallenge({ state: 'FREE' }));
        fireEvent.click(screen.getByText(/app\.earnTurbo/));
        // While in flight the button shows a spinner but keeps its name for assistive tech, and says it is busy.
        const busy = await screen.findByRole('button', { name: 'app.earnTurbo' });
        await waitFor(() => expect(busy.getAttribute('aria-busy')).toBe('true'));
        expect(busy.querySelector('.loading-spinner')).not.toBeNull();
        expect(busy.querySelector('.sr-only')!.textContent).toBe('app.earnTurbo');
        expect(window.api.playAutoTurbo).toHaveBeenCalledWith(101, 'Sunset');
        await act(async () => d.resolve(invalid({ success: true })));
        await waitFor(() => expect(onVoteComplete).toHaveBeenCalled());
    });

    test('a failed play shows a translated, announced error and does not refresh', async () => {
        window.api.playAutoTurbo = jest
            .fn()
            .mockResolvedValue({ success: false, error: 'Turbo not earned — try again later' });
        const { onVoteComplete } = renderCard(turboChallenge({ state: 'IN_PROGRESS' }));
        fireEvent.click(screen.getByText(/app\.earnTurbo/));
        await waitFor(() => expect(screen.getByText('errors.turboNotEarned')).toBeTruthy());
        expect(screen.getByText('errors.turboNotEarned').closest('[role="alert"]')).not.toBeNull();
        expect(screen.getByText(/app\.earnTurbo/).closest('button')!.className).toContain('btn-error');
        expect(onVoteComplete).not.toHaveBeenCalled();
    });

    test('an invalid-args refusal shows the translated text, not the machine code', async () => {
        window.api.playAutoTurbo = jest.fn().mockResolvedValue({ success: false, error: 'invalid-args' });
        renderCard(turboChallenge({ state: 'IN_PROGRESS' }));
        fireEvent.click(screen.getByText(/app\.earnTurbo/));
        await waitFor(() => expect(screen.getByText('errors.actionInvalidArgs')).toBeTruthy());
        expect(screen.queryByText('invalid-args')).toBeNull();
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

    test('while autovote runs the button remains available', async () => {
        renderCard(turboChallenge({ state: 'FREE' }), { autovoteRunning: true });
        fireEvent.click(screen.getByText(/app\.earnTurbo/));
        await waitFor(() => expect(window.api.playAutoTurbo).toHaveBeenCalledWith(101, 'Sunset'));
        expect(screen.queryByText('app.autoTurboRunsWithAutovote')).toBeNull();
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
        const d = deferred<Awaited<ReturnType<WindowApi['fillChallengeNow']>>>();
        window.api.fillChallengeNow = jest.fn(() => d.promise);
        const { container } = renderCard(makeChallenge());
        fireEvent.click(screen.getByText('+1'));
        await waitFor(() => expect(container.querySelectorAll('.loading-spinner')).toHaveLength(2));
        await act(async () => d.resolve(invalid({ success: true })));
    });

    test('a failed fill shows the error and does not refresh', async () => {
        window.api.fillChallengeNow = jest.fn().mockResolvedValue({ success: false, error: 'no photos' });
        const { onVoteComplete } = renderCard(makeChallenge());
        fireEvent.click(screen.getByText('+1'));
        await waitFor(() => expect(screen.getByText('errors.actionFailed')).toBeTruthy());
        expect(screen.getByRole('alert')).toBeTruthy();
        expect(screen.getByText('+1').className).toContain('btn-error');
        expect(onVoteComplete).not.toHaveBeenCalled();
    });

    test('an invalid-args fill refusal shows the translated text, not the machine code', async () => {
        window.api.fillChallengeNow = jest.fn().mockResolvedValue({ success: false, error: 'invalid-args' });
        renderCard(makeChallenge());
        fireEvent.click(screen.getByText('+1'));
        await waitFor(() => expect(screen.getByText('errors.actionInvalidArgs')).toBeTruthy());
        expect(screen.queryByText('invalid-args')).toBeNull();
    });

    test('+1 and +N stay shown while autovote runs', () => {
        renderCard(makeChallenge(), { autovoteRunning: true });
        expect(screen.getByText('+1')).toBeTruthy();
        expect(screen.getByText('+3')).toBeTruthy();
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

describe('pick', () => {
    type Listing = Extract<Awaited<ReturnType<WindowApi['getLibraryPhotos']>>, { success: true }>;
    const idOf = (n: number) => `${String(n).padStart(8, '0')}${'a'.repeat(24)}`;
    const listing = (): Listing => ({
        success: true,
        photos: [1, 2, 3].map((n) => ({
            id: idOf(n),
            labels: [`tag${n}`],
            allowed: true,
            message: null,
            uploadDate: 1,
        })),
        memberId: 'c'.repeat(32),
        truncated: false,
        nextStart: 0,
        wonIds: [],
        wonCount: 0,
        preview: false,
        readAtMs: 1_700_000_000_000,
        allowedKnown: true,
    });
    const english = (key: string) =>
        key.startsWith('app.')
            ? ((app as Record<string, string>)[key.slice(4)] ?? key)
            : key.startsWith('errors.')
              ? ((errors as Record<string, string>)[key.slice(7)] ?? key)
              : key;
    const tile = (n: number) =>
        screen.getByRole('button', { name: new RegExp(`^Photo ${String(n).padStart(8, '0')}:`) });
    const pickButton = () => screen.getByRole('button', { name: app.fillPick });
    const openAndPick = async (n = 1) => {
        fireEvent.click(pickButton());
        // Pick… opens with nothing loaded; Load all shows the library as last loaded with picking held, and the
        // fresh read unlocks it.
        fireEvent.click(await screen.findByRole('button', { name: app.pickLoadPhotos }));
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        await waitFor(() => expect(tile(1).getAttribute('aria-disabled')).toBe('false'));
        fireEvent.click(tile(n));
    };
    type SubmitPicked = WindowApi['submitPickedPhotos'];
    const submitPicked = () => jest.fn<ReturnType<SubmitPicked>, Parameters<SubmitPicked>>();
    const submit = () => fireEvent.click(screen.getByRole('button', { name: /^Submit/ }));
    const slotsOpen = (open: number) =>
        makeChallenge({
            max_photo_submits: 3,
            member: { ranking: { entries: Array.from({ length: 3 - open }, (_, i) => ({ id: i + 1 })) } },
        });

    beforeEach(() => {
        mockTranslator.t.mockImplementation(english);
        window.api.getLibraryPhotos = jest.fn().mockResolvedValue(listing());
        window.api.submitPickedPhotos = submitPicked().mockResolvedValue({ success: true, submitted: 1 });
    });
    afterEach(() => {
        mockTranslator.t.mockImplementation((key) => key);
    });

    test('Pick photos… sits beside +1 / +N, named for what it does, and the row wraps', () => {
        const { container } = renderCard(makeChallenge());
        const pick = pickButton();
        expect(pick.textContent).toBe('Pick photos…');
        expect(pick.getAttribute('title')).toBe('Choose which photos to submit now');
        expect(pick.parentElement).toBe(screen.getByText('+1').parentElement);
        expect(pick.parentElement!.className).toContain('flex-wrap');
        expect(container.querySelector('[role="dialog"]')).toBeNull();
    });

    test('picking and submitting sends the ids, closes the picker and refreshes the card', async () => {
        const { onVoteComplete } = renderCard(makeChallenge());
        await openAndPick(2);
        submit();
        await waitFor(() => expect(window.api.submitPickedPhotos).toHaveBeenCalledWith(101, [idOf(2)]));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(onVoteComplete).toHaveBeenCalledTimes(1);
        expect(window.api.fillChallengeNow).not.toHaveBeenCalled();
    });

    test.each([
        ['not-enough-slots', 'pickNotEnoughSlots'],
        ['already-entered', 'pickAlreadyEntered'],
        ['submit-rejected', 'pickRejected'],
        ['submit-unclear', 'pickUnclear'],
        ['Challenge no longer active', 'challengeNoLongerActive'],
        ['something unexpected', 'actionFailed'],
    ])(
        '%s: the picker stays open on the translated text, the card refreshes and the listing is read again',
        async (code, key) => {
            window.api.submitPickedPhotos = submitPicked().mockResolvedValue({
                success: false,
                error: code,
            });
            const { onVoteComplete } = renderCard(makeChallenge());
            await openAndPick();
            submit();
            await waitFor(() =>
                expect(screen.getByRole('alert').textContent).toBe((errors as Record<string, string>)[key]),
            );
            expect(screen.getByRole('dialog')).toBeTruthy();
            expect(onVoteComplete).toHaveBeenCalledTimes(1);
            await waitFor(() => expect(window.api.getLibraryPhotos).toHaveBeenCalledTimes(3));
        },
    );

    test.each(['invalid-args', 'No authentication token found', 'submit-busy'])(
        '%s: nothing was sent, so nothing is refreshed',
        async (code) => {
            window.api.submitPickedPhotos = submitPicked().mockResolvedValue({ success: false, error: code });
            const { onVoteComplete } = renderCard(makeChallenge());
            await openAndPick();
            submit();
            await screen.findByRole('alert');
            expect(onVoteComplete).not.toHaveBeenCalled();
            expect(window.api.getLibraryPhotos).toHaveBeenCalledTimes(2);
        },
    );

    test('submit-busy: the picker says another submit is running', async () => {
        window.api.submitPickedPhotos = submitPicked().mockResolvedValue({ success: false, error: 'submit-busy' });
        renderCard(makeChallenge());
        await openAndPick();
        submit();
        await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(errors.pickBusy));
    });

    test('an empty answer is treated as a failure after the send: generic text and a refresh', async () => {
        window.api.submitPickedPhotos = submitPicked().mockResolvedValue(invalid(undefined));
        const { onVoteComplete } = renderCard(makeChallenge());
        await openAndPick();
        submit();
        await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(errors.actionFailed));
        expect(onVoteComplete).toHaveBeenCalledTimes(1);
    });

    test('closing clears a failure: the next opening starts without it', async () => {
        window.api.submitPickedPhotos = submitPicked().mockResolvedValue({ success: false, error: 'submit-rejected' });
        renderCard(makeChallenge());
        await openAndPick();
        submit();
        await screen.findByRole('alert');
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(screen.queryByRole('dialog')).toBeNull();
        fireEvent.click(pickButton());
        await screen.findByRole('button', { name: app.pickLoadPhotos });
        expect(screen.queryByRole('alert')).toBeNull();
    });

    test('while a submit is in flight every submit button is held and the picker cannot be closed', async () => {
        const d = deferred<Awaited<ReturnType<WindowApi['submitPickedPhotos']>>>();
        window.api.submitPickedPhotos = submitPicked().mockReturnValue(d.promise);
        renderCard(makeChallenge());
        await openAndPick();
        submit();
        await waitFor(() =>
            expect(screen.getByRole('button', { name: /Submit/ }).getAttribute('aria-busy')).toBe('true'),
        );
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(screen.getByRole('dialog')).toBeTruthy();
        // The card's own buttons sit behind the dialog, held as well.
        for (const name of ['+1', '+3']) {
            expect(screen.getByText(name, { selector: 'button' }).hasAttribute('disabled')).toBe(true);
        }
        expect(pickButton().hasAttribute('disabled')).toBe(true);
        await act(async () => d.resolve(invalid({ success: true })));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    test('a fill in flight holds Pick…, and a held +1 is not what spins', async () => {
        const d = deferred<Awaited<ReturnType<WindowApi['fillChallengeNow']>>>();
        window.api.fillChallengeNow = jest.fn(() => d.promise);
        renderCard(makeChallenge());
        fireEvent.click(screen.getByText('+1'));
        await waitFor(() => expect(pickButton().hasAttribute('disabled')).toBe(true));
        await act(async () => d.resolve(invalid({ success: true })));
        await waitFor(() => expect(pickButton().hasAttribute('disabled')).toBe(false));
    });

    test('a refresh that leaves no open slot keeps the picker, says so, and still delivers an answer in flight', async () => {
        const d = deferred<Awaited<ReturnType<WindowApi['submitPickedPhotos']>>>();
        window.api.submitPickedPhotos = submitPicked().mockReturnValue(d.promise);
        const { rerender, onVoteComplete } = renderCard(slotsOpen(1));
        await openAndPick();
        submit();
        await waitFor(() => expect(window.api.submitPickedPhotos).toHaveBeenCalled());
        // The card is refreshed with the slot taken: the submit buttons' gate closes.
        rerender(
            <ChallengeCard
                challenge={slotsOpen(0)}
                timeRemaining="2h"
                timezone="local"
                autovoteRunning={false}
                onVoteComplete={onVoteComplete}
                onSettingsClick={jest.fn()}
                onCurrencySpent={jest.fn()}
            />,
        );
        expect(screen.queryByText('+1')).toBeNull();
        expect(screen.getByRole('dialog')).toBeTruthy();
        expect(screen.getByText(/^No open slots left/)).toBeTruthy();
        await act(async () => d.resolve(invalid({ success: true })));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(onVoteComplete).toHaveBeenCalledTimes(1);
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
        await waitFor(() => expect(parseJsonObject(screen.getByTestId('entry-2').textContent).swapBack).not.toBeNull());
        expect(parseJson(screen.getByTestId('entry-2').textContent)).toEqual({
            swapBack: { currentId: '2', previousId: '9', previousMemberId: 'm', kind: 'turbo' },
            swapAvailable: false,
            boostAvailable: true,
            turboAvailable: true,
        });
        expect(parseJsonObject(screen.getByTestId('entry-1').textContent).swapBack).toBeNull();
    });

    test('hands each entry the timezone its submit time is written in', () => {
        renderCard(makeChallenge({ member: { ranking: { entries: [{ id: 1 }] } } }), { timezone: 'Europe/Riga' });
        expect(screen.getByTestId('entry-1').getAttribute('data-timezone')).toBe('Europe/Riga');
    });

    test('a settings change refreshes the deadline preview in place, without remounting the card', async () => {
        const challenge = makeChallenge();
        const { container, rerender } = renderCard(challenge, { settingsVersion: 0 });
        await waitFor(() => expect(window.api.getDeadlineActions).toHaveBeenCalledTimes(1));
        expect(screen.queryByRole('alert')).toBeNull();
        const root = container.firstChild;

        jest.mocked(window.api.getDeadlineActions).mockResolvedValue({
            success: true,
            actions: [],
            ...blocked({ boost: { by: 'flag' } }),
        });
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

        await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('app.conflictFlag'));
        expect(window.api.getDeadlineActions).toHaveBeenCalledTimes(2);
        expect(container.firstChild).toBe(root);
    });

    describe('the conflict warning names its cause', () => {
        const releaseAt = nowSec() + 1800;
        const when = formatEndTime(releaseAt, 'local');
        const answer = (blockedBy: Parameters<typeof blocked>[0]) => {
            window.api.getDeadlineActions = jest
                .fn()
                .mockResolvedValue({ success: true, actions: [], ...blocked(blockedBy) });
        };
        const alerts = () => screen.getAllByRole('alert').map((alert) => alert.textContent);
        const english = (key: string) =>
            key.startsWith('app.') ? ((app as Record<string, string>)[key.slice(4)] ?? key) : key;

        beforeEach(() => mockTranslator.t.mockImplementation(english));
        afterEach(() => mockTranslator.t.mockImplementation((key) => key));

        test.each([
            [
                'Boost',
                { boost: { by: 'flag' as const } },
                "Boost can't apply: your only entry already has Turbo (they can't share an entry). Add another entry to use both.",
            ],
            [
                'Turbo',
                { turbo: { by: 'flag' as const } },
                "Turbo can't apply: your only entry already has Boost (they can't share an entry). Add another entry to use both.",
            ],
        ])('%s blocked by a flag asks for another entry', async (_name, blockedBy, text) => {
            answer(blockedBy);
            renderCard(makeChallenge());
            await waitFor(() => expect(alerts()).toEqual([text]));
        });

        test.each([
            [
                'Boost',
                { boost: { by: 'pin' as const, releaseAt } },
                `Boost is waiting: the photo is pinned for Turbo. If Turbo isn't ready by ${when}, Boost goes on that photo. Unpin it or add another entry to use Boost sooner.`,
            ],
            [
                'Turbo',
                { turbo: { by: 'pin' as const, releaseAt } },
                `Turbo is waiting: the photo is pinned for Boost. If Boost isn't ready by ${when}, Turbo goes on that photo. Unpin it or add another entry to use Turbo sooner.`,
            ],
        ])('%s blocked by a pin that gives way names the time', async (_name, blockedBy, text) => {
            answer(blockedBy);
            renderCard(makeChallenge());
            await waitFor(() => expect(alerts()).toEqual([text]));
        });

        test.each([
            [
                'Boost',
                { boost: { by: 'pin' as const } },
                "Boost won't apply: the photo is pinned for Turbo, and the pin won't give way (Emergency Submit is off or Turbo is ready). Unpin it or add another entry.",
            ],
            [
                'Turbo',
                { turbo: { by: 'pin' as const } },
                "Turbo won't apply: the photo is pinned for Boost, and the pin won't give way (Emergency Submit is off or Boost is ready). Unpin it or add another entry.",
            ],
        ])('%s blocked by a pin that never gives way says to unpin', async (_name, blockedBy, text) => {
            answer(blockedBy);
            renderCard(makeChallenge());
            await waitFor(() => expect(alerts()).toEqual([text]));
        });

        test('the compact tile shows both notes whole (no clamp, no title standing in for the text)', async () => {
            window.api.getEffectiveSetting = jest.fn(async (key) => key === 'compactCards');
            answer({ boost: { by: 'pin', releaseAt }, turbo: { by: 'flag' } });
            renderCard(makeChallenge());
            // The compact tile's note leads with the warning icon; the detailed card's alert box has none.
            await waitFor(() => expect(screen.getAllByRole('alert')[0].querySelector('svg')).not.toBeNull());
            const [boost, turbo] = screen.getAllByRole('alert');
            expect(boost.textContent).toBe(
                `${app.conflictPinReleases
                    .replace(/\{kind\}/g, 'Boost')
                    .replace(/\{other\}/g, 'Turbo')
                    .replace('{time}', when)}`,
            );
            expect(boost.className).not.toContain('line-clamp');
            expect(boost.hasAttribute('title')).toBe(false);
            expect(turbo.textContent).toBe(
                "Turbo can't apply: your only entry already has Boost (they can't share an entry). Add another entry to use both.",
            );
            // The warning icon is a separate, decorative cue ahead of the words.
            expect(boost.querySelector('svg')!.getAttribute('class')).toContain('text-warning');
        });

        test('a reworded warning for the same feature updates the same element', async () => {
            answer({ turbo: { by: 'flag' } });
            const challenge = makeChallenge();
            const { rerender } = renderCard(challenge, { settingsVersion: 0 });
            const first = await screen.findByRole('alert');
            answer({ turbo: { by: 'pin' as const, releaseAt } });
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
            await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(when));
            expect(screen.getByRole('alert')).toBe(first);
        });

        test('nothing is shown while nothing is blocked', async () => {
            answer({});
            renderCard(makeChallenge());
            await waitFor(() => expect(window.api.getDeadlineActions).toHaveBeenCalled());
            expect(screen.queryByRole('alert')).toBeNull();
        });
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
        const card = container.querySelector('#challenge-101')!;
        expect(card.className).toContain('border-2 border-error');
        expect(card.className).toContain('ring-2 ring-info ring-offset-2');
        expect(card.className).toContain(
            'focus-visible:outline-4 focus-visible:outline-base-content focus-visible:outline-offset-4',
        );
        card.scrollIntoView = jest.fn();
        scrollToChallenge(101);
        expect(document.activeElement).toBe(card);
        expect(screen.getByText('5%').className).toBe('badge h-auto badge-error');
    });

    test('a healthy card has a plain border and no ring', () => {
        const { container } = renderCard(makeChallenge());
        const card = container.querySelector('#challenge-101')!;
        expect(card.className).toMatch(/^border rounded-lg/);
        expect(card.className).not.toContain('ring-2');
        expect(screen.getByText('80%').className).toBe('badge h-auto badge-success');
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
                'badge h-auto badge-info',
                'badge h-auto badge-warning',
            ],
            ['USED', 'app.used', 'FREE', 'app.stateFree', 'badge h-auto badge-success', 'badge h-auto badge-info'],
            [
                'LOCKED',
                'app.stateLocked',
                'UNAVAILABLE',
                'app.unavailable',
                'text-base-content/70',
                'text-base-content/70',
            ],
        ];
        for (const [boost, boostText, turbo, turboText, boostClass, turboClass] of cases) {
            const view = renderCard(makeChallenge(states(boost, turbo)));
            expect(screen.getByText(boostText).className).toBe(boostClass);
            expect(screen.getByText(turboText).className).toBe(turboClass);
            view.unmount();
        }
    });

    test('exposure is a yellow badge under 50%, and plain before the start or after the close', () => {
        const low = renderCard(makeChallenge({ member: { ranking: { exposure: { exposure_factor: 30 } } } }));
        expect(screen.getByText('30%').className).toBe('badge h-auto badge-warning');
        low.unmount();
        const notStarted = renderCard(makeChallenge({ start_time: nowSec() + 600 }));
        expect(screen.getByText('80%').className).toBe('');
        notStarted.unmount();
        renderCard(makeChallenge({ close_time: nowSec() - 600 }));
        expect(screen.getByText('80%').className).toBe('');
    });

    test('renders the sanitized welcome message', () => {
        renderCard(makeChallenge({ welcome_message: 'Hello <b>world</b>' }));
        expect(screen.getByText('world').tagName).toBe('B');
    });
});

describe('benchmark scores and the gap to chase', () => {
    const english = (key: string) =>
        key.startsWith('app.') ? ((app as Record<string, string>)[key.slice(4)] ?? key) : key;
    const rows = (over: Partial<Record<'one' | 'ten' | 'hundred', string>> = {}) =>
        (
            [
                ['Top 1', over.one ?? '300'],
                ['Top 10', over.ten ?? '200'],
                ['Top 100', over.hundred ?? '100'],
            ] as const
        ).map(([benchmark, score]) => ({ benchmark, score }));
    const withBench = (total: RankingTotal, challenge = {}) =>
        makeChallenge({
            ...challenge,
            member: { ranking: { total: { votes: 50, rank: 120, percent: 10, next_message: '', ...total } } },
        });

    beforeEach(() => mockTranslator.t.mockImplementation(english));
    afterEach(() => mockTranslator.t.mockImplementation((key) => key));

    test('the three groups with their scores, and past the top 100 the gap to it', () => {
        renderCard(withBench({ benchmark: rows() }));

        expect(
            screen.getByText(`Top 1 / 10 / 100: 300 / 200 / 100 · +${(51).toLocaleString()} to top 100`),
        ).toBeTruthy();
    });

    test('a score the server left empty or garbled drops out of the line', () => {
        const { unmount } = renderCard(
            withBench({
                // A blank score, a garbled one, a group the card does not read, a row without a
                // group, a row without a score, and a row that is not a row at all.
                benchmark: invalid<RankingTotal['benchmark']>([
                    ...rows({ one: '', ten: 'garbage' }),
                    { benchmark: 'Top 5', score: '9' },
                    { benchmark: 'Top 10' },
                    { score: '7' },
                    null,
                ]),
            }),
        );
        expect(screen.getByText(`Top 1 / 10 / 100: 100 · +${(51).toLocaleString()} to top 100`)).toBeTruthy();
        unmount();

        // A benchmark block that is not a list is no benchmark block at all.
        renderCard(withBench({ benchmark: invalid<RankingTotal['benchmark']>(5) }));
        expect(screen.queryByText(/Top 1 \/ 10 \/ 100/)).toBeNull();
    });

    test('a rank the panel cannot chase with (missing, or not a positive integer) shows the scores alone', () => {
        const noRank = renderCard(withBench({ rank: undefined, benchmark: rows() }));
        expect(screen.getByText('Top 1 / 10 / 100: 300 / 200 / 100')).toBeTruthy();
        expect(screen.queryByText(/to top/)).toBeNull();
        noRank.unmount();

        renderCard(withBench({ votes: 50.5, benchmark: rows() }));
        expect(screen.getByText('Top 1 / 10 / 100: 300 / 200 / 100')).toBeTruthy();
        expect(screen.queryByText(/to top/)).toBeNull();
    });

    test.each([
        ['inside the top 100 chases the 10 benchmark', 45, `+${(151).toLocaleString()} to top 10`],
        ['inside the top 10 chases the 1 benchmark', 7, `+${(251).toLocaleString()} to top 1`],
    ])('%s', (_name, rank, expected) => {
        renderCard(withBench({ rank, benchmark: rows() }));

        expect(screen.getByText(`Top 1 / 10 / 100: 300 / 200 / 100 · ${expected}`)).toBeTruthy();
    });

    test.each([
        ['already at rank 1', 1, 50],
        ['the votes past the score', 120, 500],
    ] as Array<[string, number, number]>)('%s: no gap', (_name, rank, votes) => {
        renderCard(withBench({ rank, votes, benchmark: rows() }));

        expect(screen.getByText('Top 1 / 10 / 100: 300 / 200 / 100')).toBeTruthy();
        expect(screen.queryByText(/to top/)).toBeNull();
    });
});

describe('prize tiers', () => {
    const english = (key: string) =>
        key.startsWith('app.') ? ((app as Record<string, string>)[key.slice(4)] ?? key) : key;

    beforeEach(() => mockTranslator.t.mockImplementation(english));
    afterEach(() => mockTranslator.t.mockImplementation((key) => key));

    test('a MEMBER tier names the top photographers and lists its prizes as type × amount', () => {
        renderCard(
            makeChallenge({
                achievements_and_prizes: [
                    {
                        title: 'Gold',
                        rank: { min_rank: 1, max_rank: 10, type: 'MEMBER' },
                        prizes: [
                            { type: 'KEY', amount: 1 },
                            { type: 'COINS', amount: 250 },
                        ],
                    },
                ],
            }),
        );

        expect(screen.getByText('Gold')).toBeTruthy();
        expect(screen.getByText('Top photographer #1–10')).toBeTruthy();
        expect(screen.getByText(`Key × 1, Coins × ${(250).toLocaleString()}`)).toBeTruthy();
    });

    test('an IMAGE tier names the top photos; a tier with no rank shows its title alone', () => {
        renderCard(
            makeChallenge({
                achievements_and_prizes: [
                    {
                        title: 'Silver',
                        rank: { min_rank: 11, max_rank: 50, type: 'IMAGE' },
                        prizes: [
                            { type: 'PHOTO_SWAP', amount: 2 },
                            { type: 'EXPOSURE_AUTOFILL', amount: 1 },
                        ],
                    },
                    { title: 'Bronze', rank: null, prizes: [] },
                    // No title and no prizes at all: nothing of the tier shows.
                    { rank: null, prizes: [] },
                    // A tier the server carries without its prize list.
                    { title: 'Title only', rank: null },
                ],
            }),
        );

        expect(screen.getByText('Top photo #11–50')).toBeTruthy();
        expect(screen.getByText('Photo swap × 2, Exposure autofill × 1')).toBeTruthy();
        expect(screen.getByText('Bronze')).toBeTruthy();
        expect(screen.getByText('Title only')).toBeTruthy();
    });

    test('a prize type the app does not know is a generic label, never the raw code', () => {
        renderCard(
            makeChallenge({
                achievements_and_prizes: [{ title: 'Gold', rank: null, prizes: [{ type: 'X_CUSTOM', amount: 3 }] }],
            }),
        );

        expect(screen.getByText(`Prize × 3`)).toBeTruthy();
        expect(screen.queryByText(/X_CUSTOM/)).toBeNull();
    });

    test('a rank window the server left unreadable shows the title alone', () => {
        renderCard(
            makeChallenge({
                achievements_and_prizes: [
                    { title: 'Gold', rank: { min_rank: 'x', max_rank: 10, type: 'MEMBER' }, prizes: [] },
                ],
            }),
        );

        expect(screen.getByText('Gold')).toBeTruthy();
        expect(screen.queryByText(/Top photographer #/)).toBeNull();
    });

    test('a rank window of an unknown type is not named, and a prize without an amount is its name alone', () => {
        renderCard(
            makeChallenge({
                achievements_and_prizes: [
                    {
                        title: 'Bronze',
                        rank: { min_rank: 51, max_rank: 100, type: 'X_OTHER' },
                        prizes: [{ type: 'COINS' }],
                    },
                ],
            }),
        );

        expect(screen.getByText('Bronze')).toBeTruthy();
        expect(screen.queryByText(/Top (photographer|photo) #/)).toBeNull();
        expect(screen.getByText('Coins')).toBeTruthy();
    });

    test('no prize section without tiers', () => {
        renderCard(makeChallenge({ achievements_and_prizes: [] }));

        // Only the stat cell speaks of a prize.
        expect(screen.getAllByText('Prize')).toHaveLength(1);
    });
});

describe('track badges', () => {
    const english = (key: string) =>
        key.startsWith('app.') ? ((app as Record<string, string>)[key.slice(4)] ?? key) : key;

    beforeEach(() => mockTranslator.t.mockImplementation(english));
    afterEach(() => mockTranslator.t.mockImplementation((key) => key));

    test('a badge per track the challenge runs, none for the off or absent ones', () => {
        const all = renderCard(
            makeChallenge({ tags: [], top_photographer_enable: true, top_photo_enable: true, guru_pick_enable: true }),
        );
        expect(screen.getByText('🏆 Top photographer')).toBeTruthy();
        expect(screen.getByText('📷 Top photo')).toBeTruthy();
        expect(screen.getByText("⭐ Guru's pick")).toBeTruthy();
        all.unmount();

        renderCard(makeChallenge({ tags: [], top_photographer_enable: true, top_photo_enable: false }));
        expect(screen.getByText('🏆 Top photographer')).toBeTruthy();
        expect(screen.queryByText('📷 Top photo')).toBeNull();
        expect(screen.queryByText(/Guru's pick/)).toBeNull();
    });
});

describe('levels_rank_enable off hides the level lines alone', () => {
    const english = (key: string) =>
        key.startsWith('app.') ? ((app as Record<string, string>)[key.slice(4)] ?? key) : key;
    const withLevels = (levels_rank_enable: boolean | undefined) =>
        makeChallenge({
            ...(levels_rank_enable === undefined ? {} : { levels_rank_enable }),
            ranking_levels: { level_2: 500 },
            member: {
                ranking: {
                    total: {
                        votes: 120,
                        rank: 7,
                        level: 1,
                        level_name: 'POPULAR',
                        percent: 40,
                        next_message: 'Keep going',
                    },
                },
            },
        });

    beforeEach(() => mockTranslator.t.mockImplementation(english));
    afterEach(() => mockTranslator.t.mockImplementation((key) => key));

    test('the level badge and the next message go; rank, votes and the bar stay', () => {
        const { container } = renderCard(withLevels(false));

        expect(screen.queryByText('POPULAR 1')).toBeNull();
        expect(screen.queryByText('Keep going')).toBeNull();
        expect(container.querySelector('progress')).not.toBeNull();
        expect(screen.getByText('Rank 7 of 50')).toBeTruthy();
        expect(screen.getByText('120 Votes')).toBeTruthy();

        // With the flag on (or absent) the level lines are back.
        const { unmount } = renderCard(withLevels(true));
        expect(screen.getByText('POPULAR 1')).toBeTruthy();
        expect(screen.getByText('Keep going')).toBeTruthy();
        unmount();
        renderCard(withLevels(undefined));
        expect(screen.getByText('POPULAR 1')).toBeTruthy();
    });
});
