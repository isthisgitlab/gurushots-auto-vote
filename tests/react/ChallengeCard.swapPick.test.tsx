/**
 * The chosen swap on the full ChallengeCard: the entry's Swap button hands over to the card-level swap picker
 * (the library picker for the one photo that takes the entry's place), then a confirm for that photo. The flow
 * is owned by the card, so it survives the Swap button going away mid-browse; a refusal shows once, in the
 * picker; focus returns to the Swap button when the flow ends. Translations are the real English strings.
 */

import { render, screen, fireEvent, waitFor, within } from './helpers/test-utils';
import { ChallengeCard } from '@/components/app/ChallengeCard';
import { buildChallenge } from '../helpers/challengeFixtures';
import { rememberCurrentMember } from '@/api/useChosenPhotosOwner';
import { mockTranslator } from './helpers/setup';
import { app, errors } from '../../src/ts/translations/english';
import type { Bankroll } from '../../src/ts/types/gurushots';
import type { WindowApi } from '../../src/ts/types/ipc';

const mockChallengeSettings = {
    hasCustomSettings: false,
    autoSubmitEnabled: false,
    isCompact: false,
    hasCompactOverride: false,
    toggleCompact: jest.fn(),
};

jest.mock('@/hooks/useChallengeSettings', () => ({
    useChallengeSettings: () => mockChallengeSettings,
}));
jest.mock('@/api/useTurbo', () => ({
    useTurbo: () => ({
        playAutoTurbo: jest.fn(),
        applyTurbo: jest.fn(),
        loading: false,
        error: null,
        clearError: jest.fn(),
    }),
}));
jest.mock('@/api/useFillChallenge', () => ({
    useFillChallenge: () => ({ fillNow: jest.fn(), loading: false, error: null, clearError: jest.fn() }),
}));
jest.mock('@/components/app/VoteButton', () => ({ VoteButton: () => null }));
jest.mock('@/components/app/RunButton', () => ({ RunButton: () => null }));

type Listing = Extract<Awaited<ReturnType<WindowApi['getLibraryPhotos']>>, { success: true }>;

const MEMBER = 'b'.repeat(32);
const ENTRY_ID = 'a'.repeat(32);
const PICK_ID = 'c'.repeat(32);
const OTHER_ID = 'd'.repeat(32);
const SUGGESTED = { id: 'e'.repeat(32), member_id: MEMBER };

const FULL: Bankroll = { keys: 0, swaps: 2, fills: 0, coins: 0 };

const english = (key: string) => {
    const [group, name] = key.split('.');
    const table = (group === 'errors' ? errors : app) as Record<string, string>;
    return table[name] ?? key;
};

const makeChallenge = () => {
    const nowSec = Math.floor(Date.now() / 1000);
    return buildChallenge({
        id: 101,
        title: 'Sunset',
        url: 'sunset',
        type: undefined,
        max_photo_submits: 1,
        start_time: nowSec - 3600,
        close_time: nowSec + 3600,
        entries: 100,
        players: 50,
        votes: 2000,
        prizes_worth: '$100',
        tags: [],
        welcome_message: '',
        swap_enable: true,
        swap_locked: false,
        member: {
            boost: { state: 'UNAVAILABLE', timeout: null },
            turbo: { state: 'UNAVAILABLE', time_to_open: null },
            ranking: {
                entries: [{ id: ENTRY_ID, member_id: MEMBER, rank: 1, votes: 3 }],
                exposure: { exposure_factor: 100 },
                total: { votes: 0, rank: 0, level: 0, percent: 0, next_message: '' },
            },
        },
    });
};

const library = (): Listing => ({
    success: true,
    photos: [
        { id: ENTRY_ID, labels: ['entered'], allowed: true, message: null, uploadDate: 3 },
        { id: PICK_ID, labels: ['chosen'], allowed: true, message: null, uploadDate: 2 },
        { id: OTHER_ID, labels: ['other'], allowed: true, message: null, uploadDate: 1 },
    ],
    memberId: MEMBER,
    truncated: false,
    wonIds: [],
    wonCount: 0,
    preview: false,
    readAtMs: 1_700_000_000_000,
    allowedKnown: true,
});

