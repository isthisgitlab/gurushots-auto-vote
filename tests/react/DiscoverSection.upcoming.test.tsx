/**
 * Discover with upcoming challenges: a row that has not started says when it does and cannot be
 * joined, its photos can still be chosen, the list is read again when the soonest start arrives,
 * and a challenge that has just started stays ("starting now") until the open list shows it.
 */

import { act, render, screen, fireEvent } from './helpers/test-utils';
import { DiscoverSection } from '@/components/app/DiscoverSection';
import { mockTranslator } from './helpers/setup';
import { invalid } from '../helpers/invalid';
import { isKindBadgeText } from '../helpers/kindBadges';
import { app } from '../../src/ts/translations/english';
import { createTranslator } from '../../src/ts/translations/translator';
import type { OpenChallenge } from '../../src/ts/types/gurushots';
import type { WindowApi } from '../../src/ts/types/ipc';
import type { Translate } from '../../src/ts/translations/translator';

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
const translator = createTranslator();
const english: Translate = (key, vars) => translator.t(key, vars, 'en');

let getMemberChallenges: MemberChallenges;
let joinChallenge: jest.MockedFunction<WindowApi['joinChallenge']>;

const renderSection = (items: OpenChallenge[], timezone = 'Europe/Riga') => {
    getMemberChallenges.mockResolvedValue(invalid(answer(items)));
    return render(
        <DiscoverSection isLoggedIn bankroll={invalid({ coins: 500 })} onJoined={jest.fn()} timezone={timezone} />,
    );
};
const settle = () => act(async () => void (await jest.advanceTimersByTimeAsync(0)));
const advance = (ms: number) => act(async () => void (await jest.advanceTimersByTimeAsync(ms)));

