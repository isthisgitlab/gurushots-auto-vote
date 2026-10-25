/**
 * PhotoChooserModal: the Chosen Photos chooser on the shared Pick… picker. Nothing is read on open:
 * the saved picks show once the member check says they are this account's, Load all and Search read
 * the library, Auto (with a challenge) ranks and fills without a read. Selection is a numbered list
 * capped at MAX_CHOSEN_PHOTOS, listed picks keep their place in the library's order, a chosen id the
 * listing lacks gets its own tile, eligibility shows as text, search runs on submit and late
 * responses are dropped. With a challenge, every selected tile carries a Boost / Turbo pin pair over
 * the challenge's stored pins, and Save writes the changed pins after the host's save. Translations
 * are the real English strings so the tiles are told apart by their accessible names.
 */

import { act, fireEvent, pickOption, render, screen, waitFor, within } from './helpers/test-utils';
import { PhotoChooserModal } from '@/components/app/PhotoChooserModal';
import { PhotoGrid } from '@/components/app/PhotoGrid';
import { useImageLoads } from '@/hooks/useImageLoads';
import { Modal } from '@/components/ui/Modal';
import { mockTranslator } from './helpers/setup';
import { rememberCurrentMember } from '../../src/ts/react/hooks/currentMember';
import { app, errors } from '../../src/ts/translations/english';
import { MAX_CHOSEN_PHOTOS } from '../../src/ts/settings/limits';
import { invalid } from '../helpers/invalid';
import type { usePhotoPicker } from '@/hooks/usePhotoPicker';
import type { TileStats } from '@/hooks/usePhotoStatsLoader';
import type { EntryPinKind } from '../../src/ts/types/settings';
import type { WindowApi } from '../../src/ts/types/ipc';

// The live picker instances, so a test can press loadMore: the saved-list read keys on the listing the
// appended batch leaves (the same one on screen), and one case presses it directly.
const pickers: ReturnType<typeof usePhotoPicker>[] = [];
jest.mock('@/hooks/usePhotoPicker', () => ({
    __esModule: true,
    usePhotoPicker: (props: Parameters<typeof usePhotoPicker>[0]) => {
        const picker = jest
            .requireActual<typeof import('@/hooks/usePhotoPicker')>('@/hooks/usePhotoPicker')
            .usePhotoPicker(props);
        pickers.push(picker);
        return picker;
    },
}));

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
    nextStart: 0,
    wonIds: [],
    wonCount: 0,
    preview: false,
    readAtMs: 1_700_000_000_000,
    allowedKnown: true,
    ...over,
});

const english = (key: string) =>
    key.startsWith('app.')
        ? ((app as Record<string, string>)[key.slice(4)] ?? key)
        : key.startsWith('errors.')
          ? ((errors as Record<string, string>)[key.slice(7)] ?? key)
          : key;

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
const loadPhotos = () => fireEvent.click(screen.getByRole('button', { name: 'Load photos' }));
const opened = async () => {
    loadPhotos();
    await screen.findByRole('button', { name: /^Photo 00000001:/ });
};