const challenge = makeChallenge();
const onCurrencySpent = jest.fn();

const cardFor = (bankroll: Bankroll) => (
    <ChallengeCard
        challenge={challenge}
        timeRemaining="2h"
        timezone="local"
        autovoteRunning={false}
        onVoteComplete={jest.fn()}
        onSettingsClick={jest.fn()}
        bankroll={bankroll}
        onCurrencySpent={onCurrencySpent}
    />
);

const renderCard = (bankroll: Bankroll = FULL) => {
    const utils = render(cardFor(bankroll));
    return { ...utils, setBankroll: (next: Bankroll) => utils.rerender(cardFor(next)) };
};

const swapButton = () => screen.getByRole('button', { name: /^🔄 Swap$/ });
const tile = (id: string) => screen.getByRole('button', { name: new RegExp(`^Photo ${id.slice(0, 8)}:`) });
const pickerTitle = () => screen.queryByText('Choose the photo to swap in');
const suggestionTitle = () => screen.queryByText('Swap this photo?');

// Swap → the suggestion's confirm → Choose another photo… → the picker, read and unlocked.
const openPicker = async () => {
    fireEvent.click(swapButton());
    fireEvent.click(await screen.findByRole('button', { name: 'Choose another photo…' }));
    await screen.findByText('Choose the photo to swap in');
    await waitFor(() => expect(tile(PICK_ID).textContent).toContain('Can be entered'));
};

const useThisPhoto = () => screen.getByRole('button', { name: /^Use this photo/ });

beforeEach(() => {
    mockTranslator.t.mockImplementation(english);
    rememberCurrentMember(null);
    onCurrencySpent.mockClear();
    window.api.getLibraryPhotos = jest.fn().mockResolvedValue(library());
    window.api.previewSwapPhoto = jest.fn(
        async (_challengeId: string | number, _imageId: string | number, chosenId?: string | number | null) => ({
            success: true as const,
            outcome: 'ok' as const,
            candidate: chosenId ? { id: String(chosenId), member_id: MEMBER } : SUGGESTED,
        }),
    );
    window.api.swapEntryPhoto = jest.fn().mockResolvedValue({ success: true, outcome: 'ok' });
});

afterEach(() => {
    mockTranslator.t.mockImplementation((key) => key);
});

