/**
 * useLibraryListing — the chooser's library read: a cached answer that is a preview is shown at once and read
 * again in the background under the same generation, a Refresh reads the current search again without taking
 * the listing off the screen, and a failed re-check leaves what is shown as last loaded.
 */

import { act, renderHook, waitFor } from '@testing-library/preact';
import { useLibraryListing } from '@/hooks/useLibraryListing';
import { rememberCurrentMember } from '@/api/useChosenPhotosOwner';
import { mockApi } from './helpers/setup';
import { invalid } from '../helpers/invalid';

import type { WindowApi } from '../../src/ts/types/ipc';

jest.mock('@/api/useChosenPhotosOwner', () => ({
    __esModule: true,
    ...jest.requireActual<typeof import('@/api/useChosenPhotosOwner')>('@/api/useChosenPhotosOwner'),
    rememberCurrentMember: jest.fn(),
}));

type Answer = Awaited<ReturnType<WindowApi['getLibraryPhotos']>>;
type Listing = Extract<Answer, { success: true }>;

const photo = (id: string, over: { allowed?: boolean; message?: string | null } = {}) => ({
    id,
    labels: [`tag-${id}`],
    allowed: true,
    message: null,
    uploadDate: 1,
    ...over,
});

const answer = (over: Partial<Listing> = {}): Listing => ({
    success: true,
    photos: [photo('a')],
    memberId: 'member-1',
    truncated: false,
    wonIds: [],
    wonCount: 0,
    allowedKnown: true,
    preview: false,
    readAtMs: 1_700_000_000_000,
    ...over,
});
const previewAnswer = (over: Partial<Listing> = {}) =>
    answer({
        preview: true,
        allowedKnown: false,
        photos: [photo('a', { allowed: false })],
        ...over,
    });
const failure = (error: string): Answer => invalid<Answer>({ success: false, error });

const getLibrary = () => jest.mocked(mockApi.getLibraryPhotos);
const deferred = () => {
    let resolve!: (value: Answer) => void;
    const promise = new Promise<Answer>((r) => (resolve = r));
    return { promise, resolve };
};

const ids = (state: { status: string; listing?: Listing }) => state.listing?.photos.map((p) => p.id);

beforeEach(() => {
    jest.clearAllMocks();
    getLibrary().mockReset();
});

