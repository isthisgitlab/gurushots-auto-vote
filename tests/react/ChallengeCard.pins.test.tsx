/**
 * Pinning a photo for Boost or Turbo from the challenge card, through the real hooks and the real EntryBadge:
 * the toggles per boost/turbo state, the write and its failure text, the note for a pin that no longer
 * applies, and the compact tile's pin glyph. `t(key)` returns the key (see tests/react setup).
 */

import { render, screen, fireEvent, waitFor } from './helpers/test-utils';
import { ChallengeCard } from '@/components/app/ChallengeCard';
import { buildChallenge } from '../helpers/challengeFixtures';
import type { Challenge } from '../../src/ts/types/gurushots';
import english = require('../../src/ts/translations/english');
import latvian = require('../../src/ts/translations/latvian');

const mockChallengeSettings = {
    hasCustomSettings: false,
    autoSubmitEnabled: false,
    isCompact: false,
    hasCompactOverride: false,
    toggleCompact: jest.fn(),
};
jest.mock('@/hooks/useChallengeSettings', () => ({ useChallengeSettings: () => mockChallengeSettings }));

const nowSec = () => Math.floor(Date.now() / 1000);

const makeChallenge = (
    member: Record<string, unknown> = {},
    entries: Array<Record<string, unknown>> = [],
    overrides: Record<string, unknown> = {},
) =>
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
            boost: { state: 'AVAILABLE_KEY', timeout: 0 },
            turbo: { state: 'WON', time_to_open: null },
            ranking: {
                entries: entries.length
                    ? entries
                    : [
                          { id: 'e1', member_id: 'm', rank: 3, votes: 40 },
                          { id: 'e2', member_id: 'm', rank: 5, votes: 20 },
                      ],
                exposure: { exposure_factor: 80 },
                total: { votes: 0, rank: 0, level: 0, percent: 0, next_message: '' },
            },
            ...member,
        },
        ...overrides,
    });

const cardElement = (challenge: Challenge, settingsVersion = 0) => (
    <ChallengeCard
        challenge={challenge}
        timeRemaining="2h"
        timezone="local"
        autovoteRunning={false}
        settingsVersion={settingsVersion}
        onVoteComplete={jest.fn()}
        onSettingsClick={jest.fn()}
        onCurrencySpent={jest.fn()}
    />
);

const renderCard = (challenge: Challenge) => render(cardElement(challenge));

const pinButtons = (kind: 'Boost' | 'Turbo') =>
    screen.queryAllByRole('button', { name: new RegExp(`app\\.pin(?:ned)?For${kind}`) });

// Moves focus with no focusout or focusin reaching any listener below the window: the move's own events are swallowed.
const focusSilently = (element: HTMLElement) => {
    const swallow = (event: Event) => event.stopPropagation();
    const leaked = jest.fn();
    window.addEventListener('focusout', swallow, true);
    window.addEventListener('focusin', swallow, true);
    document.addEventListener('focusout', leaked);
    document.addEventListener('focusin', leaked);
    try {
        element.focus();
    } finally {
        window.removeEventListener('focusout', swallow, true);
        window.removeEventListener('focusin', swallow, true);
        document.removeEventListener('focusout', leaked);
        document.removeEventListener('focusin', leaked);
    }
    expect(leaked).not.toHaveBeenCalled();
};

beforeEach(() => {
    mockChallengeSettings.isCompact = false;
    window.api.getSettingsSchema = jest.fn().mockResolvedValue({ schema: {}, defaults: {} });
    window.api.getEffectiveSetting = jest.fn().mockResolvedValue(null);
    window.api.getChallengeOverride = jest.fn().mockResolvedValue(null);
    window.api.getDeadlineActions = jest.fn().mockResolvedValue({ success: true, actions: [], boostBlocked: false });
    window.api.getSwapBacks = jest.fn().mockResolvedValue({ success: true, items: [] });
    window.api.getEntryPins = jest.fn().mockResolvedValue({ boost: null, turbo: null });
    window.api.setEntryPin = jest.fn().mockResolvedValue({ success: true });
});

