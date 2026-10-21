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
import type { ListState, LibraryPhoto } from '@/hooks/useLibraryListing';
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
const baseProps = (over: Partial<Props> = {}): Props => ({
    state: {
        status: 'ready',
        listing: listing([photo(1), photo(2)], { truncated: true, nextStart: 2 }),
    } as ListState,
    known: new Map<string, LibraryPhoto>(),
    selected: [],
    hideUnlisted: false,
    locked: false,
    hasChallenge: true,
    search: false,
    revalidating: false,
    recheckFailed: false,
    loadMore: jest.fn<void, []>(),
    loadingMore: false,
    loadMoreFailed: null,
    onToggle: jest.fn<void, [string]>(),
    onRetry: jest.fn<void, []>(),
    onRefresh: jest.fn<void, []>(),
    ...over,
});
const grid = (over: Partial<Props> = {}) => render(<PhotoGrid {...baseProps(over)} />);
const more = () => screen.getByRole('button', { name: 'Load more photos' });
// The grid's own live region: it is the first on the page, before the header's read-at line.
const statusRegion = () => screen.getAllByRole('status')[0];

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
        grid({ state: { status: 'ready', listing: listing([photo(1), photo(2)]) } as ListState });
        expect(screen.queryByRole('button', { name: 'Load more photos' })).toBeNull();
        grid({
            state: {
                status: 'ready',
                listing: listing([photo(1), photo(2)], { truncated: true, preview: true }),
            } as ListState,
        });
        expect(screen.queryByRole('button', { name: 'Load more photos' })).toBeNull();
    });

    test('a press reads the next batch', () => {
        const loadMore = jest.fn<void, []>();
        grid({ loadMore });
        fireEvent.click(more());
        expect(loadMore).toHaveBeenCalledTimes(1);
    });

    test.each([
        ['the batch read is on its way', { loadingMore: true }],
        ['the listing is being read again', { revalidating: true }],
    ])('is held while %s, and a press sends nothing', (_name, over) => {
        const loadMore = jest.fn<void, []>();
        grid({ loadMore, ...over });
        expect(more().getAttribute('aria-disabled')).toBe('true');
        fireEvent.click(more());
        expect(loadMore).not.toHaveBeenCalled();
    });

    test('the batch read shows on the button itself as busy', () => {
        grid({ loadingMore: true });
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
        grid({ loadMoreFailed: failure });
        expect(screen.getByRole('alert').textContent).toBe(text);
        // Photos were read here, so the neutral first-read text never takes over the Load-more alert.
        expect(
            screen.queryByText('Your photos could not be read. The library read failed before it finished. Try again.'),
        ).toBeNull();
        // The button stays the way to retry.
        expect(more().getAttribute('aria-disabled')).toBe('false');
    });

    test('the alert clears when the retry reads on', () => {
        const loadMore = jest.fn<void, []>();
        const { rerender } = grid({ loadMore, loadMoreFailed: 'library-read-failed' });
        expect(screen.getByRole('alert')).toBeTruthy();
        fireEvent.click(more());
        expect(loadMore).toHaveBeenCalledTimes(1);
        rerender(<PhotoGrid {...baseProps({ loadMore, loadMoreFailed: null })} />);
        expect(screen.queryByRole('alert')).toBeNull();
    });
});

describe('the plain states of a read', () => {
    test('a loading listing shows the loader and no Load more button', () => {
        grid({ state: { status: 'loading' } as ListState });
        expect(screen.getByText('Loading your photos…')).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Load more photos' })).toBeNull();
    });

    test('a failed first Load photos offers Retry with the neutral text, not the Load-more wording', () => {
        const onRetry = jest.fn<void, []>();
        grid({ onRetry, state: { status: 'error', error: 'library-read-failed' } as ListState });
        expect(screen.getByText("Your photos couldn't be loaded (details below). Try again.")).toBeTruthy();
        expect(
            screen.getByText('Your photos could not be read. The library read failed before it finished. Try again.'),
        ).toBeTruthy();
        expect(screen.queryByText(/Load more photos/)).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
        expect(onRetry).toHaveBeenCalledTimes(1);
    });
});

