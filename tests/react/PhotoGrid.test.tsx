/**
 * PhotoGrid's ready listing on its own: the Load more button with its gates and failure alert, the
 * "Showing" line every non-preview listing carries in the live status region (an empty listing puts
 * its empty text there instead), the chosen picks no batch read so far has shown (a stub in a
 * cut-off listing, a missing tile otherwise — in a search listing with the search wordings), and
 * the plain loading and error states. Translations are the real English strings so tiles and lines
 * are told apart by their text.
 */

import { fireEvent, render, screen } from './helpers/test-utils';
import { PhotoGrid } from '@/components/app/PhotoGrid';
import { mockTranslator } from './helpers/setup';
import { app, errors } from '../../src/ts/translations/english';
import { invalid } from '../helpers/invalid';
import type { TileStats } from '@/hooks/usePhotoStatsLoader';
import type { LibraryPhoto } from '@/hooks/useLibraryListing';
import type { usePhotoPicker } from '@/hooks/usePhotoPicker';
import type { WindowApi } from '../../src/ts/types/ipc';

type Listing = Extract<Awaited<ReturnType<WindowApi['getLibraryPhotos']>>, { success: true }>;

const MEMBER = 'c'.repeat(32);
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

type Props = Parameters<typeof PhotoGrid>[0];
type Picker = ReturnType<typeof usePhotoPicker>;