describe('pin toggles by boost / turbo state', () => {
    test.each([
        ['AVAILABLE', true],
        ['AVAILABLE_KEY', true],
        ['LOCKED', true],
        ['MISSED', true],
        ['USED', false],
        ['UNAVAILABLE', false],
    ])('Boost %s: toggles shown = %p', async (state, shown) => {
        renderCard(makeChallenge({ boost: { state, timeout: 0 } }));
        await waitFor(() => expect(window.api.getEntryPins).toHaveBeenCalled());
        expect(pinButtons('Boost')).toHaveLength(shown ? 2 : 0);
    });

    test.each([
        ['WON', true],
        ['FREE', true],
        ['TIMER', true],
        ['LOCKED', true],
        ['USED', false],
        ['UNAVAILABLE', false],
    ])('Turbo %s: toggles shown = %p', async (state, shown) => {
        renderCard(makeChallenge({ turbo: { state, time_to_open: null } }));
        await waitFor(() => expect(window.api.getEntryPins).toHaveBeenCalled());
        expect(pinButtons('Turbo')).toHaveLength(shown ? 2 : 0);
    });

    test('a feature already on an entry is spent: its toggles go, and the other feature’s stay off that photo', async () => {
        renderCard(
            makeChallenge({}, [
                { id: 'e1', member_id: 'm', rank: 3, votes: 40, boosted: true },
                { id: 'e2', member_id: 'm', rank: 5, votes: 20 },
            ]),
        );
        await waitFor(() => expect(window.api.getEntryPins).toHaveBeenCalled());
        expect(pinButtons('Boost')).toHaveLength(0);
        // Turbo can still fire, but not on the boosted photo.
        expect(pinButtons('Turbo')).toHaveLength(1);
    });
});

describe('pin toggles for a feature that can never fire on the challenge', () => {
    test.each([
        ['a flash challenge', { type: 'flash' }, 0, 0],
        ['a single-photo challenge', { max_photo_submits: 1 }, 0, 2],
        ['an exhibition challenge', { type: 'exhibition' }, 2, 0],
    ])('%s: Boost toggles %i, Turbo toggles %i', async (_name, overrides, boostToggles, turboToggles) => {
        renderCard(makeChallenge({}, [], overrides));
        await waitFor(() => expect(window.api.getEntryPins).toHaveBeenCalled());
        expect(pinButtons('Boost')).toHaveLength(boostToggles);
        expect(pinButtons('Turbo')).toHaveLength(turboToggles);
    });

    test('no dangling-pin note for a pin on such a feature', async () => {
        window.api.getEntryPins = jest.fn().mockResolvedValue({ boost: 'gone', turbo: null });
        renderCard(makeChallenge({}, [], { type: 'flash' }));
        await waitFor(() => expect(window.api.getEntryPins).toHaveBeenCalled());
        expect(screen.queryByText('app.pinGoneNote')).toBeNull();
    });
});