beforeEach(() => {
    jest.useFakeTimers({ now: NOW_MS });
    mockTranslator.t.mockImplementation(english);
    getMemberChallenges = jest.fn();
    joinChallenge = jest.fn().mockResolvedValue({ success: true, status: 'joined' });
    window.api = invalid({
        onSettingsChanged: undefined,
        getMemberChallenges,
        joinChallenge,
        // The row chooser reads the row's pins; none are stored, so its pin controls stay idle.
        getEntryPins: jest.fn().mockResolvedValue({ boost: null, turbo: null }),
    });
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

    test('its Choose photos chooser offers Auto', async () => {
        renderSection([upcoming(2, 'Soon', 3600)]);
        await settle();
        fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: 'Choose photos for Soon' }));
        await settle();
        expect(screen.getByRole('dialog')).toBeTruthy();
        expect(screen.getByRole('button', { name: app.pickAuto })).toBeTruthy();
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
        expect(screen.getByRole('img', { name: 'Open challenges: 2' }).textContent).toBe('2');
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

describe('the count badge and a challenge that has just started', () => {
    test('a "starting now" row is neither open nor upcoming', async () => {
        renderSection([open(1, 'Open One'), upcoming(2, 'Later', 3600), upcoming(3, 'Soon', 30)]);
        await settle();
        expect(screen.getByRole('img', { name: '1 open · 2 upcoming' })).toBeTruthy();
        // Its start passes while the list stays as it is: it leaves the upcoming count, and joins no other.
        await advance(31 * 1000);
        getMemberChallenges.mockResolvedValue(invalid(answer([open(1, 'Open One'), upcoming(2, 'Later', 3570)])));
        await advance(2 * 1000);
        expect(screen.getByText('Soon')).toBeTruthy();
        expect(screen.getByRole('img', { name: '1 open · 1 upcoming' })).toBeTruthy();
    });

    test('with only starting-now rows left there is no badge, and no upcoming count of zero', async () => {
        renderSection([upcoming(3, 'Soon', 30)]);
        await settle();
        getMemberChallenges.mockResolvedValue(invalid(answer([])));
        await advance(32 * 1000);
        expect(screen.getByText('Soon')).toBeTruthy();
        expect(screen.queryByRole('img', { name: /open/i })).toBeNull();
    });

    test('without upcoming rows it is the open count, a starting-now row not among them', async () => {
        renderSection([open(1, 'A'), open(2, 'B'), upcoming(3, 'Soon', 30)]);
        await settle();
        getMemberChallenges.mockResolvedValue(invalid(answer([open(1, 'A'), open(2, 'B')])));
        await advance(32 * 1000);
        expect(screen.getByRole('img', { name: 'Open challenges: 2' }).textContent).toBe('2');
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
        expect(screen.getByText('Starting now — it will appear in the open list shortly')).toBeTruthy();
        expect(screen.getByText('Soon')).toBeTruthy();
        expect(screen.getByRole('button', { name: /Chosen/ })).toBeTruthy();
        expect(screen.queryByText(app.discoverEmpty)).toBeNull();
        // It is not open yet and no longer upcoming: counted as neither, so both numbers stay true.
        expect(screen.queryByRole('img', { name: /open/i })).toBeNull();

        await advance(60 * 1000);
        expect(getMemberChallenges).toHaveBeenCalledTimes(3);
        expect(screen.getByText('Starting now — it will appear in the open list shortly')).toBeTruthy();

        // Now the open list has it.
        getMemberChallenges.mockResolvedValue(invalid(answer([open(2, 'Soon', { chosenOwnCount: 1 })])));
        await advance(60 * 1000);
        expect(getMemberChallenges).toHaveBeenCalledTimes(4);
        expect(screen.queryByText('Starting now — it will appear in the open list shortly')).toBeNull();
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
        expect(screen.getByText('Starting now — it will appear in the open list shortly')).toBeTruthy();
        // The start was at +30 s: ten minutes on, it is gone.
        await advance(10 * 60 * 1000);
        expect(screen.queryByText('Starting now — it will appear in the open list shortly')).toBeNull();
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
        // The row stays, once.
        expect(screen.getAllByText('Soon')).toHaveLength(1);
        getMemberChallenges.mockResolvedValue(invalid(answer([])));
        await advance(60 * 1000);
        expect(screen.getByText('Starting now — it will appear in the open list shortly')).toBeTruthy();
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

    test('its Join stays disabled until the open list shows it, named for what is happening, and joins nothing', async () => {
        renderSection([lagging()]);
        await settle();
        getMemberChallenges.mockResolvedValue(invalid(answer([])));
        await advance(32 * 1000);
        expect(screen.queryByRole('button', { name: 'Join Soon' })).toBeNull();
        const join = screen.getByRole<HTMLButtonElement>('button', {
            name: 'Join Soon — opens for joining in a moment',
        });
        expect(join.disabled).toBe(true);
        expect(join.textContent).toBe(app.discoverJoin);
        fireEvent.click(join);
        expect(joinChallenge).not.toHaveBeenCalled();
        // The text says what is happening, and does not tell the user to refresh: the list reads itself.
        expect(screen.getByText(/^Starting now/).textContent).not.toMatch(/refresh/i);

        // Once the open list shows it, it joins.
        getMemberChallenges.mockResolvedValue(invalid(answer([open(2, 'Soon')])));
        await advance(60 * 1000);
        expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Join Soon' }).disabled).toBe(false);
    });

    test('a row whose start has passed but which the server still lists as upcoming waits the same way', async () => {
        renderSection([upcoming(2, 'Soon', 90)]);
        await settle();
        getMemberChallenges.mockResolvedValue(invalid(answer([upcoming(2, 'Soon', -5)])));
        await advance(91 * 1000);
        expect(screen.getByText('Starting now — it will appear in the open list shortly')).toBeTruthy();
        expect(
            screen.getByRole<HTMLButtonElement>('button', { name: 'Join Soon — opens for joining in a moment' })
                .disabled,
        ).toBe(true);
    });

    test('a "not started" answer from the server is worded, and changes nothing else', async () => {
        renderSection([open(1, 'Open One')]);
        await settle();
        joinChallenge.mockResolvedValue(invalid({ success: false, status: 'not-started' }));
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Join Open One' }));
            await jest.advanceTimersByTimeAsync(0);
        });
        expect(screen.getByText(app.discoverNotStarted)).toBeTruthy();
        expect(getMemberChallenges).toHaveBeenCalledTimes(1);
    });
});

test('the "Starts in" text counts down as time passes', async () => {
    renderSection([upcoming(2, 'Soon', 2 * 3600)]);
    await settle();
    expect(screen.getByText('Starts in 2h 0m — opens for joining then')).toBeTruthy();
    await advance(31 * 60 * 1000);
    expect(screen.getByText('Starts in 1h 29m — opens for joining then')).toBeTruthy();
});

describe('what a row says about its challenge: type, photos and tags', () => {
    // Kind badges (🏁 type, 🖼 photo count) are ghost like the tags; the icon tells them apart.
    const ghostTexts = () => [...document.querySelectorAll('span.badge.badge-ghost')].map((el) => el.textContent ?? '');
    const tagBadges = () => ghostTexts().filter((text) => !isKindBadgeText(text));
    const kindBadges = () => ghostTexts().filter(isKindBadgeText);

    test('every row, open and upcoming, shows its type as on the cards, and its photo count from two photos', async () => {
        renderSection([
            open(1, 'Open Flash', { type: 'flash', max_photo_submits: 3 }),
            upcoming(2, 'Soon Default', 3600, { type: 'default', max_photo_submits: 1 }),
            open(3, 'Open Two', { type: 'flash', max_photo_submits: 2 }),
        ]);
        await settle();
        expect(kindBadges()).toEqual(['🏁 FLASH', '🖼 3 photos', '🏁 FLASH', '🖼 2 photos', '🏁 DEFAULT']);
    });

    test('a challenge with no type shows its badge instead, and one with neither shows no kind badge', async () => {
        renderSection([
            open(1, 'Badge Only', { type: '', badge: 'Team match' }),
            upcoming(2, 'Nothing', 3600, { type: undefined }),
        ]);
        await settle();
        expect(kindBadges()).toEqual(['🏁 Team match']);
    });

    test('its tags show as small badges, without a repeat of the type or badge shown or a photo-count tag', async () => {
        renderSection([
            open(1, 'Tagged', { type: 'default', tags: ['Exhibition', 'Default', '3 photos', 'No comm'] }),
            upcoming(2, 'Badged', 3600, { type: '', badge: 'Team match', tags: ['team match', 'Comm', '1 Photo'] }),
        ]);
        await settle();
        expect(tagBadges()).toEqual(['Exhibition', 'No comm', 'Comm']);
        expect(document.querySelector('span.badge-ghost')?.className).toContain('badge-sm');
    });

    test.each([
        ['missing', undefined],
        ['empty', []],
        ['not a list', 'Exhibition'],
        ['an object', { 0: 'Exhibition' }],
        ['only non-text or blank entries', [7, null, '', '  ', { a: 1 }]],
    ])('tags that are %s show nothing, and the row is still there', async (_name, tags) => {
        renderSection([open(1, 'Plain', { tags }), upcoming(2, 'Soon', 3600, { tags })]);
        await settle();
        expect(tagBadges()).toEqual([]);
        expect(screen.getByText('Plain')).toBeTruthy();
        expect(screen.getByText('Soon')).toBeTruthy();
    });

    test('a type, badge or photo count of the wrong kind cannot crash the panel', async () => {
        renderSection([
            open(1, 'Odd', { type: 7, badge: { a: 1 }, max_photo_submits: 'many', tags: [1] }),
            open(2, 'Odd Two', { type: ['x'], badge: 'Fine', max_photo_submits: { n: 3 } }),
        ]);
        await settle();
        expect(screen.getByText('Odd')).toBeTruthy();
        expect(kindBadges()).toEqual(['🏁 Fine']);
    });

    test('the badge line wraps, so a row with many tags stays inside a narrow window', async () => {
        renderSection([open(1, 'Wide', { type: 'default', tags: ['One', 'Two', 'Three'] })]);
        await settle();
        const line = screen.getByText('One').parentElement!;
        expect(line.className).toContain('flex-wrap');
        // The cost sits on the same line, after the badges.
        expect(line.textContent).toContain('free');
    });
});

describe('when a row ends', () => {
    // 1700000000 = 2023-11-14 22:13 UTC.
    const CLOSE = 1_700_000_000;
    // The end texts without their separator, which has its own test.
    const endTexts = () =>
        [...document.querySelectorAll('li span')]
            .map((el) => el.textContent ?? '')
            .filter((text) => text.startsWith('· Ends'))
            .map((text) => text.slice(2));

    test('every row, open and upcoming, says when it ends, in the app timezone as the challenge cards do', async () => {
        renderSection(
            [open(1, 'Open One', { close_time: CLOSE }), upcoming(2, 'Soon', 3600, { close_time: CLOSE + 3600 })],
            'UTC',
        );
        await settle();
        expect(endTexts()).toEqual(['Ends 14/11/2023, 22:13', 'Ends 14/11/2023, 23:13']);
    });

    test('reads in the zone the setting names', async () => {
        const { unmount } = renderSection([open(1, 'Open One', { close_time: CLOSE })], 'Asia/Tokyo');
        await settle();
        expect(endTexts()).toEqual(['Ends 15/11/2023, 07:13']);
        unmount();
        renderSection([open(1, 'Open One', { close_time: CLOSE })], 'Europe/Riga');
        await settle();
        expect(endTexts()).toEqual(['Ends 15/11/2023, 00:13']);
    });

    test.each([
        ['missing', undefined],
        ['zero', 0],
        ['negative', -1],
        ['not a number', 'soon'],
        ['infinite', Infinity],
        ['null', null],
        ['beyond the dates a clock can write', 1e13],
    ])('a row whose close_time is %s says nothing about an end', async (_name, closeTime) => {
        renderSection([
            open(1, 'Open One', { close_time: closeTime }),
            upcoming(2, 'Soon', 3600, { close_time: closeTime }),
        ]);
        await settle();
        expect(endTexts()).toEqual([]);
        expect(screen.getByText('Open One')).toBeTruthy();
        expect(screen.getByText('Soon')).toBeTruthy();
    });

    test('sits on the badge line with the cost, which wraps', async () => {
        renderSection([open(1, 'Open One', { close_time: CLOSE })], 'UTC');
        await settle();
        const line = screen.getByText('Ends 14/11/2023, 22:13').parentElement!;
        expect(line.className).toContain('flex-wrap');
        expect(line.textContent).toContain('free');
    });

    test('is set apart from the cost by a separator that a screen reader skips, and a row with no end has none', async () => {
        renderSection([open(1, 'With', { close_time: CLOSE }), open(2, 'Without')], 'UTC');
        await settle();
        const rows = screen.getAllByRole('listitem');
        const dots = (row: HTMLElement) =>
            [...row.querySelectorAll('span[aria-hidden="true"]')].map((el) => el.textContent);
        expect(dots(rows[0])).toEqual(['· ']);
        // The separator is inside the end text, so it wraps with it, and comes after the cost.
        const line = screen.getByText('Ends 14/11/2023, 22:13').parentElement!;
        expect([...line.children].map((el) => el.textContent)).toEqual([
            '🏁 DEFAULT',
            'free',
            '· Ends 14/11/2023, 22:13',
        ]);
        expect(dots(rows[1])).toEqual([]);
    });
});