describe('a preview answer', () => {
    test('is shown at once and read again in the background, which replaces it under the same generation', async () => {
        const recheck = deferred();
        getLibrary().mockResolvedValueOnce(previewAnswer()).mockReturnValueOnce(recheck.promise);
        const { result } = renderHook(() => useLibraryListing(7));
        await waitFor(() => expect(result.current.revalidating).toBe(true));
        expect(result.current.state).toMatchObject({ status: 'ready', listing: { preview: true } });
        const generation = result.current.generation;
        expect(getLibrary().mock.calls).toEqual([
            [7, undefined, 'cached'],
            [7, undefined, 'fresh'],
        ]);
        expect(result.current.known.size).toBe(0);

        recheck.resolve(answer({ photos: [photo('a'), photo('b', { allowed: false, message: 'No' })] }));
        await waitFor(() => expect(result.current.revalidating).toBe(false));
        expect(result.current.state).toMatchObject({
            status: 'ready',
            listing: { preview: false, allowedKnown: true },
        });
        expect(result.current.generation).toBe(generation);
        expect([...result.current.known.keys()]).toEqual(['a', 'b']);
        expect(result.current.recheckFailed).toBe(false);
    });

    test('keeps the member on screen when the fresh listing cannot name one', async () => {
        getLibrary()
            .mockResolvedValueOnce(previewAnswer())
            .mockResolvedValueOnce(answer({ memberId: null }));
        const { result } = renderHook(() => useLibraryListing(7));
        await waitFor(() => expect(result.current.revalidating).toBe(false));
        await waitFor(() => expect(result.current.state).toMatchObject({ listing: { preview: false } }));
        expect(result.current.state).toMatchObject({ listing: { memberId: 'member-1' } });
        expect(rememberCurrentMember).toHaveBeenLastCalledWith('member-1');
    });

    test('a listing answered without a member on the first read has none: the member is kept only across a replacement', async () => {
        getLibrary().mockResolvedValue(answer({ memberId: null }));
        const { result } = renderHook(() => useLibraryListing(7));
        await waitFor(() => expect(result.current.state.status).toBe('ready'));
        expect(result.current.state).toMatchObject({ listing: { memberId: null } });
    });

    test.each([
        ['a failure', () => Promise.resolve(failure('Failed to read your photo library'))],
        ['a superseded read', () => Promise.resolve(failure('superseded'))],
        ['no answer at all', () => Promise.reject(new Error('down'))],
    ])(
        '%s of the re-check leaves the preview on screen with recheckFailed, and a new load clears it',
        async (_name, recheck) => {
            getLibrary().mockResolvedValueOnce(previewAnswer()).mockImplementationOnce(recheck);
            const { result } = renderHook(() => useLibraryListing(7));
            await waitFor(() => expect(result.current.recheckFailed).toBe(true));
            expect(result.current.revalidating).toBe(false);
            expect(result.current.state).toMatchObject({ status: 'ready', listing: { preview: true } });
            getLibrary().mockResolvedValueOnce(answer());
            await act(async () => result.current.load('pink'));
            expect(result.current.recheckFailed).toBe(false);
        },
    );

    test('a no-challenge-context answer to the re-check replaces the preview with that state', async () => {
        getLibrary().mockResolvedValueOnce(previewAnswer()).mockResolvedValueOnce(failure('no-challenge-context'));
        const { result } = renderHook(() => useLibraryListing(null));
        await waitFor(() => expect(result.current.state.status).toBe('no-context'));
        expect(result.current.revalidating).toBe(false);
    });

    test.each([['account-changed'], ['not-logged-in'], ['No authentication token found']])(
        'the answer %s to the re-check clears the preview and what was known',
        async (error) => {
            getLibrary().mockResolvedValueOnce(answer()).mockResolvedValueOnce(failure(error));
            const { result } = renderHook(() => useLibraryListing(7));
            await waitFor(() => expect(result.current.known.size).toBe(1));
            await act(async () => result.current.load('pink'));
            await waitFor(() => expect(result.current.state).toEqual({ status: 'error', error }));
            expect(result.current.known.size).toBe(0);
        },
    );

    test('the account leaving between the cached answer and its re-check clears what was shown', async () => {
        getLibrary().mockResolvedValueOnce(previewAnswer()).mockResolvedValueOnce(failure('account-changed'));
        const { result } = renderHook(() => useLibraryListing(7));
        await waitFor(() => expect(result.current.state).toEqual({ status: 'error', error: 'account-changed' }));
        expect(result.current.revalidating).toBe(false);
        expect(result.current.known.size).toBe(0);
    });

    test('a newer search drops a late re-check', async () => {
        const recheck = deferred();
        getLibrary()
            .mockResolvedValueOnce(previewAnswer())
            .mockReturnValueOnce(recheck.promise)
            .mockResolvedValueOnce(answer({ photos: [photo('searched')] }));
        const { result } = renderHook(() => useLibraryListing(7));
        await waitFor(() => expect(result.current.revalidating).toBe(true));
        await act(async () => result.current.load('pink'));
        await waitFor(() => expect(ids(result.current.state as never)).toEqual(['searched']));
        recheck.resolve(answer({ photos: [photo('late')] }));
        await act(async () => undefined);
        expect(ids(result.current.state as never)).toEqual(['searched']);
        expect(result.current.revalidating).toBe(false);
        expect([...result.current.known.keys()]).toEqual(['searched']);
    });

    test('nothing is shown or remembered after the hook is gone', async () => {
        const recheck = deferred();
        getLibrary().mockResolvedValueOnce(previewAnswer()).mockReturnValueOnce(recheck.promise);
        const { result, unmount } = renderHook(() => useLibraryListing(7));
        await waitFor(() => expect(result.current.revalidating).toBe(true));
        jest.mocked(rememberCurrentMember).mockClear();
        act(() => unmount());
        recheck.resolve(answer({ memberId: 'late-member' }));
        await act(async () => undefined);
        expect(rememberCurrentMember).not.toHaveBeenCalled();
        expect(result.current.state).toMatchObject({ listing: { preview: true } });
    });
});