type Props = Parameters<typeof PhotoChooserModal>[0];
const setup = (
    over: Partial<{
        value: string[];
        challengeId: string | number | null;
        canSuggest: boolean;
        recommendedIds: string[];
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
    // The remembered member outlives a test (a module-level store): each starts before any listing named one.
    rememberCurrentMember(null);
    pickers.length = 0;
    // mockReset, so a once-queued answer a failed test never consumed cannot leak into the next one.
    getLibrary()
        .mockReset()
        .mockResolvedValue(listing([photo(1), photo(2), photo(3)]));
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
        const idle = screen.getByText(/^Your photos are not loaded yet\./);
        expect(idle.getAttribute('role')).toBe('status');
        expect(idle.textContent).toBe('Your photos are not loaded yet. Load photos or search.');
        expect(screen.getByRole('button', { name: 'Load photos' })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Search' })).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Auto' })).toBeNull();
        // The help names no Auto and no challenge where there is none.
        expect(screen.getByText(/^Used first, but they must still pass/).textContent).not.toMatch(
            /press Auto|challenge's own settings/,
        );
    });

    test('with a challenge Auto is offered and the idle line names it', () => {
        setup();
        expect(screen.getByRole('button', { name: 'Auto' })).toBeTruthy();
        expect(screen.getByText(/^Your photos are not loaded yet\./).textContent).toBe(
            'Your photos are not loaded yet. Load photos, search, or press Auto.',
        );
        expect(screen.getByText(/^Auto ranks your photos/).textContent).toContain('Nothing is saved');
    });

    test('a Discover row (a challenge, but not joined) offers no Auto and its help says so', () => {
        setup({ canSuggest: false });
        expect(screen.queryByRole('button', { name: 'Auto' })).toBeNull();
        // The challenge is real, so the listing would read through it — but nothing ranks.
        expect(jest.mocked(window.api.suggestPhotos)).not.toHaveBeenCalled();
        expect(screen.getByText(/^Your photos are not loaded yet\./).textContent).toBe(
            'Your photos are not loaded yet. Load photos or search.',
        );
    });

    test('Load all reads the library through the challenge it was opened for', async () => {
        setup({ challengeId: 42 });
        await opened();
        expect(getLibrary()).toHaveBeenCalledWith(42, undefined, 'cached', 'submit', 0, 100);
    });

    test('the saved picks show as numbered stubs straight away, and Save is not held', async () => {
        // A listing named the member earlier in the page's life: the store keeps it, so the stubs get
        // their thumbnails without any read.
        rememberCurrentMember(MEMBER);
        setup({ value: [idOf(1), idOf(3)] });
        expect(await screen.findByRole('button', { name: /^Chosen photo 00000003:/ })).toBeTruthy();
        expect(stubTile(1).getAttribute('aria-pressed')).toBe('true');
        expect(stubTile(3).getAttribute('aria-pressed')).toBe('true');
        // Numbered as the list's order, in badge and name.
        expect(within(stubTile(1)).getByText('1')).toBeTruthy();
        expect(within(stubTile(3)).getByText('2')).toBeTruthy();
        expect(stubTile(1).getAttribute('aria-label')).toMatch(/Number 1 in your list\.$/);
        expect(stubTile(1).querySelector('img')?.getAttribute('src')).toContain(MEMBER);
        // No library read happened.
        expect(getLibrary()).not.toHaveBeenCalled();
        expect(screen.getByRole('button', { name: 'Use these photos' }).getAttribute('aria-disabled')).toBeNull();
        const picks = screen.getByText(/^Your chosen photos stay picked\./);
        expect(picks.getAttribute('role')).toBe('status');
    });

    test('a stub claims nothing about the photo itself: no tags, only that it is not loaded', async () => {
        setup({ value: [idOf(1)] });
        const stub = await screen.findByRole('button', { name: /^Chosen photo 00000001:/ });
        expect(stub.getAttribute('aria-label')).toBe(
            `Chosen photo ${shortOf(1)}: Not loaded yet. Number 1 in your list.`,
        );
        expect(stub.textContent).toContain('Not loaded yet');
        expect(stub.textContent).not.toContain('No tags');
    });

    test('a stub gains its thumbnail once Auto has named the member, and stays text-only before that', async () => {
        jest.mocked(window.api.suggestPhotos).mockResolvedValueOnce({
            success: true,
            memberId: MEMBER,
            photos: [photo(5)],
            statsLimited: false,
        });
        setup({ value: [idOf(1)] });
        const stub = await screen.findByRole('button', { name: /^Chosen photo 00000001:/ });
        expect(stub.querySelector('img')).toBeNull();
        expect(stub.textContent).toContain(shortOf(1));
        // Auto names the signed-in member: the stub's thumbnail can be built from it.
        fireEvent.click(screen.getByRole('button', { name: 'Auto' }));
        await screen.findByRole('region', { name: 'Suggestions' });
        expect(stubTile(1).querySelector('img')?.getAttribute('src')).toContain(MEMBER);
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

    test('with no list, Auto and Add still fill, and the line names the picks', async () => {
        jest.mocked(window.api.suggestPhotos).mockResolvedValueOnce({
            success: true,
            memberId: MEMBER,
            photos: [photo(5)],
            statsLimited: false,
        });
        setup({ value: [] });
        // Nothing waits: the plain idle line.
        expect(screen.getByText(/^Your photos are not loaded yet\./).textContent).toBe(
            'Your photos are not loaded yet. Load photos, search, or press Auto.',
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
        loadPhotos();
        await screen.findByRole('button', { name: /^Photo 00000002:/ });
        fireEvent.click(tile(2));
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(screen.getByText(discardTitle)).toBeTruthy();
        rerender(<PhotoChooserModal isOpen={false} onClose={onClose} value={[idOf(1)]} onSave={onSave} />);
        rerender(<PhotoChooserModal isOpen onClose={onClose} value={[idOf(1)]} onSave={onSave} />);
        await screen.findByRole('button', { name: /^Chosen photo 00000001:/ });
        expect(screen.queryByText(discardTitle)).toBeNull();
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
        loadPhotos();
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
        loadPhotos();
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
        // The refused photo is picked, so its tile — and the server's reason with it — stays on screen.
        setup({ value: [idOf(1)] });
        loadPhotos();
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        expect(document.querySelector('[role="dialog"] b')).toBeNull();
        expect(document.querySelector('img[src="x"]')).toBeNull();
        expect(screen.getByText('<b>no</b>')).toBeTruthy();
    });

    test('shows the empty state when the library has no photos', async () => {
        getLibrary().mockResolvedValue(listing([]));
        setup();
        loadPhotos();
        expect(await screen.findByText(/No photos found/)).toBeTruthy();
    });

    test('a cut-off listing says what is shown and offers Load more; a complete one offers nothing', async () => {
        getLibrary().mockResolvedValue(listing([photo(1), photo(2)], { truncated: true, nextStart: 2 }));
        setup();
        loadPhotos();
        expect(await screen.findByText('Showing 2 photo(s).')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Load more photos' })).toBeTruthy();
        getLibrary().mockResolvedValue(listing([photo(1), photo(2)]));
        fireEvent.click(screen.getByRole('button', { name: 'Load more photos' }));
        await waitFor(() => expect(screen.queryByRole('button', { name: 'Load more photos' })).toBeNull());
        expect(screen.getByText('Showing 2 photo(s).')).toBeTruthy();
        // Nothing new came back, and that is not a failure.
        expect(screen.queryByRole('alert')).toBeNull();
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
        expect(boxClasses.contains('scroll-pb-[min(12rem,50dvh)]')).toBe(true);
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
            loadPhotos();
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
        loadPhotos();
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
        loadPhotos();
        const missing = await missingTile();
        // A complete listing: no "beyond the photos loaded" clause.
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
            'no challenge and a complete listing',
            { allowedKnown: false },
            null,
            'Not found in your library (it may have been deleted)',
        ],
    ])('the not-available text for %s', async (_name, over, challengeId, text) => {
        getLibrary().mockResolvedValue(listing([photo(1), photo(2)], over));
        setup({ value: [idOf(9)], challengeId });
        loadPhotos();
        expect((await missingTile()).textContent).toContain(text);
    });

    test.each([
        ['a challenge and a cut-off listing', { truncated: true, nextStart: 2 }, 7],
        ['no challenge and a cut-off listing', { allowedKnown: false, truncated: true, nextStart: 2 }, null],
    ])(
        'a cut-off listing shows an unreached pick as a stub that points at Load more: %s',
        async (_name, over, challengeId) => {
            getLibrary().mockResolvedValue(listing([photo(1), photo(2)], over));
            setup({ value: [idOf(9)], challengeId });
            loadPhotos();
            const stub = await missingTile();
            expect(stub.textContent).toContain('Not in the photos loaded yet; press Load more photos to look for it.');
            expect(stub.textContent).not.toContain('Not available for this challenge');
            expect(stub.textContent).not.toContain('Not found in your library');
        },
    );

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
                "Hidden: at least 1 photo(s) that have won a challenge. A winning photo can't be entered again. Press Load more photos to look for more.",
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
        loadPhotos();
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
        loadPhotos();
        expect(await screen.findByText(/^No photos found\./)).toBeTruthy();
        expect(screen.queryByText(/every match has won/)).toBeNull();
        expect(screen.getByText(/^Hidden: at least 1 photo/)).toBeTruthy();
    });

    test('a chosen photo that has won gets its own tile text, with the next step, and can still be removed', async () => {
        getLibrary().mockResolvedValue(listing([photo(1)], { wonIds: [idOf(9)], wonCount: 1 }));
        setup({ value: [idOf(9)] });
        loadPhotos();
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
        loadPhotos();
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
        loadPhotos();
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
        // Below sm Clear takes the first row so Cancel and Save wrap together onto the second.
        expect(screen.getByRole('button', { name: 'Clear' }).className).toContain('max-sm:basis-full');
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
// A picker fixture for the direct PhotoGrid renders below: the fields the grid reads. The rest of
// the hook's return is only for the toolbar and the modals, which these blocks do not render.
const gridPicker = (over: Partial<ReturnType<typeof usePhotoPicker>> = {}): ReturnType<typeof usePhotoPicker> =>
    invalid<ReturnType<typeof usePhotoPicker>>({
        state: { status: 'idle' },
        known: new Map<string, LibraryPhoto>(),
        revalidating: false,
        recheckFailed: false,
        loadMore: jest.fn<Promise<void>, []>(),
        loadingMore: false,
        loadMoreFailed: null,
        isSearch: false,
        retry: jest.fn<number, []>(() => 1),
        suggestedKnown: new Map<string, LibraryPhoto>(),
        suggestedMemberId: null,
        idleShown: [],
        stats: new Map<string, TileStats>(),
        sortStats: new Map<string, TileStats>(),
        sortBy: 'library',
        showStats: false,
        setTileIds: jest.fn<void, [readonly string[]]>(),
        ...over,
    });

describe('PhotoGrid numbering when a selected photo is left out of the grid', () => {
    // Selected [1, 9, 2], where 9 is not in the listing: it keeps its place and its number.
    const grid = () => {
        const photos = [photo(1), photo(2), photo(3)];
        return render(
            <PhotoGrid
                picker={gridPicker({
                    state: { status: 'ready', listing: listing(photos), order: 'votes' },
                    known: new Map(photos.map((p) => [p.id, p])),
                })}
                selected={[idOf(1), idOf(9), idOf(2)]}
                locked={false}
                hasChallenge
                onToggle={jest.fn()}
                onRefresh={jest.fn()}
            />,
        );
    };
    const numberOf = (n: number) => within(tile(n)).queryByText(/^\d+$/)?.textContent ?? null;

    test('the unlisted pick holds its place: the next one is numbered 3', () => {
        grid();
        const missing = screen.getByRole('button', { name: new RegExp(`^Chosen photo ${shortOf(9)}:`) });
        expect(missing.getAttribute('aria-label')).toMatch(/Number 2 in your list\.$/);
        expect([numberOf(1), numberOf(2)]).toEqual(['1', '3']);
        expect(tile(2).getAttribute('aria-label')).toMatch(/Number 3 in your list\.$/);
        // The unselected tile has none.
        expect(numberOf(3)).toBeNull();
    });
});

describe('PhotoGrid as a plain set (max, fullKey, numbered)', () => {
    const photos = [photo(1), photo(2), photo(3)];
    const grid = (props: Partial<Parameters<typeof PhotoGrid>[0]> = {}) =>
        render(
            <PhotoGrid
                picker={gridPicker({
                    state: { status: 'ready', listing: listing(photos), order: 'votes' },
                    known: new Map(photos.map((p) => [p.id, p])),
                })}
                selected={[idOf(1), idOf(9)]}
                locked={false}
                hasChallenge
                onToggle={jest.fn()}
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
                picker={gridPicker()}
                selected={[]}
                locked={false}
                hasChallenge
                numbered={false}
                onToggle={jest.fn()}
                onRefresh={jest.fn()}
                {...props}
            />,
        );
    const idleLine = () => screen.getByText(/^Photos are not loaded yet/);

    test('with no picks it says nothing is loaded and shows no tile', () => {
        grid({ picker: gridPicker({ suggestedKnown: extra }) });
        expect(idleLine().getAttribute('role')).toBe('status');
        expect(idleLine().textContent).toBe('Photos are not loaded yet. Load photos, search, or press Auto.');
        expect(screen.queryByRole('button')).toBeNull();
    });

    test('the idle line is the caller’s key, so a chooser without Auto can name its own', () => {
        grid({ picker: gridPicker({ suggestedKnown: extra }), idleKey: 'app.photoChooserIdle' });
        expect(screen.getByText(/^Your photos are not loaded yet\./).textContent).toBe(
            'Your photos are not loaded yet. Load photos or search.',
        );
    });

    test('a pick found in extraPhotos shows as a pressed, unnumbered tile with the idle member’s thumbnail and toggles', () => {
        const onToggle = jest.fn();
        grid({
            picker: gridPicker({ idleShown: [idOf(2)], suggestedKnown: extra, suggestedMemberId: MEMBER }),
            selected: [idOf(2)],
            onToggle,
        });
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
        const props = {
            picker: gridPicker({ idleShown: [idOf(1), idOf(2)], suggestedKnown: extra }),
            selected: [idOf(2)],
            onToggle,
        };
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
        grid({ picker: gridPicker({ suggestedKnown: extra }), selected: [idOf(9)] });
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
            picker: gridPicker({ idleShown: [idOf(9), idOf(1)], suggestedKnown: extra }),
            selected: [idOf(9), idOf(1)],
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
            picker: gridPicker({ idleShown: [idOf(9)] }),
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
        grid({
            picker: gridPicker({ idleShown: [idOf(1), idOf(9)] }),
            selected: [idOf(1)],
            savedPicks: { memberId: MEMBER },
            max: 1,
            onToggle,
        });
        const held = screen.getByRole('button', { name: new RegExp(`^Chosen photo ${shortOf(9)}: List full`) });
        expect(held.getAttribute('aria-pressed')).toBe('false');
        expect(held.getAttribute('aria-disabled')).toBe('true');
        fireEvent.click(held);
        expect(onToggle).not.toHaveBeenCalled();
        expect(stubTile(1).getAttribute('aria-disabled')).toBe('false');
    });

    test('a stub that leaves the page hands the focus to the grid’s status line, as a read tile does', () => {
        const { rerender } = render(
            <PhotoGrid
                picker={gridPicker({ idleShown: [idOf(9)] })}
                selected={[idOf(9)]}
                locked={false}
                hasChallenge
                savedPicks={{ memberId: MEMBER }}
                onToggle={jest.fn()}
                onRefresh={jest.fn()}
            />,
        );
        const stub = stubTile(9);
        stub.focus();
        expect(document.activeElement).toBe(stub);
        rerender(
            <PhotoGrid
                picker={gridPicker({ idleShown: [idOf(9)] })}
                selected={[idOf(9)]}
                locked={false}
                hasChallenge
                savedPicks={null}
                onToggle={jest.fn()}
                onRefresh={jest.fn()}
            />,
        );
        expect(screen.queryByRole('button')).toBeNull();
        expect(document.activeElement).toBe(screen.getAllByRole('status')[0]);
    });
});

describe('eligibility', () => {
    test('a refused photo the saved list names keeps its dimmed tile with its reason, and stays removable', async () => {
        getLibrary().mockResolvedValue(
            listing([photo(1, { allowed: false, message: 'Already in another challenge' }), photo(2)]),
        );
        setup({ value: [idOf(1)] });
        loadPhotos();
        const blocked = await screen.findByRole('button', { name: /^Photo 00000001:/ });
        // A pick is shown whatever its mark, never dimmed (it stays removable), wearing its reason.
        expect(blocked.getAttribute('aria-disabled')).toBe('false');
        expect(blocked.querySelector('.opacity-50')).toBeNull();
        expect(within(blocked).getByText('Already in another challenge')).toBeTruthy();
        expect(screen.getByText('Can be entered')).toBeTruthy();
        fireEvent.click(blocked);
        expect(screen.queryByRole('button', { name: /^Photo 00000001:/ })).toBeNull();
    });

    test('a refused photo that is not picked is hidden and counted', async () => {
        getLibrary().mockResolvedValue(listing([photo(1, { allowed: false }), photo(2), photo(3, { allowed: false })]));
        setup();
        loadPhotos();
        expect(await screen.findByRole('button', { name: /^Photo 00000002:/ })).toBeTruthy();
        expect(screen.queryByRole('button', { name: /^Photo 00000001:/ })).toBeNull();
        expect(screen.queryByRole('button', { name: /^Photo 00000003:/ })).toBeNull();
        expect(screen.getByText("Hidden: 2 photo(s) GuruShots won't take in this challenge.")).toBeTruthy();
    });

    test('a refused photo without a message gets a generic reason, and stays removable once chosen', async () => {
        getLibrary().mockResolvedValue(listing([photo(1, { allowed: false })]));
        setup({ value: [idOf(1)] });
        const blocked = await (async () => {
            loadPhotos();
            return screen.findByRole('button', { name: /^Photo 00000001:/ });
        })();
        expect(screen.getByText('Not eligible for this challenge')).toBeTruthy();
        expect(blocked.getAttribute('aria-disabled')).toBe('false');
    });

    test('without a challenge the listing says eligibility is only checked at submit time', async () => {
        getLibrary().mockResolvedValue(listing([photo(1, { allowed: false })], { allowedKnown: false }));
        setup({ challengeId: null });
        loadPhotos();
        const only = await screen.findByRole('button', { name: /^Photo 00000001:/ });
        expect(screen.getByText(/Eligibility is not checked here/)).toBeTruthy();
        expect(only.getAttribute('aria-disabled')).toBe('false');
        expect(screen.queryByText('Not eligible for this challenge')).toBeNull();
        expect(screen.queryByText('Can be entered')).toBeNull();
        expect(getLibrary()).toHaveBeenCalledWith(null, undefined, 'cached', 'submit', 0, 100);
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
        expect(getLibrary()).toHaveBeenLastCalledWith(7, 'cat', 'fresh', 'submit', 0, 100);
        expect(await screen.findByRole('button', { name: /^Photo 00000001:/ })).toBeTruthy();
    });

    test('a selected photo a narrower search no longer lists keeps its tile', async () => {
        getLibrary()
            .mockResolvedValueOnce(listing([photo(1), photo(2)]))
            .mockResolvedValueOnce(listing([photo(3)]));
        setup({ value: [idOf(1)] });
        loadPhotos();
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
        loadPhotos();
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
        loadPhotos();
        const alert = await screen.findByRole('alert');
        // Nothing came back to show as a detail: a generic why and next step, not "details below".
        expect(alert.textContent).toContain("Your photos couldn't be loaded — the request was interrupted. Try again.");
        expect(alert.textContent).not.toContain('details below');
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        expect(getLibrary()).toHaveBeenLastCalledWith(7, undefined, 'fresh', 'submit', 0, 100);
    });

    test('an error is shown as a translated detail, never as raw handler text; invalid-args has its own', async () => {
        getLibrary().mockResolvedValueOnce({ success: false, error: 'Failed to read your photo library' });
        const view = setup();
        loadPhotos();
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
        loadPhotos();
        expect((await screen.findByRole('alert')).textContent).toContain('Bad request');
    });

    test('retry keeps the submitted search', async () => {
        getLibrary()
            .mockResolvedValueOnce(listing([photo(1)]))
            .mockResolvedValueOnce(invalid(null));
        setup();
        loadPhotos();
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        const box = screen.getByLabelText('Search your photos by tag');
        fireEvent.change(box, { target: { value: 'dog' } });
        fireEvent.submit(box.closest('form')!);
        await screen.findByRole('alert');
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
        await waitFor(() => expect(getLibrary()).toHaveBeenLastCalledWith(7, 'dog', 'fresh', 'submit', 0, 100));
    });

    test('with no challenge to read the library through it explains what is needed', async () => {
        getLibrary().mockResolvedValue({ success: false, error: 'no-challenge-context' });
        setup({ challengeId: null });
        loadPhotos();
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

    test('a Refresh clears the strip, and a read that lands keeps the picks as real tiles', async () => {
        suggestPhotos().mockResolvedValueOnce(suggestion([photo(9)]));
        setup();
        fireEvent.click(autoButton());
        await screen.findByRole('region', { name: 'Suggestions' });
        fireEvent.click(stripTile(9));
        loadPhotos();
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
    const help = screen.getByText(/^Used first, but they must still pass/).textContent!;
    expect(help).toContain('must still pass your tag filters');
    expect(help).toContain("Ranked like the app's own picks");
    expect(help).toContain('in your pick order if that setting is on');
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
    await screen.findByRole('button', { name: 'Load photos' });
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
        loadPhotos();
        const today = await screen.findByText(/^Photos as of \d{2}:\d{2}$/);
        // Its own live region, apart from the count of what is picked.
        expect(today.getAttribute('role')).toBe('status');
        expect(countLine().textContent).not.toContain('Photos as of');
        unmount();
        getLibrary().mockResolvedValue(listing([photo(1)], { readAtMs: 1_700_000_000_000 }));
        setup();
        loadPhotos();
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
        expect(getLibrary()).toHaveBeenLastCalledWith(7, undefined, 'fresh', 'submit', 0, 3);
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
        await waitFor(() => expect(getLibrary()).toHaveBeenLastCalledWith(7, 'cat', 'fresh', 'submit', 0, 100));
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        fireEvent.click(refreshButton());
        expect(getLibrary()).toHaveBeenLastCalledWith(7, 'cat', 'fresh', 'submit', 0, 3);
    });

    test('a listing read for this challenge in the last minutes opens as it is: no status line, no second read', async () => {
        getLibrary().mockResolvedValue(listing([photo(1, { allowed: false, message: 'Already used' })]));
        // Photo 1 is picked, so the refused photo keeps its tile and its reason.
        setup({ value: [idOf(1)] });
        loadPhotos();
        expect(await screen.findByText('Already used')).toBeTruthy();
        await effectsFlushed();
        expect(getLibrary()).toHaveBeenCalledTimes(1);
        expect(screen.queryByText(/as last loaded/)).toBeNull();
    });

    test('a preview for the challenge is never on screen: the loader holds its place until the fresh listing lands', async () => {
        const fresh = deferred<Listing>();
        getLibrary()
            .mockResolvedValueOnce(previewOf([photo(1), photo(2)]))
            .mockReturnValueOnce(fresh.promise);
        setup({ challengeId: 7, value: [idOf(1)] });
        loadPhotos();
        expect(await screen.findByText('Loading your photos…')).toBeTruthy();
        expect(screen.queryByRole('button', { name: /^Photo / })).toBeNull();
        expect(screen.queryByText(/as last loaded/)).toBeNull();
        await act(async () =>
            fresh.resolve(listing([photo(1, { allowed: false, message: 'Already used' }), photo(2)])),
        );
        await screen.findByRole('button', { name: /^Photo 00000002:/ });
        // The fresh listing carries this challenge's marks: the picked photo wears its refusal.
        expect(screen.getByText('Already used')).toBeTruthy();
        expect(screen.queryByText('Loading your photos…')).toBeNull();
    });

    test('a no-challenge preview shows the photos without marks and is replaced by the fresh listing', async () => {
        const fresh = deferred<Listing>();
        getLibrary()
            .mockResolvedValueOnce(previewOf([photo(1), photo(2)]))
            .mockReturnValueOnce(fresh.promise);
        setup({ challengeId: null });
        loadPhotos();
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        expect(
            screen
                .getByText('Showing your photos as last loaded while the app checks for anything new…')
                .getAttribute('role'),
        ).toBe('status');
        // Whatever the other challenge said is withheld: no "can be entered", no reason.
        expect(screen.queryByText('Can be entered')).toBeNull();
        expect(screen.queryByText('Not eligible for this challenge')).toBeNull();
        expect(refreshButton().getAttribute('aria-busy')).toBe('true');
        expect(getLibrary().mock.calls.map((call) => call[2])).toEqual(['cached', 'fresh']);
        await act(async () =>
            fresh.resolve(
                listing([photo(1, { allowed: false, message: 'Already used' }), photo(2)], { allowedKnown: false }),
            ),
        );
        await waitFor(() => expect(screen.queryByText(/as last loaded/)).toBeNull());
        // Without a challenge the photos still carry no marks.
        expect(screen.queryByText('Already used')).toBeNull();
        expect(refreshButton().getAttribute('aria-busy')).toBe('false');
    });

    test('eligibility is only said to be unchecked for a chooser with no challenge, preview or not', async () => {
        getLibrary().mockResolvedValue(previewOf([photo(1)]));
        const { unmount } = setup({ challengeId: 7 });
        loadPhotos();
        // The challenge-bound preview holds the grid behind the loader: no tiles, and no eligibility line either.
        expect(await screen.findByText('Loading your photos…')).toBeTruthy();
        expect(screen.queryByText(/Eligibility is not checked here/)).toBeNull();
        unmount();
        setup({ challengeId: null });
        loadPhotos();
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        expect(screen.getByText(/Eligibility is not checked here/)).toBeTruthy();
    });

    test('a failed re-check for the challenge lands in the error state with Retry', async () => {
        getLibrary()
            .mockResolvedValueOnce(previewOf([photo(1)]))
            .mockResolvedValueOnce(failure);
        setup({ challengeId: 7 });
        loadPhotos();
        await screen.findByRole('alert');
        expect(screen.queryByText(/as last loaded/)).toBeNull();
        expect(screen.queryByRole('button', { name: /^Photo / })).toBeNull();
        // Retry reads again, and a listing that arrives clears the alert.
        getLibrary().mockResolvedValueOnce(listing([photo(1)]));
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
    });

    test('a re-check that failed without a challenge says so and keeps the photos', async () => {
        getLibrary()
            .mockResolvedValueOnce(previewOf([photo(1)]))
            .mockResolvedValueOnce(failure);
        setup({ challengeId: null });
        loadPhotos();
        expect(
            await screen.findByText(
                "Couldn't check your photos for changes, so they're shown as last loaded. Press Refresh.",
            ),
        ).toBeTruthy();
        expect(tile(1)).toBeTruthy();
        expect(screen.queryByText(/while the app checks/)).toBeNull();
        // Refresh tries again, and a listing that arrives clears the line.
        getLibrary().mockResolvedValueOnce(listing([photo(1)]));
        fireEvent.click(refreshButton());
        await waitFor(() => expect(screen.queryByText(/Couldn't check your photos/)).toBeNull());
    });

    test("a failed Refresh on a real listing says the challenge's photos are as last loaded", async () => {
        getLibrary()
            .mockResolvedValueOnce(listing([photo(1)]))
            .mockResolvedValueOnce(failure);
        setup({ challengeId: 7 });
        loadPhotos();
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        fireEvent.click(refreshButton());
        expect(
            await screen.findByText(
                "Couldn't check which of these photos this challenge accepts, so they're shown as last loaded. Press Refresh.",
            ),
        ).toBeTruthy();
        expect(tile(1)).toBeTruthy();
        getLibrary().mockResolvedValueOnce(listing([photo(1)]));
        fireEvent.click(refreshButton());
        await waitFor(() => expect(screen.queryByText(/Couldn't check which/)).toBeNull());
    });

    test('a selected photo the preview lists is a normal tile with no marks, and picking works on a preview', async () => {
        const fresh = deferred<Listing>();
        getLibrary()
            .mockResolvedValueOnce(previewOf([photo(1), photo(2)]))
            .mockReturnValueOnce(fresh.promise);
        setup({ value: [idOf(1)], challengeId: null });
        loadPhotos();
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        expect(tile(1).getAttribute('aria-pressed')).toBe('true');
        expect(tile(1).getAttribute('aria-label')).toMatch(/Number 1 in your list\.$/);
        fireEvent.click(tile(2));
        expect(tile(2).getAttribute('aria-pressed')).toBe('true');
        expect(countLine().textContent).toContain('2 of');
        await act(async () => fresh.resolve(listing([photo(1), photo(2)], { allowedKnown: false })));
    });

    test('a selected photo the no-challenge preview lacks waits as a tile that cannot be removed, then follows the usual missing rules', async () => {
        const fresh = deferred<Listing>();
        getLibrary()
            .mockResolvedValueOnce(previewOf([photo(1)]))
            .mockReturnValueOnce(fresh.promise);
        setup({ value: [idOf(9)], challengeId: null });
        loadPhotos();
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        const waiting = pendingTile(9);
        expect(waiting.textContent).toContain('Not among your photos as last loaded. Checking again…');
        expect(waiting.getAttribute('aria-pressed')).toBe('true');
        expect(waiting.getAttribute('aria-disabled')).toBe('true');
        expect(waiting.getAttribute('aria-label')).toMatch(/Number 1 in your list\.$/);
        fireEvent.click(waiting);
        expect(pendingTile(9).getAttribute('aria-pressed')).toBe('true');
        expect(countLine().textContent).toContain('1 of');
        await act(async () => fresh.resolve(listing([photo(1)], { allowedKnown: false })));
        await waitFor(() =>
            expect(pendingTile(9).textContent).toContain('Not found in your library (it may have been deleted)'),
        );
        // Now it is the usual missing tile: removable.
        fireEvent.click(pendingTile(9));
        expect(screen.queryByRole('button', { name: new RegExp(`^Chosen photo ${shortOf(9)}:`) })).toBeNull();
    });

    test('once the re-check has failed the waiting tile says to press Refresh and can be removed', async () => {
        getLibrary()
            .mockResolvedValueOnce(previewOf([photo(1)]))
            .mockResolvedValueOnce(failure);
        setup({ value: [idOf(9)], challengeId: null });
        loadPhotos();
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
        setup({ value: [idOf(9)], challengeId: null });
        loadPhotos();
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        expect(pendingTile(9).textContent).toContain("Has won a challenge, so it can't be entered again.");
        expect(pendingTile(9).textContent).not.toContain('as last loaded');
        // The ordinary missing tile: it is a toggle that can be removed.
        expect(pendingTile(9).hasAttribute('aria-disabled')).toBe(false);
        await act(async () =>
            fresh.resolve(listing([photo(1)], { wonIds: [idOf(9)], wonCount: 1, allowedKnown: false })),
        );
    });

    test.each([
        ['Asia/Tokyo', /^Photos as of 15\/11\/2023, 07:13$/],
        ['Europe/Riga', /^Photos as of 15\/11\/2023, 00:13$/],
        ['America/New_York', /^Photos as of 14\/11\/2023, 17:13$/],
    ])('the “as of” line is written in the timezone the settings name (%s)', async (timezone, line) => {
        jest.mocked(window.api.getSettings).mockResolvedValue(invalid({ app: { timezone } }));
        getLibrary().mockResolvedValue(listing([photo(1)], { readAtMs: 1_700_000_000_000 }));
        setup();
        loadPhotos();
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
            loadPhotos();
            expect(await screen.findByText(/^Photos as of 14\/11\/2023, 22:13$/)).toBeTruthy();
            unmount();
            jest.mocked(window.api.getSettings).mockResolvedValue(invalid({ app: {} }));
            setup();
            loadPhotos();
            expect(await screen.findByText(/^Photos as of 15\/11\/2023, 00:13$/)).toBeTruthy();
        });

        test('“local” is written on the device’s clock', async () => {
            pinDeviceClock();
            getLibrary().mockResolvedValue(listing([photo(1)], { readAtMs: 1_700_000_000_000 }));
            jest.mocked(window.api.getSettings).mockResolvedValue(invalid({ app: { timezone: 'local' } }));
            setup();
            loadPhotos();
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
        loadPhotos();
        expect(await screen.findByText(text)).toBeTruthy();
    });
});

describe('Load more', () => {
    test('Load photos reads one batch and Load more reads the next from nextStart, appending it', async () => {
        getLibrary()
            .mockResolvedValueOnce(listing([photo(1), photo(2)], { truncated: true, nextStart: 2 }))
            .mockResolvedValueOnce(listing([photo(3)], { truncated: false, nextStart: 3 }));
        setup();
        loadPhotos();
        expect(await screen.findByRole('button', { name: /^Photo 00000001:/ })).toBeTruthy();
        expect(getLibrary().mock.calls[0]).toEqual([7, undefined, 'cached', 'submit', 0, 100]);
        expect(screen.getByText('Showing 2 photo(s).')).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Load more photos' }));
        expect(await screen.findByRole('button', { name: /^Photo 00000003:/ })).toBeTruthy();
        expect(getLibrary().mock.calls[1]).toEqual([7, undefined, 'fresh', 'submit', 2, 100]);
        // The last batch says the listing is complete: the button is gone and nothing failed.
        expect(screen.queryByRole('button', { name: 'Load more photos' })).toBeNull();
        expect(screen.queryByRole('alert')).toBeNull();
        expect(screen.getByText('Showing 3 photo(s).')).toBeTruthy();
    });

    test('while the batch read is in flight, Load more, the toolbar Load photos and Refresh are held', async () => {
        getLibrary().mockResolvedValueOnce(listing([photo(1), photo(2)], { truncated: true, nextStart: 2 }));
        setup();
        loadPhotos();
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        const batch = deferred<Listing>();
        getLibrary().mockReturnValueOnce(invalid(batch.promise));
        fireEvent.click(screen.getByRole('button', { name: 'Load more photos' }));
        const more = screen.getByRole('button', { name: 'Load more photos' });
        expect(more.getAttribute('aria-disabled')).toBe('true');
        expect(more.getAttribute('aria-busy')).toBe('true');
        expect(screen.getByRole('button', { name: 'Load photos' }).getAttribute('aria-disabled')).toBe('true');
        expect(screen.getByRole('button', { name: 'Refresh photos' }).hasAttribute('disabled')).toBe(true);
        await act(async () => batch.resolve(listing([photo(3)], { truncated: false, nextStart: 3 })));
        await screen.findByRole('button', { name: /^Photo 00000003:/ });
        expect(screen.getByRole('button', { name: 'Load photos' }).getAttribute('aria-disabled')).toBe('false');
    });

    test('a failed batch keeps the listing, says what happened and the button retries', async () => {
        getLibrary().mockResolvedValueOnce(listing([photo(1), photo(2)], { truncated: true, nextStart: 2 }));
        setup();
        loadPhotos();
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        getLibrary().mockResolvedValueOnce({ success: false, error: 'library-read-failed' });
        fireEvent.click(screen.getByRole('button', { name: 'Load more photos' }));
        const alert = await screen.findByRole('alert');
        expect(
            within(alert).getByText(
                "Couldn't load more photos. The read was interrupted. Press Load more photos to try again.",
            ),
        ).toBeTruthy();
        expect(screen.getByRole('button', { name: /^Photo 00000001:/ })).toBeTruthy();
        // The button retries: a good batch clears the failure.
        getLibrary().mockResolvedValueOnce(listing([photo(3)], { truncated: true, nextStart: 3 }));
        fireEvent.click(screen.getByRole('button', { name: 'Load more photos' }));
        await screen.findByRole('button', { name: /^Photo 00000003:/ });
        expect(screen.queryByRole('alert')).toBeNull();
        expect(screen.getByText('Showing 3 photo(s).')).toBeTruthy();
    });

    test('a failure the app has no wording for falls back to the load-more text', async () => {
        getLibrary().mockResolvedValueOnce(listing([photo(1)], { truncated: true, nextStart: 1 }));
        setup();
        loadPhotos();
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        getLibrary().mockResolvedValueOnce({ success: false, error: 'fetch-failed' });
        fireEvent.click(screen.getByRole('button', { name: 'Load more photos' }));
        expect(
            await screen.findByText(
                "Couldn't load more photos. The read was interrupted. Press Load more photos to try again.",
            ),
        ).toBeTruthy();
    });

    test('Search reads a batch of its results and Load more continues the same search', async () => {
        getLibrary().mockResolvedValueOnce(listing([photo(1)], { truncated: true, nextStart: 1 }));
        setup();
        fireEvent.change(screen.getByLabelText('Search your photos by tag'), { target: { value: 'sunset' } });
        fireEvent.submit(screen.getByLabelText('Search your photos by tag').closest('form')!);
        expect(await screen.findByRole('button', { name: /^Photo 00000001:/ })).toBeTruthy();
        expect(getLibrary().mock.calls[0]).toEqual([7, 'sunset', 'fresh', 'submit', 0, 100]);
        getLibrary().mockResolvedValueOnce(listing([photo(2)], { truncated: false, nextStart: 2 }));
        fireEvent.click(screen.getByRole('button', { name: 'Load more photos' }));
        await screen.findByRole('button', { name: /^Photo 00000002:/ });
        expect(getLibrary().mock.calls[1]).toEqual([7, 'sunset', 'fresh', 'submit', 1, 100]);
        expect(screen.queryByRole('button', { name: 'Load more photos' })).toBeNull();
    });

    test('Refresh re-reads the loaded extent: the keep it sends covers the photos on screen', async () => {
        const batch = Array.from({ length: 120 }, (_, n) => photo(n + 1));
        getLibrary()
            .mockResolvedValueOnce(listing(batch, { truncated: true, nextStart: 120 }))
            .mockResolvedValueOnce(listing(batch, { truncated: true, nextStart: 120 }));
        setup();
        loadPhotos();
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        fireEvent.click(screen.getByRole('button', { name: 'Refresh photos' }));
        await waitFor(() => expect(getLibrary().mock.calls[1]).toEqual([7, undefined, 'fresh', 'submit', 0, 120]));
    });
});

describe('recommended marks', () => {
    // A marked tile's accessible name starts with the mark (WCAG 2.5.3), so it is found by that name.
    const markedTile = (n: number) =>
        screen.getByRole('button', { name: new RegExp(`^Recommended photo\\. Photo ${shortOf(n)}:`) });

    test('the ids the Discover row handed in carry the mark, visible and in the name, and only they', async () => {
        setup({ recommendedIds: [idOf(2)] });
        await opened();

        expect(within(markedTile(2)).getByText('Recommended photo')).toBeTruthy();
        expect(markedTile(2).getAttribute('aria-label')).toMatch(
            new RegExp(`^Recommended photo\\. Photo ${shortOf(2)}:`),
        );
        expect(within(tile(1)).queryByText('Recommended photo')).toBeNull();
        expect(tile(1).getAttribute('aria-label')).not.toMatch(/^Recommended photo/);
        expect(within(tile(3)).queryByText('Recommended photo')).toBeNull();
    });

    test('without the prop no tile is marked', async () => {
        setup();
        await opened();

        for (const n of [1, 2, 3]) expect(within(tile(n)).queryByText('Recommended photo')).toBeNull();
    });
});

describe('pins', () => {
    const getPins = () => jest.mocked(window.api.getEntryPins);
    const setPins = () => jest.mocked(window.api.setEntryPin);
    const boostToggle = () => screen.getByRole('button', { name: 'Pin for Boost' });
    const boostPressed = () => screen.getByRole('button', { name: 'Pinned for Boost' });
    const turboToggle = () => screen.getByRole('button', { name: 'Pin for Turbo' });
    const turboPressed = () => screen.getByRole('button', { name: 'Pinned for Turbo' });
    const save = () => screen.getByRole('button', { name: 'Use these photos' });
    const groupOf = (n: number) => screen.getByRole('group', { name: `Pins for chosen photo ${n}` });

    beforeEach(() => {
        // The suite's shared mocks: this describe overrides them per case, so each starts from none.
        getPins().mockReset().mockResolvedValue({ boost: null, turbo: null });
        setPins().mockReset().mockResolvedValue({ success: true });
    });

    test('no pin controls and no read without a challenge id, as the global settings and rules pass none', async () => {
        const onSave = jest.fn().mockResolvedValue(true);
        render(<PhotoChooserModal isOpen onClose={jest.fn()} value={[idOf(1)]} onSave={onSave} />);
        expect(await screen.findByRole('button', { name: /^Chosen photo 00000001:/ })).toBeTruthy();
        expect(getPins()).not.toHaveBeenCalled();
        expect(screen.queryByText(/^Pin a chosen photo/)).toBeNull();
        expect(screen.queryByRole('button', { name: 'Pin for Boost' })).toBeNull();
        // A save here has no pin stage: the host's save alone runs.
        fireEvent.click(save());
        await waitFor(() => expect(onSave).toHaveBeenCalled());
        expect(setPins()).not.toHaveBeenCalled();
    });

    test('selected tiles carry the pair, disabled until the read settles, which names the stored pin', async () => {
        const pending = deferred<Awaited<ReturnType<WindowApi['getEntryPins']>>>();
        getPins().mockReturnValueOnce(invalid(pending.promise));
        setup({ value: [idOf(1)] });
        expect(await screen.findByRole('button', { name: /^Chosen photo 00000001:/ })).toBeTruthy();
        const help = screen.getByText(/^Pin a chosen photo/);
        expect(help.getAttribute('role')).toBeNull();
        const boost = boostToggle();
        // Both toggles name the one help line.
        expect(boost.getAttribute('aria-describedby')).toBe(help.id);
        expect(turboToggle().getAttribute('aria-describedby')).toBe(help.id);
        expect(boost.getAttribute('aria-disabled')).toBe('true');
        // A press before the read settles does nothing.
        fireEvent.click(boost);
        expect(boostPressed).toThrow();
        await act(async () => pending.resolve({ boost: idOf(1), turbo: null }));
        const pressed = await screen.findByRole('button', { name: 'Pinned for Boost' });
        expect(pressed.getAttribute('aria-disabled')).toBe('false');
    });

    test('a failed read shows a note instead of the controls, not "no pins"', async () => {
        getPins().mockResolvedValueOnce(null);
        setup({ value: [idOf(1)] });
        const note = await screen.findByRole('alert');
        expect(note.textContent).toBe(
            "Pins couldn't be read, so they can't be changed here. Close and reopen to try again.",
        );
        expect(screen.queryByRole('button', { name: 'Pin for Boost' })).toBeNull();
        expect(screen.queryByText(/^Pin a chosen photo/)).toBeNull();
    });

    test('pinning a photo for one kind clears the other kind when it names the same photo', async () => {
        getPins().mockResolvedValue({ boost: null, turbo: idOf(1) });
        setup({ value: [idOf(1)] });
        expect(await screen.findByRole('button', { name: 'Pinned for Turbo' })).toBeTruthy();
        fireEvent.click(boostToggle());
        expect(screen.queryByRole('button', { name: 'Pinned for Turbo' })).toBeNull();
        expect(boostPressed()).toBeTruthy();
        // The other way round: pinning Turbo on the same photo clears the Boost pin.
        fireEvent.click(turboToggle());
        expect(screen.queryByRole('button', { name: 'Pinned for Boost' })).toBeNull();
        expect(turboPressed()).toBeTruthy();
    });

    test('a Boost/Turbo swap sends one write: the moved Turbo null is the backend’s to clear', async () => {
        getPins().mockResolvedValue({ boost: null, turbo: idOf(1) });
        const { onSave, onClose } = setup({ value: [idOf(1)] });
        await screen.findByRole('button', { name: 'Pinned for Turbo' });
        fireEvent.click(boostToggle());
        fireEvent.click(save());
        await waitFor(() => expect(onSave).toHaveBeenCalledWith([idOf(1)]));
        await waitFor(() => expect(setPins()).toHaveBeenCalledTimes(1));
        expect(setPins()).toHaveBeenCalledWith('boost', 7, idOf(1));
        await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    });

    test('a save writes only the kinds the draft changed — none, when the selection alone moved', async () => {
        getPins().mockResolvedValue({ boost: idOf(1), turbo: null });
        const { onSave } = setup({ value: [idOf(1)] });
        expect(await screen.findByRole('button', { name: 'Pinned for Boost' })).toBeTruthy();
        await opened();
        fireEvent.click(tile(2));
        fireEvent.click(save());
        await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
        expect(setPins()).not.toHaveBeenCalled();
    });

    test('the pin writes wait for the host save to succeed', async () => {
        const hostSave = deferred<boolean>();
        const onSave = jest.fn<Promise<boolean>, [string[]]>(() => hostSave.promise);
        setup({ value: [idOf(1)], onSave });
        await opened();
        fireEvent.click(boostToggle());
        fireEvent.click(save());
        await waitFor(() => expect(onSave).toHaveBeenCalledWith([idOf(1)]));
        expect(setPins()).not.toHaveBeenCalled();
        await act(async () => hostSave.resolve(true));
        await waitFor(() => expect(setPins()).toHaveBeenCalledTimes(1));
        expect(setPins()).toHaveBeenCalledWith('boost', 7, idOf(1));
    });

    test('a host save that fails writes no pins and keeps the generic alert', async () => {
        getPins().mockResolvedValue({ boost: null, turbo: idOf(1) });
        const onSave = jest.fn().mockResolvedValue(false);
        const { onClose } = setup({ value: [idOf(1)], onSave });
        await screen.findByRole('button', { name: 'Pinned for Turbo' });
        fireEvent.click(boostToggle());
        fireEvent.click(save());
        expect((await screen.findByRole('alert')).textContent).toContain("weren't saved");
        expect(setPins()).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
    });

    test('deselecting a photo with a stored pin keeps it: no write, and the elsewhere line names it', async () => {
        getPins().mockResolvedValue({ boost: idOf(1), turbo: idOf(9) });
        const { onSave } = setup({ value: [idOf(1)] });
        expect(await screen.findByRole('button', { name: 'Pinned for Boost' })).toBeTruthy();
        await opened();
        fireEvent.click(tile(1));
        // The stored pin is untouched: the line above the grid now names it, with its Clear pin button.
        expect(screen.getByText("Boost is pinned to a photo that isn't in this list.")).toBeTruthy();
        expect(screen.getByText("Turbo is pinned to a photo that isn't in this list.")).toBeTruthy();
        fireEvent.click(save());
        await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
        expect(setPins()).not.toHaveBeenCalled();
    });

    test('deselecting a photo drops only the draft pin set on it in this session', async () => {
        const { onSave } = setup({ value: [idOf(1)] });
        await opened();
        fireEvent.click(boostToggle());
        expect(boostPressed()).toBeTruthy();
        fireEvent.click(tile(1));
        expect(screen.queryByRole('button', { name: /^Pin/ })).toBeNull();
        fireEvent.click(save());
        await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
        expect(setPins()).not.toHaveBeenCalled();
    });

    test('pinning a chosen photo for a kind replaces the elsewhere pin at save', async () => {
        getPins().mockResolvedValue({ boost: idOf(9), turbo: null });
        const { onSave } = setup({ value: [idOf(1)] });
        expect(await screen.findByText("Boost is pinned to a photo that isn't in this list.")).toBeTruthy();
        fireEvent.click(boostToggle());
        expect(screen.queryByText(/isn't in this list/)).toBeNull();
        fireEvent.click(save());
        await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
        expect(setPins()).toHaveBeenCalledTimes(1);
        expect(setPins()).toHaveBeenCalledWith('boost', 7, idOf(1));
    });

    test("the elsewhere line's Clear pin saves the clear of the stored pin", async () => {
        getPins().mockResolvedValue({ boost: idOf(9), turbo: null });
        const { onSave } = setup({ value: [idOf(1)] });
        const line = await screen.findByText("Boost is pinned to a photo that isn't in this list.");
        fireEvent.click(within(line.closest('p') as HTMLElement).getByRole('button', { name: 'Clear pin' }));
        expect(screen.queryByText(/isn't in this list/)).toBeNull();
        fireEvent.click(save());
        await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
        expect(setPins()).toHaveBeenCalledTimes(1);
        expect(setPins()).toHaveBeenCalledWith('boost', 7, null);
    });

    test('a pin-only change asks before discarding, and a toggle taken back is no change', async () => {
        getPins().mockResolvedValue({ boost: idOf(1), turbo: null });
        const { onClose } = setup({ value: [idOf(1)] });
        expect(await screen.findByRole('button', { name: 'Pinned for Boost' })).toBeTruthy();
        fireEvent.click(boostPressed());
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(screen.getByText('Discard your changes?')).toBeTruthy();
        expect(onClose).not.toHaveBeenCalled();
        // The question closes only itself; pinning the photo again leaves the draft as it started.
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(screen.queryByText('Discard your changes?')).toBeNull();
        fireEvent.click(boostToggle());
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    test("a failed pin write keeps the modal open on the pin's own alert, not the generic one", async () => {
        const { onSave, onClose } = setup({ value: [idOf(1)] });
        await opened();
        fireEvent.click(boostToggle());
        setPins().mockResolvedValueOnce({ success: false, error: 'pin-cap-reached' });
        fireEvent.click(save());
        await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
        const alert = await screen.findByRole('alert');
        expect(alert.textContent).toBe(
            `Your chosen photos are kept, but the Boost pin wasn't saved: ${english('errors.pinCapReached')} Press Use these photos to try again.`,
        );
        expect(onClose).not.toHaveBeenCalled();
    });

    test('a retried Save repeats the host save and the same pin writes', async () => {
        const { onSave, onClose } = setup({ value: [idOf(1)] });
        await opened();
        fireEvent.click(boostToggle());
        setPins().mockResolvedValueOnce({ success: false, error: 'pin-write-failed' });
        fireEvent.click(save());
        await waitFor(() => expect(setPins()).toHaveBeenCalledTimes(1));
        expect((await screen.findByRole('alert')).textContent).toContain("the Boost pin wasn't saved");
        fireEvent.click(save());
        await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
        expect(onSave).toHaveBeenCalledTimes(2);
        expect(setPins()).toHaveBeenCalledTimes(2);
        expect(setPins()).toHaveBeenNthCalledWith(1, 'boost', 7, idOf(1));
        expect(setPins()).toHaveBeenNthCalledWith(2, 'boost', 7, idOf(1));
    });

    test('Clear empties the selection and the pin draft with it, so nothing pin-named is saved', async () => {
        getPins().mockResolvedValue({ boost: idOf(9), turbo: null });
        const { onSave } = setup({ value: [idOf(1)] });
        expect(await screen.findByText("Boost is pinned to a photo that isn't in this list.")).toBeTruthy();
        fireEvent.click(boostToggle());
        fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
        expect(screen.getByText("Boost is pinned to a photo that isn't in this list.")).toBeTruthy();
        fireEvent.click(save());
        await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
        expect(setPins()).not.toHaveBeenCalled();
    });

    test('a save where both pin writes fail attempts both and shows the both-pins message', async () => {
        getPins().mockResolvedValue({ boost: null, turbo: null });
        const { onClose } = setup({ value: [idOf(1), idOf(2)] });
        await opened();
        fireEvent.click(within(groupOf(1)).getByRole('button', { name: 'Pin for Boost' }));
        fireEvent.click(within(groupOf(2)).getByRole('button', { name: 'Pin for Turbo' }));
        setPins().mockResolvedValue({ success: false, error: 'pin-write-failed' });
        fireEvent.click(save());
        await waitFor(() => expect(setPins()).toHaveBeenCalledTimes(2));
        expect(setPins()).toHaveBeenNthCalledWith(1, 'boost', 7, idOf(1));
        expect(setPins()).toHaveBeenNthCalledWith(2, 'turbo', 7, idOf(2));
        expect((await screen.findByRole('alert')).textContent).toBe(
            `Your chosen photos are kept, but the Boost and Turbo pins weren't saved: ${english('errors.pinFailed')} Press Use these photos to try again.`,
        );
        expect(onClose).not.toHaveBeenCalled();
    });

    test('a save where one pin write fails still attempts the other and names the failed kind', async () => {
        getPins().mockResolvedValue({ boost: null, turbo: null });
        const { onClose } = setup({ value: [idOf(1), idOf(2)] });
        await opened();
        fireEvent.click(within(groupOf(1)).getByRole('button', { name: 'Pin for Boost' }));
        fireEvent.click(within(groupOf(2)).getByRole('button', { name: 'Pin for Turbo' }));
        setPins().mockImplementation(async (kind: EntryPinKind) =>
            kind === 'boost' ? { success: false, error: 'pin-write-failed' } : { success: true },
        );
        fireEvent.click(save());
        await waitFor(() => expect(setPins()).toHaveBeenCalledTimes(2));
        expect(setPins()).toHaveBeenNthCalledWith(1, 'boost', 7, idOf(1));
        expect(setPins()).toHaveBeenNthCalledWith(2, 'turbo', 7, idOf(2));
        expect((await screen.findByRole('alert')).textContent).toBe(
            `Your chosen photos are kept, but the Boost pin wasn't saved: ${english('errors.pinFailed')} Press Use these photos to try again.`,
        );
        expect(onClose).not.toHaveBeenCalled();
    });

    test("each tile's pin pair is a group named with the photo's position in the list", async () => {
        setup({ value: [idOf(2), idOf(1)] });
        await opened();
        // Photo 2 was picked first, so its pair is group 1; the group sits with its tile in the cell.
        expect(groupOf(1).previousElementSibling!.getAttribute('aria-label')).toMatch(/^Photo 00000002:/);
        expect(groupOf(2).previousElementSibling!.getAttribute('aria-label')).toMatch(/^Photo 00000001:/);
    });
});

describe('the toolbar: order, loaded-photo sort and Show stats', () => {
    const getStats = () => jest.mocked(window.api.getPhotoStats);
    const orderSelect = () => screen.getByLabelText('Order (applies to your whole library)') as HTMLSelectElement;
    const sortSelect = () => screen.getByLabelText('Then sort loaded photos by') as HTMLSelectElement;
    const showStatsBox = () => screen.getByRole('checkbox', { name: 'Show stats' }) as HTMLInputElement;
    const statOf = (id: string) => ({ id, votes: 121, views: 50, likes: 1, guruPicks: 0 });
    const statsAnswer = async (asked: unknown) => ({
        success: true as const,
        stats: (asked as string[]).map((id) => statOf(id)),
        missing: [] as string[],
    });
    const tileOrder = () =>
        screen
            .getAllByRole('button')
            .map((button) => button.getAttribute('aria-label') ?? '')
            .filter((label) => label.startsWith('Photo '))
            .map((label) => label.slice('Photo '.length, 'Photo '.length + 8));

    beforeEach(() => {
        getStats().mockReset().mockImplementation(statsAnswer);
    });

    test('both selects and Show stats are there, labeled; the Show-stats help is always shown, the sort help is not', () => {
        setup();
        expect(orderSelect().value).toBe('votes');
        expect(sortSelect().value).toBe('library');
        expect(screen.getByRole('option', { name: 'Votes' })).toBeTruthy();
        expect(screen.getByRole('option', { name: 'Newest' })).toBeTruthy();
        expect(screen.getByRole('option', { name: 'Oldest' })).toBeTruthy();
        expect(screen.getByRole('option', { name: 'Library order' })).toBeTruthy();
        expect(screen.getByRole('option', { name: 'Ratio (votes per view)' })).toBeTruthy();
        expect(screen.getByRole('option', { name: 'Likes' })).toBeTruthy();
        expect(screen.getByRole('option', { name: 'Guru picks' })).toBeTruthy();
        expect(showStatsBox().checked).toBe(false);
        expect(screen.getByText(/^Reads each photo's votes, views, likes and Guru picks/)).toBeTruthy();
        expect(screen.queryByText(/reorder only the/)).toBeNull();
    });

    test('a select change whose value is not one of the named ones changes nothing', async () => {
        setup();
        await opened();
        // A guarded value reads nothing and runs nothing: no order re-read, no stats run.
        fireEvent.change(orderSelect(), { target: { value: 'toString' } });
        fireEvent.change(sortSelect(), { target: { value: '__proto__' } });
        expect(getLibrary()).toHaveBeenCalledTimes(1);
        expect(getStats()).not.toHaveBeenCalled();
    });

    test('an order change re-reads the listing in that order', async () => {
        setup();
        await opened();
        getLibrary().mockResolvedValueOnce(listing([photo(5)]));
        pickOption(orderSelect(), 'newest');
        // The re-read keeps the extent on screen: 3 photos shown, not one batch.
        await waitFor(() =>
            expect(getLibrary()).toHaveBeenLastCalledWith(7, undefined, 'fresh', 'submit', 0, 3, 'newest'),
        );
        expect(await screen.findByRole('button', { name: /^Photo 00000005:/ })).toBeTruthy();
    });

    test('the help line names the shown count and the order on screen', async () => {
        setup();
        await opened();
        pickOption(sortSelect(), 'ratio');
        await effectsFlushed();
        expect(
            screen.getByText(
                'Ratio, likes and Guru picks reorder only the photos shown (3). Load more adds more, in Votes order.',
            ),
        ).toBeTruthy();
        pickOption(orderSelect(), 'oldest');
        // The re-read keeps the extent on screen: 3 photos shown, not one batch.
        await waitFor(() =>
            expect(getLibrary()).toHaveBeenLastCalledWith(7, undefined, 'fresh', 'submit', 0, 3, 'oldest'),
        );
        await screen.findByText(/in Oldest order\.$/);
    });

    test('the help line counts the tiles the grid shows: every photo hidden reports none, not the loaded count', async () => {
        getLibrary().mockResolvedValue(
            listing([photo(1, { allowed: false }), photo(2, { allowed: false }), photo(3, { allowed: false })]),
        );
        setup();
        loadPhotos();
        pickOption(sortSelect(), 'ratio');
        await effectsFlushed();
        expect(
            screen.getByText(
                'Ratio, likes and Guru picks reorder only the photos shown (0). Load more adds more, in Votes order.',
            ),
        ).toBeTruthy();
    });

    test('Show stats on under Votes reads the tiles without reordering, and ends with "Stats read."', async () => {
        setup();
        await opened();
        fireEvent.click(showStatsBox());
        expect(screen.getByText('Reading stats: 0 of 3')).toBeTruthy();
        await screen.findByText('Stats read.');
        expect(getStats().mock.calls[0][0]).toEqual([idOf(1), idOf(2), idOf(3)]);
        expect(tileOrder()).toEqual([shortOf(1), shortOf(2), shortOf(3)]);
        expect(screen.queryByRole('alert')).toBeNull();
    });

    test('a loaded-photo sort turns Show stats on and locks it with the reason; back on Library order it can be cleared', async () => {
        setup();
        await opened();
        pickOption(sortSelect(), 'guruPicks');
        await effectsFlushed();
        expect(showStatsBox().checked).toBe(true);
        expect(showStatsBox().getAttribute('aria-disabled')).toBe('true');
        const describedBy = showStatsBox().getAttribute('aria-describedby');
        expect(describedBy).toBeTruthy();
        expect(document.getElementById(describedBy!)?.textContent).toBe(
            'Needed for the Ratio, Likes and Guru picks sorts.',
        );
        fireEvent.click(showStatsBox());
        expect(showStatsBox().checked).toBe(true);
        // Back on Library order the box unlocks and can be cleared.
        pickOption(sortSelect(), 'library');
        await effectsFlushed();
        expect(showStatsBox().getAttribute('aria-disabled')).toBe('false');
        expect(showStatsBox().getAttribute('aria-describedby')).toBeNull();
        fireEvent.click(showStatsBox());
        expect(showStatsBox().checked).toBe(false);
    });

    test('a run that comes back missing shows the warning with Retry, and Retry restarts with one call', async () => {
        getStats()
            .mockReset()
            .mockResolvedValue({ success: true, stats: [], missing: [idOf(1), idOf(2), idOf(3)] });
        setup();
        await opened();
        fireEvent.click(showStatsBox());
        await screen.findByText(
            "Stats couldn't be read for 3 of these photos. GuruShots didn't send them, or reading is paused for a minute after errors. Try again in a minute.",
        );
        expect(getStats()).toHaveBeenCalledTimes(1);
        // Retry during the cool-down: the status counts again, the warning returns, and the restart
        // sent its one call — nothing beside it.
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
        expect(screen.getByText('Reading stats: 0 of 3')).toBeTruthy();
        await screen.findByText(
            "Stats couldn't be read for 3 of these photos. GuruShots didn't send them, or reading is paused for a minute after errors. Try again in a minute.",
        );
        expect(getStats()).toHaveBeenCalledTimes(2);
    });

    test('under a loaded-photo sort the warning says the unread photos are listed last, and the status names the reorder', async () => {
        getStats()
            .mockReset()
            .mockResolvedValue({ success: true, stats: [], missing: [idOf(1), idOf(2)] });
        setup();
        await opened();
        pickOption(sortSelect(), 'ratio');
        expect(
            await screen.findByText(
                "Stats couldn't be read for 2 of these photos. GuruShots didn't send them, or reading is paused for a minute after errors. They're listed last. Try again in a minute.",
            ),
        ).toBeTruthy();
        expect(screen.getByText('Stats read. Photos reordered.')).toBeTruthy();
    });

    test('a failed call (not a missing one) leaves the status empty and the warning carries the failure', async () => {
        getStats().mockReset().mockRejectedValue(new Error('down'));
        // Without Auto, so the toolbar's status region is the only aria-live one on the page.
        setup({ canSuggest: false });
        await opened();
        fireEvent.click(showStatsBox());
        await screen.findByText(
            "Stats couldn't be read for 3 of these photos. GuruShots didn't send them, or reading is paused for a minute after errors. Try again in a minute.",
        );
        // The region the run would report in holds nothing: the run did not get its answers.
        expect(document.querySelector('p[aria-live="polite"]')?.textContent).toBe('');
        expect(getStats()).toHaveBeenCalledTimes(1);
    });

    test('the stats status region is mounted where Auto is not (a Discover row)', async () => {
        setup({ canSuggest: false });
        await opened();
        expect(screen.queryByRole('button', { name: 'Auto' })).toBeNull();
        fireEvent.click(showStatsBox());
        await screen.findByText('Stats read.');
    });

    test('both selects and Show stats reset when the chooser reopens', async () => {
        const first = setup();
        await opened();
        pickOption(orderSelect(), 'newest');
        pickOption(sortSelect(), 'ratio');
        await effectsFlushed();
        expect(showStatsBox().checked).toBe(true);
        first.rerender(<PhotoChooserModal {...first} isOpen={false} />);
        first.rerender(<PhotoChooserModal {...first} isOpen />);
        expect(orderSelect().value).toBe('votes');
        expect(sortSelect().value).toBe('library');
        expect(showStatsBox().checked).toBe(false);
    });
});
