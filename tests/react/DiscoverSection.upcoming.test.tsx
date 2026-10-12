/**
 * Discover with upcoming challenges: a row that has not started says when it does and cannot be
 * joined, its photos can still be chosen, the list is read again when the soonest start arrives,
 * and a challenge that has just started stays ("starting now") until the open list shows it.
 */

import { act, render, screen, fireEvent } from './helpers/test-utils';
import { DiscoverSection } from '@/components/app/DiscoverSection';
import { mockTranslator } from './helpers/setup';
import { invalid } from '../helpers/invalid';
import { app } from '../../src/ts/translations/english';
import type { OpenChallenge } from '../../src/ts/types/gurushots';
import type { WindowApi } from '../../src/ts/types/ipc';

const NOW_MS = 1_800_000_000_000;
const NOW_SEC = NOW_MS / 1000;

const chosen = { chosenOwn: [], chosenOwnCount: 0, chosenEffectiveCount: 0 };
const open = (id: number, title: string, over: object = {}) =>
    invalid<OpenChallenge>({ id, title, type: 'default', join_coins: 0, ...chosen, ...over });
const upcoming = (id: number, title: string, startsIn: number, over: object = {}) =>
    open(id, title, { status: 'upcoming', start_time: NOW_SEC + startsIn, ...over });

type MemberChallenges = jest.MockedFunction<WindowApi['getMemberChallenges']>;
const answer = (items: OpenChallenge[]) => ({ success: true as const, items });

// The English text with its placeholders filled in, so what a user reads is what is asserted.
const english = (key: string, ...rest: unknown[]) => {
    void rest;
    return key.startsWith('app.') ? ((app as Record<string, string>)[key.slice(4)] ?? key) : key;
};

let getMemberChallenges: MemberChallenges;
let joinChallenge: jest.MockedFunction<WindowApi['joinChallenge']>;

const renderSection = (items: OpenChallenge[]) => {
    getMemberChallenges.mockResolvedValue(invalid(answer(items)));
    return render(<DiscoverSection isLoggedIn bankroll={invalid({ coins: 500 })} onJoined={jest.fn()} />);
};
const settle = () => act(async () => void (await jest.advanceTimersByTimeAsync(0)));
const advance = (ms: number) => act(async () => void (await jest.advanceTimersByTimeAsync(ms)));

beforeEach(() => {
    jest.useFakeTimers({ now: NOW_MS });
    mockTranslator.t.mockImplementation(english);
    getMemberChallenges = jest.fn();
    joinChallenge = jest.fn().mockResolvedValue({ success: true, status: 'joined' });
    window.api = invalid({ onSettingsChanged: undefined, getMemberChallenges, joinChallenge });
});

afterEach(() => {
    jest.useRealTimers();
    mockTranslator.t.mockImplementation((key) => key);
});