// The picker fields PhotoGrid reads, as a fixture. The rest of the hook's return is only for the
// toolbar and the modals, which this file never renders — a partial fixture, through invalid.
const basePicker = (over: Partial<Picker> = {}): Picker =>
    invalid<Picker>({
        state: {
            status: 'ready',
            listing: listing([photo(1), photo(2)], { truncated: true, nextStart: 2 }),
            order: 'votes',
        },
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

const baseProps = (over: Partial<Props> = {}): Props => ({
    picker: basePicker(),
    selected: [],
    locked: false,
    hasChallenge: true,
    onToggle: jest.fn<void, [string]>(),
    onRefresh: jest.fn<void, []>(),
    ...over,
});
const grid = (over: Partial<Props> = {}) => render(<PhotoGrid {...baseProps(over)} />);
const more = () => screen.getByRole('button', { name: 'Load more photos' });
// The grid's own live region: it is the first on the page, before the header's read-at line.
const statusRegion = () => screen.getAllByRole('status')[0];
// The tiles in the order they render, told apart by the first 8 characters of their ids.
const tileOrder = () =>
    screen
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label') ?? '')
        .filter((label) => label.startsWith('Photo '))
        .map((label) => label.slice('Photo '.length, 'Photo '.length + 8));
const tileStat = (n: number, over: Partial<Omit<TileStats, 'id'>> = {}): TileStats => ({
    id: idOf(n),
    votes: 10,
    views: 10,
    likes: 0,
    guruPicks: 0,
    ...over,
});

beforeEach(() => {
    mockTranslator.t.mockImplementation(english);
});

afterEach(() => {
    mockTranslator.t.mockImplementation((key) => key);
});

describe('the Load more button', () => {
    test('a cut-off, non-preview listing offers it; a complete one and a preview do not', () => {
        const first = grid();
        expect(more()).toBeTruthy();
        first.unmount();
        grid({
            picker: basePicker({ state: { status: 'ready', listing: listing([photo(1), photo(2)]), order: 'votes' } }),
        });
        expect(screen.queryByRole('button', { name: 'Load more photos' })).toBeNull();
        grid({
            picker: basePicker({
                state: {
                    status: 'ready',
                    listing: listing([photo(1), photo(2)], { truncated: true, preview: true }),
                    order: 'votes',
                },
            }),
        });
        expect(screen.queryByRole('button', { name: 'Load more photos' })).toBeNull();
    });

    test('a press reads the next batch', () => {
        const loadMore = jest.fn<Promise<void>, []>();
        grid({ picker: basePicker({ loadMore }) });
        fireEvent.click(more());
        expect(loadMore).toHaveBeenCalledTimes(1);
    });

    test.each([
        ['the batch read is on its way', { loadingMore: true }],
        ['the listing is being read again', { revalidating: true }],
    ])('is held while %s, and a press sends nothing', (_name, over) => {
        const loadMore = jest.fn<Promise<void>, []>();
        grid({ picker: basePicker({ loadMore, ...over }) });
        expect(more().getAttribute('aria-disabled')).toBe('true');
        fireEvent.click(more());
        expect(loadMore).not.toHaveBeenCalled();
    });

    test('the batch read shows on the button itself as busy', () => {
        grid({ picker: basePicker({ loadingMore: true }) });
        expect(more().getAttribute('aria-busy')).toBe('true');
        expect(more().querySelector('.sr-only')).not.toBeNull();
    });

    test.each([
        [
            'the library read failing keeps the Load-more wording',
            'library-read-failed',
            "Couldn't load more photos. The read was interrupted. Press Load more photos to try again.",
        ],
        [
            'a failure the app has no wording for',
            'fetch-failed',
            "Couldn't load more photos. The read was interrupted. Press Load more photos to try again.",
        ],
    ])('%s shows in an alert of its own', (_name, failure, text) => {
        grid({ picker: basePicker({ loadMoreFailed: failure }) });
        expect(screen.getByRole('alert').textContent).toBe(text);
        // Photos were read here, so the neutral first-read text never takes over the Load-more alert.
        expect(
            screen.queryByText('Your photos could not be read. The library read failed before it finished. Try again.'),
        ).toBeNull();
        // The button stays the way to retry.
        expect(more().getAttribute('aria-disabled')).toBe('false');
    });

    test('the alert clears when the retry reads on', () => {
        const loadMore = jest.fn<Promise<void>, []>();
        const { rerender } = grid({ picker: basePicker({ loadMore, loadMoreFailed: 'library-read-failed' }) });
        expect(screen.getByRole('alert')).toBeTruthy();
        fireEvent.click(more());
        expect(loadMore).toHaveBeenCalledTimes(1);
        rerender(<PhotoGrid {...baseProps({ picker: basePicker({ loadMore, loadMoreFailed: null }) })} />);
        expect(screen.queryByRole('alert')).toBeNull();
    });
});

describe('the plain states of a read', () => {
    test('a loading listing shows the loader and no Load more button', () => {
        grid({ picker: basePicker({ state: { status: 'loading' } }) });
        expect(screen.getByText('Loading your photos…')).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Load more photos' })).toBeNull();
    });

    test('a failed first Load photos offers Retry with the neutral text, not the Load-more wording', () => {
        const retry = jest.fn<number, []>(() => 1);
        grid({ picker: basePicker({ retry, state: { status: 'error', error: 'library-read-failed' } }) });
        expect(screen.getByText("Your photos couldn't be loaded (details below). Try again.")).toBeTruthy();
        expect(
            screen.getByText('Your photos could not be read. The library read failed before it finished. Try again.'),
        ).toBeTruthy();
        expect(screen.queryByText(/Load more photos/)).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
        expect(retry).toHaveBeenCalledTimes(1);
    });
});

describe('the Showing line', () => {
    test('a non-preview listing says what is shown, in the grid’s live region, complete or not', () => {
        const first = grid();
        expect(statusRegion().textContent).toBe('Showing 2 photo(s).');
        first.unmount();
        grid({
            picker: basePicker({ state: { status: 'ready', listing: listing([photo(1), photo(2)]), order: 'votes' } }),
        });
        expect(statusRegion().textContent).toBe('Showing 2 photo(s).');
    });

    test('the count is the tiles the grid shows, not the refused ones it hides', () => {
        grid({
            picker: basePicker({
                state: {
                    status: 'ready',
                    listing: listing([photo(1, { allowed: false, message: 'In another challenge' }), photo(2)]),
                    order: 'votes',
                },
            }),
        });
        expect(statusRegion().textContent).toBe(
            "Showing 1 photo(s).Hidden: 1 photo(s) GuruShots won't take in this challenge.",
        );
    });

    test('a truncated listing where every photo is blocked says so, pointing past the batch too', () => {
        grid({
            blockedIds: new Set([idOf(1), idOf(2)]),
        });
        expect(statusRegion().textContent).toContain(
            "GuruShots won't take any of the photos loaded so far in this challenge. Press Load more photos to look further, or search by tag. If nothing fits, upload new photos and press Refresh.",
        );
    });

    test('the final batch leaves the line and takes the button away, so the region never goes empty', () => {
        grid({
            picker: basePicker({ state: { status: 'ready', listing: listing([photo(1), photo(2)]), order: 'votes' } }),
        });
        expect(statusRegion().textContent).toBe('Showing 2 photo(s).');
        expect(screen.queryByRole('button', { name: 'Load more photos' })).toBeNull();
    });
});

describe('an empty listing', () => {
    test('the live region holds the empty text instead of a Showing 0 line, with no second copy in the body', () => {
        grid({ picker: basePicker({ state: { status: 'ready', listing: listing([]), order: 'votes' } }) });
        expect(statusRegion().textContent).toBe(
            'No photos found. Try another tag, or upload photos to your GuruShots library and press Refresh.',
        );
        expect(screen.queryByText('Showing 0 photo(s).')).toBeNull();
        expect(screen.getAllByText(/No photos found/)).toHaveLength(1);
    });

    test('a complete one where every match has won says so in the region', () => {
        grid({
            picker: basePicker({
                state: { status: 'ready', listing: listing([], { wonIds: [idOf(7)], wonCount: 1 }), order: 'votes' },
            }),
        });
        expect(statusRegion().textContent).toBe(
            'No photos you can enter were found: every match has won a challenge. Try another tag, or upload new photos to your GuruShots library and press Refresh.',
        );
        expect(screen.queryByText('Showing 0 photo(s).')).toBeNull();
    });

    test('a preview keeps its empty text as a body paragraph — its region names no count', () => {
        grid({
            hasChallenge: false,
            picker: basePicker({
                state: {
                    status: 'ready',
                    listing: listing([], { preview: true, allowedKnown: false }),
                    order: 'votes',
                },
            }),
        });
        expect(statusRegion().textContent).toBe('');
        expect(screen.getByText(/No photos found/)).toBeTruthy();
    });
});

describe('hiding refused photos in a challenge-bound grid', () => {
    const refusedAt = (n: number, message = 'In another challenge') => photo(n, { allowed: false, message });

    test('without submit the refused photos are hidden and counted, and the appended batch keeps hiding', () => {
        const first = grid({
            picker: basePicker({
                state: {
                    status: 'ready',
                    listing: listing([photo(1), refusedAt(2)], { truncated: true, nextStart: 2 }),
                    order: 'votes',
                },
            }),
        });
        expect(screen.queryByRole('button', { name: /^Photo 00000002:/ })).toBeNull();
        expect(statusRegion().textContent).toBe(
            "Showing 1 photo(s).Hidden: at least 1 photo(s) GuruShots won't take in this challenge. Press Load more photos to look for others.",
        );
        first.unmount();
        // Load more appended its batch: the truncation is gone, and the new refused photo is hidden with the rest.
        grid({
            picker: basePicker({
                state: {
                    status: 'ready',
                    listing: listing([photo(1), refusedAt(2), refusedAt(3)]),
                    order: 'votes',
                },
            }),
        });
        expect(screen.queryByRole('button', { name: /^Photo 00000003:/ })).toBeNull();
        expect(statusRegion().textContent).toBe(
            "Showing 1 photo(s).Hidden: 2 photo(s) GuruShots won't take in this challenge.",
        );
    });

    test('a picked refused photo stays shown, and unticking it hides it and hands the focus to the status line', () => {
        const shown = listing([photo(1), refusedAt(2)]);
        const { rerender } = grid({
            picker: basePicker({ state: { status: 'ready', listing: shown, order: 'votes' } }),
            selected: [idOf(2)],
        });
        const tileEl = screen.getByRole('button', { name: /^Photo 00000002:/ });
        expect(tileEl.getAttribute('aria-pressed')).toBe('true');
        expect(tileEl.textContent).toContain('In another challenge');
        // The pick is shown, so nothing is hidden and the status line stays empty.
        expect(screen.queryByText(/^Hidden: /)).toBeNull();
        tileEl.focus();
        rerender(
            <PhotoGrid
                {...baseProps({
                    picker: basePicker({ state: { status: 'ready', listing: shown, order: 'votes' } }),
                    selected: [],
                })}
            />,
        );
        expect(screen.queryByRole('button', { name: /^Photo 00000002:/ })).toBeNull();
        // The Hidden line keeps the status region on screen, so the handed-off focus is not on a hidden element.
        expect(document.activeElement).toBe(statusRegion());
        expect(statusRegion().textContent).toBe(
            "Showing 1 photo(s).Hidden: 1 photo(s) GuruShots won't take in this challenge.",
        );
    });

    test('says so when every listed photo is refused, and a pick holds the line back', () => {
        const all = listing([refusedAt(1), refusedAt(2)]);
        const noneLine =
            "GuruShots won't take any of the listed photos in this challenge. Search by tag to find others, or upload new photos and press Refresh.";
        const { rerender } = grid({
            picker: basePicker({ state: { status: 'ready', listing: all, order: 'votes' } }),
        });
        expect(statusRegion().textContent).toBe(
            `Showing 0 photo(s).Hidden: 2 photo(s) GuruShots won't take in this challenge.${noneLine}`,
        );
        rerender(
            <PhotoGrid
                {...baseProps({
                    picker: basePicker({ state: { status: 'ready', listing: all, order: 'votes' } }),
                    selected: [idOf(1)],
                })}
            />,
        );
        // The picked refused photo is shown; the other is hidden and counted, and nothing more is claimed.
        expect(screen.getByRole('button', { name: /^Photo 00000001:/ }).getAttribute('aria-pressed')).toBe('true');
        expect(statusRegion().textContent).toBe(
            "Showing 1 photo(s).Hidden: 1 photo(s) GuruShots won't take in this challenge.",
        );
    });

    test('a no-challenge grid hides nothing', () => {
        grid({
            hasChallenge: false,
            picker: basePicker({
                state: {
                    status: 'ready',
                    listing: listing([photo(1, { allowed: false, message: 'No' }), photo(2)], { allowedKnown: false }),
                    order: 'votes',
                },
            }),
        });
        expect(screen.getByRole('button', { name: /^Photo 00000001:/ })).toBeTruthy();
        expect(screen.getByRole('button', { name: /^Photo 00000002:/ })).toBeTruthy();
        expect(screen.queryByText(/^Hidden: /)).toBeNull();
    });
});

describe('a preview in the grid', () => {
    test('a challenge-bound preview is never rendered: the loader holds its place', () => {
        grid({
            picker: basePicker({
                state: {
                    status: 'ready',
                    listing: listing([photo(1), photo(2)], { preview: true, allowedKnown: false }),
                    order: 'votes',
                },
            }),
        });
        expect(screen.getByText('Loading your photos…')).toBeTruthy();
        expect(screen.queryByRole('button', { name: /^Photo / })).toBeNull();
        expect(screen.queryByText(/as last loaded/)).toBeNull();
        expect(statusRegion().textContent).toBe('');
    });

    test('without a challenge the preview renders its tiles, its line, and the pick that waits', () => {
        grid({
            hasChallenge: false,
            selected: [idOf(9)],
            picker: basePicker({
                state: {
                    status: 'ready',
                    listing: listing([photo(1)], { preview: true, allowedKnown: false }),
                    order: 'votes',
                },
            }),
        });
        expect(screen.getByRole('button', { name: /^Photo 00000001:/ })).toBeTruthy();
        // A preview names no count in the grid's live region; its header line says what it is.
        expect(screen.queryByText('Showing 1 photo(s).')).toBeNull();
        expect(
            screen.getByText('Showing your photos as last loaded while the app checks for anything new…'),
        ).toBeTruthy();
        const pending = screen.getByRole('button', { name: /^Chosen photo 00000009:/ });
        expect(pending.textContent).toContain('Not among your photos as last loaded. Checking again…');
        expect(pending.getAttribute('aria-disabled')).toBe('true');
    });

    test('after a failed re-check the same preview says so, and the waiting pick can be removed', () => {
        grid({
            hasChallenge: false,
            selected: [idOf(9)],
            picker: basePicker({
                recheckFailed: true,
                state: {
                    status: 'ready',
                    listing: listing([photo(1)], { preview: true, allowedKnown: false }),
                    order: 'votes',
                },
            }),
        });
        expect(screen.getByRole('button', { name: /^Photo 00000001:/ })).toBeTruthy();
        expect(
            screen.getByText("Couldn't check your photos for changes, so they're shown as last loaded. Press Refresh."),
        ).toBeTruthy();
        const pending = screen.getByRole('button', { name: /^Chosen photo 00000009:/ });
        expect(pending.textContent).toContain('Not among your photos as last loaded. Press Refresh to check again.');
        expect(pending.getAttribute('aria-disabled')).toBe('false');
    });
});

describe('the focus hand-off', () => {
    test('the button its final batch takes away hands the focus to the status line', () => {
        const { rerender } = grid();
        const button = more();
        button.focus();
        expect(document.activeElement).toBe(button);
        rerender(
            <PhotoGrid
                {...baseProps({
                    picker: basePicker({
                        state: { status: 'ready', listing: listing([photo(1), photo(2)]), order: 'votes' },
                    }),
                })}
            />,
        );
        expect(screen.queryByRole('button', { name: 'Load more photos' })).toBeNull();
        expect(document.activeElement).toBe(statusRegion());
    });
});

describe('a chosen pick no batch has shown', () => {
    test.each([
        ['a cut-off listing', true],
        ['a complete listing', false],
    ])('%s: a won pick keeps its missing tile, which says why it is gone', (_name, truncated) => {
        grid({
            selected: [idOf(9)],
            picker: basePicker({
                state: {
                    status: 'ready',
                    listing: listing([photo(1), photo(2)], { truncated, wonIds: [idOf(9)], wonCount: 1 }),
                    order: 'votes',
                },
            }),
        });
        const won = screen.getByRole('button', {
            name: new RegExp(`^Chosen photo ${shortOf(9)}: Has won a challenge`),
        });
        expect(won.className).toContain('border-warning');
        expect(screen.queryByText(/^Not in the photos loaded yet/)).toBeNull();
    });

    test('in a cut-off listing an unreached pick is a stub with the listing member’s thumbnail, and it toggles', () => {
        const onToggle = jest.fn<void, [string]>();
        grid({ selected: [idOf(9)], onToggle });
        const stub = screen.getByRole('button', {
            name: new RegExp(
                `^Chosen photo ${shortOf(9)}: Not in the photos loaded yet; press Load more photos to look for it\\. Number 1 in your list\\.$`,
            ),
        });
        expect(stub.querySelector('img')?.getAttribute('src')).toContain(MEMBER);
        // The stub stands for the pick itself: it is selected, and the tap takes it back.
        expect(stub.getAttribute('aria-pressed')).toBe('true');
        fireEvent.click(stub);
        expect(onToggle).toHaveBeenCalledWith(idOf(9));
    });

    test('in a complete listing the same pick is a missing tile with the challenge’s likely reasons', () => {
        grid({
            selected: [idOf(9)],
            picker: basePicker({ state: { status: 'ready', listing: listing([photo(1), photo(2)]), order: 'votes' } }),
        });
        const missing = screen.getByRole('button', {
            name: new RegExp(
                `^Chosen photo ${shortOf(9)}: Not available for this challenge \\(in another challenge, or deleted\\)`,
            ),
        });
        expect(missing.querySelector('img')).toBeNull();
    });
});

describe('a search listing', () => {
    test('a truncated one shows an unreached pick as a stub whose note names both ways to reach it', () => {
        grid({ picker: basePicker({ isSearch: true }), selected: [idOf(9)] });
        expect(
            screen.getByRole('button', {
                name: new RegExp(
                    `^Chosen photo ${shortOf(9)}: Not in the search results loaded so far\\. Load more photos finds it if it carries this tag; Load photos reads from the top of your whole library, so it may need Load more after it\\. Number 1 in your list\\.$`,
                ),
            }),
        ).toBeTruthy();
    });

    test('a won pick in a truncated one keeps the won text on its missing tile — the only one a cut-off listing shows', () => {
        grid({
            picker: basePicker({
                isSearch: true,
                state: {
                    status: 'ready',
                    listing: listing([photo(1), photo(2)], { truncated: true, wonIds: [idOf(9)], wonCount: 1 }),
                    order: 'votes',
                },
            }),
            selected: [idOf(9)],
        });
        expect(
            screen.getByRole('button', { name: new RegExp(`^Chosen photo ${shortOf(9)}: Has won a challenge`) }),
        ).toBeTruthy();
        expect(screen.queryByText(/search results/)).toBeNull();
    });

    test.each([
        ['with a challenge', true],
        ['without a challenge', false],
    ])('a complete one %s says the pick is not in these results, never that it was deleted', (_name, hasChallenge) => {
        grid({
            hasChallenge,
            selected: [idOf(9)],
            picker: basePicker({
                isSearch: true,
                state: { status: 'ready', listing: listing([photo(1), photo(2)]), order: 'votes' },
            }),
        });
        const missing = screen.getByRole('button', {
            name: new RegExp(
                `^Chosen photo ${shortOf(9)}: Not in these search results\\. Try another tag, or press Load photos — it reads from the top of your library, so you may need Load more to find it\\. Number 1 in your list\\.$`,
            ),
        });
        expect(missing.textContent).not.toContain('deleted');
    });
});

describe('the loaded-photo sort', () => {
    const listingOf = (ids: number[]): Picker['state'] => ({
        status: 'ready',
        listing: listing(ids.map((n) => photo(n))),
        order: 'votes',
    });

    test('ratio: known values descending, a views-0 ratio after every real one, unknown last, ties keep the listing order', () => {
        grid({
            picker: basePicker({
                sortBy: 'ratio',
                sortStats: new Map([
                    [idOf(1), tileStat(1, { votes: 30, views: 10 })],
                    [idOf(2), tileStat(2, { votes: 30, views: 15 })],
                    [idOf(3), tileStat(3, { votes: 5, views: 0 })],
                    // 4 ties with 1 and is listed after it, so it keeps its place behind it.
                    [idOf(4), tileStat(4, { votes: 30, views: 10 })],
                ]),
                state: listingOf([5, 2, 1, 4, 3, 6]),
            }),
        });
        // 5 and 6 have no stats: unknown last, in the listing's order; 3 is known but has no views.
        expect(tileOrder()).toEqual([shortOf(1), shortOf(4), shortOf(2), shortOf(3), shortOf(5), shortOf(6)]);
    });

    test('likes and Guru picks: known values descending, unknown last', () => {
        const stats = new Map([
            [idOf(1), tileStat(1, { likes: 5, guruPicks: 1 })],
            [idOf(2), tileStat(2, { likes: 9, guruPicks: 3 })],
            [idOf(3), tileStat(3, { likes: 1, guruPicks: 9 })],
        ]);
        const first = grid({ picker: basePicker({ sortBy: 'likes', sortStats: stats, state: listingOf([1, 2, 3]) }) });
        expect(tileOrder()).toEqual([shortOf(2), shortOf(1), shortOf(3)]);
        first.unmount();
        grid({ picker: basePicker({ sortBy: 'guruPicks', sortStats: stats, state: listingOf([1, 2, 3]) }) });
        expect(tileOrder()).toEqual([shortOf(3), shortOf(2), shortOf(1)]);
    });

    test('the pinned picks the listing does not return stay first in pick order', () => {
        grid({
            picker: basePicker({
                sortBy: 'ratio',
                sortStats: new Map([
                    [idOf(1), tileStat(1, { votes: 100, views: 1 })],
                    [idOf(9), tileStat(9, { votes: 1, views: 100 })],
                ]),
                known: new Map([[idOf(9), photo(9)]]),
                state: listingOf([1, 2]),
            }),
            selected: [idOf(9)],
        });
        expect(tileOrder()[0]).toBe(shortOf(9));
    });

    test('answers landing mid-run do not reorder; the snapshot refreshed at the run end reorders once', () => {
        const stats = new Map([
            [idOf(1), tileStat(1, { votes: 1, views: 100 })],
            [idOf(2), tileStat(2, { votes: 100, views: 1 })],
            [idOf(3), tileStat(3, { votes: 2, views: 1 })],
        ]);
        const first = grid({ picker: basePicker({ sortBy: 'ratio', state: listingOf([1, 2, 3]) }) });
        expect(tileOrder()).toEqual([shortOf(1), shortOf(2), shortOf(3)]);
        // The live Map fills in while the run is out; the sort snapshot is still empty, so nothing moves.
        first.rerender(
            <PhotoGrid
                {...baseProps({ picker: basePicker({ sortBy: 'ratio', stats, state: listingOf([1, 2, 3]) }) })}
            />,
        );
        expect(tileOrder()).toEqual([shortOf(1), shortOf(2), shortOf(3)]);
        // The run ends: the loader hands the grid its refreshed snapshot, and the tiles reorder once.
        first.rerender(
            <PhotoGrid
                {...baseProps({
                    picker: basePicker({ sortBy: 'ratio', stats, sortStats: stats, state: listingOf([1, 2, 3]) }),
                })}
            />,
        );
        // 2 (100 votes per view), then 3 (2), then 1 (0.01).
        expect(tileOrder()).toEqual([shortOf(2), shortOf(3), shortOf(1)]);
    });

    test('a sort change reorders at once from the stats already read, with no stats call', () => {
        const stats = new Map([
            [idOf(1), tileStat(1, { votes: 1, views: 100 })],
            [idOf(2), tileStat(2, { votes: 100, views: 1 })],
        ]);
        const first = grid({ picker: basePicker({ sortStats: stats, state: listingOf([1, 2]) }) });
        expect(tileOrder()).toEqual([shortOf(1), shortOf(2)]);
        first.rerender(
            <PhotoGrid
                {...baseProps({ picker: basePicker({ sortBy: 'ratio', sortStats: stats, state: listingOf([1, 2]) }) })}
            />,
        );
        expect(tileOrder()).toEqual([shortOf(2), shortOf(1)]);
        expect(jest.mocked(window.api.getPhotoStats)).not.toHaveBeenCalled();
    });
    test('a reorder of the same tiles (a run ending under a loaded sort) reports nothing new', () => {
        const setTileIds = jest.fn<void, [readonly string[]]>();
        const stats = new Map([
            [idOf(1), tileStat(1, { votes: 1, views: 100 })],
            [idOf(2), tileStat(2, { votes: 100, views: 1 })],
        ]);
        // The run is out: the empty snapshot keeps the listing's order, and the ids were reported.
        const first = grid({ picker: basePicker({ sortBy: 'ratio', setTileIds, state: listingOf([1, 2]) }) });
        expect(tileOrder()).toEqual([shortOf(1), shortOf(2)]);
        expect(setTileIds).toHaveBeenCalledTimes(1);
        // The run ends: the refreshed snapshot reorders the tiles — the same set, so no new report.
        first.rerender(
            <PhotoGrid
                {...baseProps({
                    picker: basePicker({
                        sortBy: 'ratio',
                        setTileIds,
                        stats,
                        sortStats: stats,
                        state: listingOf([1, 2]),
                    }),
                })}
            />,
        );
        expect(tileOrder()).toEqual([shortOf(2), shortOf(1)]);
        expect(setTileIds).toHaveBeenCalledTimes(1);
    });
});

describe('the ids reported for the stats loader', () => {
    test('the listed photos shown are reported; refused hidden ones and stub tiles are not', () => {
        const setTileIds = jest.fn<void, [readonly string[]]>();
        grid({
            picker: basePicker({
                setTileIds,
                state: {
                    status: 'ready',
                    listing: listing([photo(1), photo(2, { allowed: false, message: 'No' }), photo(3)], {
                        truncated: true,
                        nextStart: 3,
                    }),
                    order: 'votes',
                },
            }),
            selected: [idOf(9)],
        });
        // 2 is refused and hidden; 9 is an unreached pick, so it renders as a saved-pick stub.
        expect(setTileIds).toHaveBeenCalledWith([idOf(1), idOf(3)]);
    });

    test('the report comes once per change: a re-render with the same tiles sends nothing', () => {
        const setTileIds = jest.fn<void, [readonly string[]]>();
        const props = baseProps({ picker: basePicker({ setTileIds }) });
        const first = render(<PhotoGrid {...props} />);
        first.rerender(<PhotoGrid {...props} />);
        expect(setTileIds).toHaveBeenCalledTimes(1);
    });

    test("the report keeps the grid's render order, so the loader reads the visible top first", () => {
        const setTileIds = jest.fn<void, [readonly string[]]>();
        grid({
            picker: basePicker({
                setTileIds,
                state: { status: 'ready', listing: listing([photo(3), photo(1), photo(2)]), order: 'votes' },
            }),
        });
        expect(setTileIds).toHaveBeenCalledWith([idOf(3), idOf(1), idOf(2)]);
    });

    test('while idle, only the records the grid shows as full tiles are reported', () => {
        const setTileIds = jest.fn<void, [readonly string[]]>();
        grid({
            picker: basePicker({
                setTileIds,
                suggestedKnown: new Map([[idOf(7), photo(7)]]),
                idleShown: [idOf(7), idOf(8)],
                state: { status: 'idle' },
            }),
        });
        // 8 is a saved pick without a record: a stub, never asked for.
        expect(setTileIds).toHaveBeenCalledWith([idOf(7)]);
    });
    test('a refused photo hidden under a Ratio sort: the shown order is right and the hidden photo is not asked for', () => {
        const setTileIds = jest.fn<void, [readonly string[]]>();
        grid({
            picker: basePicker({
                sortBy: 'ratio',
                setTileIds,
                sortStats: new Map([
                    [idOf(1), tileStat(1, { votes: 1, views: 100 })],
                    // Photo 2 is refused and hidden, so it never takes a place in the order.
                    [idOf(2), tileStat(2, { votes: 50, views: 100 })],
                    [idOf(3), tileStat(3, { votes: 100, views: 100 })],
                ]),
                state: {
                    status: 'ready',
                    listing: listing([photo(1), photo(2, { allowed: false, message: 'No' }), photo(3)], {
                        truncated: true,
                        nextStart: 3,
                    }),
                    order: 'votes',
                },
            }),
        });
        // The hidden photo does not displace anyone: 3 (ratio 1.0) before 1 (0.01), and only the
        // shown ids are reported to the loader, in the order the grid displays them.
        expect(tileOrder()).toEqual([shortOf(3), shortOf(1)]);
        expect(setTileIds).toHaveBeenCalledWith([idOf(3), idOf(1)]);
    });
});
