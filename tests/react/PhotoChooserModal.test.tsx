/**
 * PhotoChooserModal: the Chosen Photos chooser on the shared Pick… picker. Nothing is read on open:
 * the saved picks show once the member check says they are this account's, Load all and Search read
 * the library, Auto (with a challenge) ranks and fills without a read. Selection is a numbered list
 * capped at MAX_CHOSEN_PHOTOS, listed picks keep their place in the library's order, a chosen id the
 * listing lacks gets its own tile, eligibility shows as text, search runs on submit and late
 * responses are dropped. Translations are the real English strings so the tiles are told apart by
 * their accessible names.
 */

import { act, fireEvent, render, screen, waitFor, within } from './helpers/test-utils';
import { PhotoChooserModal } from '@/components/app/PhotoChooserModal';
import { PhotoGrid } from '@/components/app/PhotoGrid';
import { useImageLoads } from '@/hooks/useImageLoads';
import { Modal } from '@/components/ui/Modal';
import { rememberCurrentMember } from '@/api/useChosenPhotosOwner';
import { fireSettingsChanged, mockTranslator } from './helpers/setup';
import { app } from '../../src/ts/translations/english';
import { MAX_CHOSEN_PHOTOS } from '../../src/ts/settings/limits';
import { invalid } from '../helpers/invalid';
import type { WindowApi } from '../../src/ts/types/ipc';

// Counts renders of the tiles: each PhotoTile render calls the hook once.
jest.mock('@/hooks/useImageLoads', () => {
    const actual = jest.requireActual<typeof import('@/hooks/useImageLoads')>('@/hooks/useImageLoads');
    return { __esModule: true, ...actual, useImageLoads: jest.fn(actual.useImageLoads) };
});

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
    wonIds: [],
    wonCount: 0,
    preview: false,
    readAtMs: 1_700_000_000_000,
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
const getSetting = () => jest.mocked(window.api.getSetting);
const confirm = () => jest.mocked(window.api.confirmAccount);

// The count line is the first live region; the footer's hold/confirmation status is the last.
const countLine = () => screen.getAllByRole('status')[0];

// Passive effects run after the next frame (preact schedules them with requestAnimationFrame, then a
// timeout): wait for exactly that, not for an arbitrary time, before judging what they did.
const effectsFlushed = () =>
    act(
        () =>
            new Promise<void>((resolve) => {
                requestAnimationFrame(() => setTimeout(resolve, 0));
            }),
    );

const tile = (n: number) => screen.getByRole('button', { name: new RegExp(`^Photo ${shortOf(n)}:`) });
// A saved pick while nothing is read: a stub, named as one.
const stubTile = (n: number) => screen.getByRole('button', { name: new RegExp(`^Chosen photo ${shortOf(n)}:`) });
const loadAll = () => fireEvent.click(screen.getByRole('button', { name: 'Load all photos' }));
const opened = async () => {
    loadAll();
    await screen.findByRole('button', { name: /^Photo 00000001:/ });
};

type Props = Parameters<typeof PhotoChooserModal>[0];
const setup = (
    over: Partial<{
        value: string[];
        challengeId: string | number | null;
        savedCount: number;
        canSuggest: boolean;
        reloadSaved: jest.MockedFunction<() => Promise<string[] | null>>;
        onSave: jest.MockedFunction<(ids: string[]) => boolean | Promise<boolean>>;
        onClose: jest.MockedFunction<() => void>;
    }> = {},
) => {
    const props: Props = {
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
    // mockReset, so a once-queued answer a failed test never consumed cannot leak into the next one.
    getSetting().mockReset().mockResolvedValue('');
    getLibrary()
        .mockReset()
        .mockResolvedValue(listing([photo(1), photo(2), photo(3)]));
    confirm().mockReset().mockResolvedValue({ success: true, memberId: MEMBER });
});

afterEach(() => {
    mockTranslator.t.mockImplementation((key) => key);
});