describe('pinning from the card', () => {
    const isBusy = (toggle: HTMLElement) =>
        toggle.getAttribute('aria-busy') === 'true' && toggle.getAttribute('aria-disabled') === 'true';

    test('while a write is in flight the toggles are aria-disabled and busy, ignore a press, and keep focus', async () => {
        let finish: (value: { success: true }) => void = () => {};
        window.api.setEntryPin = jest.fn(() => new Promise<{ success: true }>((resolve) => (finish = resolve)));
        renderCard(makeChallenge());
        const first = pinButtons('Boost')[0];
        first.focus();
        fireEvent.click(first);
        await waitFor(() => expect(isBusy(pinButtons('Boost')[0])).toBe(true));
        for (const toggle of [...pinButtons('Boost'), ...pinButtons('Turbo')]) {
            expect(isBusy(toggle)).toBe(true);
            // Never `disabled`: that would drop the keyboard focus to <body>.
            expect((toggle as HTMLButtonElement).disabled).toBe(false);
        }
        expect(document.activeElement).toBe(first);
        fireEvent.click(pinButtons('Boost')[1]);
        fireEvent.click(first);
        expect(window.api.setEntryPin).toHaveBeenCalledTimes(1);
        finish({ success: true });
        await waitFor(() => expect(pinButtons('Boost')[0].getAttribute('aria-busy')).toBe('false'));
        expect(pinButtons('Boost')[0].getAttribute('aria-disabled')).toBe('false');
        expect(document.activeElement).toBe(first);
    });

    test('the toggles stay busy until the pins are read back, so a second tap never acts on stale pins', async () => {
        let release: (pins: { boost: string | null; turbo: string | null }) => void = () => {};
        renderCard(makeChallenge());
        await waitFor(() => expect(window.api.getEntryPins).toHaveBeenCalledTimes(1));
        window.api.getEntryPins = jest.fn(
            () => new Promise<{ boost: string | null; turbo: string | null }>((resolve) => (release = resolve)),
        );
        fireEvent.click(pinButtons('Boost')[0]);
        // The save has returned, the read-back is still pending.
        await waitFor(() => expect(window.api.getEntryPins).toHaveBeenCalledTimes(1));
        expect(window.api.setEntryPin).toHaveBeenCalledTimes(1);
        expect(isBusy(pinButtons('Boost')[0])).toBe(true);
        fireEvent.click(pinButtons('Boost')[0]);
        expect(window.api.setEntryPin).toHaveBeenCalledTimes(1);
        release({ boost: 'e1', turbo: null });
        await waitFor(() => expect(pinButtons('Boost')[0].getAttribute('aria-pressed')).toBe('true'));
        expect(pinButtons('Boost')[0].getAttribute('aria-busy')).toBe('false');
    });

    test('pressing a toggle writes the pin for that entry, then shows it pressed', async () => {
        renderCard(makeChallenge());
        const [first] = pinButtons('Boost');
        await waitFor(() => expect(window.api.getEntryPins).toHaveBeenCalledTimes(1));
        window.api.getEntryPins = jest.fn().mockResolvedValue({ boost: 'e1', turbo: null });
        fireEvent.click(first);
        await waitFor(() => expect(window.api.setEntryPin).toHaveBeenCalledWith('boost', 101, 'e1'));
        await waitFor(() => expect(pinButtons('Boost')[0].getAttribute('aria-pressed')).toBe('true'));
        expect(pinButtons('Boost')[1].getAttribute('aria-pressed')).toBe('false');
    });

    test('pressing a pressed toggle clears the pin', async () => {
        window.api.getEntryPins = jest.fn().mockResolvedValue({ boost: null, turbo: 'e2' });
        renderCard(makeChallenge());
        await waitFor(() => expect(pinButtons('Turbo')[1].getAttribute('aria-pressed')).toBe('true'));
        fireEvent.click(pinButtons('Turbo')[1]);
        await waitFor(() => expect(window.api.setEntryPin).toHaveBeenCalledWith('turbo', 101, null));
    });

    test('a failed write says so with fixed translated text, until dismissed', async () => {
        window.api.setEntryPin = jest.fn().mockResolvedValue({ success: false, error: 'pin-write-failed' });
        renderCard(makeChallenge());
        fireEvent.click(pinButtons('Boost')[0]);
        expect(await screen.findByText('errors.pinFailed')).not.toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'errors.dismiss' }));
        expect(screen.queryByText('errors.pinFailed')).toBeNull();
    });

    test('the pin cap has its own text, and anything unlisted gets the generic failure, not the settings-file one', async () => {
        window.api.setEntryPin = jest.fn().mockResolvedValue({ success: false, error: 'pin-cap-reached' });
        renderCard(makeChallenge());
        fireEvent.click(pinButtons('Boost')[0]);
        expect(await screen.findByText('errors.pinCapReached')).not.toBeNull();
        expect(screen.queryByText('errors.pinFailed')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'errors.dismiss' }));

        window.api.setEntryPin = jest.fn().mockResolvedValue({ success: false, error: 'boom' });
        fireEvent.click(pinButtons('Boost')[0]);
        expect(await screen.findByText('errors.actionFailed')).not.toBeNull();
        expect(screen.queryByText('errors.pinFailed')).toBeNull();
    });
});