describe('choosing the replacement', () => {
    test('Choose another photo… closes the suggestion and opens the picker; entered photos are blocked', async () => {
        renderCard();
        await openPicker();
        expect(suggestionTitle()).toBeNull();
        expect(window.api.previewSwapPhoto).toHaveBeenCalledTimes(1);
        expect(window.api.getLibraryPhotos).toHaveBeenCalledWith(101, undefined, 'cached');
        expect(screen.getByText('Picked: 0/1')).toBeTruthy();
        expect(tile(ENTRY_ID).textContent).toContain('Already in this challenge');
        expect(tile(ENTRY_ID).getAttribute('aria-disabled')).toBe('true');
        fireEvent.click(tile(ENTRY_ID));
        expect(useThisPhoto().hasAttribute('disabled')).toBe(true);
        expect(tile(OTHER_ID).getAttribute('aria-disabled')).toBe('false');
    });

    test('a pick is previewed as chosen, confirmed as "Your pick", and that exact photo is spent', async () => {
        renderCard();
        await openPicker();
        fireEvent.click(tile(PICK_ID));
        fireEvent.click(useThisPhoto());
        expect(await screen.findByText('Swap this photo?')).toBeTruthy();
        expect(window.api.previewSwapPhoto).toHaveBeenLastCalledWith(101, ENTRY_ID, PICK_ID);
        expect(pickerTitle()).toBeNull();
        expect(screen.getByAltText('Your pick')).toBeTruthy();
        expect(screen.getByText(app.currencySwapChosenBody)).toBeTruthy();
        expect(window.api.swapEntryPhoto).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole('button', { name: /^Spend 1 swap/ }));
        await waitFor(() => expect(onCurrencySpent).toHaveBeenCalledTimes(1));
        expect(window.api.swapEntryPhoto).toHaveBeenCalledWith(101, ENTRY_ID, PICK_ID, true);
        await waitFor(() => expect(suggestionTitle()).toBeNull());
        await waitFor(() => expect(document.activeElement === swapButton()).toBe(true));
    });

    test('the confirm repeats the boost / turbo warning the suggestion showed', async () => {
        const boosted = makeChallenge();
        boosted.member!.ranking!.entries![0].boosted = true;
        render(
            <ChallengeCard
                challenge={boosted}
                timeRemaining="2h"
                timezone="local"
                autovoteRunning={false}
                onVoteComplete={jest.fn()}
                onSettingsClick={jest.fn()}
                bankroll={FULL}
                onCurrencySpent={onCurrencySpent}
            />,
        );
        await openPicker();
        fireEvent.click(tile(PICK_ID));
        fireEvent.click(useThisPhoto());
        expect(await screen.findByText(app.currencySwapBoostedWarning)).toBeTruthy();
    });

    test('no suggestion: the picker opens with the reason, with no error under the button', async () => {
        window.api.previewSwapPhoto = jest
            .fn()
            .mockResolvedValue({ success: false, outcome: 'no-alternative', error: 'no-alternative' });
        renderCard();
        fireEvent.click(swapButton());
        await screen.findByText('Choose the photo to swap in');
        expect(suggestionTitle()).toBeNull();
        const notice = screen.getByText(app.swapPickNoSuggestion);
        expect(notice.closest('.alert-info')).toBeTruthy();
        expect(swapButton().className).not.toContain('btn-error');
        expect(screen.getAllByText(app.swapPickNoSuggestion)).toHaveLength(1);
        expect(screen.queryByText(app.currencyOutcomeNoAlternative)).toBeNull();
    });
});

