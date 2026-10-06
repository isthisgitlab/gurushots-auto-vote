/**
 * PhotoChooserModal: the Chosen Photos chooser. Selection is a set capped at
 * MAX_CHOSEN_PHOTOS, selected photos stay pinned first, a chosen id the listing
 * lacks gets its own tile, eligibility shows as text, search runs on submit and
 * late responses are dropped. Translations are the real English strings so the
 * tiles are told apart by their accessible names.
 */

import { act, fireEvent, render, screen, waitFor, within } from './helpers/test-utils';
import { PhotoChooserModal } from '@/components/app/PhotoChooserModal';
import { Modal } from '@/components/ui/Modal';
import { rememberCurrentMember } from '@/api/useChosenPhotosOwner';
import { mockTranslator } from './helpers/setup';
import { app } from '../../src/ts/translations/english';
import { MAX_CHOSEN_PHOTOS } from '../../src/ts/settings/limits';
import { invalid } from '../helpers/invalid';
import type { WindowApi } from '../../src/ts/types/ipc';

type Listing = Extract<Awaited<ReturnType<WindowApi['getLibraryPhotos']>>, { success: true }>;
type LibraryPhoto = Listing['photos'][number];

const MEMBER = 'c'.repeat(32);
// 32-hex ids, so buildPhotoUrl accepts them; the first 8 characters tell tiles apart.
const idOf = (n: number) => `${String(n).padStart(8, '0')}${'a'.repeat(24)}`;
const shortOf = (n: number) => String(n).padStart(8, '0');

const photo = (n: number, over: Partial<LibraryPhoto> = {}): LibraryPhoto => ({
    id: idOf(n),
    labels: [`tag${n}`],
    allowed: true,
    message: null,
    uploadDate: 1,
    ...over,
});

const listing = (photos: LibraryPhoto[], over: Partial<Listing> = {}): Listing => ({
    success: true,
    photos,
    memberId: MEMBER,
    truncated: false,
    allowedKnown: true,
    ...over,
});

const english = (key: string) =>
    key.startsWith('app.') ? ((app as Record<string, string>)[key.slice(4)] ?? key) : key;

const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
        resolve = res;
    });
    return { promise, resolve };
};

const getLibrary = () => jest.mocked(window.api.getLibraryPhotos);

// The count line is the first live region; the footer's hold/confirmation status is the last.
const countLine = () => screen.getAllByRole('status')[0];

const tile = (n: number) => screen.getByRole('button', { name: new RegExp(`^Photo ${shortOf(n)}:`) });

const setup = (
    over: Partial<{
        value: string[];
        challengeId: string | number | null;
        savedCount: number;
        reloadSaved: jest.MockedFunction<() => Promise<string[] | null>>;
        onSave: jest.MockedFunction<(ids: string[]) => boolean | Promise<boolean>>;
        onClose: jest.MockedFunction<() => void>;
    }> = {},
) => {
    const props = {
        isOpen: true,
        onClose: jest.fn(),
        value: [] as string[],
        challengeId: 7 as string | number | null,
        onSave: jest.fn().mockResolvedValue(true),
        ...over,
    };
    return { ...props, ...render(<PhotoChooserModal {...props} />) };
};

beforeEach(() => {
    mockTranslator.t.mockImplementation(english);
    rememberCurrentMember(null);
    jest.mocked(window.api.getSetting).mockResolvedValue('');
    jest.mocked(window.api.getLibraryPhotos).mockResolvedValue(listing([photo(1), photo(2), photo(3)]));
});

afterEach(() => {
    mockTranslator.t.mockImplementation((key) => key);
});

describe('listing and tiles', () => {
    test('renders nothing while closed', () => {
        render(<PhotoChooserModal isOpen={false} onClose={jest.fn()} value={[]} onSave={jest.fn()} />);
        // The dialog is portalled to the body, so that is where it would show up.
        expect(document.body.querySelector('[role="dialog"]')).toBeNull();
        expect(getLibrary()).not.toHaveBeenCalled();
    });

    test('shows the loader, then a tile per photo with a lazy, referrer-less CDN thumbnail', async () => {
        const pending = deferred<Listing>();
        getLibrary().mockReturnValueOnce(invalid(pending.promise));
        setup();
        expect(screen.getByText('Loading your photos…')).toBeTruthy();
        await act(async () => pending.resolve(listing([photo(1)])));
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        const img = tile(1).querySelector('img')!;
        expect(img.getAttribute('src')).toBe(`https://photos.gurushots.com/unsafe/240x240/${MEMBER}/3_${idOf(1)}.jpg`);
        expect(img.getAttribute('loading')).toBe('lazy');
        expect(img.getAttribute('referrerpolicy')).toBe('no-referrer');
        expect(img.getAttribute('alt')).toBe('');
        expect(screen.getByText('tag1')).toBeTruthy();
    });

    test('reads the library through the challenge it was opened for', async () => {
        setup({ challengeId: 42 });
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        expect(getLibrary()).toHaveBeenCalledWith(42, undefined);
    });

    test('a photo with no usable URL becomes a text tile with its tags and short id', async () => {
        getLibrary().mockResolvedValue(
            listing([photo(1, { labels: ['red', 'sea'] }), photo(2, { labels: [] })], { memberId: null }),
        );
        setup();
        const first = await screen.findByRole('button', { name: /^Photo 00000001:/ });
        expect(first.querySelector('img')).toBeNull();
        expect(first.textContent).toContain('red, sea');
        expect(first.textContent).toContain(shortOf(1));
        expect(tile(2).textContent).toContain('No tags');
    });

    test('a thumbnail that fails to load falls back to the text tile', async () => {
        const RealImage = window.Image;
        window.Image = invalid(
            class {
                onerror?: () => void;
                set src(_url: string) {
                    queueMicrotask(() => this.onerror?.());
                }
            },
        );
        try {
            setup();
            await screen.findByRole('button', { name: /^Photo 00000001:/ });
            await waitFor(() => expect(tile(1).querySelector('img')).toBeNull());
            expect(tile(1).textContent).toContain(shortOf(1));
        } finally {
            window.Image = RealImage;
        }
    });

    test('server-supplied tags and reasons are rendered as text, never as markup', async () => {
        getLibrary().mockResolvedValue(
            listing([photo(1, { labels: ['<img src=x onerror=alert(1)>'], allowed: false, message: '<b>no</b>' })]),
        );
        setup();
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        expect(document.querySelector('[role="dialog"] b')).toBeNull();
        expect(document.querySelector('img[src="x"]')).toBeNull();
        expect(screen.getByText('<b>no</b>')).toBeTruthy();
    });

    test('shows the empty state when the library has no photos', async () => {
        getLibrary().mockResolvedValue(listing([]));
        setup();
        expect(await screen.findByText(/No photos found/)).toBeTruthy();
    });

    test('says when the listing was cut off', async () => {
        getLibrary().mockResolvedValue(listing([photo(1), photo(2)], { truncated: true }));
        setup();
        expect(await screen.findByText('Showing the first 2 photos. Search by tag to find others.')).toBeTruthy();
    });

    test('no truncation note for a complete listing', async () => {
        setup();
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        expect(screen.queryByText(/Showing the first/)).toBeNull();
    });
});