describe('an upcoming row', () => {
    test('says in text when the challenge starts, and that joining opens then', async () => {
        renderSection([open(1, 'Open One'), upcoming(2, 'Soon', 2 * 3600 + 15 * 60)]);
        await settle();
        expect(screen.getByText('Starts in 2h 15m — opens for joining then')).toBeTruthy();
        // An open row says nothing of the kind.
        expect(screen.getAllByText(/Starts in/)).toHaveLength(1);
    });

    test('has a disabled Join named by its challenge, and clicking does nothing', async () => {
        renderSection([open(1, 'Open One'), upcoming(2, 'Soon', 3600)]);
        await settle();
        const join = screen.getByRole<HTMLButtonElement>('button', { name: 'Join Soon — not open until it starts' });
        expect(join.disabled).toBe(true);
        expect(join.textContent).toBe(app.discoverJoin);
        fireEvent.click(join);
        expect(joinChallenge).not.toHaveBeenCalled();
        // The open row beside it still joins.
        expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Join Open One' }).disabled).toBe(false);
    });

    test('a paid one shows what it costs, opens no confirmation and spends nothing', async () => {
        renderSection([upcoming(3, 'Paid Soon', 3600, { join_coins: 250 })]);
        await settle();
        expect(screen.getByText('250 coins')).toBeTruthy();
        const join = screen.getByRole<HTMLButtonElement>('button', {
            name: 'Join Paid Soon — not open until it starts',
        });
        expect(join.disabled).toBe(true);
        fireEvent.click(join);
        expect(screen.queryByText(app.discoverConfirmTitle)).toBeNull();
        expect(joinChallenge).not.toHaveBeenCalled();
    });

    test('keeps Choose photos available', async () => {
        renderSection([upcoming(2, 'Soon', 3600)]);
        await settle();
        const choose = screen.getByRole<HTMLButtonElement>('button', { name: 'Choose photos for Soon' });
        expect(choose.disabled).toBe(false);
    });

    test('explains when chosen photos get used, once it has some', async () => {
        renderSection([
            upcoming(2, 'Plain', 3600),
            upcoming(3, 'With photos', 3600, { chosenOwn: ['a'], chosenOwnCount: 1, chosenEffectiveCount: 1 }),
        ]);
        await settle();
        expect(screen.getAllByText(app.discoverUpcomingChosenHint)).toHaveLength(1);
    });

    test('with nothing upcoming the list is exactly the open one, counted as before', async () => {
        renderSection([open(1, 'A'), open(2, 'B')]);
        await settle();
        expect(screen.getByRole('img', { name: '2 open challenges' }).textContent).toBe('2');
        expect(screen.queryByText(/Starts in|Starting now/)).toBeNull();
    });
});

describe('the count badge', () => {
    test('counts open and upcoming apart', async () => {
        renderSection([open(1, 'A'), open(2, 'B'), upcoming(3, 'C', 3600)]);
        await settle();
        const badge = screen.getByRole('img', { name: '2 open · 1 upcoming' });
        expect(badge.textContent).toBe('2 open · 1 upcoming');
    });

    test('says so when every row is upcoming', async () => {
        renderSection([upcoming(3, 'C', 3600)]);
        await settle();
        expect(screen.getByRole('img', { name: '0 open · 1 upcoming' })).toBeTruthy();
    });
});

describe('when the soonest challenge starts', () => {
    test('the list is read again then, once', async () => {
        renderSection([upcoming(2, 'Soon', 120), upcoming(3, 'Later', 7200)]);
        await settle();
        expect(getMemberChallenges).toHaveBeenCalledTimes(1);
        await advance(119 * 1000);
        expect(getMemberChallenges).toHaveBeenCalledTimes(1);
        // The server now lists it as open.
        getMemberChallenges.mockResolvedValue(invalid(answer([open(2, 'Soon'), upcoming(3, 'Later', 7080)])));
        await advance(2 * 1000);
        expect(getMemberChallenges).toHaveBeenCalledTimes(2);
        expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Join Soon' }).disabled).toBe(false);
        expect(screen.queryByText(/Starting now/)).toBeNull();
        // Nothing keeps asking: the next start is two hours off.
        await advance(5 * 60 * 1000);
        expect(getMemberChallenges).toHaveBeenCalledTimes(2);
    });

    test('a list with nothing upcoming sets no timer', async () => {
        renderSection([open(1, 'A')]);
        await settle();
        await advance(24 * 3600 * 1000);
        expect(getMemberChallenges).toHaveBeenCalledTimes(1);
    });
});