describe('a refused pick or spend', () => {
    test('a preview that succeeds without a photo leaves the picker open', async () => {
        renderCard();
        await openPicker();
        window.api.previewSwapPhoto = jest.fn().mockResolvedValue({ success: true, outcome: 'ok' });
        fireEvent.click(tile(PICK_ID));
        fireEvent.click(useThisPhoto());
        await waitFor(() => expect(window.api.previewSwapPhoto).toHaveBeenCalledTimes(1));
        expect(pickerTitle()).toBeTruthy();
        expect(suggestionTitle()).toBeNull();
        expect(onCurrencySpent).not.toHaveBeenCalled();
    });

    test('a refused pick shows its reason once, in the picker, which stays open with the pick', async () => {
        renderCard();
        await openPicker();
        window.api.previewSwapPhoto = jest
            .fn()
            .mockResolvedValue({ success: false, outcome: 'already-entered', error: 'already-entered' });
        fireEvent.click(tile(PICK_ID));
        fireEvent.click(useThisPhoto());
        const alert = await screen.findByRole('alert');
        expect(alert.textContent).toBe(app.currencyOutcomeAlreadyEntered);
        expect(screen.getAllByText(app.currencyOutcomeAlreadyEntered)).toHaveLength(1);
        expect(pickerTitle()).toBeTruthy();
        expect(suggestionTitle()).toBeNull();
        expect(tile(PICK_ID).getAttribute('aria-pressed')).toBe('true');
        // The Swap button under the card carries no error of its own.
        expect(swapButton().className).not.toContain('btn-error');
    });

    test('a spend the server turned down goes back to the picker with its reason; a new pick confirms again', async () => {
        window.api.swapEntryPhoto = jest
            .fn()
            .mockResolvedValueOnce({ success: false, outcome: 'stale-candidate', error: 'stale-candidate' })
            .mockResolvedValue({ success: true, outcome: 'ok' });
        renderCard();
        await openPicker();
        fireEvent.click(tile(PICK_ID));
        fireEvent.click(useThisPhoto());
        fireEvent.click(await screen.findByRole('button', { name: /^Spend 1 swap/ }));
        // The preview was used up by the attempt: the picker reopens, saying why, instead of a Spend that cannot work.
        await screen.findByText('Choose the photo to swap in');
        const alert = await screen.findByRole('alert');
        expect(alert.textContent).toBe(app.currencyOutcomeStaleCandidate);
        expect(screen.getAllByText(app.currencyOutcomeStaleCandidate)).toHaveLength(1);
        expect(screen.queryByText(app.currencySwapChosenBody)).toBeNull();
        expect(onCurrencySpent).not.toHaveBeenCalled();

        await waitFor(() => expect(tile(OTHER_ID).textContent).toContain('Can be entered'));
        fireEvent.click(tile(OTHER_ID));
        fireEvent.click(useThisPhoto());
        expect(await screen.findByText(app.currencySwapChosenBody)).toBeTruthy();
        expect(window.api.previewSwapPhoto).toHaveBeenLastCalledWith(101, ENTRY_ID, OTHER_ID);
        expect(screen.queryByRole('alert')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: /^Spend 1 swap/ }));
        await waitFor(() => expect(onCurrencySpent).toHaveBeenCalledTimes(1));
        expect(window.api.swapEntryPhoto).toHaveBeenLastCalledWith(101, ENTRY_ID, OTHER_ID, true);
    });

    test('a preview that says the entry is gone keeps the picker open with its alert and refreshes the card behind it', async () => {
        renderCard();
        await openPicker();
        window.api.previewSwapPhoto = jest
            .fn()
            .mockResolvedValue({ success: false, outcome: 'not-available', error: 'not-available' });
        fireEvent.click(tile(PICK_ID));
        fireEvent.click(useThisPhoto());
        expect((await screen.findByRole('alert')).textContent).toBe(app.currencyOutcomeNotAvailable);
        await waitFor(() => expect(onCurrencySpent).toHaveBeenCalledTimes(1));
        expect(pickerTitle()).not.toBeNull();
        expect(suggestionTitle()).toBeNull();
        expect(window.api.swapEntryPhoto).not.toHaveBeenCalled();
    });

    test('cancelling after a refused spend ends the flow, and a fresh one starts clean', async () => {
        window.api.swapEntryPhoto = jest
            .fn()
            .mockResolvedValue({ success: false, outcome: 'api-failed', error: 'api-failed' });
        renderCard();
        await openPicker();
        fireEvent.click(tile(PICK_ID));
        fireEvent.click(useThisPhoto());
        fireEvent.click(await screen.findByRole('button', { name: /^Spend 1 swap/ }));
        expect((await screen.findByRole('alert')).textContent).toBe(app.currencyOutcomeFailed);
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(pickerTitle()).toBeNull());
        await waitFor(() => expect(document.activeElement === swapButton()).toBe(true));
        fireEvent.click(swapButton());
        fireEvent.click(await screen.findByRole('button', { name: 'Choose another photo…' }));
        await screen.findByText('Choose the photo to swap in');
        expect(screen.queryByRole('alert')).toBeNull();
    });

    test('Cancel on the confirm ends the flow without spending; focus returns to Swap', async () => {
        renderCard();
        await openPicker();
        fireEvent.click(tile(PICK_ID));
        fireEvent.click(useThisPhoto());
        await screen.findByText(app.currencySwapChosenBody);
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(suggestionTitle()).toBeNull());
        expect(pickerTitle()).toBeNull();
        expect(window.api.swapEntryPhoto).not.toHaveBeenCalled();
        await waitFor(() => expect(document.activeElement === swapButton()).toBe(true));
    });

    test.each([
        ['unclear', app.currencyOutcomeUnclear],
        ['no-balance', app.currencyOutcomeNoBalance],
    ])(
        'a %s spend keeps the confirm open with Spend off; closing it ends the flow and refreshes',
        async (outcome, text) => {
            window.api.swapEntryPhoto = jest.fn().mockResolvedValue({ success: false, outcome, error: outcome });
            renderCard();
            await openPicker();
            fireEvent.click(tile(PICK_ID));
            fireEvent.click(useThisPhoto());
            fireEvent.click(await screen.findByRole('button', { name: /^Spend 1 swap/ }));
            const alert = await screen.findByRole('alert');
            expect(alert.textContent).toBe(text);
            expect(alert.className).toContain('alert-error');
            expect(screen.getByText(app.currencySwapChosenBody)).toBeTruthy();
            expect(pickerTitle()).toBeNull();
            expect(screen.getByRole('button', { name: /^Spend 1 swap/ }).hasAttribute('disabled')).toBe(true);
            expect(screen.getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(false);
            expect(window.api.swapEntryPhoto).toHaveBeenCalledTimes(1);
            expect(onCurrencySpent).not.toHaveBeenCalled();

            fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
            await waitFor(() => expect(suggestionTitle()).toBeNull());
            expect(pickerTitle()).toBeNull();
            expect(onCurrencySpent).toHaveBeenCalledTimes(1);
            expect(window.api.swapEntryPhoto).toHaveBeenCalledTimes(1);
            await waitFor(() => expect(document.activeElement === swapButton()).toBe(true));
        },
    );

    test('a spend that found the state moved on refreshes the card and ends the flow', async () => {
        window.api.swapEntryPhoto = jest
            .fn()
            .mockResolvedValue({ success: false, outcome: 'not-available', error: 'not-available' });
        renderCard();
        await openPicker();
        fireEvent.click(tile(PICK_ID));
        fireEvent.click(useThisPhoto());
        fireEvent.click(await screen.findByRole('button', { name: /^Spend 1 swap/ }));
        await waitFor(() => expect(onCurrencySpent).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(suggestionTitle()).toBeNull());
    });
});