describe('selection', () => {
    test('toggles a photo on and off (aria-pressed) and saves the chosen ids', async () => {
        const { onSave, onClose } = setup();
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        expect(tile(2).getAttribute('aria-pressed')).toBe('false');
        fireEvent.click(tile(2));
        fireEvent.click(tile(3));
        expect(tile(2).getAttribute('aria-pressed')).toBe('true');
        fireEvent.click(tile(3));
        expect(countLine().textContent).toBe(`1 of ${MAX_CHOSEN_PHOTOS} chosen`);
        fireEvent.click(screen.getByRole('button', { name: 'Use these photos' }));
        await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
        expect(onSave).toHaveBeenCalledWith([idOf(2)]);
    });

    test('starts from the saved value', async () => {
        setup({ value: [idOf(1)] });
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        expect(tile(1).getAttribute('aria-pressed')).toBe('true');
    });

    test('selected photos are pinned above the rest', async () => {
        getLibrary().mockResolvedValue(listing([photo(1), photo(2), photo(3)]));
        setup({ value: [idOf(3)] });
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        const order = screen
            .getAllByRole('button', { name: /^Photo / })
            .map((button) => button.getAttribute('aria-label'));
        expect(order.map((label) => label!.slice(6, 14))).toEqual([shortOf(3), shortOf(1), shortOf(2)]);
    });

    const missingTile = () => screen.findByRole('button', { name: new RegExp(`^Chosen photo ${shortOf(9)}:`) });

    test('a chosen photo the listing lacks gets a not-available tile that can still be removed', async () => {
        getLibrary().mockResolvedValue(listing([photo(1), photo(2)]));
        setup({ value: [idOf(9)] });
        const missing = await missingTile();
        // A complete listing: no "beyond the first N photos" clause.
        expect(missing.textContent).toContain('Not available for this challenge (in another challenge, or deleted)');
        expect(missing.getAttribute('aria-label')).toBe(
            `Chosen photo ${shortOf(9)}: Not available for this challenge (in another challenge, or deleted)`,
        );
        expect(missing.getAttribute('aria-pressed')).toBe('true');
        fireEvent.click(missing);
        expect(screen.queryByRole('button', { name: new RegExp(`^Chosen photo ${shortOf(9)}:`) })).toBeNull();
    });

    test.each([
        [
            'a challenge and a cut-off listing',
            { truncated: true },
            7,
            'Not available for this challenge (in another challenge, deleted, or beyond the first 2 photos)',
        ],
        [
            'no challenge and a complete listing',
            { allowedKnown: false },
            null,
            'Not found in your library (it may have been deleted)',
        ],
        [
            'no challenge and a cut-off listing',
            { allowedKnown: false, truncated: true },
            null,
            'Not found in the photos listed (it may have been deleted, or be beyond the first 2 photos)',
        ],
    ])('the not-available text for %s', async (_name, over, challengeId, text) => {
        getLibrary().mockResolvedValue(listing([photo(1), photo(2)], over));
        setup({ value: [idOf(9)], challengeId });
        expect((await missingTile()).textContent).toContain(text);
    });

    test('stops at the cap: other photos cannot be added and a line says so, selected ones can still be removed', async () => {
        const many = Array.from({ length: MAX_CHOSEN_PHOTOS + 1 }, (_, n) => photo(n + 1));
        getLibrary().mockResolvedValue(listing(many));
        setup({ value: many.slice(0, MAX_CHOSEN_PHOTOS).map((p) => p.id) });
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        expect(countLine().textContent).toContain('Limit reached — remove one to add another');
        const extra = tile(MAX_CHOSEN_PHOTOS + 1);
        // aria-disabled, not disabled: Tab still reaches it. Clicking it does nothing.
        expect(extra.getAttribute('aria-disabled')).toBe('true');
        expect(extra.hasAttribute('disabled')).toBe(false);
        fireEvent.click(extra);
        expect(extra.getAttribute('aria-pressed')).toBe('false');
        expect(countLine().textContent).toContain(`${MAX_CHOSEN_PHOTOS} of ${MAX_CHOSEN_PHOTOS}`);
        // The reason is short text on the tile itself. The picture and its tags are dimmed; the reason
        // is not, so it stays at full contrast (opacity on the tile would have dimmed it too).
        expect(extra.textContent).toContain('List full');
        expect(extra.className).not.toContain('opacity-50');
        expect(extra.querySelectorAll('.opacity-50').length).toBeGreaterThan(0);
        const reason = within(extra).getByText('List full');
        expect(reason.className).not.toContain('opacity-50');
        expect(reason.closest('.opacity-50')).toBeNull();
        expect(tile(1).textContent).not.toContain('List full');
        expect(tile(1).querySelector('.opacity-50')).toBeNull();
        expect(tile(1).getAttribute('aria-disabled')).toBe('false');
        fireEvent.click(tile(1));
        expect(tile(MAX_CHOSEN_PHOTOS + 1).getAttribute('aria-disabled')).toBe('false');
        expect(tile(MAX_CHOSEN_PHOTOS + 1).textContent).not.toContain('List full');
        expect(countLine().textContent).not.toContain('Limit reached');
    });

    test('Clear empties the selection and Cancel closes without saving', async () => {
        const { onSave, onClose } = setup({ value: [idOf(1)] });
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
        expect(tile(1).getAttribute('aria-pressed')).toBe('false');
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(onSave).not.toHaveBeenCalled();
    });
});

describe('eligibility', () => {
    test('a refused photo is greyed out with its reason as visible text and cannot be added', async () => {
        getLibrary().mockResolvedValue(
            listing([photo(1, { allowed: false, message: 'Already in another challenge' }), photo(2)]),
        );
        setup();
        const blocked = await screen.findByRole('button', { name: /^Photo 00000001:/ });
        // Reachable by Tab (aria-disabled, never disabled) but not addable.
        expect(blocked.getAttribute('aria-disabled')).toBe('true');
        expect(blocked.hasAttribute('disabled')).toBe(false);
        // The picture is dimmed, the reason is not.
        expect(blocked.querySelector('.opacity-50')).not.toBeNull();
        expect(within(blocked).getByText('Already in another challenge').closest('.opacity-50')).toBeNull();
        fireEvent.click(blocked);
        expect(blocked.getAttribute('aria-pressed')).toBe('false');
        expect(screen.getByText('Already in another challenge')).toBeTruthy();
        expect(screen.getByText('Can be entered')).toBeTruthy();
    });

    test('a refused photo without a message gets a generic reason, and stays removable once chosen', async () => {
        getLibrary().mockResolvedValue(listing([photo(1, { allowed: false })]));
        setup({ value: [idOf(1)] });
        const blocked = await screen.findByRole('button', { name: /^Photo 00000001:/ });
        expect(screen.getByText('Not eligible for this challenge')).toBeTruthy();
        expect(blocked.getAttribute('aria-disabled')).toBe('false');
    });

    test('without a challenge the listing says eligibility is only checked at submit time', async () => {
        getLibrary().mockResolvedValue(listing([photo(1, { allowed: false })], { allowedKnown: false }));
        setup({ challengeId: null });
        const only = await screen.findByRole('button', { name: /^Photo 00000001:/ });
        expect(screen.getByText(/Eligibility is not checked here/)).toBeTruthy();
        expect(only.getAttribute('aria-disabled')).toBe('false');
        expect(screen.queryByText('Not eligible for this challenge')).toBeNull();
        expect(screen.queryByText('Can be entered')).toBeNull();
        expect(getLibrary()).toHaveBeenCalledWith(null, undefined);
    });
});