describe('alwaysFresh', () => {
    test('turns a cached answer with its marks into a preview with none, and reads again', async () => {
        const recheck = deferred();
        getLibrary()
            .mockResolvedValueOnce(
                answer({ photos: [photo('a', { allowed: false, message: 'Used in another challenge' })] }),
            )
            .mockReturnValueOnce(recheck.promise);
        const { result } = renderHook(() => useLibraryListing(7, { alwaysFresh: true }));
        await waitFor(() => expect(result.current.revalidating).toBe(true));
        const { state } = result.current;
        expect(state).toMatchObject({
            status: 'ready',
            listing: { preview: true, allowedKnown: false, photos: [{ id: 'a', allowed: false, message: null }] },
        });
        expect(result.current.known.size).toBe(0);
        recheck.resolve(answer({ photos: [photo('a', { allowed: false, message: 'Used in another challenge' })] }));
        await waitFor(() => expect(result.current.revalidating).toBe(false));
        expect(result.current.state).toMatchObject({ listing: { preview: false, allowedKnown: true } });
        expect(getLibrary().mock.calls.map((call) => call[2])).toEqual(['cached', 'fresh']);
    });

    test('an answer whose read began after the request is not a cached one: one call, no preview, nothing locked', async () => {
        getLibrary().mockResolvedValueOnce(answer({ readAtMs: Date.now() + 60_000 }));
        const { result } = renderHook(() => useLibraryListing(7, { alwaysFresh: true }));
        await waitFor(() => expect(result.current.state.status).toBe('ready'));
        await act(async () => undefined);
        expect(getLibrary()).toHaveBeenCalledTimes(1);
        expect(result.current.state).toMatchObject({ listing: { preview: false, allowedKnown: true } });
        expect(result.current.revalidating).toBe(false);
        expect([...result.current.known.keys()]).toEqual(['a']);
    });

    test('a search is a fresh read, with no preview', async () => {
        getLibrary().mockResolvedValueOnce(previewAnswer()).mockResolvedValueOnce(answer()).mockResolvedValue(answer());
        const { result } = renderHook(() => useLibraryListing(7, { alwaysFresh: true }));
        await waitFor(() => expect(result.current.revalidating).toBe(false));
        await act(async () => result.current.load('pink'));
        expect(getLibrary().mock.calls.at(-1)).toEqual([7, 'pink', 'fresh']);
        expect(result.current.state).toMatchObject({ listing: { preview: false } });
        expect(result.current.revalidating).toBe(false);
    });
});

describe('load and retry', () => {
    test('a no-search load asks for the cached listing, a search and a retry ask for a fresh one', async () => {
        getLibrary().mockResolvedValue(answer());
        const { result } = renderHook(() => useLibraryListing(7));
        await waitFor(() => expect(result.current.state.status).toBe('ready'));
        await act(async () => result.current.load('pink'));
        await act(async () => result.current.load(''));
        expect(getLibrary().mock.calls.map((call) => [call[1], call[2]])).toEqual([
            [undefined, 'cached'],
            ['pink', 'fresh'],
            [undefined, 'cached'],
        ]);
        await act(async () => {
            result.current.retry();
        });
        expect(getLibrary().mock.calls.at(-1)).toEqual([7, undefined, 'fresh']);
    });

    test('Retry is a new generation with the loading state, as before', async () => {
        getLibrary().mockResolvedValue(answer());
        const { result } = renderHook(() => useLibraryListing(7));
        await waitFor(() => expect(result.current.state.status).toBe('ready'));
        const before = result.current.generation;
        const retry = deferred();
        getLibrary().mockReturnValueOnce(retry.promise);
        let generation = 0;
        act(() => {
            generation = result.current.retry();
        });
        expect(generation).toBe(before + 1);
        expect(result.current.generation).toBe(before + 1);
        expect(result.current.state.status).toBe('loading');
        retry.resolve(answer());
        await waitFor(() => expect(result.current.state.status).toBe('ready'));
    });

    test.each([
        ['an error', failure('Failed to read your photo library'), 'Failed to read your photo library'],
        ['a superseded read, which offers Retry', failure('superseded'), null],
    ])('%s ends in the error state', async (_name, response, error) => {
        getLibrary().mockResolvedValue(response);
        const { result } = renderHook(() => useLibraryListing(7));
        await waitFor(() => expect(result.current.state).toEqual({ status: 'error', error }));
    });

    test('an unanswered read (a rejection) ends in the error state with no detail', async () => {
        getLibrary().mockRejectedValue(new Error('down'));
        const { result } = renderHook(() => useLibraryListing(7));
        await waitFor(() => expect(result.current.state).toEqual({ status: 'error', error: null }));
    });

    test('a cached answer that is not a preview is the listing, and feeds known', async () => {
        getLibrary().mockResolvedValue(answer({ photos: [photo('a'), photo('b')] }));
        const { result } = renderHook(() => useLibraryListing(7));
        await waitFor(() => expect(result.current.state.status).toBe('ready'));
        expect([...result.current.known.keys()]).toEqual(['a', 'b']);
        expect(result.current.revalidating).toBe(false);
        expect(getLibrary()).toHaveBeenCalledTimes(1);
    });
});