describe('ownership and focus', () => {
    test('the picker survives the Swap button going away mid-browse', async () => {
        const { setBankroll } = renderCard();
        await openPicker();
        fireEvent.click(tile(PICK_ID));
        setBankroll({ ...FULL, swaps: 0 });
        expect(screen.queryByRole('button', { name: /^🔄 Swap$/ })).toBeNull();
        expect(pickerTitle()).toBeTruthy();
        expect(tile(PICK_ID).getAttribute('aria-pressed')).toBe('true');
        // The pick still goes through to its confirm.
        fireEvent.click(useThisPhoto());
        expect(await screen.findByText(app.currencySwapChosenBody)).toBeTruthy();
    });

    test('Cancel in the picker ends the flow, without going back to the suggestion; focus returns to Swap', async () => {
        renderCard();
        await openPicker();
        fireEvent.click(within(document.body).getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(pickerTitle()).toBeNull());
        expect(suggestionTitle()).toBeNull();
        await waitFor(() => expect(document.activeElement === swapButton()).toBe(true));
        expect(window.api.swapEntryPhoto).not.toHaveBeenCalled();
    });

    test('after a failed preview of the suggestion that is not "no alternative" the button shows the error as before', async () => {
        window.api.previewSwapPhoto = jest
            .fn()
            .mockResolvedValue({ success: false, outcome: 'api-failed', error: 'api-failed' });
        renderCard();
        fireEvent.click(swapButton());
        expect(await screen.findByText(app.currencyOutcomeFailed)).toBeTruthy();
        expect(pickerTitle()).toBeNull();
    });
});