describe('search', () => {
    test('searches on submit, not while typing', async () => {
        setup();
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        const box = screen.getByLabelText('Search your photos by tag');
        fireEvent.change(box, { target: { value: '  cat ' } });
        expect(getLibrary()).toHaveBeenCalledTimes(1);
        fireEvent.submit(box.closest('form')!);
        await waitFor(() => expect(getLibrary()).toHaveBeenCalledTimes(2));
        expect(getLibrary()).toHaveBeenLastCalledWith(7, 'cat');
    });

    test('a selected photo a narrower search no longer lists keeps its tile', async () => {
        getLibrary()
            .mockResolvedValueOnce(listing([photo(1), photo(2)]))
            .mockResolvedValueOnce(listing([photo(3)]));
        setup({ value: [idOf(1)] });
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        fireEvent.change(screen.getByLabelText('Search your photos by tag'), { target: { value: 'x' } });
        fireEvent.submit(screen.getByLabelText('Search your photos by tag').closest('form')!);
        await screen.findByRole('button', { name: /^Photo 00000003:/ });
        // Known from the first listing: still the photo, not a "not available" tile.
        expect(tile(1).textContent).not.toContain('Not available');
        expect(tile(1).getAttribute('aria-pressed')).toBe('true');
    });

    test('drops a late response for a search that has been replaced', async () => {
        const first = deferred<Listing>();
        const second = deferred<Listing>();
        getLibrary().mockReturnValueOnce(invalid(first.promise)).mockReturnValueOnce(invalid(second.promise));
        setup();
        const box = screen.getByLabelText('Search your photos by tag');
        fireEvent.change(box, { target: { value: 'b' } });
        fireEvent.submit(box.closest('form')!);
        await act(async () => second.resolve(listing([photo(2)])));
        await screen.findByRole('button', { name: /^Photo 00000002:/ });
        await act(async () => first.resolve(listing([photo(1)])));
        expect(screen.queryByRole('button', { name: /^Photo 00000001:/ })).toBeNull();
        expect(tile(2)).toBeTruthy();
    });

    test('a response that arrives after the modal closed changes nothing', async () => {
        const pending = deferred<Listing>();
        getLibrary().mockReturnValueOnce(invalid(pending.promise));
        const { rerender, onClose, onSave } = setup();
        rerender(<PhotoChooserModal isOpen={false} onClose={onClose} value={[]} onSave={onSave} />);
        await act(async () => pending.resolve(listing([photo(1)])));
        expect(screen.queryByRole('button', { name: /^Photo / })).toBeNull();
    });

    test('a superseded answer to the newest request offers Retry instead of loading forever', async () => {
        getLibrary()
            .mockResolvedValueOnce({ success: false, error: 'superseded' })
            .mockResolvedValueOnce(listing([photo(1)]));
        setup();
        const alert = await screen.findByRole('alert');
        expect(screen.queryByText('Loading your photos…')).toBeNull();
        // The code is not shown as a detail.
        expect(alert.textContent).not.toContain('superseded');
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
    });

    test('a superseded answer to an older request is still ignored', async () => {
        const first = deferred<unknown>();
        getLibrary()
            .mockReturnValueOnce(invalid(first.promise))
            .mockResolvedValueOnce(listing([photo(2)]));
        setup();
        const box = screen.getByLabelText('Search your photos by tag');
        fireEvent.change(box, { target: { value: 'b' } });
        fireEvent.submit(box.closest('form')!);
        await screen.findByRole('button', { name: /^Photo 00000002:/ });
        await act(async () => first.resolve({ success: false, error: 'superseded' }));
        expect(screen.queryByRole('alert')).toBeNull();
        expect(tile(2)).toBeTruthy();
    });
});