describe('the Showing line', () => {
    test('a non-preview listing says what is shown, in the grid’s live region, complete or not', () => {
        const first = grid();
        expect(statusRegion().textContent).toBe('Showing 2 photo(s).');
        first.unmount();
        grid({ state: { status: 'ready', listing: listing([photo(1), photo(2)]) } as ListState });
        expect(statusRegion().textContent).toBe('Showing 2 photo(s).');
    });

    test('the count is the tiles the grid shows, not the refused ones it hides', () => {
        grid({
            submit: true,
            state: {
                status: 'ready',
                listing: listing([photo(1, { allowed: false, message: 'In another challenge' }), photo(2)]),
            } as ListState,
        });
        expect(statusRegion().textContent).toBe(
            "Showing 1 photo(s).Hidden: 1 photo(s) GuruShots won't take in this challenge.",
        );
    });

    test('a truncated listing where every photo is blocked says so, pointing past the batch too', () => {
        grid({
            submit: true,
            blockedIds: new Set([idOf(1), idOf(2)]),
        });
        expect(statusRegion().textContent).toContain(
            "GuruShots won't take any of the photos loaded so far in this challenge. Press Load more photos to look further, or search by tag. If nothing fits, upload new photos and press Refresh.",
        );
    });

    test('a preview listing names no count: its header already says it shows the library as last loaded', () => {
        grid({
            state: {
                status: 'ready',
                listing: listing([photo(1), photo(2)], { preview: true }),
            } as ListState,
        });
        expect(screen.queryByText('Showing 2 photo(s).')).toBeNull();
    });

    test('the final batch leaves the line and takes the button away, so the region never goes empty', () => {
        grid({ state: { status: 'ready', listing: listing([photo(1), photo(2)]) } as ListState });
        expect(statusRegion().textContent).toBe('Showing 2 photo(s).');
        expect(screen.queryByRole('button', { name: 'Load more photos' })).toBeNull();
    });
});

describe('an empty listing', () => {
    test('the live region holds the empty text instead of a Showing 0 line, with no second copy in the body', () => {
        grid({ state: { status: 'ready', listing: listing([]) } as ListState });
        expect(statusRegion().textContent).toBe(
            'No photos found. Try another tag, or upload photos to your GuruShots library and press Refresh.',
        );
        expect(screen.queryByText('Showing 0 photo(s).')).toBeNull();
        expect(screen.getAllByText(/No photos found/)).toHaveLength(1);
    });

    test('a complete one where every match has won says so in the region', () => {
        grid({
            state: {
                status: 'ready',
                listing: listing([], { wonIds: [idOf(7)], wonCount: 1 }),
            } as ListState,
        });
        expect(statusRegion().textContent).toBe(
            'No photos you can enter were found: every match has won a challenge. Try another tag, or upload new photos to your GuruShots library and press Refresh.',
        );
        expect(screen.queryByText('Showing 0 photo(s).')).toBeNull();
    });

    test('a preview keeps its empty text as a body paragraph — its region names no count', () => {
        grid({ state: { status: 'ready', listing: listing([], { preview: true }) } as ListState });
        expect(statusRegion().textContent).toBe('');
        expect(screen.getByText(/No photos found/)).toBeTruthy();
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
                {...baseProps({ state: { status: 'ready', listing: listing([photo(1), photo(2)]) } as ListState })}
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
            state: {
                status: 'ready',
                listing: listing([photo(1), photo(2)], { truncated, wonIds: [idOf(9)], wonCount: 1 }),
            } as ListState,
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
            state: { status: 'ready', listing: listing([photo(1), photo(2)]) } as ListState,
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
        grid({ search: true, selected: [idOf(9)] });
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
            search: true,
            selected: [idOf(9)],
            state: {
                status: 'ready',
                listing: listing([photo(1), photo(2)], { truncated: true, wonIds: [idOf(9)], wonCount: 1 }),
            } as ListState,
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
            search: true,
            hasChallenge,
            selected: [idOf(9)],
            state: { status: 'ready', listing: listing([photo(1), photo(2)]) } as ListState,
        });
        const missing = screen.getByRole('button', {
            name: new RegExp(
                `^Chosen photo ${shortOf(9)}: Not in these search results\\. Try another tag, or press Load photos — it reads from the top of your library, so you may need Load more to find it\\. Number 1 in your list\\.$`,
            ),
        });
        expect(missing.textContent).not.toContain('deleted');
    });
});