describe('a stored pin that no longer applies', () => {
    test('a photo that left the challenge gets a note with a clear button', async () => {
        window.api.getEntryPins = jest.fn().mockResolvedValue({ boost: 'gone', turbo: null });
        renderCard(makeChallenge());
        expect(await screen.findByText('app.pinGoneNote')).not.toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'app.pinClear' }));
        await waitFor(() => expect(window.api.setEntryPin).toHaveBeenCalledWith('boost', 101, null));
    });

    test('while a pin write is in flight Clear is aria-disabled and busy, does nothing, and keeps focus', async () => {
        let finish: (value: { success: true }) => void = () => {};
        window.api.setEntryPin = jest.fn(() => new Promise<{ success: true }>((resolve) => (finish = resolve)));
        window.api.getEntryPins = jest.fn().mockResolvedValue({ boost: 'gone', turbo: null });
        renderCard(makeChallenge());
        const clear = await screen.findByRole('button', { name: 'app.pinClear' });
        clear.focus();
        expect(clear.getAttribute('aria-busy')).toBe('false');
        fireEvent.click(clear);
        await waitFor(() => expect(clear.getAttribute('aria-busy')).toBe('true'));
        expect(clear.getAttribute('aria-disabled')).toBe('true');
        // Never `disabled`: that would drop the keyboard focus to <body>.
        expect((clear as HTMLButtonElement).disabled).toBe(false);
        fireEvent.click(clear);
        expect(window.api.setEntryPin).toHaveBeenCalledTimes(1);
        expect(document.activeElement).toBe(clear);
        finish({ success: true });
        await waitFor(() => expect(clear.getAttribute('aria-busy')).toBe('false'));
    });

    test('a clear that removes the note moves focus to the entry details; a failed clear leaves it on the button', async () => {
        window.api.getEntryPins = jest
            .fn()
            .mockResolvedValueOnce({ boost: 'gone', turbo: null })
            .mockResolvedValue({ boost: null, turbo: null });
        window.api.setEntryPin = jest
            .fn()
            .mockResolvedValueOnce({ success: false, error: 'pin-write-failed' })
            .mockResolvedValue({ success: true });
        renderCard(makeChallenge());
        const clear = await screen.findByRole('button', { name: 'app.pinClear' });
        const details = screen.getByText('app.entryDetails').parentElement!.parentElement!;
        expect(details.getAttribute('tabindex')).toBe('-1');

        clear.focus();
        fireEvent.click(clear);
        await waitFor(() => expect(window.api.setEntryPin).toHaveBeenCalledTimes(1));
        await screen.findByText('errors.pinFailed');
        expect(clear.isConnected).toBe(true);
        expect(document.activeElement).toBe(clear);

        fireEvent.click(clear);
        await waitFor(() => expect(screen.queryByText('app.pinGoneNote')).toBeNull());
        await waitFor(() => expect(document.activeElement).toBe(details));
    });

    test('the entry details are a group named exactly "Entry details", labelled by a plain label', async () => {
        renderCard(makeChallenge());
        const group = await screen.findByRole('group', { name: 'app.entryDetails' });
        const label = screen.getByText('app.entryDetails');
        expect(group).toBe(label.parentElement!.parentElement);
        expect(group.getAttribute('aria-labelledby')).toBe(label.id);
        expect(label.id).not.toBe('');
        expect(label.textContent).toBe('app.entryDetails');
    });

    // The clear's own read still returns the pin, so the note outlives the write; a later read (a settings-changed
    // broadcast bumps settingsVersion) is what removes it.
    const clearThenUnmountOnLaterRead = async () => {
        window.api.getEntryPins = jest
            .fn()
            .mockResolvedValueOnce({ boost: 'gone', turbo: null })
            .mockResolvedValueOnce({ boost: 'gone', turbo: null })
            .mockResolvedValue({ boost: null, turbo: null });
        const challenge = makeChallenge();
        const view = renderCard(challenge);
        const clear = await screen.findByRole('button', { name: 'app.pinClear' });
        clear.focus();
        fireEvent.click(clear);
        await waitFor(() => expect(window.api.getEntryPins).toHaveBeenCalledTimes(2));
        await waitFor(() => expect(clear.getAttribute('aria-busy')).toBe('false'));
        expect(clear.isConnected).toBe(true);
        expect(document.activeElement).toBe(clear);
        const details = screen.getByRole('group', { name: 'app.entryDetails' });
        const unmountNote = () => view.rerender(cardElement(challenge, 1));
        return { details, unmountNote };
    };

    test('a note that unmounts on a read after the clear resolved still hands focus to the entry details, without scrolling', async () => {
        const { details, unmountNote } = await clearThenUnmountOnLaterRead();
        const focus = jest.spyOn(details, 'focus');
        unmountNote();
        await waitFor(() => expect(screen.queryByText('app.pinGoneNote')).toBeNull());
        await waitFor(() => expect(document.activeElement).toBe(details));
        expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    });

    test('focus the user moved elsewhere before the note unmounts is not stolen', async () => {
        const { details, unmountNote } = await clearThenUnmountOnLaterRead();
        const focus = jest.spyOn(details, 'focus');
        const elsewhere = pinButtons('Turbo')[0];
        elsewhere.focus();
        expect(document.activeElement).toBe(elsewhere);
        unmountNote();
        await waitFor(() => expect(screen.queryByText('app.pinGoneNote')).toBeNull());
        expect(document.activeElement).toBe(elsewhere);
        expect(focus).not.toHaveBeenCalled();
    });

    test('after a failed clear, focus that moved to <body> is not pulled back when the note unmounts later', async () => {
        window.api.getEntryPins = jest
            .fn()
            .mockResolvedValueOnce({ boost: 'gone', turbo: null })
            .mockResolvedValue({ boost: null, turbo: null });
        window.api.setEntryPin = jest.fn().mockResolvedValue({ success: false, error: 'pin-write-failed' });
        const challenge = makeChallenge();
        const view = renderCard(challenge);
        const clear = await screen.findByRole('button', { name: 'app.pinClear' });
        const details = screen.getByRole('group', { name: 'app.entryDetails' });
        const focus = jest.spyOn(details, 'focus');
        clear.focus();
        fireEvent.click(clear);
        await screen.findByText('errors.pinFailed');
        expect(clear.isConnected).toBe(true);

        // E.g. a click on empty space: nothing else takes focus.
        clear.blur();
        expect(document.activeElement).toBe(document.body);

        view.rerender(cardElement(challenge, 1));
        await waitFor(() => expect(screen.queryByText('app.pinGoneNote')).toBeNull());
        expect(document.activeElement).toBe(document.body);
        expect(focus).not.toHaveBeenCalled();
    });

    test('a click that leaves focus on another element (engines that do not focus a button on click) does not move it when the note unmounts', async () => {
        window.api.getEntryPins = jest
            .fn()
            .mockResolvedValueOnce({ boost: 'gone', turbo: null })
            .mockResolvedValue({ boost: null, turbo: null });
        renderCard(makeChallenge());
        const clear = await screen.findByRole('button', { name: 'app.pinClear' });
        const elsewhere = pinButtons('Turbo')[0];
        elsewhere.focus();
        fireEvent.click(clear);
        await waitFor(() => expect(screen.queryByText('app.pinGoneNote')).toBeNull());
        expect(document.activeElement).toBe(elsewhere);
    });

    test('a focusout fired by the button’s own removal still hands focus to the entry details', async () => {
        const { details, unmountNote } = await clearThenUnmountOnLaterRead();
        const clear = screen.getByRole('button', { name: 'app.pinClear' });
        // Some engines fire focusout on a focused node as it is removed: the note's removal (preact calls
        // `remove()` on the note's root) fires one from the button first, within the very update that removes it.
        const note = clear.closest('[role="group"] > *') as HTMLElement;
        const removeNote = note.remove.bind(note);
        let removeRan = false;
        note.remove = () => {
            removeRan = true;
            // Focus leaves the button first (blur() fires its focusout, <body> active), so a forget that ran
            // synchronously here — the button still connected — would wipe the record and lose the hand-off.
            clear.blur();
            removeNote();
        };
        unmountNote();
        await waitFor(() => expect(screen.queryByText('app.pinGoneNote')).toBeNull());
        expect(removeRan).toBe(true);
        expect(document.activeElement).toBe(details);
    });

    test('the window losing focus (a focusout while the button keeps focus) does not forget the clear', async () => {
        const { details, unmountNote } = await clearThenUnmountOnLaterRead();
        const clear = screen.getByRole('button', { name: 'app.pinClear' });
        clear.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
        await Promise.resolve();
        expect(document.activeElement).toBe(clear);
        // The window regains focus: the browser fires focusin on the button that still holds it, which keeps the record.
        clear.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        unmountNote();
        await waitFor(() => expect(screen.queryByText('app.pinGoneNote')).toBeNull());
        expect(document.activeElement).toBe(details);
    });

    test('focus that moved without a focusout from the button (a dialog focusing while the window is unfocused) is not pulled back', async () => {
        const { details, unmountNote } = await clearThenUnmountOnLaterRead();
        const clear = screen.getByRole('button', { name: 'app.pinClear' });
        const focus = jest.spyOn(details, 'focus');
        // The window loses focus: the focusout reaches the listener, the button keeps its record.
        clear.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
        await Promise.resolve();
        // Focus then moves with no focusout or focusin reaching the listener.
        const elsewhere = pinButtons('Turbo')[0];
        focusSilently(elsewhere);
        expect(document.activeElement).toBe(elsewhere);
        unmountNote();
        await waitFor(() => expect(screen.queryByText('app.pinGoneNote')).toBeNull());
        expect(document.activeElement).toBe(elsewhere);
        expect(focus).not.toHaveBeenCalled();
    });

    test('a silent focus move is forgotten when the focusin reaches its element, so a later move to <body> is not pulled back', async () => {
        const { details, unmountNote } = await clearThenUnmountOnLaterRead();
        const clear = screen.getByRole('button', { name: 'app.pinClear' });
        const focus = jest.spyOn(details, 'focus');
        clear.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
        await Promise.resolve();
        const elsewhere = pinButtons('Turbo')[0];
        focusSilently(elsewhere);
        // The window regains focus: the browser fires focusin on the element that already holds it.
        elsewhere.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        // The user then lands on <body> (the record, if kept, would claim it).
        elsewhere.blur();
        expect(document.activeElement).toBe(document.body);
        unmountNote();
        await waitFor(() => expect(screen.queryByText('app.pinGoneNote')).toBeNull());
        expect(document.activeElement).toBe(document.body);
        expect(focus).not.toHaveBeenCalled();
    });

    test('a removed button still reported as the active element (focus lost with it) hands focus to the entry details', async () => {
        const { details, unmountNote } = await clearThenUnmountOnLaterRead();
        const clear = screen.getByRole('button', { name: 'app.pinClear' });
        // happy-dom never leaves a disconnected element as activeElement: report it, as an engine that does would.
        const active = jest.spyOn(document, 'activeElement', 'get').mockReturnValue(clear);
        try {
            // The note unmounts once the re-keyed read resolves: the stub must stay live until the layout effect
            // has seen the button disconnected, so only `!active.isConnected` can report the focus as lost.
            unmountNote();
            await waitFor(() => expect(screen.queryByText('app.pinGoneNote')).toBeNull());
            expect(clear.isConnected).toBe(false);
        } finally {
            active.mockRestore();
        }
        expect(document.activeElement).toBe(details);
    });

    test('a blur microtask left over from one clear does not forget a newer clear', async () => {
        window.api.getEntryPins = jest
            .fn()
            .mockResolvedValueOnce({ boost: 'gone', turbo: 'gone' })
            .mockResolvedValueOnce({ boost: 'gone', turbo: 'gone' })
            .mockResolvedValueOnce({ boost: 'gone', turbo: 'gone' })
            .mockResolvedValue({ boost: null, turbo: null });
        const challenge = makeChallenge();
        const view = renderCard(challenge);
        const clears = await screen.findAllByRole('button', { name: 'app.pinClear' });
        expect(clears).toHaveLength(2);
        const details = screen.getByRole('group', { name: 'app.entryDetails' });
        clears[0].focus();
        fireEvent.click(clears[0]);
        await waitFor(() => expect(window.api.getEntryPins).toHaveBeenCalledTimes(2));
        await waitFor(() => expect(clears[0].getAttribute('aria-busy')).toBe('false'));
        // Moving focus fires the first button's focusout (its forget-microtask is queued while it is still the
        // recorded one), and the second click records the second button before that microtask runs. That is a
        // race only script can produce (focus() and click() in one task): a microtask checkpoint follows every
        // listener the browser dispatches, so there the microtask runs before any later click handler. The same
        // focus() also fires a focusin on the second button, which already clears the first record before the
        // click, so the test still pins the microtask's newer-record guard (the second click's record survives).
        clears[1].focus();
        fireEvent.click(clears[1]);
        await waitFor(() => expect(window.api.getEntryPins).toHaveBeenCalledTimes(3));
        await waitFor(() => expect(clears[1].getAttribute('aria-busy')).toBe('false'));
        expect(document.activeElement).toBe(clears[1]);

        view.rerender(cardElement(challenge, 1));
        await waitFor(() => expect(screen.queryByText('app.pinGoneNote')).toBeNull());
        expect(document.activeElement).toBe(details);
    });

    test('a photo that carries the other feature gets the conflict note', async () => {
        window.api.getEntryPins = jest.fn().mockResolvedValue({ boost: null, turbo: 'e1' });
        renderCard(
            makeChallenge({}, [
                { id: 'e1', member_id: 'm', rank: 3, votes: 40, boosted: true },
                { id: 'e2', member_id: 'm', rank: 5, votes: 20 },
            ]),
        );
        expect(await screen.findByText('app.pinConflictNote')).not.toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'app.pinClear' }));
        await waitFor(() => expect(window.api.setEntryPin).toHaveBeenCalledWith('turbo', 101, null));
    });

    test('no note once the feature is spent, or while the pin is usable', async () => {
        window.api.getEntryPins = jest.fn().mockResolvedValue({ boost: 'gone', turbo: 'e2' });
        renderCard(makeChallenge({ boost: { state: 'USED', timeout: 0 } }));
        await waitFor(() => expect(window.api.getEntryPins).toHaveBeenCalled());
        expect(screen.queryByText('app.pinGoneNote')).toBeNull();
        expect(screen.queryByText('app.pinConflictNote')).toBeNull();
    });
});