describe('a challenge that has just started but is not in the open list yet', () => {
    const lagging = () => upcoming(2, 'Soon', 30, { chosenOwn: ['a'], chosenOwnCount: 1, chosenEffectiveCount: 1 });

    test('stays as "Starting now" with its chosen photos, is asked for every minute, and is picked up once open', async () => {
        renderSection([lagging()]);
        await settle();
        // The start arrives; the server has dropped it from upcoming and not listed it as open yet.
        getMemberChallenges.mockResolvedValue(invalid(answer([])));
        await advance(32 * 1000);
        expect(getMemberChallenges).toHaveBeenCalledTimes(2);
        expect(screen.getByText('Starting now — refresh')).toBeTruthy();
        expect(screen.getByText('Soon')).toBeTruthy();
        expect(screen.getByRole('button', { name: /Chosen/ })).toBeTruthy();
        expect(screen.queryByText(app.discoverEmpty)).toBeNull();
        // Counted with the upcoming ones: it is not open yet.
        expect(screen.getByRole('img', { name: '0 open · 1 upcoming' })).toBeTruthy();

        await advance(60 * 1000);
        expect(getMemberChallenges).toHaveBeenCalledTimes(3);
        expect(screen.getByText('Starting now — refresh')).toBeTruthy();

        // Now the open list has it.
        getMemberChallenges.mockResolvedValue(invalid(answer([open(2, 'Soon', { chosenOwnCount: 1 })])));
        await advance(60 * 1000);
        expect(getMemberChallenges).toHaveBeenCalledTimes(4);
        expect(screen.queryByText('Starting now — refresh')).toBeNull();
        expect(screen.getAllByText('Soon')).toHaveLength(1);
        // And the asking stops.
        await advance(5 * 60 * 1000);
        expect(getMemberChallenges).toHaveBeenCalledTimes(4);
    });

    test('is dropped after the grace period of ten minutes, and the asking stops', async () => {
        renderSection([lagging()]);
        await settle();
        getMemberChallenges.mockResolvedValue(invalid(answer([])));
        await advance(32 * 1000);
        expect(screen.getByText('Starting now — refresh')).toBeTruthy();
        // The start was at +30 s: ten minutes on, it is gone.
        await advance(10 * 60 * 1000);
        expect(screen.queryByText('Starting now — refresh')).toBeNull();
        expect(screen.getByText(app.discoverEmpty)).toBeTruthy();
        const calls = getMemberChallenges.mock.calls.length;
        await advance(5 * 60 * 1000);
        expect(getMemberChallenges).toHaveBeenCalledTimes(calls);
    });

    test('survives a failed read in between', async () => {
        renderSection([lagging()]);
        await settle();
        getMemberChallenges.mockResolvedValue(invalid({ success: false, error: 'down', items: [] }));
        await advance(32 * 1000);
        expect(screen.getByText(app.discoverUnavailableList, { selector: 'p' })).toBeTruthy();
        getMemberChallenges.mockResolvedValue(invalid(answer([])));
        await advance(60 * 1000);
        expect(screen.getByText('Starting now — refresh')).toBeTruthy();
    });

    test('a row that merely left the list before its start is not kept', async () => {
        renderSection([upcoming(2, 'Gone', 3600)]);
        await settle();
        getMemberChallenges.mockResolvedValue(invalid(answer([])));
        await act(async () => {
            fireEvent.click(screen.getByText(app.discoverRefresh));
            await jest.advanceTimersByTimeAsync(0);
        });
        expect(screen.queryByText('Gone')).toBeNull();
        expect(screen.getByText(app.discoverEmpty)).toBeTruthy();
    });

    test('its Join is not disabled, and a live "not started" answer is shown', async () => {
        renderSection([lagging()]);
        await settle();
        getMemberChallenges.mockResolvedValue(invalid(answer([])));
        await advance(32 * 1000);
        joinChallenge.mockResolvedValue(invalid({ success: false, status: 'not-started' }));
        const join = screen.getByRole<HTMLButtonElement>('button', { name: 'Join Soon' });
        expect(join.disabled).toBe(false);
        await act(async () => {
            fireEvent.click(join);
            await jest.advanceTimersByTimeAsync(0);
        });
        expect(screen.getByText(app.discoverNotStarted)).toBeTruthy();
        // Nothing else changed: no refetch for an answer that changes nothing.
        expect(getMemberChallenges).toHaveBeenCalledTimes(2);
    });
});

test('the "Starts in" text counts down as time passes', async () => {
    renderSection([upcoming(2, 'Soon', 2 * 3600)]);
    await settle();
    expect(screen.getByText('Starts in 2h 0m — opens for joining then')).toBeTruthy();
    await advance(31 * 60 * 1000);
    expect(screen.getByText('Starts in 1h 29m — opens for joining then')).toBeTruthy();
});