describe('failures', () => {
    test('a failed read shows what happened, why and what next, and Retry reads again with the last search', async () => {
        getLibrary()
            .mockResolvedValueOnce(invalid(null))
            .mockResolvedValueOnce(listing([photo(1)]));
        setup();
        const alert = await screen.findByRole('alert');
        // Nothing came back to show as a detail: a generic why and next step, not "details below".
        expect(alert.textContent).toContain("Your photos couldn't be loaded — the request was interrupted. Try again.");
        expect(alert.textContent).not.toContain('details below');
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        expect(getLibrary()).toHaveBeenLastCalledWith(7, undefined);
    });

    test('an error carries its own text as a detail; invalid-args is translated', async () => {
        getLibrary().mockResolvedValueOnce({ success: false, error: 'Failed to read your photo library' });
        const view = setup();
        const alert = await screen.findByRole('alert');
        // With a detail to point at, "details below" is accurate and no cause is claimed.
        expect(alert.textContent).toContain("Your photos couldn't be loaded (details below). Try again.");
        expect(alert.textContent).not.toMatch(/GuruShots didn't answer|session/);
        expect(alert.textContent).toContain('Failed to read your photo library');
        view.unmount();

        mockTranslator.t.mockImplementation((key) =>
            key === 'errors.actionInvalidArgs' ? 'Bad request' : english(key),
        );
        getLibrary().mockResolvedValueOnce({ success: false, error: 'invalid-args' });
        setup();
        expect((await screen.findByRole('alert')).textContent).toContain('Bad request');
    });

    test('retry keeps the submitted search', async () => {
        getLibrary()
            .mockResolvedValueOnce(listing([photo(1)]))
            .mockResolvedValueOnce(invalid(null));
        setup();
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        const box = screen.getByLabelText('Search your photos by tag');
        fireEvent.change(box, { target: { value: 'dog' } });
        fireEvent.submit(box.closest('form')!);
        await screen.findByRole('alert');
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
        await waitFor(() => expect(getLibrary()).toHaveBeenLastCalledWith(7, 'dog'));
    });

    test('with no challenge to read the library through it explains what is needed', async () => {
        getLibrary().mockResolvedValue({ success: false, error: 'no-challenge-context' });
        setup({ challengeId: null });
        expect((await screen.findByRole('alert')).textContent).toContain('no active or joinable challenge');
    });

    test('a save the caller refuses keeps the modal open on an error', async () => {
        const onSave = jest.fn().mockResolvedValue(false);
        const { onClose } = setup({ onSave });
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        fireEvent.click(screen.getByRole('button', { name: 'Use these photos' }));
        expect((await screen.findByRole('alert')).textContent).toContain("weren't saved");
        expect(onClose).not.toHaveBeenCalled();
        // A second attempt clears the error before trying again.
        onSave.mockResolvedValue(true);
        fireEvent.click(screen.getByRole('button', { name: 'Use these photos' }));
        await waitFor(() => expect(onClose).toHaveBeenCalled());
    });

    test('a save that throws is treated as refused', async () => {
        const { onClose } = setup({ onSave: jest.fn().mockRejectedValue(new Error('boom')) });
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        fireEvent.click(screen.getByRole('button', { name: 'Use these photos' }));
        expect((await screen.findByRole('alert')).textContent).toContain("weren't saved");
        expect(onClose).not.toHaveBeenCalled();
    });

    test('Save is disabled while saving', async () => {
        const saving = deferred<boolean>();
        const { onClose } = setup({ onSave: jest.fn<Promise<boolean>, [string[]]>(() => saving.promise) });
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        fireEvent.click(screen.getByRole('button', { name: 'Use these photos' }));
        await waitFor(() =>
            expect((screen.getByRole('button', { name: 'Use these photos' }) as HTMLButtonElement).disabled).toBe(true),
        );
        await act(async () => saving.resolve(true));
        expect(onClose).toHaveBeenCalled();
    });

    test('a synchronous save callback works too', async () => {
        const { onClose, onSave } = setup({ onSave: jest.fn().mockReturnValue(true) });
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        fireEvent.click(screen.getByRole('button', { name: 'Use these photos' }));
        await waitFor(() => expect(onClose).toHaveBeenCalled());
        expect(onSave).toHaveBeenCalledWith([]);
    });
});

describe('account scope', () => {
    const OTHER = 'd'.repeat(32);
    const notice = () => screen.findByText(/saved under another account, so the app ignores them/);

    beforeEach(() => {
        jest.mocked(window.api.clearChosenPhotos).mockResolvedValue({ success: true, removed: 2 });
    });

    test("warns that saving here makes the other account's lists apply too, and never shows their ids", async () => {
        jest.mocked(window.api.getSetting).mockResolvedValue(OTHER);
        setup({ value: [idOf(1), idOf(9)] });
        expect((await notice()).textContent).toContain('Saving a list here makes them apply to this account too');
        // Counted, not shown: no tile, short id or thumbnail for the other account's photos.
        expect(screen.getByText('2 photo(s) saved under another account')).toBeTruthy();
        expect(screen.queryByRole('button', { name: new RegExp(`${shortOf(9)}`) })).toBeNull();
        expect(document.body.textContent).not.toContain(shortOf(9));
        // The selection starts empty: those photos are not this account's to build on.
        expect(countLine().textContent).toBe(`0 of ${MAX_CHOSEN_PHOTOS} chosen`);
        expect(tile(1).getAttribute('aria-pressed')).toBe('false');
    });

    test('the notice judges the list the modal opened with, so it stays after clearing and choosing again', async () => {
        jest.mocked(window.api.getSetting).mockResolvedValue(OTHER);
        setup({ value: [idOf(1)] });
        await notice();
        fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
        expect(screen.queryByText(/saved under another account, so the app ignores them/)).not.toBeNull();
        fireEvent.click(tile(2));
        expect(screen.queryByText(/saved under another account, so the app ignores them/)).not.toBeNull();
        expect(countLine().textContent).toBe(`1 of ${MAX_CHOSEN_PHOTOS} chosen`);
    });

    test('the notice and the withheld photos stay while a search is loading or fails', async () => {
        jest.mocked(window.api.getSetting).mockResolvedValue(OTHER);
        setup({ value: [idOf(1), idOf(2)] });
        await notice();
        const box = screen.getByLabelText('Search your photos by tag');
        const pending = deferred<Listing>();
        getLibrary().mockReturnValueOnce(invalid(pending.promise));
        fireEvent.change(box, { target: { value: 'x' } });
        fireEvent.submit(box.closest('form')!);
        // Loading: the listing says nothing about the account, yet the notice is still there.
        expect(screen.getByText('Loading your photos…')).toBeTruthy();
        expect(screen.queryByText(/saved under another account, so the app ignores them/)).not.toBeNull();
        expect(screen.getByText('2 photo(s) saved under another account')).toBeTruthy();
        await act(async () => pending.resolve(invalid({ success: false, error: 'down' })));
        // Failed: still there.
        await screen.findByRole('button', { name: 'Retry' });
        expect(screen.queryByText(/saved under another account, so the app ignores them/)).not.toBeNull();
        expect(screen.queryByRole('button', { name: new RegExp(`${shortOf(1)}`) })).toBeNull();
    });

    test('a count passed in for a withheld list is shown with the notice, though no ids are', async () => {
        jest.mocked(window.api.getSetting).mockResolvedValue(OTHER);
        render(
            <PhotoChooserModal
                isOpen
                onClose={jest.fn()}
                value={[]}
                savedCount={3}
                challengeId={7}
                onSave={jest.fn()}
            />,
        );
        await notice();
        expect(screen.getByText('3 photo(s) saved under another account')).toBeTruthy();
    });

    test('saving still saves what was chosen here', async () => {
        jest.mocked(window.api.getSetting).mockResolvedValue(OTHER);
        const { onSave } = setup({ value: [idOf(1)] });
        await notice();
        fireEvent.click(tile(2));
        fireEvent.click(screen.getByRole('button', { name: 'Use these photos' }));
        await waitFor(() => expect(onSave).toHaveBeenCalledWith([idOf(2)]));
    });

    test('removing the lists asks first, then removes them and drops the notice', async () => {
        jest.mocked(window.api.getSetting).mockResolvedValue(OTHER);
        setup({ value: [idOf(1)] });
        await notice();
        fireEvent.click(screen.getByRole('button', { name: 'Remove those lists' }));
        expect(
            await screen.findByText(
                "Remove the chosen-photo lists saved under the other account, in every setting, profile, rule and scenario? This can't be undone. Submit Only Chosen Photos is kept.",
            ),
        ).toBeTruthy();
        expect(window.api.clearChosenPhotos).not.toHaveBeenCalled();
        // The confirm button carries the same name as the notice's, so take the one in the confirm dialog.
        const confirm = screen.getAllByRole('button', { name: 'Remove those lists' }).at(-1)!;
        fireEvent.click(confirm);
        await waitFor(() => expect(window.api.clearChosenPhotos).toHaveBeenCalledTimes(1));
        await waitFor(() =>
            expect(screen.queryByText(/saved under another account, so the app ignores them/)).toBeNull(),
        );
        expect(screen.queryByText('2 photo(s) saved under another account')).toBeNull();
    });

    test('cancelling the confirmation removes nothing', async () => {
        jest.mocked(window.api.getSetting).mockResolvedValue(OTHER);
        setup({ value: [idOf(1)] });
        await notice();
        fireEvent.click(screen.getByRole('button', { name: 'Remove those lists' }));
        await screen.findByText(/Remove the chosen-photo lists saved under the other account/);
        fireEvent.click(screen.getAllByRole('button', { name: 'Cancel' }).at(-1)!);
        await waitFor(() =>
            expect(screen.queryByText(/Remove the chosen-photo lists saved under the other account/)).toBeNull(),
        );
        expect(window.api.clearChosenPhotos).not.toHaveBeenCalled();
        expect(screen.queryByText(/saved under another account, so the app ignores them/)).not.toBeNull();
    });

    test('Escape closes the confirmation only, and removes nothing', async () => {
        jest.mocked(window.api.getSetting).mockResolvedValue(OTHER);
        const { onClose } = setup({ value: [idOf(1)] });
        await notice();
        fireEvent.click(screen.getByRole('button', { name: 'Remove those lists' }));
        await screen.findByText(/Remove the chosen-photo lists saved under the other account/);
        fireEvent.keyDown(document, { key: 'Escape' });
        await waitFor(() =>
            expect(screen.queryByText(/Remove the chosen-photo lists saved under the other account/)).toBeNull(),
        );
        expect(onClose).not.toHaveBeenCalled();
        expect(window.api.clearChosenPhotos).not.toHaveBeenCalled();
    });

    test.each([
        ['a refused removal', jest.fn().mockResolvedValue({ success: false, error: 'disk' })],
        ['a removal the bridge rejects', jest.fn().mockRejectedValue(new Error('down'))],
    ])('%s keeps the notice and says the lists were not removed', async (_name, clear) => {
        jest.mocked(window.api.getSetting).mockResolvedValue(OTHER);
        window.api.clearChosenPhotos = clear;
        setup({ value: [idOf(1)] });
        await notice();
        fireEvent.click(screen.getByRole('button', { name: 'Remove those lists' }));
        await screen.findByText(/Remove the chosen-photo lists saved under the other account/);
        fireEvent.click(screen.getAllByRole('button', { name: 'Remove those lists' }).at(-1)!);
        expect(await screen.findByText(/The lists weren't removed/)).toBeTruthy();
        expect(screen.queryByText(/saved under another account, so the app ignores them/)).not.toBeNull();
    });

    test('no warning when the list belongs to the signed-in account', async () => {
        jest.mocked(window.api.getSetting).mockResolvedValue(MEMBER);
        setup({ value: [idOf(1)] });
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        expect(screen.queryByText(/saved under another account/)).toBeNull();
        expect(tile(1).getAttribute('aria-pressed')).toBe('true');
    });

    test('no warning when no owner was recorded, or the member is unknown', async () => {
        setup({ value: [idOf(1)] });
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        expect(screen.queryByText(/saved under another account/)).toBeNull();
    });

    test('no warning for an empty list', async () => {
        jest.mocked(window.api.getSetting).mockResolvedValue(OTHER);
        setup();
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        expect(screen.queryByText(/saved under another account/)).toBeNull();
    });
});

describe('Save while the account is unknown', () => {
    const OTHER = 'd'.repeat(32);
    const use = () => screen.getByRole('button', { name: 'Use these photos' });
    const hint = 'Saving waits until your photos have loaded, so the app can check which account the list belongs to.';

    const errorHint =
        'Saving is held until your photos load, so the app can check which account the list belongs to. Press Retry above.';
    const noContextHint =
        "Saving is blocked: without an active or open challenge the app can't check which account this list belongs to. Clear the list to save, or join a challenge first.";

    const expectHeldBack = (text = hint) => {
        // aria-disabled, not disabled: the button stays focusable, and the hint is linked to it.
        expect(use().getAttribute('aria-disabled')).toBe('true');
        expect(use().hasAttribute('disabled')).toBe(false);
        const hintElement = screen.getByText(text);
        expect(use().getAttribute('aria-describedby')).toBe(hintElement.id);
    };

    test('is held back while the listing loads or has failed, once an owner is on record and a list is chosen', async () => {
        jest.mocked(window.api.getSetting).mockResolvedValue(OTHER);
        const pending = deferred<Listing>();
        getLibrary().mockReturnValueOnce(invalid(pending.promise));
        const { onSave } = setup({ value: [idOf(1)] });
        await waitFor(() => expect(window.api.getSetting).toHaveBeenCalled());
        await act(async () => undefined);
        expectHeldBack();
        fireEvent.click(use());
        expect(onSave).not.toHaveBeenCalled();
        await act(async () => pending.resolve(invalid({ success: false, error: 'down' })));
        await screen.findByRole('button', { name: 'Retry' });
        // The hint names the way out of this state: Retry, not a wait that will not end by itself.
        expectHeldBack(errorHint);
        expect(screen.queryByText(hint)).toBeNull();
        // Once a listing shows who is signed in, Save is available again, and the hint is gone.
        getLibrary().mockResolvedValueOnce(listing([photo(1)]));
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        expect(use().getAttribute('aria-disabled')).toBe('false');
        expect(use().hasAttribute('aria-describedby')).toBe(false);
        expect(screen.queryByText(hint)).toBeNull();
    });

    test('is held back with no challenge to read the library through, and the hint does not promise a load', async () => {
        jest.mocked(window.api.getSetting).mockResolvedValue(OTHER);
        getLibrary().mockResolvedValue({ success: false, error: 'no-challenge-context' });
        setup({ value: [idOf(1)], challengeId: null });
        await screen.findByRole('alert');
        expectHeldBack(noContextHint);
        // Nothing will load, so "saving waits until your photos have loaded" would be a false promise.
        expect(screen.queryByText(hint)).toBeNull();
    });

    test('clearing the list lifts the no-challenge hold, so the way out the hint names works', async () => {
        jest.mocked(window.api.getSetting).mockResolvedValue(OTHER);
        getLibrary().mockResolvedValue({ success: false, error: 'no-challenge-context' });
        const { onSave } = setup({ value: [idOf(1)], challengeId: null });
        await screen.findByRole('alert');
        fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
        expect(screen.queryByText(noContextHint)).toBeNull();
        fireEvent.click(use());
        await waitFor(() => expect(onSave).toHaveBeenCalledWith([]));
    });

    test('saving nothing is never held back: it writes no list', async () => {
        jest.mocked(window.api.getSetting).mockResolvedValue(OTHER);
        const pending = deferred<Listing>();
        getLibrary().mockReturnValueOnce(invalid(pending.promise));
        const { onSave } = setup({ value: [] });
        await waitFor(() => expect(window.api.getSetting).toHaveBeenCalled());
        await act(async () => undefined);
        expect(use().getAttribute('aria-disabled')).toBe('false');
        expect(screen.queryByText(hint)).toBeNull();
        fireEvent.click(use());
        await waitFor(() => expect(onSave).toHaveBeenCalledWith([]));
    });

    test('is not held back when no owner is on record', async () => {
        const pending = deferred<Listing>();
        getLibrary().mockReturnValueOnce(invalid(pending.promise));
        setup({ value: [idOf(1)] });
        await act(async () => undefined);
        expect(use().getAttribute('aria-disabled')).toBe('false');
    });
});

describe('a saved list that came without its ids', () => {
    const OWNER = MEMBER;
    const use = () => screen.getByRole('button', { name: 'Use these photos' });
    const hint = 'Saving waits until your photos have loaded, so the app can check which account the list belongs to.';
    const readFailedHint =
        "Couldn't read your saved list for this challenge, so saving is held to protect it. Press Retry.";
    const readFailedAgainHint =
        'Reading your saved list failed again, so saving stays held to protect it. Press Retry again shortly.';
    const notLoggedInHint =
        "You're signed out, so the account can't be checked. Log in again, then reopen the chooser.";
    const noContextHeldHint =
        'There is no challenge to read your library through, so saving is held. Join a challenge, or close this window.';
    const confirmedText = 'Account confirmed — your saved list is loaded.';
    const lockedText = 'Locked until your saved list is read';
    const checkingHint = 'Checking which account this list belongs to…';
    const checkFailedHint =
        'The account check failed, so saving is held to protect your list. Press Retry again shortly.';
    const unconfirmedHint =
        "Couldn't confirm which account this list belongs to, so saving is held to protect it. Press Retry, or close and reopen the chooser.";
    // A re-read mock: what it answers on its successive calls.
    const rereads = (...answers: Array<string[] | null | Error>) => {
        const reloadSaved = jest.fn<Promise<string[] | null>, []>();
        for (const answer of answers) {
            if (answer instanceof Error) reloadSaved.mockRejectedValueOnce(answer);
            else reloadSaved.mockResolvedValueOnce(answer);
        }
        return reloadSaved;
    };
    const pressed = (n: number) => tile(n).getAttribute('aria-pressed');

    beforeEach(() => {
        jest.mocked(window.api.getSetting).mockResolvedValue(OWNER);
    });

    test('Save, an empty one too, is held until the list has been read again and seeds the selection', async () => {
        const pending = deferred<Listing>();
        getLibrary().mockReturnValueOnce(invalid(pending.promise));
        const reloadSaved = rereads([idOf(1), idOf(2)]);
        const { onSave } = setup({ value: [], savedCount: 2, reloadSaved });
        await act(async () => undefined);
        // Nothing to save yet: the selection is empty only because the ids were withheld.
        expect(use().getAttribute('aria-disabled')).toBe('true');
        fireEvent.click(use());
        expect(onSave).not.toHaveBeenCalled();
        expect(reloadSaved).not.toHaveBeenCalled();

        await act(async () => pending.resolve(listing([photo(1), photo(2), photo(3)])));
        await waitFor(() => expect(pressed(1)).toBe('true'));
        expect(pressed(2)).toBe('true');
        expect(reloadSaved).toHaveBeenCalledTimes(1);
        await waitFor(() => expect(use().getAttribute('aria-disabled')).toBe('false'));
        expect(screen.queryByText(hint)).toBeNull();
        fireEvent.click(use());
        await waitFor(() => expect(onSave).toHaveBeenCalledWith([idOf(1), idOf(2)]));
    });

    test('an empty save goes through only once the user has really cleared the list', async () => {
        const { onSave } = setup({ value: [], savedCount: 1, reloadSaved: rereads([idOf(1)]) });
        await waitFor(() => expect(pressed(1)).toBe('true'));
        await waitFor(() => expect(use().getAttribute('aria-disabled')).toBe('false'));
        fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
        fireEvent.click(use());
        await waitFor(() => expect(onSave).toHaveBeenCalledWith([]));
    });

    test('the tiles are inert while the list is unread, so the late read cannot overwrite a pick', async () => {
        const read = deferred<string[] | null>();
        const reloadSaved = jest.fn<Promise<string[] | null>, []>().mockReturnValue(read.promise);
        setup({ value: [], savedCount: 1, reloadSaved });
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        await waitFor(() => expect(reloadSaved).toHaveBeenCalledTimes(1));
        // Read in flight: every tile says it cannot be changed, and a click does nothing.
        expect(tile(3).getAttribute('aria-disabled')).toBe('true');
        fireEvent.click(tile(3));
        expect(pressed(3)).toBe('false');
        // The photos have loaded, so the hint names what is awaited instead of "waits until loaded".
        expect(screen.getByText(checkingHint)).toBeTruthy();
        expect(screen.queryByText(hint)).toBeNull();

        await act(async () => read.resolve([idOf(1)]));
        await waitFor(() => expect(pressed(1)).toBe('true'));
        expect(pressed(3)).toBe('false');
        expect(tile(3).getAttribute('aria-disabled')).toBe('false');
        fireEvent.click(tile(3));
        expect(pressed(3)).toBe('true');
    });

    describe('ready, but the list cannot be confirmed', () => {
        const expectUnconfirmed = async (message = unconfirmedHint) => {
            await screen.findByText(message);
            expect(screen.queryByText(hint)).toBeNull();
            expect(use().getAttribute('aria-disabled')).toBe('true');
            // The tiles are inert here too: nothing may be picked over a list that is unread.
            expect(tile(2).getAttribute('aria-disabled')).toBe('true');
            fireEvent.click(tile(2));
            expect(pressed(2)).toBe('false');
        };

        const confirmWith = (...answers: Array<string | null>) => {
            const confirm = jest.mocked(window.api.confirmAccount);
            for (const memberId of answers) {
                confirm.mockResolvedValueOnce(
                    memberId === null ? { success: false, error: 'account-check-failed' } : { success: true, memberId },
                );
            }
            return confirm;
        };
        const retryButton = () => screen.getByRole('button', { name: 'Retry' });

        test('a listing that cannot say who is signed in: Retry checks the account only, never the library again, and seeds the list', async () => {
            getLibrary().mockResolvedValueOnce(listing([photo(1), photo(2)], { memberId: null }));
            const confirm = confirmWith(OWNER);
            const reloadSaved = rereads([idOf(1)]);
            const { onSave } = setup({ value: [], savedCount: 1, reloadSaved });
            await expectUnconfirmed();
            expect(reloadSaved).not.toHaveBeenCalled();
            fireEvent.click(use());
            expect(onSave).not.toHaveBeenCalled();

            fireEvent.click(retryButton());
            await waitFor(() => expect(pressed(1)).toBe('true'));
            await waitFor(() => expect(use().getAttribute('aria-disabled')).toBe('false'));
            expect(screen.queryByText(unconfirmedHint)).toBeNull();
            expect(confirm).toHaveBeenCalledTimes(1);
            // The listing on screen was reused: no second library walk.
            expect(getLibrary()).toHaveBeenCalledTimes(1);
            fireEvent.click(use());
            await waitFor(() => expect(onSave).toHaveBeenCalledWith([idOf(1)]));
        });

        test('the check fails again: the hint says so and Retry stays; a later press can succeed', async () => {
            getLibrary().mockResolvedValue(listing([photo(1), photo(2)], { memberId: null }));
            confirmWith(null, OWNER);
            const { onSave } = setup({ value: [], savedCount: 1, reloadSaved: rereads([idOf(1)]) });
            await screen.findByText(unconfirmedHint);
            fireEvent.click(retryButton());
            await screen.findByText(checkFailedHint);
            expect(screen.queryByText(unconfirmedHint)).toBeNull();
            expect(use().getAttribute('aria-disabled')).toBe('true');
            expect(getLibrary()).toHaveBeenCalledTimes(1);

            fireEvent.click(retryButton());
            await waitFor(() => expect(pressed(1)).toBe('true'));
            fireEvent.click(use());
            await waitFor(() => expect(onSave).toHaveBeenCalledWith([idOf(1)]));
        });

        test('a check that rejects counts as a failed check', async () => {
            getLibrary().mockResolvedValue(listing([photo(1)], { memberId: null }));
            jest.mocked(window.api.confirmAccount).mockRejectedValueOnce(new Error('ipc down'));
            setup({ value: [], savedCount: 1, reloadSaved: rereads() });
            await screen.findByText(unconfirmedHint);
            fireEvent.click(retryButton());
            await screen.findByText(checkFailedHint);
        });

        test("the check names another account: the notice shows, the ids stay withheld and Save is the user's choice", async () => {
            getLibrary().mockResolvedValue(listing([photo(1), photo(2)], { memberId: null }));
            confirmWith('d'.repeat(32));
            const reloadSaved = rereads();
            const { onSave } = setup({ value: [], savedCount: 2, reloadSaved });
            await screen.findByText(unconfirmedHint);
            fireEvent.click(retryButton());
            expect(await screen.findByText(/saved under another account, so the app ignores them/)).toBeTruthy();
            expect(reloadSaved).not.toHaveBeenCalled();
            await waitFor(() => expect(use().getAttribute('aria-disabled')).toBe('false'));
            fireEvent.click(tile(2));
            fireEvent.click(use());
            await waitFor(() => expect(onSave).toHaveBeenCalledWith([idOf(2)]));
        });

        test('Retry stays mounted, focused, aria-busy and inert while the check runs; the hint is a live region apart from it', async () => {
            getLibrary().mockResolvedValue(listing([photo(1)], { memberId: null }));
            const answer = deferred<{ success: true; memberId: string }>();
            jest.mocked(window.api.confirmAccount).mockReturnValueOnce(invalid(answer.promise));
            setup({ value: [], savedCount: 1, reloadSaved: rereads([idOf(1)]) });
            await screen.findByText(unconfirmedHint);

            // Save is described by the status paragraph, which holds the text only: Retry is outside it.
            const status = document.getElementById(use().getAttribute('aria-describedby')!)!;
            expect(status.getAttribute('role')).toBe('status');
            expect(status.querySelector('button')).toBeNull();
            expect(retryButton().closest('[role="status"]')).toBeNull();

            const retry = retryButton();
            retry.focus();
            fireEvent.click(retry);
            await screen.findByText(checkingHint);
            expect(retryButton()).toBe(retry);
            expect(document.activeElement).toBe(retry);
            expect(retry.getAttribute('aria-busy')).toBe('true');
            expect(retry.getAttribute('aria-disabled')).toBe('true');
            // A second press while it runs asks nothing more.
            fireEvent.click(retry);
            expect(window.api.confirmAccount).toHaveBeenCalledTimes(1);

            // Busy looks busy: a spinner and the disabled style, DaisyUI only.
            expect(retry.className).toContain('btn-disabled');
            expect(retry.querySelector('.loading.loading-spinner')).not.toBeNull();

            await act(async () => answer.resolve({ success: true, memberId: OWNER }));
            await waitFor(() => expect(pressed(1)).toBe('true'));
            expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
        });

        test('Retry stays mounted and focused through the read after the check, then focus moves to Save and success is announced', async () => {
            getLibrary().mockResolvedValue(listing([photo(1)], { memberId: null }));
            confirmWith(OWNER);
            const read = deferred<string[] | null>();
            const reloadSaved = jest.fn<Promise<string[] | null>, []>().mockReturnValue(read.promise);
            setup({ value: [], savedCount: 1, reloadSaved });
            await screen.findByText(unconfirmedHint);
            expect(screen.queryByText(confirmedText)).toBeNull();

            const retry = retryButton();
            retry.focus();
            fireEvent.click(retry);
            // The account answers; the list read that follows is held deferred. Retry is still the same
            // focused, busy button, and the hint says what is awaited.
            await waitFor(() => expect(reloadSaved).toHaveBeenCalledTimes(1));
            await screen.findByText(checkingHint);
            expect(retryButton()).toBe(retry);
            expect(document.activeElement).toBe(retry);
            expect(retry.getAttribute('aria-busy')).toBe('true');
            expect(retry.getAttribute('aria-disabled')).toBe('true');

            await act(async () => read.resolve([idOf(1)]));
            await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull());
            expect(document.activeElement).toBe(use());
            // The success is in a live region that was mounted all along.
            const announced = screen.getByText(confirmedText);
            expect(announced.getAttribute('role')).toBe('status');
        });

        test('a hold nobody pressed Retry for lifts without moving focus or announcing success', async () => {
            const read = deferred<string[] | null>();
            setup({
                value: [],
                savedCount: 1,
                reloadSaved: jest.fn<Promise<string[] | null>, []>().mockReturnValue(read.promise),
            });
            await screen.findByRole('button', { name: /^Photo 00000001:/ });
            // No Retry is offered for the automatic read, busy or not.
            expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
            await act(async () => read.resolve([idOf(1)]));
            await waitFor(() => expect(use().getAttribute('aria-disabled')).toBe('false'));
            expect(document.activeElement).not.toBe(use());
            expect(screen.queryByText(confirmedText)).toBeNull();
        });

        test.each([
            ['gives nothing', null],
            ['rejects', new Error('ipc down')],
        ])('a read that %s: its own hint and Retry, and a good Retry releases Save', async (_name, failure) => {
            const reloadSaved = rereads(failure, [idOf(1), idOf(2)]);
            const { onSave } = setup({ value: [], savedCount: 2, reloadSaved });
            // The account is known, so the words are about the read, not about the account.
            await expectUnconfirmed(readFailedHint);
            expect(screen.queryByText(unconfirmedHint)).toBeNull();
            expect(reloadSaved).toHaveBeenCalledTimes(1);
            fireEvent.click(use());
            expect(onSave).not.toHaveBeenCalled();

            fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
            await waitFor(() => expect(reloadSaved).toHaveBeenCalledTimes(2));
            await waitFor(() => expect(pressed(2)).toBe('true'));
            await waitFor(() => expect(use().getAttribute('aria-disabled')).toBe('false'));
            // The listing was not asked again: only the read was.
            expect(getLibrary()).toHaveBeenCalledTimes(1);
            fireEvent.click(use());
            await waitFor(() => expect(onSave).toHaveBeenCalledWith([idOf(1), idOf(2)]));
        });

        test('a read that fails again says so with its own repeat text, and a second Retry still works', async () => {
            const reloadSaved = rereads(null, null, [idOf(1)]);
            setup({ value: [], savedCount: 1, reloadSaved });
            await screen.findByText(readFailedHint);
            fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
            await waitFor(() => expect(reloadSaved).toHaveBeenCalledTimes(2));
            await screen.findByText(readFailedAgainHint);
            expect(screen.queryByText(readFailedHint)).toBeNull();
            fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
            await waitFor(() => expect(pressed(1)).toBe('true'));
            expect(screen.queryByText(readFailedAgainHint)).toBeNull();
        });

        test('signed out is not a failed check: it says to log in again and offers no Retry', async () => {
            getLibrary().mockResolvedValue(listing([photo(1)], { memberId: null }));
            jest.mocked(window.api.confirmAccount).mockResolvedValueOnce({ success: false, error: 'not-logged-in' });
            setup({ value: [], savedCount: 1, reloadSaved: rereads() });
            await screen.findByText(unconfirmedHint);
            fireEvent.click(retryButton());
            await screen.findByText(notLoggedInHint);
            expect(screen.queryByText(checkFailedHint)).toBeNull();
            expect(screen.queryByText(/Press Retry again shortly/)).toBeNull();
            expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
            expect(use().getAttribute('aria-disabled')).toBe('true');
        });
    });

    test('locked tiles say they are locked, in every locked state, not that they can be entered, and the tile name says it too', async () => {
        const read = deferred<string[] | null>();
        setup({
            value: [],
            savedCount: 1,
            reloadSaved: jest.fn<Promise<string[] | null>, []>().mockReturnValue(read.promise),
        });
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        expect(tile(1).textContent).toContain(lockedText);
        expect(tile(1).textContent).not.toContain('Can be entered');
        expect(tile(1).getAttribute('aria-label')).toBe(`Photo 00000001: tag1. ${lockedText}`);
        await act(async () => read.resolve([]));
        await waitFor(() => expect(tile(1).textContent).toContain('Can be entered'));
        expect(tile(1).textContent).not.toContain(lockedText);
    });

    test('Clear is held while the list is unread: a press changes nothing, and it says why', async () => {
        const read = deferred<string[] | null>();
        setup({
            // A partial selection is visible while the saved list (two photos) is still unread.
            value: [idOf(2)],
            savedCount: 2,
            reloadSaved: jest.fn<Promise<string[] | null>, []>().mockReturnValue(read.promise),
        });
        await screen.findByRole('button', { name: /^Photo 00000002:/ });
        expect(pressed(2)).toBe('true');
        expect(countLine().textContent).toBe(`1 of ${MAX_CHOSEN_PHOTOS} chosen`);

        const clear = screen.getByRole('button', { name: 'Clear' });
        expect(clear.getAttribute('aria-disabled')).toBe('true');
        // Its own description says why Clear is held (not the Save hint).
        const why = document.getElementById(clear.getAttribute('aria-describedby')!)!;
        expect(why.textContent).toBe(
            "Clear is unavailable until your saved list has been read, so a late read can't undo it.",
        );
        expect(clear.getAttribute('aria-describedby')).not.toBe(use().getAttribute('aria-describedby'));

        // The press is ignored while the read is still out: the selection is untouched.
        fireEvent.click(clear);
        expect(pressed(2)).toBe('true');
        expect(countLine().textContent).toBe(`1 of ${MAX_CHOSEN_PHOTOS} chosen`);

        await act(async () => read.resolve([idOf(1), idOf(2)]));
        await waitFor(() => expect(pressed(1)).toBe('true'));
        expect(pressed(2)).toBe('true');
        const free = screen.getByRole('button', { name: 'Clear' });
        expect(free.getAttribute('aria-disabled')).toBe('false');
        expect(free.hasAttribute('aria-describedby')).toBe(false);
        expect(screen.queryByText(/Clear is unavailable/)).toBeNull();
    });

    test('no challenge to read through while the list is unread: the hint names only the ways out that exist', async () => {
        getLibrary().mockResolvedValue({ success: false, error: 'no-challenge-context' });
        setup({ value: [], savedCount: 1, challengeId: null, reloadSaved: rereads() });
        await screen.findByText(noContextHeldHint);
        // Clear is held, so the hint must not send the user to it; there is nothing to retry either.
        expect(noContextHeldHint).not.toMatch(/clear/i);
        expect(screen.queryByText(/Clear the list to save/)).toBeNull();
        expect(screen.getByRole('button', { name: 'Clear' }).getAttribute('aria-disabled')).toBe('true');
        expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
        expect(use().getAttribute('aria-disabled')).toBe('true');
    });

    test('after a failed read, a new ready listing reads as pending at once: the failure hint does not flash', async () => {
        const reloadSaved = rereads(null);
        const second = deferred<string[] | null>();
        reloadSaved.mockReturnValueOnce(second.promise);
        setup({ value: [], savedCount: 1, reloadSaved });
        await screen.findByText(readFailedHint);

        // A new search: loading, then a ready listing again. The read for it is pending, not failed.
        const next = deferred<Listing>();
        getLibrary().mockReturnValueOnce(invalid(next.promise));
        fireEvent.submit(screen.getByRole('searchbox').closest('form')!);
        await act(async () => next.resolve(listing([photo(1)])));
        expect(screen.queryByText(readFailedHint)).toBeNull();
        expect(screen.queryByText(unconfirmedHint)).toBeNull();
        expect(await screen.findByText(checkingHint)).toBeTruthy();
        await act(async () => second.resolve([idOf(1)]));
        await waitFor(() => expect(pressed(1)).toBe('true'));
    });

    test("another account: the ids stay withheld, the notice shows, nothing is re-read and Save is the user's choice", async () => {
        jest.mocked(window.api.getSetting).mockResolvedValue('d'.repeat(32));
        const reloadSaved = rereads();
        const { onSave } = setup({ value: [], savedCount: 2, reloadSaved });
        expect(await screen.findByText(/saved under another account, so the app ignores them/)).toBeTruthy();
        expect(screen.getByText('2 photo(s) saved under another account')).toBeTruthy();
        expect(reloadSaved).not.toHaveBeenCalled();
        expect(pressed(1)).toBe('false');
        await waitFor(() => expect(use().getAttribute('aria-disabled')).toBe('false'));
        fireEvent.click(tile(2));
        fireEvent.click(use());
        await waitFor(() => expect(onSave).toHaveBeenCalledWith([idOf(2)]));
    });

    test('a list that arrived with its ids is not held back at all, and its tiles work', async () => {
        const reloadSaved = rereads();
        setup({ value: [idOf(1)], savedCount: 1, reloadSaved });
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        expect(use().getAttribute('aria-disabled')).toBe('false');
        expect(tile(2).getAttribute('aria-disabled')).toBe('false');
        expect(reloadSaved).not.toHaveBeenCalled();
    });
});

describe('a row that inherits', () => {
    test('says that saving nothing makes it use the list from the settings or rules again', async () => {
        render(<PhotoChooserModal isOpen onClose={jest.fn()} value={[]} clearMeansInherit onSave={jest.fn()} />);
        expect(screen.getByText(/Saving with nothing chosen removes this challenge's own list/)).toBeTruthy();
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
    });

    test('says nothing of the kind elsewhere', async () => {
        setup();
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        expect(screen.queryByText(/removes this challenge's own list/)).toBeNull();
    });
});

test('explains how chosen photos are ranked and used', async () => {
    setup();
    expect(screen.getByText(/ranks chosen photos the way it ranks its own picks/)).toBeTruthy();
    await screen.findByRole('button', { name: /^Photo 00000001:/ });
});

test('Escape closes only the chooser when it is open inside another modal', async () => {
    const outerClose = jest.fn();
    const innerClose = jest.fn();
    const tree = (innerOpen: boolean) => (
        <Modal isOpen onClose={outerClose} title="outer">
            <PhotoChooserModal isOpen={innerOpen} onClose={innerClose} value={[]} onSave={jest.fn()} />
        </Modal>
    );
    const { rerender } = render(tree(false));
    // The chooser opens after the settings modal it sits in.
    rerender(tree(true));
    await screen.findByRole('button', { name: /^Photo 00000001:/ });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(innerClose).toHaveBeenCalledTimes(1);
    expect(outerClose).not.toHaveBeenCalled();
    // Once the chooser is gone the outer modal answers again, and the page stays locked until the last one closes.
    rerender(tree(false));
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(outerClose).toHaveBeenCalledTimes(1);
});