describe('refresh', () => {
    test('reads the current search again, keeps the listing on screen while it does and starts a new generation when it lands', async () => {
        getLibrary()
            .mockResolvedValueOnce(answer())
            .mockResolvedValueOnce(answer({ photos: [photo('p')] }));
        const { result } = renderHook(() => useLibraryListing(7));
        await waitFor(() => expect(result.current.state.status).toBe('ready'));
        await act(async () => result.current.load('pink'));
        const generation = result.current.generation;
        const read = deferred();
        getLibrary().mockReturnValueOnce(read.promise);
        let landsOn = 0;
        act(() => {
            landsOn = result.current.refresh();
        });
        expect(landsOn).toBe(generation + 1);
        expect(result.current.revalidating).toBe(true);
        expect(ids(result.current.state as never)).toEqual(['p']);
        expect(result.current.generation).toBe(generation);
        expect(getLibrary().mock.calls.at(-1)).toEqual([7, 'pink', 'fresh']);
        read.resolve(answer({ photos: [photo('p'), photo('q')], readAtMs: 1_700_000_100_000 }));
        await waitFor(() => expect(result.current.revalidating).toBe(false));
        expect(ids(result.current.state as never)).toEqual(['p', 'q']);
        expect(result.current.generation).toBe(generation + 1);
        expect([...result.current.known.keys()]).toContain('q');
    });

    test('a failed refresh leaves the listing and says so; the next one clears that', async () => {
        getLibrary().mockResolvedValueOnce(answer());
        const { result } = renderHook(() => useLibraryListing(7));
        await waitFor(() => expect(result.current.state.status).toBe('ready'));
        getLibrary().mockResolvedValueOnce(failure('superseded'));
        await act(async () => {
            result.current.refresh();
        });
        await waitFor(() => expect(result.current.recheckFailed).toBe(true));
        expect(result.current.revalidating).toBe(false);
        expect(ids(result.current.state as never)).toEqual(['a']);
        getLibrary().mockResolvedValueOnce(answer());
        await act(async () => {
            result.current.refresh();
        });
        await waitFor(() => expect(result.current.revalidating).toBe(false));
        expect(result.current.recheckFailed).toBe(false);
    });

    test.each([
        ['no-challenge-context', { status: 'no-context' }],
        ['account-changed', { status: 'error', error: 'account-changed' }],
    ])('%s replaces the listing with that state', async (error, expected) => {
        getLibrary().mockResolvedValueOnce(answer()).mockResolvedValueOnce(failure(error));
        const { result } = renderHook(() => useLibraryListing(7));
        await waitFor(() => expect(result.current.state.status).toBe('ready'));
        await act(async () => {
            result.current.refresh();
        });
        await waitFor(() => expect(result.current.state).toEqual(expected));
        expect(result.current.revalidating).toBe(false);
    });

    test('a newer load drops a refresh still in flight', async () => {
        getLibrary().mockResolvedValueOnce(answer());
        const { result } = renderHook(() => useLibraryListing(7));
        await waitFor(() => expect(result.current.state.status).toBe('ready'));
        const read = deferred();
        getLibrary()
            .mockReturnValueOnce(read.promise)
            .mockResolvedValueOnce(answer({ photos: [photo('searched')] }));
        act(() => {
            result.current.refresh();
        });
        await act(async () => result.current.load('pink'));
        const generation = result.current.generation;
        read.resolve(answer({ photos: [photo('late')] }));
        await act(async () => undefined);
        expect(ids(result.current.state as never)).toEqual(['searched']);
        expect(result.current.generation).toBe(generation);
    });
});