describe('the compact tile', () => {
    beforeEach(() => {
        mockChallengeSettings.isCompact = true;
    });

    test.each([
        ['boost', '🚀📌', 'app.pinnedForBoost'],
        ['turbo', '⚡📌', 'app.pinnedForTurbo'],
    ] as const)('marks the entry pinned for %s with a glyph and screen-reader text', async (kind, glyph, text) => {
        window.api.getEntryPins = jest.fn().mockResolvedValue({ boost: null, turbo: null, [kind]: 'e2' });
        renderCard(makeChallenge());
        expect(await screen.findByText(text)).not.toBeNull();
        expect(screen.getByText(glyph)).not.toBeNull();
        expect(screen.getByText(text).className).toContain('sr-only');
    });

    test('shows no pin mark without a pin, or once the pinned feature is spent', async () => {
        renderCard(makeChallenge());
        await waitFor(() => expect(window.api.getEntryPins).toHaveBeenCalled());
        expect(screen.queryByText('app.pinnedForBoost')).toBeNull();
    });

    test('a spent feature’s pin shows nothing', async () => {
        window.api.getEntryPins = jest.fn().mockResolvedValue({ boost: 'e1', turbo: null });
        renderCard(makeChallenge({ boost: { state: 'USED', timeout: 0 } }));
        await waitFor(() => expect(window.api.getEntryPins).toHaveBeenCalled());
        expect(screen.queryByText('app.pinnedForBoost')).toBeNull();
    });

    test.each([
        ['a photo that left the challenge', { boost: 'gone', turbo: null }, {}, 'app.pinNotApplying'],
        [
            'a photo that carries the other feature',
            { boost: null, turbo: 'e1' },
            { boosted: true },
            'app.pinNotApplying',
        ],
    ])('%s gets one muted pin mark with its text', async (_name, pins, flags, text) => {
        window.api.getEntryPins = jest.fn().mockResolvedValue(pins);
        renderCard(
            makeChallenge({}, [
                { id: 'e1', member_id: 'm', rank: 3, votes: 40, ...flags },
                { id: 'e2', member_id: 'm', rank: 5, votes: 20 },
            ]),
        );
        const hidden = await screen.findByText(text);
        expect(hidden.className).toContain('sr-only');
        const mark = hidden.parentElement!;
        expect(mark.getAttribute('title')).toBe(text);
        expect(mark.className).toContain('text-base-content/60');
        // The short reason is visible text (a title is invisible on touch), hidden from screen readers.
        const visible = screen.getByText('📌 app.pinNotApplyingShort');
        expect(visible.getAttribute('aria-hidden')).toBe('true');
        expect(mark.contains(visible)).toBe(true);
    });

    test('both features not applying read as one mark and one sentence, naming them once', async () => {
        window.api.getEntryPins = jest.fn().mockResolvedValue({ boost: 'gone', turbo: 'also-gone' });
        renderCard(makeChallenge());
        const hidden = await screen.findAllByText('app.pinNotApplyingBoth');
        expect(hidden).toHaveLength(1);
        expect(hidden[0].className).toContain('sr-only');
        const mark = hidden[0].parentElement!;
        expect(mark.getAttribute('title')).toBe('app.pinNotApplyingBoth');
        expect(screen.getAllByText('📌 app.pinNotApplyingShortBoth')).toHaveLength(1);
        expect(screen.queryByText('app.pinNotApplying')).toBeNull();
        expect(screen.queryByText('📌 app.pinNotApplyingShort')).toBeNull();
    });

    test('the tile’s strings carry the placeholders it fills in, in both languages', () => {
        for (const { app } of [english, latvian]) {
            expect(app.pinNotApplying).toContain('{kind}');
            expect(app.pinNotApplyingShort).toContain('{kind}');
            for (const text of [app.pinNotApplyingBoth, app.pinNotApplyingShortBoth]) {
                expect(text).toContain('{boost}');
                expect(text).toContain('{turbo}');
            }
        }
    });

    test('no mark for a usable pin, no pin, a spent feature or a feature that never fires', async () => {
        window.api.getEntryPins = jest.fn().mockResolvedValue({ boost: 'e1', turbo: null });
        renderCard(makeChallenge());
        await waitFor(() => expect(window.api.getEntryPins).toHaveBeenCalled());
        expect(screen.queryByText('app.pinNotApplying')).toBeNull();
        expect(screen.queryByText('📌 app.pinNotApplyingShort')).toBeNull();
    });

    test.each([
        ['spent', makeChallenge({ boost: { state: 'USED', timeout: 0 } })],
        ['never fires', makeChallenge({}, [], { type: 'flash' })],
    ])('no mark for a stored pin whose feature is %s', async (_name, challenge) => {
        window.api.getEntryPins = jest.fn().mockResolvedValue({ boost: 'gone', turbo: null });
        renderCard(challenge);
        await waitFor(() => expect(window.api.getEntryPins).toHaveBeenCalled());
        expect(screen.queryByText('app.pinNotApplying')).toBeNull();
        expect(screen.queryByText('📌 app.pinNotApplyingShort')).toBeNull();
    });

    test('has no toggles: pinning stays in the detailed card', async () => {
        renderCard(makeChallenge());
        await waitFor(() => expect(window.api.getEntryPins).toHaveBeenCalled());
        expect(pinButtons('Boost')).toHaveLength(0);
    });
});