describe('opening', () => {
    test('renders nothing while closed', () => {
        render(<PhotoChooserModal isOpen={false} onClose={jest.fn()} value={[]} onSave={jest.fn()} />);
        // The dialog is portalled to the body, so that is where it would show up.
        expect(document.body.querySelector('[role="dialog"]')).toBeNull();
        expect(getLibrary()).not.toHaveBeenCalled();
    });

    test('reads nothing on open: an idle line, Load all, Search and no Auto without a challenge', () => {
        setup({ challengeId: null });
        expect(getLibrary()).not.toHaveBeenCalled();
        expect(confirm()).not.toHaveBeenCalled();
        const idle = screen.getByText(/^Your photos are not loaded yet\./);
        expect(idle.getAttribute('role')).toBe('status');
        expect(idle.textContent).toBe('Your photos are not loaded yet. Load them all or search.');
        expect(screen.getByRole('button', { name: 'Load all photos' })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Search' })).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Auto' })).toBeNull();
        // The help names no Auto and no challenge where there is none.
        expect(screen.getByText(/^The app uses these photos first/).textContent).not.toMatch(
            /press Auto|challenge's own settings/,
        );
    });

    test('with a challenge Auto is offered and the idle line names it', () => {
        setup();
        expect(screen.getByRole('button', { name: 'Auto' })).toBeTruthy();
        expect(screen.getByText(/^Your photos are not loaded yet\./).textContent).toBe(
            'Your photos are not loaded yet. Load them all, search, or press Auto.',
        );
        expect(screen.getByText(/^Auto ranks your photos/).textContent).toContain('Nothing is saved');
    });

    test('a Discover row (a challenge, but not joined) offers no Auto and its help says so', () => {
        setup({ canSuggest: false });
        expect(screen.queryByRole('button', { name: 'Auto' })).toBeNull();
        // The challenge is real, so the listing would read through it — but nothing ranks.
        expect(jest.mocked(window.api.suggestPhotos)).not.toHaveBeenCalled();
        expect(screen.getByText(/^Your photos are not loaded yet\./).textContent).toBe(
            'Your photos are not loaded yet. Load them all or search.',
        );
    });

    test('Load all reads the library through the challenge it was opened for', async () => {
        setup({ challengeId: 42 });
        await opened();
        expect(getLibrary()).toHaveBeenCalledWith(42, undefined, 'cached', 'submit');
    });

    test('the saved picks show as numbered stubs once the check says they are this account’s, and Save is not held', async () => {
        getSetting().mockResolvedValue(MEMBER);
        setup({ value: [idOf(1), idOf(3)] });
        expect(await screen.findByRole('button', { name: /^Chosen photo 00000003:/ })).toBeTruthy();
        expect(stubTile(1).getAttribute('aria-pressed')).toBe('true');
        expect(stubTile(3).getAttribute('aria-pressed')).toBe('true');
        // Numbered as the list's order, in badge and name.
        expect(within(stubTile(1)).getByText('1')).toBeTruthy();
        expect(within(stubTile(3)).getByText('2')).toBeTruthy();
        expect(stubTile(1).getAttribute('aria-label')).toMatch(/Number 1 in your list\.$/);
        // The member matches the owner, so the thumbnails come through.
        expect(stubTile(1).querySelector('img')?.getAttribute('src')).toContain(MEMBER);
        expect(stubTile(1).querySelector('img')?.getAttribute('referrerpolicy')).toBe('no-referrer');
        // No library read happened.
        expect(getLibrary()).not.toHaveBeenCalled();
        expect(screen.getByRole('button', { name: 'Use these photos' }).getAttribute('aria-disabled')).toBe('false');
        const picks = screen.getByText(/^Your chosen photos stay picked\./);
        expect(picks.getAttribute('role')).toBe('status');
    });

    test('a stub claims nothing about the photo itself: no tags, only that it is not loaded', async () => {
        getSetting().mockResolvedValue(MEMBER);
        setup({ value: [idOf(1)] });
        const stub = await screen.findByRole('button', { name: /^Chosen photo 00000001:/ });
        expect(stub.getAttribute('aria-label')).toBe(
            `Chosen photo ${shortOf(1)}: Not loaded yet. Number 1 in your list.`,
        );
        expect(stub.textContent).toContain('Not loaded yet');
        expect(stub.textContent).not.toContain('No tags');
    });

    test('a stub whose thumbnail fails to load falls back to its short id, only that stub', async () => {
        getSetting().mockResolvedValue(MEMBER);
        setup({ value: [idOf(1), idOf(2)] });
        await screen.findByRole('button', { name: /^Chosen photo 00000001:/ });
        act(() => {
            stubTile(1).querySelector('img')!.dispatchEvent(new Event('error'));
        });
        expect(stubTile(1).querySelector('img')).toBeNull();
        expect(stubTile(1).textContent).toContain(shortOf(1));
        expect(stubTile(2).querySelector('img')).not.toBeNull();
    });

    test('a list with no owner on record shows text-only stubs once any member is known', async () => {
        setup({ value: [idOf(1)] });
        const stub = await screen.findByRole('button', { name: /^Chosen photo 00000001:/ });
        expect(stub.querySelector('img')).toBeNull();
        expect(stub.textContent).toContain(shortOf(1));
        expect(getLibrary()).not.toHaveBeenCalled();
    });

    test('stubs are togglable and keep their place unpicked, offered again while there is room', async () => {
        setup({ value: [idOf(1)] });
        await screen.findByRole('button', { name: /^Chosen photo 00000001:/ });
        const stub = stubTile(1);
        fireEvent.click(stub);
        expect(stub.getAttribute('aria-pressed')).toBe('false');
        expect(countLine().textContent).toBe(`0 of ${MAX_CHOSEN_PHOTOS} chosen`);
        fireEvent.click(stub);
        expect(stub.getAttribute('aria-pressed')).toBe('true');
        expect(within(stubTile(1)).getByText('1')).toBeTruthy();
    });

    test('with no list and no owner on record, Auto and Add still fill, and the line names the picks', async () => {
        jest.mocked(window.api.suggestPhotos).mockResolvedValueOnce({
            success: true,
            memberId: MEMBER,
            photos: [photo(5)],
            statsLimited: false,
        });
        setup({ value: [] });
        // No check ran (nothing is on record) and nothing waits: the plain idle line.
        expect(confirm()).not.toHaveBeenCalled();
        expect(screen.getByText(/^Your photos are not loaded yet\./).textContent).toBe(
            'Your photos are not loaded yet. Load them all, search, or press Auto.',
        );
        fireEvent.click(screen.getByRole('button', { name: 'Auto' }));
        const strip = await screen.findByRole('region', { name: 'Suggestions' });
        fireEvent.click(within(strip).getByRole('button', { name: 'Add suggestions' }));
        const inGrid = screen.getAllByRole('button', { name: /^Photo 00000005:/ }).find((el) => !strip.contains(el))!;
        expect(inGrid.getAttribute('aria-pressed')).toBe('true');
        // The line follows the picks, not the gate.
        expect(screen.getByText(/^Your chosen photos stay picked\./).getAttribute('role')).toBe('status');
        expect(screen.queryByText(/^Your photos are not loaded yet\./)).toBeNull();
        expect(getLibrary()).not.toHaveBeenCalled();
    });

    test('the numbering survives the switch from idle stubs to the read library', async () => {
        getSetting().mockResolvedValue(MEMBER);
        setup({ value: [idOf(3), idOf(1)] });
        await screen.findByRole('button', { name: /^Chosen photo 00000001:/ });
        expect(within(stubTile(3)).getByText('1')).toBeTruthy();
        expect(within(stubTile(1)).getByText('2')).toBeTruthy();
        await opened();
        // The same order, now as tiles of the listing.
        expect(tile(3).getAttribute('aria-label')).toMatch(/Number 1 in your list\.$/);
        expect(tile(1).getAttribute('aria-label')).toMatch(/Number 2 in your list\.$/);
        expect(screen.queryByRole('button', { name: /^Chosen photo / })).toBeNull();
    });
});
describe('closing with unsaved picks', () => {
    const backdrop = () => document.querySelector<HTMLElement>('.modal-backdrop')!;
    const discardTitle = 'Discard your changes?';

    test('Escape and the backdrop close at once while the selection is the saved one', async () => {
        const { onClose } = setup({ value: [idOf(1)] });
        await screen.findByRole('button', { name: /^Chosen photo 00000001:/ });
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);
        fireEvent.click(backdrop());
        expect(onClose).toHaveBeenCalledTimes(2);
        expect(screen.queryByText(discardTitle)).toBeNull();
    });

    test('Escape, the backdrop and the close button ask before discarding a changed selection', async () => {
        const { onClose, onSave } = setup({ value: [idOf(1)] });
        await opened();
        fireEvent.click(tile(2));

        fireEvent.keyDown(document, { key: 'Escape' });
        expect(screen.getByText(discardTitle)).toBeTruthy();
        expect(onClose).not.toHaveBeenCalled();
        // Escape closes the question only; the picks are still there.
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(screen.queryByText(discardTitle)).toBeNull();
        expect(tile(2).getAttribute('aria-pressed')).toBe('true');

        fireEvent.click(backdrop());
        expect(screen.getByText(discardTitle)).toBeTruthy();
        fireEvent.click(
            within(screen.getByText(discardTitle).closest('[role="dialog"]') as HTMLElement).getByRole('button', {
                name: 'Cancel',
            }),
        );
        expect(screen.queryByText(discardTitle)).toBeNull();

        fireEvent.click(screen.getByRole('button', { name: 'common.closeModal' }));
        fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(onSave).not.toHaveBeenCalled();
    });

    test('putting the selection back to the saved one closes without asking; the same photos in another order is a change', async () => {
        const { onClose } = setup({ value: [idOf(1), idOf(2)] });
        await opened();
        fireEvent.click(tile(2));
        fireEvent.click(tile(2));
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);

        fireEvent.click(tile(1));
        fireEvent.click(tile(1));
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(screen.getByText(discardTitle)).toBeTruthy();
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    test('a modal the parent keeps mounted does not reopen on the discard question', async () => {
        const { rerender, onClose, onSave } = setup({ value: [idOf(1)] });
        await opened();
        fireEvent.click(tile(2));
        fireEvent.keyDown(document, { key: 'Escape' });
        fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
        expect(onClose).toHaveBeenCalledTimes(1);
        // The parent closes it, and opens it again later.
        rerender(<PhotoChooserModal isOpen={false} onClose={onClose} value={[idOf(1)]} onSave={onSave} />);
        rerender(<PhotoChooserModal isOpen onClose={onClose} value={[idOf(1)]} onSave={onSave} />);
        await screen.findByRole('button', { name: /^Chosen photo 00000001:/ });
        expect(screen.queryByText(discardTitle)).toBeNull();

        // A question left open when the parent closes the chooser is gone too.
        loadAll();
        await screen.findByRole('button', { name: /^Photo 00000002:/ });
        fireEvent.click(tile(2));
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(screen.getByText(discardTitle)).toBeTruthy();
        rerender(<PhotoChooserModal isOpen={false} onClose={onClose} value={[idOf(1)]} onSave={onSave} />);
        rerender(<PhotoChooserModal isOpen onClose={onClose} value={[idOf(1)]} onSave={onSave} />);
        await screen.findByRole('button', { name: /^Chosen photo 00000001:/ });
        expect(screen.queryByText(discardTitle)).toBeNull();
    });

    test('a saved list read late is the list to compare with, not a change', async () => {
        const reloadSaved = jest.fn().mockResolvedValue([idOf(1)]);
        getSetting().mockResolvedValue(MEMBER);
        const { onClose } = setup({ value: [], savedCount: 1, reloadSaved });
        await screen.findByRole('button', { name: /^Chosen photo 00000001:/ });
        await waitFor(() => expect(stubTile(1).getAttribute('aria-pressed')).toBe('true'));
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});

describe('listing and tiles', () => {
    test('picking one photo re-renders only that tile', async () => {
        setup();
        await opened();
        const rendered = jest.mocked(useImageLoads);
        rendered.mockClear();
        fireEvent.click(tile(1));
        expect(tile(1).getAttribute('aria-pressed')).toBe('true');
        expect(rendered).toHaveBeenCalledTimes(1);
    });

    test('a selected tile has a base-content border and ring, no background change; an unselected one keeps the quiet border', async () => {
        setup({ value: [idOf(1)] });
        await opened();
        const selected = tile(1).classList;
        const unselected = tile(2).classList;
        expect(selected.contains('border-base-content')).toBe(true);
        expect(selected.contains('border-base-300')).toBe(false);
        expect(selected.contains('ring-base-content')).toBe(true);
        expect(tile(1).className).not.toMatch(/\bbg-/);
        expect(unselected.contains('border-base-300')).toBe(true);
        expect(unselected.contains('border-base-content')).toBe(false);
        expect(unselected.contains('ring-base-content')).toBe(false);
    });

    test('every tile carries an offset focus outline that clears the selection ring', async () => {
        setup({ value: [idOf(1)] });
        await opened();
        const outline = [
            'focus-visible:outline-2',
            'focus-visible:outline-offset-4',
            'focus-visible:outline-base-content',
        ];
        for (const n of [1, 2]) {
            // The missing classes are named, so a failure says which one went.
            expect(outline.filter((cls) => !tile(n).classList.contains(cls))).toEqual([]);
        }
    });

    test('shows the loader, then a tile per photo with a lazy, referrer-less CDN thumbnail', async () => {
        const pending = deferred<Listing>();
        getLibrary().mockReturnValueOnce(invalid(pending.promise));
        setup();
        loadAll();
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

    test('a photo with no usable URL becomes a text tile with its tags and short id', async () => {
        getLibrary().mockResolvedValue(
            listing([photo(1, { labels: ['red', 'sea'] }), photo(2, { labels: [] })], { memberId: null }),
        );
        setup();
        loadAll();
        const first = await screen.findByRole('button', { name: /^Photo 00000001:/ });
        expect(first.querySelector('img')).toBeNull();
        expect(first.textContent).toContain('red, sea');
        expect(first.textContent).toContain(shortOf(1));
        expect(tile(2).textContent).toContain('No tags');
    });

    test('a thumbnail that fails to load falls back to the text tile', async () => {
        setup();
        await opened();
        act(() => {
            tile(1).querySelector('img')!.dispatchEvent(new Event('error'));
        });
        expect(tile(1).querySelector('img')).toBeNull();
        expect(tile(1).textContent).toContain(shortOf(1));
        // Only that tile: the others keep their pictures.
        expect(tile(2).querySelector('img')).not.toBeNull();
    });

    test('server-supplied tags and reasons are rendered as text, never as markup', async () => {
        getLibrary().mockResolvedValue(
            listing([photo(1, { labels: ['<img src=x onerror=alert(1)>'], allowed: false, message: '<b>no</b>' })]),
        );
        setup();
        loadAll();
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        expect(document.querySelector('[role="dialog"] b')).toBeNull();
        expect(document.querySelector('img[src="x"]')).toBeNull();
        expect(screen.getByText('<b>no</b>')).toBeTruthy();
    });

    test('shows the empty state when the library has no photos', async () => {
        getLibrary().mockResolvedValue(listing([]));
        setup();
        loadAll();
        expect(await screen.findByText(/No photos found/)).toBeTruthy();
    });

    test('says when the listing was cut off', async () => {
        getLibrary().mockResolvedValue(listing([photo(1), photo(2)], { truncated: true }));
        setup();
        loadAll();
        expect(await screen.findByText('Showing the first 2 photos. Search by tag to find others.')).toBeTruthy();
    });

    test('no truncation note for a complete listing', async () => {
        setup();
        await opened();
        expect(screen.queryByText(/Showing the first/)).toBeNull();
    });
});
describe('selection', () => {
    test('Save sits in a footer pinned to the bottom of the modal box, which keeps focus above it', async () => {
        setup();
        await opened();
        const footer = screen.getByRole('button', { name: 'Use these photos' }).closest('.sticky')!;
        expect(footer.parentElement!.lastElementChild).toBe(footer);
        const box = document.querySelector('.modal-box')!;
        expect(box.lastElementChild).toBe(footer.parentElement);
        const boxClasses = box.classList;
        expect(boxClasses.contains('scroll-pb-[min(24rem,50dvh)]')).toBe(true);
        expect(boxClasses.contains('md:scroll-pb-[min(12rem,50dvh)]')).toBe(true);
        expect(boxClasses.contains('scroll-pb-60')).toBe(false);
        expect(boxClasses.contains('md:scroll-pb-32')).toBe(false);
    });

    test('toggles a photo on and off (aria-pressed) and saves the chosen ids', async () => {
        const { onSave, onClose } = setup();
        await opened();
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

    describe('the numbers: the order the photos are saved in', () => {
        const badge = (n: number) => within(tile(n)).queryByText(/^\d+$/)?.textContent ?? null;

        test('selected tiles are numbered 1, 2, 3 in the order picked, in a visible badge and in the name; the rest are not', async () => {
            setup();
            await opened();
            fireEvent.click(tile(3));
            fireEvent.click(tile(1));
            fireEvent.click(tile(2));
            expect([badge(3), badge(1), badge(2)]).toEqual(['1', '2', '3']);
            expect(tile(3).getAttribute('aria-label')).toBe(
                'Photo 00000003: tag3. Can be entered. Number 1 in your list.',
            );
            expect(tile(2).getAttribute('aria-label')).toMatch(/Number 3 in your list\.$/);
            // The tiles keep the library's order: picking does not move them.
            const order = screen
                .getAllByRole('button', { name: /^Photo / })
                .map((button) => button.getAttribute('aria-label')!.slice(6, 14));
            expect(order).toEqual([shortOf(1), shortOf(2), shortOf(3)]);
        });

        test('an unselected tile has no number and its name is unchanged', async () => {
            setup();
            await opened();
            expect(badge(1)).toBeNull();
            expect(tile(1).getAttribute('aria-label')).toBe('Photo 00000001: tag1. Can be entered');
        });

        test('deselecting moves the later ones up, and selecting again puts the photo last', async () => {
            setup({ value: [idOf(1), idOf(2), idOf(3)] });
            await opened();
            expect([badge(1), badge(2), badge(3)]).toEqual(['1', '2', '3']);
            fireEvent.click(tile(1));
            expect([badge(2), badge(3)]).toEqual(['1', '2']);
            expect(badge(1)).toBeNull();
            fireEvent.click(tile(1));
            expect([badge(2), badge(3), badge(1)]).toEqual(['1', '2', '3']);
        });

        test('a saved photo the listing lacks keeps its place in the numbering, with no gap before the next', async () => {
            setup({ value: [idOf(1), idOf(9), idOf(2)] });
            loadAll();
            const missing = await screen.findByRole('button', { name: new RegExp(`^Chosen photo ${shortOf(9)}:`) });
            expect(within(missing).getByText('2')).toBeTruthy();
            expect(missing.getAttribute('aria-label')).toMatch(/Number 2 in your list\.$/);
            expect([badge(1), badge(2)]).toEqual(['1', '3']);
        });

        test('the numbers go to the saved list as its order', async () => {
            const { onSave } = setup();
            await opened();
            fireEvent.click(tile(2));
            fireEvent.click(tile(3));
            fireEvent.click(tile(1));
            fireEvent.click(screen.getByRole('button', { name: 'Use these photos' }));
            await waitFor(() => expect(onSave).toHaveBeenCalledWith([idOf(2), idOf(3), idOf(1)]));
        });
    });

    test('starts from the saved value', async () => {
        setup({ value: [idOf(1)] });
        await opened();
        expect(tile(1).getAttribute('aria-pressed')).toBe('true');
    });

    test('listed picks keep their place in the library order, and toggling one does not move any tile', async () => {
        getLibrary().mockResolvedValue(listing([photo(1), photo(2), photo(3)]));
        setup({ value: [idOf(3)] });
        await opened();
        const order = () =>
            screen
                .getAllByRole('button', { name: /^Photo / })
                .map((button) => button.getAttribute('aria-label')!.slice(6, 14));
        expect(order()).toEqual([shortOf(1), shortOf(2), shortOf(3)]);
        fireEvent.click(tile(1));
        fireEvent.click(tile(3));
        expect(order()).toEqual([shortOf(1), shortOf(2), shortOf(3)]);
        expect(within(tile(1)).getByText('1')).toBeTruthy();
    });

    test('picks the listing does not return stay pinned first, numbered in pick order with the listed ones', async () => {
        getLibrary().mockResolvedValue(listing([photo(1), photo(2), photo(3)]));
        setup({ value: [idOf(3), idOf(9), idOf(1)] });
        loadAll();
        const missing = await missingTile();
        expect(missing.getAttribute('aria-label')).toMatch(/Number 2 in your list\.$/);
        const order = screen.getAllByRole('button', { name: /^(Photo|Chosen photo) / }).map((button) =>
            button
                .getAttribute('aria-label')!
                .replace(/^(Photo|Chosen photo) /, '')
                .slice(0, 8),
        );
        expect(order).toEqual([shortOf(9), shortOf(1), shortOf(2), shortOf(3)]);
        expect(tile(3).getAttribute('aria-label')).toMatch(/Number 1 in your list\.$/);
        expect(tile(1).getAttribute('aria-label')).toMatch(/Number 3 in your list\.$/);
        expect(tile(2).getAttribute('aria-label')).not.toMatch(/Number/);
    });

    const missingTile = () => screen.findByRole('button', { name: new RegExp(`^Chosen photo ${shortOf(9)}:`) });

    test('a chosen photo the listing lacks gets a not-available tile that can still be removed', async () => {
        getLibrary().mockResolvedValue(listing([photo(1), photo(2)]));
        setup({ value: [idOf(9)] });
        loadAll();
        const missing = await missingTile();
        // A complete listing: no "beyond the first N photos" clause.
        expect(missing.textContent).toContain('Not available for this challenge (in another challenge, or deleted)');
        expect(missing.getAttribute('aria-label')).toBe(
            `Chosen photo ${shortOf(9)}: Not available for this challenge (in another challenge, or deleted). Number 1 in your list.`,
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
        loadAll();
        expect((await missingTile()).textContent).toContain(text);
    });

    test('says how many winning photos the listing left out, and only when it left some out', async () => {
        getLibrary().mockResolvedValue(listing([photo(1)], { wonIds: [idOf(7), idOf(8)], wonCount: 2 }));
        setup();
        await opened();
        expect(
            screen.getByText("Hidden: 2 photo(s) that have won a challenge. A winning photo can't be entered again."),
        ).toBeTruthy();
    });

    test('the hidden count is the listing’s own count, not the length of its capped id list', async () => {
        getLibrary().mockResolvedValue(listing([photo(1)], { wonIds: [idOf(7)], wonCount: 1500 }));
        setup();
        await opened();
        expect(screen.getByText(/^Hidden: 1500 photo\(s\)/)).toBeTruthy();
    });

    test('a cut-off listing says at least that many were hidden', async () => {
        getLibrary().mockResolvedValue(listing([photo(1)], { wonIds: [idOf(7)], wonCount: 1, truncated: true }));
        setup();
        await opened();
        expect(
            screen.getByText(
                "Hidden: at least 1 photo(s) that have won a challenge. A winning photo can't be entered again.",
            ),
        ).toBeTruthy();
    });

    test('shows no winning-photo line when none were left out', async () => {
        getLibrary().mockResolvedValue(listing([photo(1)]));
        setup();
        await opened();
        expect(screen.queryByText(/have won a challenge/)).toBeNull();
    });

    test('a listing with every match hidden says so instead of "No photos found"', async () => {
        getLibrary().mockResolvedValue(listing([], { wonIds: [idOf(7)], wonCount: 1 }));
        setup();
        loadAll();
        expect(
            await screen.findByText(
                'No photos you can enter were found: every match has won a challenge. Try another tag, or upload new photos to your GuruShots library and press Refresh.',
            ),
        ).toBeTruthy();
        expect(screen.queryByText(/^No photos found/)).toBeNull();
    });

    test('a cut-off listing with nothing kept does not claim every match has won: eligible photos may lie beyond what was read', async () => {
        getLibrary().mockResolvedValue(listing([], { wonIds: [idOf(7)], wonCount: 1, truncated: true }));
        setup();
        loadAll();
        expect(await screen.findByText(/^No photos found\./)).toBeTruthy();
        expect(screen.queryByText(/every match has won/)).toBeNull();
        expect(screen.getByText(/^Hidden: at least 1 photo/)).toBeTruthy();
    });

    test('a chosen photo that has won gets its own tile text, with the next step, and can still be removed', async () => {
        getLibrary().mockResolvedValue(listing([photo(1)], { wonIds: [idOf(9)], wonCount: 1 }));
        setup({ value: [idOf(9)] });
        loadAll();
        const won = await missingTile();
        expect(won.textContent).toContain(
            "Has won a challenge, so it can't be entered again. Click it to remove it from your list.",
        );
        expect(won.textContent).not.toContain('Not available for this challenge');
        expect(won.getAttribute('aria-pressed')).toBe('true');
        fireEvent.click(won);
        expect(screen.queryByRole('button', { name: new RegExp(`^Chosen photo ${shortOf(9)}:`) })).toBeNull();
    });

    test('a chosen photo keeps its has-won text after a search whose listing no longer names it', async () => {
        getLibrary()
            .mockResolvedValueOnce(listing([photo(1)], { wonIds: [idOf(9)], wonCount: 1 }))
            .mockResolvedValueOnce(listing([photo(2)]));
        setup({ value: [idOf(9)] });
        loadAll();
        expect((await missingTile()).textContent).toContain("Has won a challenge, so it can't be entered again.");
        fireEvent.change(screen.getByLabelText('Search your photos by tag'), { target: { value: 'x' } });
        fireEvent.submit(screen.getByLabelText('Search your photos by tag').closest('form')!);
        await screen.findByRole('button', { name: /^Photo 00000002:/ });
        // The count line describes this listing, which hid nothing; the tile still says why it is missing.
        expect(screen.queryByText(/^Hidden:/)).toBeNull();
        const won = await missingTile();
        expect(won.textContent).toContain("Has won a challenge, so it can't be entered again.");
        expect(won.textContent).not.toContain('Not available for this challenge');
    });

    test('stops at the cap: other photos cannot be added and a line says so, selected ones can still be removed', async () => {
        const many = Array.from({ length: MAX_CHOSEN_PHOTOS + 1 }, (_, n) => photo(n + 1));
        getLibrary().mockResolvedValue(listing(many));
        setup({ value: many.slice(0, MAX_CHOSEN_PHOTOS).map((p) => p.id) });
        loadAll();
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

    test('the footer buttons read Clear apart on the left, then Cancel, then the primary rightmost', async () => {
        setup();
        await opened();
        const footer = screen.getByRole('button', { name: 'Clear' }).parentElement!.parentElement!;
        expect(Array.from(footer.querySelectorAll('button')).map((button) => button.textContent)).toEqual([
            'Clear',
            'Cancel',
            'Use these photos',
        ]);
        // Apart on the left; below sm it takes the first row so Cancel and Save wrap together onto the second.
        expect(screen.getByRole('button', { name: 'Clear' }).parentElement!.className).toBe(
            'mr-auto max-sm:basis-full',
        );
    });

    test('Clear empties the selection and Cancel closes without saving', async () => {
        const { onSave, onClose } = setup({ value: [idOf(1)] });
        await opened();
        const clear = screen.getByRole('button', { name: 'Clear' });
        expect(clear.className).toContain('btn-error');
        expect(clear.className).not.toContain('btn-outline');
        fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
        expect(tile(1).getAttribute('aria-pressed')).toBe('false');
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(onSave).not.toHaveBeenCalled();
    });
});
describe('PhotoGrid numbering when a selected photo is left out of the grid', () => {
    // Selected [1, 9, 2], where 9 is not in the listing: with another account's list it is not shown.
    const grid = (hideUnlisted: boolean) => {
        const photos = [photo(1), photo(2), photo(3)];
        return render(
            <PhotoGrid
                state={{ status: 'ready', listing: listing(photos) }}
                known={new Map(photos.map((p) => [p.id, p]))}
                selected={[idOf(1), idOf(9), idOf(2)]}
                hideUnlisted={hideUnlisted}
                locked={false}
                hasChallenge
                revalidating={false}
                recheckFailed={false}
                onToggle={jest.fn()}
                onRetry={jest.fn()}
                onRefresh={jest.fn()}
            />,
        );
    };
    const numberOf = (n: number) => within(tile(n)).queryByText(/^\d+$/)?.textContent ?? null;

    test('the visible tiles are numbered 1 and 2, with no gap where the hidden one was, in badge and name', () => {
        grid(true);
        expect([numberOf(1), numberOf(2)]).toEqual(['1', '2']);
        expect(tile(1).getAttribute('aria-label')).toMatch(/Number 1 in your list\.$/);
        expect(tile(2).getAttribute('aria-label')).toMatch(/Number 2 in your list\.$/);
        expect(screen.queryByRole('button', { name: new RegExp(`^Chosen photo ${shortOf(9)}:`) })).toBeNull();
        // The unselected tile has none.
        expect(numberOf(3)).toBeNull();
    });

    test('shown (this account), the unlisted photo holds its place and the next one is 3', () => {
        grid(false);
        const missing = screen.getByRole('button', { name: new RegExp(`^Chosen photo ${shortOf(9)}:`) });
        expect(missing.getAttribute('aria-label')).toMatch(/Number 2 in your list\.$/);
        expect([numberOf(1), numberOf(2)]).toEqual(['1', '3']);
        expect(tile(2).getAttribute('aria-label')).toMatch(/Number 3 in your list\.$/);
    });
});

describe('PhotoGrid as a plain set (max, fullKey, numbered)', () => {
    const photos = [photo(1), photo(2), photo(3)];
    const grid = (props: Partial<Parameters<typeof PhotoGrid>[0]> = {}) =>
        render(
            <PhotoGrid
                state={{ status: 'ready', listing: listing(photos) }}
                known={new Map(photos.map((p) => [p.id, p]))}
                selected={[idOf(1), idOf(9)]}
                hideUnlisted={false}
                locked={false}
                hasChallenge
                revalidating={false}
                recheckFailed={false}
                onToggle={jest.fn()}
                onRetry={jest.fn()}
                onRefresh={jest.fn()}
                {...props}
            />,
        );

    test('unnumbered: no badge and no position in any selected tile, the missing one included', () => {
        grid({ numbered: false });
        expect(tile(1).querySelector('.badge')).toBeNull();
        expect(tile(1).getAttribute('aria-label')).not.toMatch(/Number/);
        const missing = screen.getByRole('button', { name: new RegExp(`^Chosen photo ${shortOf(9)}:`) });
        expect(missing.querySelector('.badge')).toBeNull();
        expect(missing.getAttribute('aria-label')).not.toMatch(/Number/);
    });

    test('an unnumbered selected tile has no badge, so it is marked by the border and ring', () => {
        grid({ numbered: false });
        expect(tile(1).className).toContain('border-base-content');
        expect(tile(1).className).toContain('ring-base-content');
        expect(tile(1).className).not.toMatch(/\bbg-/);
        expect(tile(2).className).not.toContain('ring-base-content');
    });

    test('by default selected tiles are numbered', () => {
        grid();
        expect(tile(1).getAttribute('aria-label')).toMatch(/Number 1 in your list\.$/);
    });

    test('a smaller max stops offering tiles once reached, with the given full text', () => {
        grid({ max: 2, fullKey: 'app.pickFull' });
        expect(tile(2).getAttribute('aria-disabled')).toBe('true');
        expect(tile(2).textContent).toContain('All open slots picked');
        expect(tile(2).textContent).not.toContain('List full');
    });

    test('by default the cap is the Chosen Photos one and the text is "List full"', () => {
        grid({ selected: Array.from({ length: MAX_CHOSEN_PHOTOS }, (_, i) => idOf(i + 10)) });
        expect(tile(1).getAttribute('aria-disabled')).toBe('true');
        expect(tile(1).textContent).toContain('List full');
    });
});

describe('PhotoGrid before any listing is read (idle)', () => {
    const extra = new Map([photo(1), photo(2)].map((p) => [p.id, p]));
    const grid = (props: Partial<Parameters<typeof PhotoGrid>[0]> = {}) =>
        render(
            <PhotoGrid
                state={{ status: 'idle' }}
                known={new Map()}
                selected={[]}
                hideUnlisted={false}
                locked={false}
                hasChallenge
                revalidating={false}
                recheckFailed={false}
                numbered={false}
                onToggle={jest.fn()}
                onRetry={jest.fn()}
                onRefresh={jest.fn()}
                {...props}
            />,
        );
    const idleLine = () => screen.getByText(/^Photos are not loaded yet/);

    test('with no picks it says nothing is loaded and shows no tile', () => {
        grid({ extraPhotos: extra });
        expect(idleLine().getAttribute('role')).toBe('status');
        expect(idleLine().textContent).toBe('Photos are not loaded yet. Load them all, search, or press Auto.');
        expect(screen.queryByRole('button')).toBeNull();
    });

    test('the idle line is the caller’s key, so a chooser without Auto can name its own', () => {
        grid({ extraPhotos: extra, idleKey: 'app.photoChooserIdle' });
        expect(screen.getByText(/^Your photos are not loaded yet\./).textContent).toBe(
            'Your photos are not loaded yet. Load them all or search.',
        );
    });

    test('a pick found in extraPhotos shows as a pressed, unnumbered tile with the idle member’s thumbnail and toggles', () => {
        const onToggle = jest.fn();
        grid({ selected: [idOf(2)], extraPhotos: extra, idleMemberId: MEMBER, onToggle });
        expect(screen.getByText(/^Your picks can be submitted as they are/).getAttribute('role')).toBe('status');
        expect(screen.queryByText(/^Photos are not loaded yet/)).toBeNull();
        expect(screen.getAllByRole('button')).toHaveLength(1);
        expect(tile(2).getAttribute('aria-pressed')).toBe('true');
        expect(tile(2).querySelector('.badge')).toBeNull();
        expect(tile(2).textContent).not.toContain('Can be entered');
        expect(tile(2).querySelector('img')?.getAttribute('src')).toContain(MEMBER);
        fireEvent.click(tile(2));
        expect(onToggle).toHaveBeenCalledWith(idOf(2));
    });

    test('idleIds keeps an unpicked tile in place, offered again while there is room and held at the cap', () => {
        const onToggle = jest.fn();
        const props = { selected: [idOf(2)], idleIds: [idOf(1), idOf(2)], extraPhotos: extra, onToggle };
        const { unmount } = grid({ ...props, max: 3 });
        expect(screen.getAllByRole('button')).toHaveLength(2);
        expect(tile(1).getAttribute('aria-pressed')).toBe('false');
        expect(tile(1).getAttribute('aria-disabled')).toBe('false');
        fireEvent.click(tile(1));
        expect(onToggle).toHaveBeenCalledWith(idOf(1));
        unmount();
        grid({ ...props, max: 1 });
        expect(tile(1).getAttribute('aria-disabled')).toBe('true');
        expect(tile(2).getAttribute('aria-disabled')).toBe('false');
    });

    test('a pick missing from extraPhotos renders nothing while no saved picks are allowed', () => {
        grid({ selected: [idOf(9)], extraPhotos: extra });
        expect(screen.queryByRole('button')).toBeNull();
    });

    test('without extraPhotos a pick renders nothing', () => {
        grid({ selected: [idOf(1)] });
        expect(screen.getByText(/^Your picks can be submitted as they are/)).toBeTruthy();
        expect(screen.queryByRole('button')).toBeNull();
    });

    test('a saved pick without a record shows as a stub with the member it is allowed, numbered when the grid is', () => {
        const onToggle = jest.fn();
        grid({
            selected: [idOf(9), idOf(1)],
            extraPhotos: extra,
            savedPicks: { memberId: MEMBER },
            numbered: true,
            onToggle,
        });
        // The record (an Auto pick, say) is a real tile; the bare id is a stub after it.
        expect(screen.getAllByRole('button')).toHaveLength(2);
        const stub = stubTile(9);
        expect(stub.getAttribute('aria-pressed')).toBe('true');
        expect(within(stub).getByText('1')).toBeTruthy();
        expect(stub.getAttribute('aria-label')).toBe(
            `Chosen photo ${shortOf(9)}: Not loaded yet. Number 1 in your list.`,
        );
        expect(within(tile(1)).getByText('2')).toBeTruthy();
        expect(stub.querySelector('img')?.getAttribute('src')).toContain(MEMBER);
        fireEvent.click(stub);
        expect(onToggle).toHaveBeenCalledWith(idOf(9));
    });

    test('a stub with no member is text-only, and a locked one says the locked key and is inert', () => {
        grid({
            selected: [idOf(9)],
            savedPicks: { memberId: null },
            locked: true,
            lockedKey: 'app.photoChooserTileLocked',
        });
        const stub = screen.getByRole('button', {
            name: new RegExp(`^Chosen photo ${shortOf(9)}: Locked until your saved list is read`),
        });
        expect(stub.querySelector('img')).toBeNull();
        expect(stub.getAttribute('aria-disabled')).toBe('true');
    });

    test('an unpicked stub at the cap says the list is full in its name too, and is inert; a picked one stays removable', () => {
        const onToggle = jest.fn();
        grid({ selected: [idOf(1)], idleIds: [idOf(1), idOf(9)], savedPicks: { memberId: MEMBER }, max: 1, onToggle });
        const held = screen.getByRole('button', { name: new RegExp(`^Chosen photo ${shortOf(9)}: List full`) });
        expect(held.getAttribute('aria-pressed')).toBe('false');
        expect(held.getAttribute('aria-disabled')).toBe('true');
        fireEvent.click(held);
        expect(onToggle).not.toHaveBeenCalled();
        expect(stubTile(1).getAttribute('aria-disabled')).toBe('false');
    });

    test('while the member check is on its way the grid says so and shows nothing of the picks', () => {
        grid({ selected: [idOf(9)], extraPhotos: extra, savedPicks: { memberId: MEMBER }, checkingMember: true });
        expect(screen.queryByRole('button')).toBeNull();
        const loader = screen.getByText('Checking which account these photos belong to…');
        expect(loader.closest('[role="status"]')).toBeTruthy();
    });

    test('a stub that leaves the page hands the focus to the grid’s status line, as a read tile does', () => {
        const { rerender } = render(
            <PhotoGrid
                state={{ status: 'idle' }}
                known={new Map()}
                selected={[idOf(9)]}
                hideUnlisted={false}
                locked={false}
                hasChallenge
                revalidating={false}
                recheckFailed={false}
                savedPicks={{ memberId: MEMBER }}
                onToggle={jest.fn()}
                onRetry={jest.fn()}
                onRefresh={jest.fn()}
            />,
        );
        const stub = stubTile(9);
        stub.focus();
        expect(document.activeElement).toBe(stub);
        rerender(
            <PhotoGrid
                state={{ status: 'idle' }}
                known={new Map()}
                selected={[idOf(9)]}
                hideUnlisted={false}
                locked={false}
                hasChallenge
                revalidating={false}
                recheckFailed={false}
                savedPicks={null}
                onToggle={jest.fn()}
                onRetry={jest.fn()}
                onRefresh={jest.fn()}
            />,
        );
        expect(screen.queryByRole('button')).toBeNull();
        expect(document.activeElement).toBe(screen.getAllByRole('status')[0]);
    });
});

describe('eligibility', () => {
    test('a refused photo is greyed out with its reason as visible text and cannot be added', async () => {
        getLibrary().mockResolvedValue(
            listing([photo(1, { allowed: false, message: 'Already in another challenge' }), photo(2)]),
        );
        setup();
        loadAll();
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

    test('the Chosen Photos chooser keeps every refused photo on screen: none is hidden or counted', async () => {
        getLibrary().mockResolvedValue(listing([photo(1, { allowed: false }), photo(2, { allowed: false })]));
        setup();
        await opened();
        expect(screen.getByRole('button', { name: /^Photo 00000002:/ })).toBeTruthy();
        expect(screen.queryByText(/^Hidden: /)).toBeNull();
        expect(screen.queryByText(/won't take any of the listed photos/)).toBeNull();
    });

    test('a refused photo without a message gets a generic reason, and stays removable once chosen', async () => {
        getLibrary().mockResolvedValue(listing([photo(1, { allowed: false })]));
        setup({ value: [idOf(1)] });
        const blocked = await (async () => {
            loadAll();
            return screen.findByRole('button', { name: /^Photo 00000001:/ });
        })();
        expect(screen.getByText('Not eligible for this challenge')).toBeTruthy();
        expect(blocked.getAttribute('aria-disabled')).toBe('false');
    });

    test('without a challenge the listing says eligibility is only checked at submit time', async () => {
        getLibrary().mockResolvedValue(listing([photo(1, { allowed: false })], { allowedKnown: false }));
        setup({ challengeId: null });
        loadAll();
        const only = await screen.findByRole('button', { name: /^Photo 00000001:/ });
        expect(screen.getByText(/Eligibility is not checked here/)).toBeTruthy();
        expect(only.getAttribute('aria-disabled')).toBe('false');
        expect(screen.queryByText('Not eligible for this challenge')).toBeNull();
        expect(screen.queryByText('Can be entered')).toBeNull();
        expect(getLibrary()).toHaveBeenCalledWith(null, undefined, 'cached', 'submit');
    });
});
describe('search', () => {
    test('the search box is a named text search with no autofill and a search key on the keyboard', async () => {
        setup();
        await opened();
        const box = screen.getByLabelText('Search your photos by tag');
        expect(box.getAttribute('name')).toBe('photo-search');
        expect(box.getAttribute('autocomplete')).toBe('off');
        expect(box.getAttribute('enterkeyhint')).toBe('search');
    });

    test('searches on submit, not while typing, from idle too', async () => {
        setup();
        const box = screen.getByLabelText('Search your photos by tag');
        fireEvent.change(box, { target: { value: '  cat ' } });
        expect(getLibrary()).not.toHaveBeenCalled();
        fireEvent.submit(box.closest('form')!);
        await waitFor(() => expect(getLibrary()).toHaveBeenCalledTimes(1));
        expect(getLibrary()).toHaveBeenLastCalledWith(7, 'cat', 'fresh', 'submit');
        expect(await screen.findByRole('button', { name: /^Photo 00000001:/ })).toBeTruthy();
    });

    test('a selected photo a narrower search no longer lists keeps its tile', async () => {
        getLibrary()
            .mockResolvedValueOnce(listing([photo(1), photo(2)]))
            .mockResolvedValueOnce(listing([photo(3)]));
        setup({ value: [idOf(1)] });
        loadAll();
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
        loadAll();
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
        loadAll();
        const alert = await screen.findByRole('alert');
        // Nothing came back to show as a detail: a generic why and next step, not "details below".
        expect(alert.textContent).toContain("Your photos couldn't be loaded — the request was interrupted. Try again.");
        expect(alert.textContent).not.toContain('details below');
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        expect(getLibrary()).toHaveBeenLastCalledWith(7, undefined, 'fresh', 'submit');
    });

    test('an error is shown as a translated detail, never as raw handler text; invalid-args has its own', async () => {
        getLibrary().mockResolvedValueOnce({ success: false, error: 'Failed to read your photo library' });
        const view = setup();
        loadAll();
        const alert = await screen.findByRole('alert');
        // With a detail to point at, "details below" is accurate and no cause is claimed.
        expect(alert.textContent).toContain("Your photos couldn't be loaded (details below). Try again.");
        expect(alert.textContent).not.toMatch(/GuruShots didn't answer|session/);
        expect(alert.textContent).not.toContain('Failed to read your photo library');
        expect(alert.textContent).toContain(english('errors.actionFailed'));
        view.unmount();

        mockTranslator.t.mockImplementation((key) =>
            key === 'errors.actionInvalidArgs' ? 'Bad request' : english(key),
        );
        getLibrary().mockResolvedValueOnce({ success: false, error: 'invalid-args' });
        setup();
        loadAll();
        expect((await screen.findByRole('alert')).textContent).toContain('Bad request');
    });

    test('retry keeps the submitted search', async () => {
        getLibrary()
            .mockResolvedValueOnce(listing([photo(1)]))
            .mockResolvedValueOnce(invalid(null));
        setup();
        loadAll();
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        const box = screen.getByLabelText('Search your photos by tag');
        fireEvent.change(box, { target: { value: 'dog' } });
        fireEvent.submit(box.closest('form')!);
        await screen.findByRole('alert');
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
        await waitFor(() => expect(getLibrary()).toHaveBeenLastCalledWith(7, 'dog', 'fresh', 'submit'));
    });

    test('with no challenge to read the library through it explains what is needed', async () => {
        getLibrary().mockResolvedValue({ success: false, error: 'no-challenge-context' });
        setup({ challengeId: null });
        loadAll();
        expect((await screen.findByRole('alert')).textContent).toContain('no active or joinable challenge');
    });

    test('a save the caller refuses keeps the modal open on an error', async () => {
        const onSave = jest.fn().mockResolvedValue(false);
        const { onClose } = setup({ onSave });
        await opened();
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
        await opened();
        fireEvent.click(screen.getByRole('button', { name: 'Use these photos' }));
        expect((await screen.findByRole('alert')).textContent).toContain("weren't saved");
        expect(onClose).not.toHaveBeenCalled();
    });

    test('Save is disabled while saving', async () => {
        const saving = deferred<boolean>();
        const { onClose } = setup({ onSave: jest.fn<Promise<boolean>, [string[]]>(() => saving.promise) });
        await opened();
        fireEvent.click(screen.getByRole('button', { name: 'Use these photos' }));
        await waitFor(() =>
            expect((screen.getByRole('button', { name: 'Use these photos' }) as HTMLButtonElement).disabled).toBe(true),
        );
        await act(async () => saving.resolve(true));
        expect(onClose).toHaveBeenCalled();
    });

    test('a synchronous save callback works too', async () => {
        const { onClose, onSave } = setup({ onSave: jest.fn().mockReturnValue(true) });
        await opened();
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
        getSetting().mockResolvedValue(OTHER);
        setup({ value: [idOf(1), idOf(9)] });
        expect((await notice()).textContent).toContain('Saving a list here makes them apply to this account too');
        // Counted, not shown: no tile, stub, short id or thumbnail for the other account's photos.
        expect(screen.getByText('2 photo(s) saved under another account')).toBeTruthy();
        expect(screen.queryByRole('button', { name: new RegExp(`${shortOf(9)}`) })).toBeNull();
        expect(document.body.textContent).not.toContain(shortOf(9));
        // The selection starts empty: those photos are not this account's to build on.
        expect(countLine().textContent).toBe(`0 of ${MAX_CHOSEN_PHOTOS} chosen`);
        expect(screen.queryByRole('button', { name: /^Photo |^Chosen photo / })).toBeNull();
    });

    test('after that reset no stub stays behind for a saved id', async () => {
        getSetting().mockResolvedValue(OTHER);
        setup({ value: [], savedCount: 1 });
        await notice();
        expect(screen.queryByRole('button', { name: /^Chosen photo / })).toBeNull();
        expect(screen.getByText(/^Your photos are not loaded yet\./).textContent).not.toMatch(/chosen photos/);
        expect(countLine().textContent).toBe(`0 of ${MAX_CHOSEN_PHOTOS} chosen`);
    });

    test('the notice judges the list the modal opened with, so it stays after clearing and choosing again', async () => {
        getSetting().mockResolvedValue(OTHER);
        setup({ value: [idOf(1)] });
        await notice();
        loadAll();
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
        expect(screen.queryByText(/saved under another account, so the app ignores them/)).not.toBeNull();
        fireEvent.click(tile(2));
        expect(screen.queryByText(/saved under another account, so the app ignores them/)).not.toBeNull();
        expect(countLine().textContent).toBe(`1 of ${MAX_CHOSEN_PHOTOS} chosen`);
    });

    test('the notice and the withheld photos stay while a search is loading or fails', async () => {
        getSetting().mockResolvedValue(OTHER);
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
        getSetting().mockResolvedValue(OTHER);
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
        getSetting().mockResolvedValue(OTHER);
        const { onSave } = setup({ value: [idOf(1)] });
        await notice();
        loadAll();
        await screen.findByRole('button', { name: /^Photo 00000002:/ });
        fireEvent.click(tile(2));
        fireEvent.click(screen.getByRole('button', { name: 'Use these photos' }));
        await waitFor(() => expect(onSave).toHaveBeenCalledWith([idOf(2)]));
    });

    test('removing the lists asks first, then removes them and drops the notice', async () => {
        getSetting().mockResolvedValue(OTHER);
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
        const confirmButton = screen.getAllByRole('button', { name: 'Remove those lists' }).at(-1)!;
        fireEvent.click(confirmButton);
        await waitFor(() => expect(window.api.clearChosenPhotos).toHaveBeenCalledTimes(1));
        await waitFor(() =>
            expect(screen.queryByText(/saved under another account, so the app ignores them/)).toBeNull(),
        );
        expect(screen.queryByText('2 photo(s) saved under another account')).toBeNull();
    });

    test('cancelling the confirmation removes nothing', async () => {
        getSetting().mockResolvedValue(OTHER);
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
        getSetting().mockResolvedValue(OTHER);
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
        getSetting().mockResolvedValue(OTHER);
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
        getSetting().mockResolvedValue(MEMBER);
        setup({ value: [idOf(1)] });
        await screen.findByRole('button', { name: /^Chosen photo 00000001:/ });
        expect(screen.queryByText(/saved under another account/)).toBeNull();
        expect(stubTile(1).getAttribute('aria-pressed')).toBe('true');
    });

    test('no warning for an empty list', async () => {
        getSetting().mockResolvedValue(OTHER);
        setup();
        await opened();
        expect(screen.queryByText(/saved under another account/)).toBeNull();
    });
});

describe('the member check on open', () => {
    const use = () => screen.getByRole('button', { name: 'Use these photos' });
    const expectHeldBack = (text: string) => {
        // aria-disabled, not disabled: the button stays focusable, and the hint is linked to it.
        expect(use().getAttribute('aria-disabled')).toBe('true');
        expect(use().hasAttribute('disabled')).toBe(false);
        const hintElement = screen.getByText(text);
        expect(use().getAttribute('aria-describedby')).toBe(hintElement.id);
    };
    const checkingHint = 'Checking which account this list belongs to…';
    const checkFailedHint =
        'The account check failed, so saving is held to protect your list. Press Retry again shortly.';
    const notLoggedInHint =
        "You're signed out, so the account can't be checked. Log in again, then reopen the chooser.";
    const ownerFailedHint =
        'Which account saved this list could not be read, so saving is held to protect it. Press Retry to read it again.';

    // Whatever the gate says, an Auto pick never goes invisible: with the gate closed and the wait
    // over, Auto and Add still put tiles on screen and the line names the picks.
    const expectAutoPicksShow = async () => {
        jest.mocked(window.api.suggestPhotos).mockResolvedValueOnce({
            success: true,
            memberId: MEMBER,
            photos: [photo(5)],
            statsLimited: false,
        });
        fireEvent.click(screen.getByRole('button', { name: 'Auto' }));
        const strip = await screen.findByRole('region', { name: 'Suggestions' });
        fireEvent.click(within(strip).getByRole('button', { name: 'Add suggestions' }));
        // The added pick shows in the grid (the strip keeps its own tile of it), and the line
        // names the picks instead of "not loaded yet".
        const inGrid = screen.getAllByRole('button', { name: /^Photo 00000005:/ }).find((el) => !strip.contains(el))!;
        expect(inGrid.getAttribute('aria-pressed')).toBe('true');
        expect(screen.getByText(/^Your chosen photos stay picked\./).getAttribute('role')).toBe('status');
        expect(getLibrary()).not.toHaveBeenCalled();
    };

    test('runs when a list is on record: the grid waits for it and Save is held', async () => {
        const answer = deferred<{ success: true; memberId: string }>();
        confirm().mockReturnValueOnce(invalid(answer.promise));
        setup({ value: [idOf(1)] });
        // The loader says what is awaited; nothing of the pick shows, and no stub either.
        expect(await screen.findByText('Checking which account these photos belong to…')).toBeTruthy();
        expect(screen.queryByRole('button', { name: /^Chosen photo |^Photo / })).toBeNull();
        expectHeldBack(checkingHint);
        expect(getLibrary()).not.toHaveBeenCalled();
        await act(async () => answer.resolve({ success: true, memberId: MEMBER }));
        await waitFor(() => expect(stubTile(1).getAttribute('aria-pressed')).toBe('true'));
        expect(use().getAttribute('aria-disabled')).toBe('false');
        expect(use().hasAttribute('aria-describedby')).toBe(false);
    });

    test('a failed check says so and Retry re-asks it, never the library', async () => {
        confirm()
            .mockResolvedValueOnce({ success: false, error: 'account-check-failed' })
            .mockResolvedValueOnce({ success: true, memberId: MEMBER });
        setup({ value: [idOf(1)] });
        await screen.findByText(checkFailedHint);
        expectHeldBack(checkFailedHint);
        // The line names the picks (they are chosen, whatever the account question says), and no
        // stub shows while the gate is closed.
        expect(screen.getByText(/^Your chosen photos stay picked\./)).toBeTruthy();
        expect(screen.queryByRole('button', { name: /^Chosen photo / })).toBeNull();
        fireEvent.click(use());
        expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
        await screen.findByRole('button', { name: /^Chosen photo 00000001:/ });
        expect(use().getAttribute('aria-disabled')).toBe('false');
        expect(confirm()).toHaveBeenCalledTimes(2);
        expect(getLibrary()).not.toHaveBeenCalled();
    });

    test('a check that rejects counts as a failed check', async () => {
        confirm().mockRejectedValueOnce(new Error('ipc down'));
        setup({ value: [idOf(1)] });
        await screen.findByText(checkFailedHint);
    });

    test('signed out is not a failed check: it says to log in again and offers no Retry', async () => {
        confirm().mockResolvedValueOnce({ success: false, error: 'not-logged-in' });
        setup({ value: [idOf(1)] });
        await screen.findByText(notLoggedInHint);
        expect(screen.queryByText(checkFailedHint)).toBeNull();
        expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
        expect(use().getAttribute('aria-disabled')).toBe('true');
    });

    test('saving nothing, with no list and no owner on record, is never held back', async () => {
        const { onSave } = setup({ value: [] });
        expect(confirm()).not.toHaveBeenCalled();
        expect(use().getAttribute('aria-disabled')).toBe('false');
        fireEvent.click(use());
        await waitFor(() => expect(onSave).toHaveBeenCalledWith([]));
    });

    test('the check can answer before the owner read does: the gate waits for the owner', async () => {
        const owner = deferred<string>();
        getSetting().mockReturnValueOnce(invalid(owner.promise));
        setup({ value: [idOf(1)] });
        // The member is known, but whose list this is is not: no stub, and Save (nothing to protect
        // over the ids this layer already holds) is free.
        await waitFor(() => expect(confirm()).toHaveBeenCalledTimes(1));
        await screen.findByText('Checking which account these photos belong to…');
        await act(async () => owner.resolve(MEMBER));
        await waitFor(() => expect(stubTile(1).querySelector('img')?.getAttribute('src')).toContain(MEMBER));
    });

    test('a failed owner read holds Save with its own reason; its Retry reads the record, then picks add', async () => {
        getSetting().mockResolvedValue(MEMBER).mockRejectedValueOnce(new Error('down'));
        setup({ value: [idOf(1)] });
        await waitFor(() => expect(confirm()).toHaveBeenCalledTimes(1));
        // The member and the owner read have both answered (the latter badly): no wait line, never a
        // stub, and the hold names the record itself.
        await waitFor(() => expect(screen.queryByText('Checking which account these photos belong to…')).toBeNull());
        expect(screen.queryByRole('button', { name: /^Chosen photo / })).toBeNull();
        await screen.findByText(ownerFailedHint);
        expect(use().getAttribute('aria-disabled')).toBe('true');

        jest.mocked(window.api.suggestPhotos).mockResolvedValueOnce({
            success: true,
            memberId: MEMBER,
            photos: [photo(5)],
            statsLimited: false,
        });
        fireEvent.click(screen.getByRole('button', { name: 'Auto' }));
        const strip = await screen.findByRole('region', { name: 'Suggestions' });
        // The suggestion is visible, but nothing is added over a list whose owner is unknown.
        expect(within(strip).getByRole('button', { name: 'Add suggestions' }).hasAttribute('disabled')).toBe(true);

        // Retry reads the record again, never the library; once it lands and matches, the hold
        // lifts, the stubs show and Add fills.
        const reads = getSetting().mock.calls.length;
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
        await waitFor(() => expect(getSetting().mock.calls.length).toBeGreaterThan(reads));
        expect(getLibrary()).not.toHaveBeenCalled();
        await waitFor(() => expect(stubTile(1).querySelector('img')?.getAttribute('src')).toContain(MEMBER));
        await waitFor(() => expect(use().getAttribute('aria-disabled')).toBe('false'));
        expect(screen.queryByText(ownerFailedHint)).toBeNull();
        fireEvent.click(within(strip).getByRole('button', { name: 'Add suggestions' }));
        const inGrid = screen.getAllByRole('button', { name: /^Photo 00000005:/ }).find((el) => !strip.contains(el))!;
        expect(inGrid.getAttribute('aria-pressed')).toBe('true');
    });

    test('a list that came with its ids waits for the owner read too: Save is held until it lands and matches', async () => {
        const owner = deferred<string>();
        getSetting().mockReturnValueOnce(invalid(owner.promise));
        setup({ value: [idOf(1)] });
        await waitFor(() => expect(confirm()).toHaveBeenCalledTimes(1));
        // The check has answered, but whose list this is has not: saving restamps the owner, so it
        // waits — with the wait named, and no stub.
        await screen.findByText(checkingHint);
        expect(use().getAttribute('aria-disabled')).toBe('true');
        expect(screen.queryByRole('button', { name: /^Chosen photo / })).toBeNull();
        await act(async () => owner.resolve(MEMBER));
        await waitFor(() => expect(stubTile(1).querySelector('img')?.getAttribute('src')).toContain(MEMBER));
        await waitFor(() => expect(use().getAttribute('aria-disabled')).toBe('false'));
    });

    test('no list of its own and another account’s owner on record: no wait line, and picks stay visible', async () => {
        getSetting().mockResolvedValue('d'.repeat(32));
        setup({ value: [] });
        await waitFor(() => expect(confirm()).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(screen.queryByText('Checking which account these photos belong to…')).toBeNull());
        expect(screen.queryByRole('button', { name: /^Chosen photo / })).toBeNull();
        // No notice either: this layer holds no list to warn about.
        expect(screen.queryByText(/saved under another account/)).toBeNull();
        await expectAutoPicksShow();
    });

    test('a failed check stays failed through a Load all that names no member, and Retry re-asks it', async () => {
        confirm()
            .mockResolvedValueOnce({ success: false, error: 'account-check-failed' })
            .mockResolvedValueOnce({ success: true, memberId: MEMBER });
        setup({ value: [idOf(1)] });
        await screen.findByText(checkFailedHint);
        getLibrary().mockResolvedValueOnce(listing([photo(1)], { memberId: null }));
        loadAll();
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        // The read changed nothing about the account: the failure and its Retry are still there.
        expect(screen.getByText(checkFailedHint)).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
        await waitFor(() => expect(confirm()).toHaveBeenCalledTimes(2));
        // The library is already on screen: the pick is its tile, held no more.
        await waitFor(() => expect(tile(1).getAttribute('aria-pressed')).toBe('true'));
        expect(use().getAttribute('aria-disabled')).toBe('false');
    });

    test('a Load all pressed while the check is in flight, then the check fails: the failure shows with its Retry', async () => {
        const answer = deferred<{ success: false; error: 'account-check-failed' }>();
        confirm()
            .mockReturnValueOnce(invalid(answer.promise))
            .mockResolvedValueOnce({ success: true, memberId: MEMBER });
        getLibrary().mockResolvedValueOnce(listing([photo(1)], { memberId: null }));
        setup({ value: [idOf(1)] });
        loadAll();
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        await act(async () => answer.resolve({ success: false, error: 'account-check-failed' }));
        await screen.findByText(checkFailedHint);
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
        await waitFor(() => expect(confirm()).toHaveBeenCalledTimes(2));
    });

    test('a Load all whose listing names no member after a successful check leaves the chooser’s member in place', async () => {
        getSetting().mockResolvedValue(MEMBER);
        setup({ value: [idOf(1)] });
        await screen.findByRole('button', { name: /^Chosen photo 00000001:/ });
        getLibrary().mockResolvedValueOnce(listing([photo(1)], { memberId: null }));
        loadAll();
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        // The listing itself names no member, so its tiles are text-only; the member the check
        // found is still the chooser's (no hold comes back, the pick stays).
        expect(tile(1).querySelector('img')).toBeNull();
        expect(tile(1).getAttribute('aria-pressed')).toBe('true');
        expect(use().getAttribute('aria-disabled')).toBe('false');
        expect(screen.queryByText(checkingHint)).toBeNull();
    });
});
describe('a saved list that came without its ids', () => {
    const OWNER = MEMBER;
    const use = () => screen.getByRole('button', { name: 'Use these photos' });
    const checkingHint = 'Checking which account this list belongs to…';
    const readFailedHint =
        "Couldn't read your saved list for this challenge, so saving is held to protect it. Press Retry.";
    const readFailedAgainHint =
        'Reading your saved list failed again, so saving stays held to protect it. Press Retry again shortly.';
    const notLoggedInHint =
        "You're signed out, so the account can't be checked. Log in again, then reopen the chooser.";
    const unconfirmedHint =
        'The account that saved this list is not on record, so saving is held to protect it. Press Retry, or close and reopen the chooser.';
    const checkFailedHint =
        'The account check failed, so saving is held to protect your list. Press Retry again shortly.';
    const ownerFailedHint =
        'Which account saved this list could not be read, so saving is held to protect it. Press Retry to read it again.';
    const confirmedText = 'Account confirmed — your saved list is loaded.';
    const lockedText = 'Locked until your saved list is read';
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
        getSetting().mockResolvedValue(OWNER);
    });

    test('the check answers before the owner read lands: no unconfirmed flash, no library-reading Retry', async () => {
        const owner = deferred<string>();
        getSetting().mockReturnValueOnce(invalid(owner.promise));
        const reloadSaved = rereads([idOf(1)]);
        setup({ value: [], savedCount: 1, reloadSaved });
        await waitFor(() => expect(confirm()).toHaveBeenCalledTimes(1));
        // Whose list this is is still being read: the hold says it is checking, and offers no way
        // out that would read the library.
        await screen.findByText(checkingHint);
        expect(screen.queryByText(unconfirmedHint)).toBeNull();
        expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
        expect(getLibrary()).not.toHaveBeenCalled();
        await act(async () => owner.resolve(OWNER));
        await waitFor(() => expect(stubTile(1).getAttribute('aria-pressed')).toBe('true'));
        await waitFor(() => expect(use().getAttribute('aria-disabled')).toBe('false'));
    });

    test('an owner read that fails is its own hold, and its Retry reads the record again, never the library', async () => {
        getSetting().mockResolvedValue(OWNER).mockRejectedValueOnce(new Error('down'));
        const reloadSaved = rereads([idOf(1)]);
        setup({ value: [], savedCount: 1, reloadSaved });
        await waitFor(() => expect(confirm()).toHaveBeenCalledTimes(1));
        await screen.findByText(ownerFailedHint);
        expect(screen.queryByText(unconfirmedHint)).toBeNull();
        expect(getLibrary()).not.toHaveBeenCalled();

        const reads = getSetting().mock.calls.length;
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
        await waitFor(() => expect(getSetting().mock.calls.length).toBeGreaterThan(reads));
        expect(getLibrary()).not.toHaveBeenCalled();
        expect(confirm()).toHaveBeenCalledTimes(1);
        // The record lands this time: the list is read and the hold lifts.
        await waitFor(() => expect(stubTile(1).getAttribute('aria-pressed')).toBe('true'));
        await waitFor(() => expect(use().getAttribute('aria-disabled')).toBe('false'));
    });

    test('Save, an empty one too, is held until the list has been read again and seeds the selection', async () => {
        const read = deferred<string[] | null>();
        const reloadSaved = jest.fn<Promise<string[] | null>, []>().mockReturnValue(read.promise);
        const { onSave } = setup({ value: [], savedCount: 2, reloadSaved });
        // Nothing to save yet: the selection is empty only because the ids were withheld.
        await waitFor(() => expect(reloadSaved).toHaveBeenCalledTimes(1));
        expect(use().getAttribute('aria-disabled')).toBe('true');
        expect(screen.getByText(checkingHint)).toBeTruthy();
        fireEvent.click(use());
        expect(onSave).not.toHaveBeenCalled();
        expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();

        await act(async () => read.resolve([idOf(1), idOf(2)]));
        await waitFor(() => expect(stubTile(1).getAttribute('aria-pressed')).toBe('true'));
        expect(stubTile(2).getAttribute('aria-pressed')).toBe('true');
        await waitFor(() => expect(use().getAttribute('aria-disabled')).toBe('false'));
        fireEvent.click(use());
        await waitFor(() => expect(onSave).toHaveBeenCalledWith([idOf(1), idOf(2)]));
    });

    test('an empty save goes through only once the user has really cleared the list', async () => {
        const { onSave } = setup({ value: [], savedCount: 1, reloadSaved: rereads([idOf(1)]) });
        await waitFor(() => expect(stubTile(1).getAttribute('aria-pressed')).toBe('true'));
        await waitFor(() => expect(use().getAttribute('aria-disabled')).toBe('false'));
        fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
        fireEvent.click(use());
        await waitFor(() => expect(onSave).toHaveBeenCalledWith([]));
    });

    test('the tiles are inert while the list is unread, so the late read cannot overwrite a pick', async () => {
        const read = deferred<string[] | null>();
        const reloadSaved = jest.fn<Promise<string[] | null>, []>().mockReturnValue(read.promise);
        setup({ value: [], savedCount: 1, reloadSaved });
        loadAll();
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        await waitFor(() => expect(reloadSaved).toHaveBeenCalledTimes(1));
        // Read in flight: every tile says it cannot be changed, and a click does nothing.
        expect(tile(3).getAttribute('aria-disabled')).toBe('true');
        fireEvent.click(tile(3));
        expect(pressed(3)).toBe('false');
        expect(screen.getByText(checkingHint)).toBeTruthy();

        await act(async () => read.resolve([idOf(1)]));
        await waitFor(() => expect(pressed(1)).toBe('true'));
        expect(pressed(3)).toBe('false');
        expect(tile(3).getAttribute('aria-disabled')).toBe('false');
        fireEvent.click(tile(3));
        expect(pressed(3)).toBe('true');
    });

    describe('the list cannot be confirmed', () => {
        const expectUnconfirmed = async (message: string) => {
            await screen.findByText(message);
            expect(use().getAttribute('aria-disabled')).toBe('true');
        };

        const confirmWith = (...answers: Array<string | null>) => {
            const confirmMock = confirm();
            for (const memberId of answers) {
                confirmMock.mockResolvedValueOnce(
                    memberId === null ? { success: false, error: 'account-check-failed' } : { success: true, memberId },
                );
            }
            return confirmMock;
        };
        const retryButton = () => screen.getByRole('button', { name: 'Retry' });

        test('a check that cannot name the member: Retry re-asks it only, never the library or the read, and seeds the list', async () => {
            confirmWith(null, OWNER);
            const reloadSaved = rereads([idOf(1)]);
            const { onSave } = setup({ value: [], savedCount: 1, reloadSaved });
            await expectUnconfirmed(checkFailedHint);
            expect(reloadSaved).not.toHaveBeenCalled();
            fireEvent.click(use());
            expect(onSave).not.toHaveBeenCalled();

            fireEvent.click(retryButton());
            await waitFor(() => expect(stubTile(1).getAttribute('aria-pressed')).toBe('true'));
            await waitFor(() => expect(use().getAttribute('aria-disabled')).toBe('false'));
            expect(screen.queryByText(checkFailedHint)).toBeNull();
            expect(confirm()).toHaveBeenCalledTimes(2);
            // No library walk ever happened.
            expect(getLibrary()).not.toHaveBeenCalled();
            fireEvent.click(use());
            await waitFor(() => expect(onSave).toHaveBeenCalledWith([idOf(1)]));
        });

        test('the check fails again: the hint says so and Retry stays; a later press can succeed', async () => {
            confirmWith(null, null, OWNER);
            const { onSave } = setup({ value: [], savedCount: 1, reloadSaved: rereads([idOf(1)]) });
            await screen.findByText(checkFailedHint);
            fireEvent.click(retryButton());
            await screen.findByText(checkFailedHint);
            expect(use().getAttribute('aria-disabled')).toBe('true');
            expect(getLibrary()).not.toHaveBeenCalled();

            fireEvent.click(retryButton());
            await waitFor(() => expect(stubTile(1).getAttribute('aria-pressed')).toBe('true'));
            fireEvent.click(use());
            await waitFor(() => expect(onSave).toHaveBeenCalledWith([idOf(1)]));
        });

        test('a check that rejects counts as a failed check', async () => {
            confirm().mockRejectedValueOnce(new Error('ipc down')).mockRejectedValueOnce(new Error('ipc down'));
            setup({ value: [], savedCount: 1, reloadSaved: rereads() });
            await screen.findByText(checkFailedHint);
            fireEvent.click(retryButton());
            await screen.findByText(checkFailedHint);
        });

        test("the check names another account: the notice shows, the ids stay withheld and Save is the user's choice", async () => {
            confirmWith('d'.repeat(32));
            const reloadSaved = rereads();
            const { onSave } = setup({ value: [], savedCount: 2, reloadSaved });
            expect(await screen.findByText(/saved under another account, so the app ignores them/)).toBeTruthy();
            expect(reloadSaved).not.toHaveBeenCalled();
            await waitFor(() => expect(use().getAttribute('aria-disabled')).toBe('false'));
            fireEvent.click(use());
            await waitFor(() => expect(onSave).toHaveBeenCalledWith([]));
        });

        test('Retry stays mounted, focused, aria-busy and inert while the check runs; the hint is a live region apart from it', async () => {
            const answer = deferred<{ success: true; memberId: string }>();
            confirmWith(null);
            confirm().mockReturnValueOnce(invalid(answer.promise));
            setup({ value: [], savedCount: 1, reloadSaved: rereads([idOf(1)]) });
            await screen.findByText(checkFailedHint);

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
            expect(confirm()).toHaveBeenCalledTimes(2);

            // Busy looks busy: a spinner and the disabled style, DaisyUI only.
            expect(retry.className).toContain('btn-disabled');
            expect(retry.querySelector('.loading.loading-spinner')).not.toBeNull();

            await act(async () => answer.resolve({ success: true, memberId: OWNER }));
            await waitFor(() => expect(stubTile(1).getAttribute('aria-pressed')).toBe('true'));
            expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
        });

        test('Retry stays mounted and focused through the read after the check, then focus moves to Save and success is announced', async () => {
            // The open check fails, so Retry is what runs the successful one; the read follows it.
            confirm().mockResolvedValueOnce({ success: false, error: 'account-check-failed' });
            confirmWith(OWNER);
            const read = deferred<string[] | null>();
            const reloadSaved = jest.fn<Promise<string[] | null>, []>().mockReturnValue(read.promise);
            setup({ value: [], savedCount: 1, reloadSaved });
            await screen.findByText(checkFailedHint);
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
            await waitFor(() => expect(document.activeElement).toBe(use()));
            // The success is in a live region that was mounted all along.
            const announced = screen.getByText(confirmedText);
            expect(announced.getAttribute('role')).toBe('status');
        });

        test('focus goes to the status line when Retry ends signed out (Save is still held), so it is never dropped', async () => {
            confirm()
                .mockResolvedValueOnce({ success: false, error: 'account-check-failed' })
                .mockResolvedValueOnce({ success: false, error: 'not-logged-in' });
            setup({ value: [], savedCount: 1, reloadSaved: rereads() });
            await screen.findByText(checkFailedHint);
            const retry = retryButton();
            retry.focus();
            fireEvent.click(retry);
            await screen.findByText(notLoggedInHint);
            expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
            const status = screen.getByText(notLoggedInHint);
            await waitFor(() => expect(document.activeElement).toBe(status));
            expect(status.getAttribute('role')).toBe('status');
        });

        test('focus goes to Save when Retry finds another account (Save is free then)', async () => {
            const answer = deferred<{ success: true; memberId: string }>();
            confirm().mockResolvedValueOnce({ success: false, error: 'account-check-failed' });
            confirm().mockReturnValueOnce(invalid(answer.promise));
            setup({ value: [], savedCount: 1, reloadSaved: rereads() });
            await screen.findByText(checkFailedHint);
            const retry = retryButton();
            retry.focus();
            fireEvent.click(retry);
            await act(async () => answer.resolve({ success: true, memberId: 'd'.repeat(32) }));
            await screen.findByText(/saved under another account, so the app ignores them/);
            await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull());
            expect(use().getAttribute('aria-disabled')).toBe('false');
            await waitFor(() => expect(document.activeElement).toBe(use()));
        });

        test('focus lost from the page goes to Save when a pressed Retry lifts the hold', async () => {
            const read = deferred<string[] | null>();
            const reloadSaved = jest.fn<Promise<string[] | null>, []>().mockReturnValue(read.promise);
            confirm().mockResolvedValueOnce({ success: false, error: 'account-check-failed' });
            confirm().mockResolvedValueOnce({ success: true, memberId: OWNER });
            setup({ value: [], savedCount: 1, reloadSaved });
            await screen.findByText(checkFailedHint);
            fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
            // The check answered; the read is still out and the focus fell to the page.
            await waitFor(() => expect(reloadSaved).toHaveBeenCalledTimes(1));
            if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
            await act(async () => undefined);
            expect(document.activeElement).toBe(document.body);
            await act(async () => read.resolve([idOf(1)]));
            await waitFor(() => expect(document.activeElement).toBe(use()));
        });

        test('focus parked on the footer’s status line goes to Save when a pressed Retry lifts the hold', async () => {
            const read = deferred<string[] | null>();
            const reloadSaved = jest.fn<Promise<string[] | null>, []>().mockReturnValue(read.promise);
            confirm().mockResolvedValueOnce({ success: false, error: 'account-check-failed' });
            confirm().mockResolvedValueOnce({ success: true, memberId: OWNER });
            setup({ value: [], savedCount: 1, reloadSaved });
            await screen.findByText(checkFailedHint);
            fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
            await waitFor(() => expect(reloadSaved).toHaveBeenCalledTimes(1));
            const status = document.getElementById(use().getAttribute('aria-describedby')!)!;
            status.focus();
            await act(async () => read.resolve([idOf(1)]));
            await waitFor(() => expect(document.activeElement).toBe(use()));
        });

        test('focus the user has put elsewhere is never taken when the hold lifts', async () => {
            const answer = deferred<{ success: true; memberId: string }>();
            confirm().mockResolvedValueOnce({ success: false, error: 'account-check-failed' });
            confirm().mockReturnValueOnce(invalid(answer.promise));
            setup({ value: [], savedCount: 1, reloadSaved: rereads([idOf(1)]) });
            await screen.findByText(checkFailedHint);
            fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
            // While the check runs the user moves to Cancel; the lifted hold must not pull focus away.
            const cancel = screen.getByRole('button', { name: 'Cancel' });
            cancel.focus();
            await act(async () => answer.resolve({ success: true, memberId: OWNER }));
            // The hold has lifted and the confirmation is on screen: the footer has committed what its
            // focus effects react to. Only then is where focus is worth judging.
            await screen.findByText(confirmedText);
            await waitFor(() => expect(use().getAttribute('aria-disabled')).toBe('false'));
            await effectsFlushed();
            expect(document.activeElement).toBe(cancel);
        });

        test('an earlier failed read, then a search, then a successful automatic read: focus stays in the search box and nothing is announced', async () => {
            const reloadSaved = rereads(null, null, [idOf(1)]);
            setup({ value: [], savedCount: 1, reloadSaved });
            await screen.findByText(readFailedHint);
            fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
            await screen.findByText(readFailedAgainHint);

            const search = screen.getByRole('searchbox');
            search.focus();
            fireEvent.submit(search.closest('form')!);
            await waitFor(() => expect(pressed(1)).toBe('true'));
            await waitFor(() => expect(use().getAttribute('aria-disabled')).toBe('false'));
            expect(document.activeElement).toBe(search);
            expect(screen.queryByText(confirmedText)).toBeNull();
        });

        test('a successful Retry is announced once: a later search does not announce it again', async () => {
            const { onSave } = setup({ value: [], savedCount: 1, reloadSaved: rereads(null, [idOf(1)]) });
            await screen.findByText(readFailedHint);
            fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
            await screen.findByText(confirmedText);
            expect(onSave).not.toHaveBeenCalled();
            const search = screen.getByRole('searchbox');
            fireEvent.submit(search.closest('form')!);
            await waitFor(() => expect(getLibrary()).toHaveBeenCalledTimes(1));
            // The reload has settled (Save is free again, the list already read) before judging the text.
            await waitFor(() => expect(use().getAttribute('aria-disabled')).toBe('false'));
            expect(screen.queryByText(confirmedText)).toBeNull();
        });

        test('Retry that reloads the listing (the owner not on record) keeps focus, then a good owner and read announces and focuses Save', async () => {
            // The member check names the member, but the owner record is not there yet: Retry reloads the listing.
            getSetting().mockResolvedValue('');
            const reloadSaved = rereads([idOf(1)]);
            setup({ value: [], savedCount: 1, reloadSaved });
            await screen.findByText(unconfirmedHint);
            expect(reloadSaved).not.toHaveBeenCalled();

            const retry = retryButton();
            retry.focus();
            const reload = deferred<Listing>();
            getLibrary().mockReturnValueOnce(invalid(reload.promise));
            fireEvent.click(retry);
            // While the listing loads Retry stays the same focused, busy button, and the hint says
            // what is awaited.
            await screen.findByText(checkingHint);
            expect(retryButton()).toBe(retry);
            expect(document.activeElement).toBe(retry);
            expect(retry.getAttribute('aria-busy')).toBe('true');

            // The owner is on record now; the reloaded listing names the same member, so the list is read.
            getSetting().mockResolvedValue(OWNER);
            await act(async () => {
                fireSettingsChanged({});
                reload.resolve(listing([photo(1)]));
            });
            await screen.findByText(confirmedText);
            await waitFor(() => expect(pressed(1)).toBe('true'));
            expect(screen.getByText(confirmedText).getAttribute('role')).toBe('status');
            await waitFor(() => expect(document.activeElement).toBe(use()));
        });

        test('a hold nobody pressed Retry for lifts without moving focus or announcing success', async () => {
            const read = deferred<string[] | null>();
            setup({
                value: [],
                savedCount: 1,
                reloadSaved: jest.fn<Promise<string[] | null>, []>().mockReturnValue(read.promise),
            });
            await screen.findByText(checkingHint);
            // No Retry is offered for the automatic read, busy or not.
            expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
            await act(async () => read.resolve([idOf(1)]));
            await waitFor(() => expect(use().getAttribute('aria-disabled')).toBe('false'));
            // Let the footer's focus effects run before judging where focus is.
            await effectsFlushed();
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
            expect(screen.queryByText(checkFailedHint)).toBeNull();
            expect(reloadSaved).toHaveBeenCalledTimes(1);
            fireEvent.click(use());
            expect(onSave).not.toHaveBeenCalled();

            fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
            await waitFor(() => expect(reloadSaved).toHaveBeenCalledTimes(2));
            await waitFor(() => expect(stubTile(2).getAttribute('aria-pressed')).toBe('true'));
            await waitFor(() => expect(use().getAttribute('aria-disabled')).toBe('false'));
            // The listing was never asked: only the read was.
            expect(getLibrary()).not.toHaveBeenCalled();
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
            await waitFor(() => expect(stubTile(1).getAttribute('aria-pressed')).toBe('true'));
            expect(screen.queryByText(readFailedAgainHint)).toBeNull();
        });

        test('signed out is not a failed check: it says to log in again and offers no Retry', async () => {
            confirm().mockResolvedValueOnce({ success: false, error: 'not-logged-in' });
            setup({ value: [], savedCount: 1, reloadSaved: rereads() });
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
        loadAll();
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
        loadAll();
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

    test('with no challenge to read through, the member check still runs and the list is still read', async () => {
        const reloadSaved = rereads([idOf(1)]);
        setup({ value: [], savedCount: 1, challengeId: null, reloadSaved });
        await waitFor(() => expect(stubTile(1).getAttribute('aria-pressed')).toBe('true'));
        await waitFor(() => expect(use().getAttribute('aria-disabled')).toBe('false'));
        expect(getLibrary()).not.toHaveBeenCalled();
        expect(confirm()).toHaveBeenCalledTimes(1);
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
        await waitFor(() => expect(screen.queryByText(readFailedHint)).toBeNull());
        expect(screen.queryByText(checkFailedHint)).toBeNull();
        expect(await screen.findByText(checkingHint)).toBeTruthy();
        await act(async () => second.resolve([idOf(1)]));
        await waitFor(() => expect(pressed(1)).toBe('true'));
    });

    test("another account: the ids stay withheld, the notice shows, nothing is re-read and Save is the user's choice", async () => {
        getSetting().mockResolvedValue('d'.repeat(32));
        const reloadSaved = rereads();
        const { onSave } = setup({ value: [], savedCount: 2, reloadSaved });
        expect(await screen.findByText(/saved under another account, so the app ignores them/)).toBeTruthy();
        expect(screen.getByText('2 photo(s) saved under another account')).toBeTruthy();
        expect(reloadSaved).not.toHaveBeenCalled();
        expect(screen.queryByRole('button', { name: /^Chosen photo / })).toBeNull();
        await waitFor(() => expect(use().getAttribute('aria-disabled')).toBe('false'));
        loadAll();
        await screen.findByRole('button', { name: /^Photo 00000002:/ });
        fireEvent.click(tile(2));
        fireEvent.click(use());
        await waitFor(() => expect(onSave).toHaveBeenCalledWith([idOf(2)]));
    });

    test('a list that arrived with its ids is not held back at all, and its tiles work', async () => {
        const reloadSaved = rereads();
        setup({ value: [idOf(1)], savedCount: 1, reloadSaved });
        await screen.findByRole('button', { name: /^Chosen photo 00000001:/ });
        expect(use().getAttribute('aria-disabled')).toBe('false');
        expect(reloadSaved).not.toHaveBeenCalled();
        loadAll();
        await screen.findByRole('button', { name: /^Photo 00000002:/ });
        expect(tile(2).getAttribute('aria-disabled')).toBe('false');
    });
});
describe('Auto suggestions', () => {
    type Suggestion = Awaited<ReturnType<WindowApi['suggestPhotos']>>;
    type SuggestionOk = Extract<Suggestion, { success: true }>;
    const suggestion = (photos: LibraryPhoto[], over: Partial<SuggestionOk> = {}): SuggestionOk => ({
        success: true,
        memberId: MEMBER,
        photos,
        statsLimited: false,
        ...over,
    });
    const suggestPhotos = () => jest.mocked(window.api.suggestPhotos);
    const autoButton = () => screen.getByRole('button', { name: /^(Auto|Next suggestions)$/ });
    const strip = () => screen.getByRole('region', { name: 'Suggestions' });
    const stripTile = (n: number) => within(strip()).getByRole('button', { name: new RegExp(`^Photo ${shortOf(n)}:`) });
    const addButton = () => within(strip()).getByRole('button', { name: /^(Add suggestions|No free slots)$/ });

    beforeEach(() => {
        suggestPhotos().mockResolvedValue(suggestion([photo(1)]));
    });

    test('Auto from idle ranks under the auto-submit rules, with the chooser’s own words', async () => {
        suggestPhotos().mockResolvedValueOnce(suggestion([photo(3), photo(1)]));
        setup();
        fireEvent.click(autoButton());
        expect(await screen.findByText('Ranking your photos… this can take a minute. Nothing is saved.')).toBeTruthy();
        await screen.findByRole('region', { name: 'Suggestions' });
        expect(suggestPhotos()).toHaveBeenCalledWith(7, 'submit', []);
        expect(getLibrary()).not.toHaveBeenCalled();
        expect(stripTile(3).querySelector('img')?.getAttribute('src')).toContain(MEMBER);
    });

    test('a pick from the strip shows as an idle tile from the answer’s record, numbered, and no library is read', async () => {
        suggestPhotos().mockResolvedValueOnce(suggestion([photo(9, { labels: ['sunset'] })]));
        setup();
        fireEvent.click(autoButton());
        await screen.findByRole('region', { name: 'Suggestions' });
        fireEvent.click(stripTile(9));
        const inGrid = screen.getAllByRole('button', { name: /^Photo 00000009:/ }).find((el) => !strip().contains(el))!;
        expect(inGrid).toBeDefined();
        expect(inGrid.getAttribute('aria-pressed')).toBe('true');
        expect(within(inGrid).getByText('1')).toBeTruthy();
        expect(inGrid.querySelector('img')?.getAttribute('src')).toContain(MEMBER);
        expect(getLibrary()).not.toHaveBeenCalled();
        expect(countLine().textContent).toBe(`1 of ${MAX_CHOSEN_PHOTOS} chosen`);
    });

    test('Add suggestions appends the best ones not picked, in rank order, never removing a saved pick', async () => {
        getSetting().mockResolvedValue(MEMBER);
        suggestPhotos().mockResolvedValueOnce(suggestion([photo(3), photo(1), photo(2)]));
        const many = Array.from({ length: MAX_CHOSEN_PHOTOS - 3 }, (_, n) => photo(n + 10));
        const manyIds = many.map((p) => p.id);
        const { onSave } = setup({ value: [...manyIds, idOf(4)] });
        await screen.findByRole('button', { name: new RegExp(`^Chosen photo ${shortOf(4)}:`) });
        fireEvent.click(autoButton());
        await screen.findByRole('region', { name: 'Suggestions' });
        expect(addButton().hasAttribute('disabled')).toBe(false);
        fireEvent.click(addButton());
        // Two free slots: #1 and #2 of the suggestions, after the saved picks.
        expect(countLine().textContent).toContain(`${MAX_CHOSEN_PHOTOS} of ${MAX_CHOSEN_PHOTOS} chosen`);
        expect(stripTile(3).getAttribute('aria-pressed')).toBe('true');
        expect(stripTile(1).getAttribute('aria-pressed')).toBe('true');
        expect(stripTile(2).getAttribute('aria-pressed')).toBe('false');
        expect(addButton().textContent).toBe('No free slots');
        expect(addButton().hasAttribute('disabled')).toBe(true);
        fireEvent.click(screen.getByRole('button', { name: 'Use these photos' }));
        await waitFor(() => expect(onSave).toHaveBeenCalledWith([...manyIds, idOf(4), idOf(3), idOf(1)]));
    });

    test('Add suggestions is disabled once every suggestion is picked', async () => {
        suggestPhotos().mockResolvedValueOnce(suggestion([photo(1), photo(2)]));
        setup();
        fireEvent.click(autoButton());
        await screen.findByRole('region', { name: 'Suggestions' });
        expect(addButton().hasAttribute('disabled')).toBe(false);
        fireEvent.click(addButton());
        expect(addButton().hasAttribute('disabled')).toBe(true);
    });

    test('Add suggestions stays locked while a withheld list is read again, so nothing added is lost', async () => {
        const read = deferred<string[] | null>();
        const reloadSaved = jest.fn<Promise<string[] | null>, []>().mockReturnValue(read.promise);
        getSetting().mockResolvedValue(MEMBER);
        suggestPhotos().mockResolvedValueOnce(suggestion([photo(1)]));
        setup({ value: [], savedCount: 1, reloadSaved });
        fireEvent.click(autoButton());
        await screen.findByRole('region', { name: 'Suggestions' });
        expect(addButton().hasAttribute('disabled')).toBe(true);
        fireEvent.click(stripTile(1));
        expect(stripTile(1).getAttribute('aria-pressed')).toBe('false');
        await act(async () => read.resolve([idOf(2)]));
        await waitFor(() => expect(addButton().hasAttribute('disabled')).toBe(false));
        fireEvent.click(stripTile(1));
        expect(stripTile(1).getAttribute('aria-pressed')).toBe('true');
    });

    test('Auto → Add → Save works with no saved list at all, only an owner on record', async () => {
        getSetting().mockResolvedValue(MEMBER);
        suggestPhotos().mockResolvedValueOnce(suggestion([photo(1), photo(2)]));
        const { onSave } = setup({ value: [] });
        await waitFor(() => expect(confirm()).toHaveBeenCalledTimes(1));
        fireEvent.click(autoButton());
        await screen.findByRole('region', { name: 'Suggestions' });
        fireEvent.click(addButton());
        expect(countLine().textContent).toBe(`2 of ${MAX_CHOSEN_PHOTOS} chosen`);
        expect(screen.getByRole('button', { name: 'Use these photos' }).getAttribute('aria-disabled')).toBe('false');
        fireEvent.click(screen.getByRole('button', { name: 'Use these photos' }));
        await waitFor(() => expect(onSave).toHaveBeenCalledWith([idOf(1), idOf(2)]));
        expect(getLibrary()).not.toHaveBeenCalled();
    });

    test('a Refresh clears the strip, and a read that lands keeps the picks as real tiles', async () => {
        suggestPhotos().mockResolvedValueOnce(suggestion([photo(9)]));
        setup();
        fireEvent.click(autoButton());
        await screen.findByRole('region', { name: 'Suggestions' });
        fireEvent.click(stripTile(9));
        loadAll();
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        // The strip survives a Load all; a Refresh is what drops it.
        expect(screen.queryByRole('region', { name: 'Suggestions' })).not.toBeNull();
        getLibrary().mockResolvedValueOnce(listing([photo(1), photo(9)]));
        fireEvent.click(screen.getByRole('button', { name: 'Refresh photos' }));
        await waitFor(() => expect(screen.queryByRole('region', { name: 'Suggestions' })).toBeNull());
        // The pick is now a tile of the listing, not a missing one.
        expect(tile(9).getAttribute('aria-pressed')).toBe('true');
        expect(tile(9).textContent).not.toContain('Not available');
    });

    test('paging asks for the ids already shown, as in the submit picker', async () => {
        const set = (from: number, count = 5) => Array.from({ length: count }, (_, i) => photo(from + i));
        suggestPhotos().mockResolvedValueOnce(suggestion(set(1)));
        setup();
        fireEvent.click(autoButton());
        await screen.findByRole('img', { name: 'Suggestion #1' });
        suggestPhotos().mockResolvedValueOnce(suggestion(set(6)));
        fireEvent.click(screen.getByRole('button', { name: 'Next suggestions' }));
        await screen.findByRole('img', { name: 'Suggestion #6' });
        expect(suggestPhotos()).toHaveBeenLastCalledWith(7, 'submit', [1, 2, 3, 4, 5].map(idOf));
    });
});

describe('a row that inherits', () => {
    test('says that saving nothing makes it use the list from the settings or rules again', async () => {
        render(<PhotoChooserModal isOpen onClose={jest.fn()} value={[]} clearMeansInherit onSave={jest.fn()} />);
        expect(screen.getByText(/Saving with nothing chosen removes this challenge's own list/)).toBeTruthy();
        await opened();
    });

    test('says nothing of the kind elsewhere', async () => {
        setup();
        await opened();
        expect(screen.queryByText(/removes this challenge's own list/)).toBeNull();
    });
});

test('explains how chosen photos are used: ranked, or in the picked order when that setting is on, and where it lives', async () => {
    setup();
    const help = screen.getByText(/^The app uses these photos first/).textContent!;
    expect(help).toContain('must still pass your tag filters');
    expect(help).toContain('ranks them the way it ranks its own picks');
    expect(help).toContain('Use Chosen Photos in the order I picked them');
    expect(help).toContain("this challenge's own settings");
    expect(help).toContain('Nothing is read until you load, search or press Auto');
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
    await screen.findByRole('button', { name: 'Load all photos' });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(innerClose).toHaveBeenCalledTimes(1);
    expect(outerClose).not.toHaveBeenCalled();
    // Once the chooser is gone the outer modal answers again, and the page stays locked until the last one closes.
    rerender(tree(false));
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(outerClose).toHaveBeenCalledTimes(1);
});

describe('the cached listing, its preview and Refresh', () => {
    const previewOf = (photos: LibraryPhoto[], over: Partial<Listing> = {}) =>
        listing(
            photos.map((p) => ({ ...p, allowed: false, message: null })),
            { preview: true, allowedKnown: false, ...over },
        );
    const failure = invalid<Awaited<ReturnType<WindowApi['getLibraryPhotos']>>>({
        success: false,
        error: 'Failed to read your photo library',
    });
    const refreshButton = () => screen.getByRole('button', { name: 'Refresh photos' });
    const pendingTile = (n: number) => screen.getByRole('button', { name: new RegExp(`^Chosen photo ${shortOf(n)}:`) });

    test('says when the photos were read: the time when it was today, the date as well when it was not', async () => {
        getLibrary().mockResolvedValue(listing([photo(1)], { readAtMs: Date.now() }));
        const { unmount } = setup();
        loadAll();
        const today = await screen.findByText(/^Photos as of \d{2}:\d{2}$/);
        // Its own live region, apart from the count of what is picked.
        expect(today.getAttribute('role')).toBe('status');
        expect(countLine().textContent).not.toContain('Photos as of');
        unmount();
        getLibrary().mockResolvedValue(listing([photo(1)], { readAtMs: 1_700_000_000_000 }));
        setup();
        loadAll();
        expect(await screen.findByText(/^Photos as of \d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}$/)).toBeTruthy();
    });

    test('Refresh is named for what it does, reads again at once with the listing still on screen, and shows the new one', async () => {
        setup();
        await opened();
        const button = refreshButton();
        expect(button.textContent).toBe('Refresh');
        expect(button.getAttribute('aria-busy')).toBe('false');
        expect(button.hasAttribute('disabled')).toBe(false);
        const reread = deferred<Listing>();
        getLibrary().mockReturnValueOnce(reread.promise);
        fireEvent.click(button);
        expect(getLibrary()).toHaveBeenLastCalledWith(7, undefined, 'fresh', 'submit');
        await waitFor(() => expect(button.getAttribute('aria-busy')).toBe('true'));
        expect(button.hasAttribute('disabled')).toBe(true);
        // The photos stay while it reads.
        expect(tile(1)).toBeTruthy();
        await act(async () => reread.resolve(listing([photo(1), photo(5)])));
        await screen.findByRole('button', { name: /^Photo 00000005:/ });
        expect(refreshButton().getAttribute('aria-busy')).toBe('false');
        expect(refreshButton().hasAttribute('disabled')).toBe(false);
    });

    test('Refresh reads the search that is on screen again', async () => {
        setup();
        await opened();
        fireEvent.change(screen.getByLabelText('Search your photos by tag'), { target: { value: 'cat' } });
        fireEvent.submit(screen.getByLabelText('Search your photos by tag').closest('form')!);
        await waitFor(() => expect(getLibrary()).toHaveBeenLastCalledWith(7, 'cat', 'fresh', 'submit'));
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        fireEvent.click(refreshButton());
        expect(getLibrary()).toHaveBeenLastCalledWith(7, 'cat', 'fresh', 'submit');
    });

    test('a listing read for this challenge in the last minutes opens as it is: no status line, no second read', async () => {
        getLibrary().mockResolvedValue(listing([photo(1, { allowed: false, message: 'Already used' })]));
        setup();
        loadAll();
        expect(await screen.findByText('Already used')).toBeTruthy();
        await effectsFlushed();
        expect(getLibrary()).toHaveBeenCalledTimes(1);
        expect(screen.queryByText(/as last loaded/)).toBeNull();
    });

    test.each([
        [7, 'Showing your photos as last loaded while the app checks which ones this challenge accepts…'],
        [null, 'Showing your photos as last loaded while the app checks for anything new…'],
    ])(
        'a preview for challenge %p says the app is checking, shows the photos without marks and is replaced by the fresh listing',
        async (challengeId, line) => {
            const fresh = deferred<Listing>();
            getLibrary()
                .mockResolvedValueOnce(previewOf([photo(1), photo(2)]))
                .mockReturnValueOnce(fresh.promise);
            setup({ challengeId });
            loadAll();
            await screen.findByRole('button', { name: /^Photo 00000001:/ });
            expect(screen.getByText(line).getAttribute('role')).toBe('status');
            // Whatever the other challenge said is withheld: no "can be entered", no reason.
            expect(screen.queryByText('Can be entered')).toBeNull();
            expect(screen.queryByText('Not eligible for this challenge')).toBeNull();
            expect(refreshButton().getAttribute('aria-busy')).toBe('true');
            expect(getLibrary().mock.calls.map((call) => call[2])).toEqual(['cached', 'fresh']);
            await act(async () =>
                fresh.resolve(
                    listing([photo(1, { allowed: false, message: 'Already used' }), photo(2)], {
                        allowedKnown: challengeId !== null,
                    }),
                ),
            );
            await waitFor(() => expect(screen.queryByText(line)).toBeNull());
            // With a challenge its marks are in now; without one the photos still carry none.
            if (challengeId === null) expect(screen.queryByText('Already used')).toBeNull();
            else expect(screen.getByText('Already used')).toBeTruthy();
            expect(refreshButton().getAttribute('aria-busy')).toBe('false');
        },
    );

    test('eligibility is only said to be unchecked for a chooser with no challenge, preview or not', async () => {
        getLibrary().mockResolvedValue(previewOf([photo(1)]));
        const { unmount } = setup({ challengeId: 7 });
        loadAll();
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        expect(screen.queryByText(/Eligibility is not checked here/)).toBeNull();
        unmount();
        setup({ challengeId: null });
        loadAll();
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        expect(screen.getByText(/Eligibility is not checked here/)).toBeTruthy();
    });

    test.each([
        [
            7,
            "Couldn't check which of these photos this challenge accepts, so they're shown as last loaded. Press Refresh.",
        ],
        [null, "Couldn't check your photos for changes, so they're shown as last loaded. Press Refresh."],
    ])('a re-check that failed for challenge %p says so and keeps the photos', async (challengeId, line) => {
        getLibrary()
            .mockResolvedValueOnce(previewOf([photo(1)]))
            .mockResolvedValueOnce(failure);
        setup({ challengeId });
        loadAll();
        expect(await screen.findByText(line)).toBeTruthy();
        expect(tile(1)).toBeTruthy();
        expect(screen.queryByText(/while the app checks/)).toBeNull();
        // Refresh tries again, and a listing that arrives clears the line.
        getLibrary().mockResolvedValueOnce(listing([photo(1)]));
        fireEvent.click(refreshButton());
        await waitFor(() => expect(screen.queryByText(line)).toBeNull());
    });

    test('a selected photo the preview lists is a normal tile with no marks, and picking works on a preview', async () => {
        const fresh = deferred<Listing>();
        getLibrary()
            .mockResolvedValueOnce(previewOf([photo(1), photo(2)]))
            .mockReturnValueOnce(fresh.promise);
        setup({ value: [idOf(1)] });
        loadAll();
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        expect(tile(1).getAttribute('aria-pressed')).toBe('true');
        expect(tile(1).getAttribute('aria-label')).toMatch(/Number 1 in your list\.$/);
        fireEvent.click(tile(2));
        expect(tile(2).getAttribute('aria-pressed')).toBe('true');
        expect(countLine().textContent).toContain('2 of');
        await act(async () => fresh.resolve(listing([photo(1), photo(2)])));
    });

    test.each([
        [7, 'Not available for this challenge (in another challenge, or deleted)'],
        [null, 'Not found in your library (it may have been deleted)'],
    ])(
        'a selected photo the preview lacks waits as a tile that cannot be removed, then follows the usual missing rules (challenge %p)',
        async (challengeId, missing) => {
            const fresh = deferred<Listing>();
            getLibrary()
                .mockResolvedValueOnce(previewOf([photo(1)]))
                .mockReturnValueOnce(fresh.promise);
            setup({ value: [idOf(9)], challengeId });
            loadAll();
            await screen.findByRole('button', { name: /^Photo 00000001:/ });
            const waiting = pendingTile(9);
            expect(waiting.textContent).toContain('Not among your photos as last loaded. Checking again…');
            expect(waiting.getAttribute('aria-pressed')).toBe('true');
            expect(waiting.getAttribute('aria-disabled')).toBe('true');
            expect(waiting.getAttribute('aria-label')).toMatch(/Number 1 in your list\.$/);
            fireEvent.click(waiting);
            expect(pendingTile(9).getAttribute('aria-pressed')).toBe('true');
            expect(countLine().textContent).toContain('1 of');
            await act(async () => fresh.resolve(listing([photo(1)], { allowedKnown: challengeId !== null })));
            await waitFor(() => expect(pendingTile(9).textContent).toContain(missing));
            // Now it is the usual missing tile: removable.
            fireEvent.click(pendingTile(9));
            expect(screen.queryByRole('button', { name: new RegExp(`^Chosen photo ${shortOf(9)}:`) })).toBeNull();
        },
    );

    test('once the re-check has failed the waiting tile says to press Refresh and can be removed', async () => {
        getLibrary()
            .mockResolvedValueOnce(previewOf([photo(1)]))
            .mockResolvedValueOnce(failure);
        setup({ value: [idOf(9)] });
        loadAll();
        await waitFor(() =>
            expect(pendingTile(9).textContent).toContain(
                'Not among your photos as last loaded. Press Refresh to check again.',
            ),
        );
        expect(pendingTile(9).getAttribute('aria-disabled')).toBe('false');
        fireEvent.click(pendingTile(9));
        expect(screen.queryByRole('button', { name: new RegExp(`^Chosen photo ${shortOf(9)}:`) })).toBeNull();
        expect(countLine().textContent).toContain('0 of');
    });

    test('a chosen photo that has won shows the won tile during a preview, not the waiting one', async () => {
        const fresh = deferred<Listing>();
        getLibrary()
            .mockResolvedValueOnce(previewOf([photo(1)], { wonIds: [idOf(9)], wonCount: 1 }))
            .mockReturnValueOnce(fresh.promise);
        setup({ value: [idOf(9)] });
        loadAll();
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        expect(pendingTile(9).textContent).toContain("Has won a challenge, so it can't be entered again.");
        expect(pendingTile(9).textContent).not.toContain('as last loaded');
        // The ordinary missing tile: it is a toggle that can be removed.
        expect(pendingTile(9).hasAttribute('aria-disabled')).toBe(false);
        await act(async () => fresh.resolve(listing([photo(1)], { wonIds: [idOf(9)], wonCount: 1 })));
    });

    test.each([
        ['Asia/Tokyo', /^Photos as of 15\/11\/2023, 07:13$/],
        ['Europe/Riga', /^Photos as of 15\/11\/2023, 00:13$/],
        ['America/New_York', /^Photos as of 14\/11\/2023, 17:13$/],
    ])('the “as of” line is written in the timezone the settings name (%s)', async (timezone, line) => {
        jest.mocked(window.api.getSettings).mockResolvedValue(invalid({ app: { timezone } }));
        getLibrary().mockResolvedValue(listing([photo(1)], { readAtMs: 1_700_000_000_000 }));
        setup();
        loadAll();
        expect(await screen.findByText(line)).toBeTruthy();
    });

    describe('the “as of” line against the device clock', () => {
        afterEach(() => {
            jest.restoreAllMocks();
        });

        // Without a timeZone option the date methods read the device clock. A sentinel makes that observable on any
        // host (process.env.TZ does not reach Node under Jest); a call that names a zone goes through.
        const pinDeviceClock = (): void => {
            const realTime = Date.prototype.toLocaleTimeString;
            const realDate = Date.prototype.toLocaleDateString;
            jest.spyOn(Date.prototype, 'toLocaleTimeString').mockImplementation(function (
                this: Date,
                locales?: Intl.LocalesArgument,
                options?: Intl.DateTimeFormatOptions,
            ) {
                return options?.timeZone ? realTime.call(this, locales, options) : '05:37';
            });
            jest.spyOn(Date.prototype, 'toLocaleDateString').mockImplementation(function (
                this: Date,
                locales?: Intl.LocalesArgument,
                options?: Intl.DateTimeFormatOptions,
            ) {
                return options?.timeZone ? realDate.call(this, locales, options) : 'DEVICE-DATE';
            });
        };

        test('a timezone that is not valid is read as UTC, and Riga when none is set', async () => {
            pinDeviceClock();
            getLibrary().mockResolvedValue(listing([photo(1)], { readAtMs: 1_700_000_000_000 }));
            jest.mocked(window.api.getSettings).mockResolvedValue(invalid({ app: { timezone: 'Not/AZone' } }));
            const { unmount } = setup();
            loadAll();
            expect(await screen.findByText(/^Photos as of 14\/11\/2023, 22:13$/)).toBeTruthy();
            unmount();
            jest.mocked(window.api.getSettings).mockResolvedValue(invalid({ app: {} }));
            setup();
            loadAll();
            expect(await screen.findByText(/^Photos as of 15\/11\/2023, 00:13$/)).toBeTruthy();
        });

        test('“local” is written on the device’s clock', async () => {
            pinDeviceClock();
            getLibrary().mockResolvedValue(listing([photo(1)], { readAtMs: 1_700_000_000_000 }));
            jest.mocked(window.api.getSettings).mockResolvedValue(invalid({ app: { timezone: 'local' } }));
            setup();
            loadAll();
            expect(await screen.findByText('Photos as of 05:37')).toBeTruthy();
        });
    });

    test.each([
        [
            'an empty listing',
            listing([]),
            'No photos found. Try another tag, or upload photos to your GuruShots library and press Refresh.',
        ],
        [
            'one where every match has won',
            listing([], { wonIds: [idOf(7)], wonCount: 1 }),
            'No photos you can enter were found: every match has won a challenge. Try another tag, or upload new photos to your GuruShots library and press Refresh.',
        ],
    ])('%s ends by pointing at Refresh', async (_name, empty, text) => {
        getLibrary().mockResolvedValue(empty);
        setup();
        loadAll();
        expect(await screen.findByText(text)).toBeTruthy();
    });
});