describe('the member on screen', () => {
    test('is kept by a preview’s background re-check only: Refresh and Retry that cannot name one show none', async () => {
        getLibrary()
            .mockResolvedValueOnce(answer({ memberId: 'member-1' }))
            .mockResolvedValueOnce(answer({ memberId: null }))
            .mockResolvedValueOnce(answer({ memberId: null }));
        const { result } = renderHook(() => useLibraryListing(7));
        await waitFor(() => expect(result.current.state).toMatchObject({ listing: { memberId: 'member-1' } }));
        await act(async () => {
            result.current.refresh();
        });
        await waitFor(() => expect(result.current.state).toMatchObject({ listing: { memberId: null } }));
        await act(async () => {
            result.current.retry();
        });
        await waitFor(() => expect(result.current.state).toMatchObject({ listing: { memberId: null } }));
    });

    test('after an account switch, a Refresh that cannot name a member keeps neither the old member nor the old photos', async () => {
        getLibrary()
            .mockResolvedValueOnce(answer({ memberId: 'member-1', photos: [photo('a')] }))
            .mockResolvedValueOnce(answer({ memberId: 'member-2', photos: [photo('b')] }))
            .mockResolvedValueOnce(answer({ memberId: null, photos: [photo('c')] }));
        const { result } = renderHook(() => useLibraryListing(7));
        await waitFor(() => expect([...result.current.known.keys()]).toEqual(['a']));
        // The account switched: the next listing names another member, and what was known is not theirs.
        await act(async () => {
            result.current.refresh();
        });
        await waitFor(() => expect(result.current.state).toMatchObject({ listing: { memberId: 'member-2' } }));
        expect([...result.current.known.keys()]).toEqual(['b']);
        await act(async () => {
            result.current.refresh();
        });
        await waitFor(() => expect(result.current.state).toMatchObject({ listing: { memberId: null } }));
        expect([...result.current.known.keys()]).toEqual(['c']);
    });

    test('the same member keeps what was known, and a first listing with none has nothing to clear', async () => {
        getLibrary()
            .mockResolvedValueOnce(answer({ memberId: null, photos: [photo('a')] }))
            .mockResolvedValueOnce(answer({ memberId: 'member-1', photos: [photo('b')] }))
            .mockResolvedValueOnce(answer({ memberId: 'member-1', photos: [photo('c')] }));
        const { result } = renderHook(() => useLibraryListing(7));
        await waitFor(() => expect([...result.current.known.keys()]).toEqual(['a']));
        await act(async () => {
            result.current.refresh();
        });
        await waitFor(() => expect([...result.current.known.keys()]).toEqual(['a', 'b']));
        await act(async () => {
            result.current.refresh();
        });
        await waitFor(() => expect([...result.current.known.keys()]).toEqual(['a', 'b', 'c']));
    });

    test('a preview whose member differs from the one on screen empties what was known too', async () => {
        getLibrary()
            .mockResolvedValueOnce(answer({ memberId: 'member-1', photos: [photo('a')] }))
            .mockResolvedValueOnce(previewAnswer({ memberId: 'member-2' }))
            .mockResolvedValueOnce(answer({ memberId: 'member-2', photos: [photo('d')] }));
        const { result } = renderHook(() => useLibraryListing(7));
        await waitFor(() => expect([...result.current.known.keys()]).toEqual(['a']));
        await act(async () => result.current.load(''));
        await waitFor(() => expect(result.current.revalidating).toBe(false));
        await waitFor(() => expect([...result.current.known.keys()]).toEqual(['d']));
    });
});
