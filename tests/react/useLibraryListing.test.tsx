/**
 * useLibraryListing — the chooser's library read: a cached answer that is a preview is shown at once and read
 * again in the background under the same request, a Refresh reads the current search again without taking
 * the listing off the screen, and a failed re-check lands in the error state when the hook reads for a
 * challenge (a challenge-bound grid holds a loader for the preview) and leaves the preview as last loaded
 * with recheckFailed when it does not.
 */

import { act, renderHook, waitFor } from '@testing-library/preact';
import { useCurrentMember } from '@/hooks/currentMember';
import { useLibraryListing } from '@/hooks/useLibraryListing';
import { mockApi } from './helpers/setup';
import { invalid } from '../helpers/invalid';
import { MAX_WON_IDS } from '../../src/ts/settings/limits';

import type { WindowApi } from '../../src/ts/types/ipc';

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
    nextStart: 0,
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
    test('is shown at once and read again in the background, which replaces it under the same request', async () => {
        const recheck = deferred();
        getLibrary().mockResolvedValueOnce(previewAnswer()).mockReturnValueOnce(recheck.promise);
        const { result } = renderHook(() => useLibraryListing(7));
        await waitFor(() => expect(result.current.revalidating).toBe(true));
        expect(result.current.state).toMatchObject({ status: 'ready', listing: { preview: true } });
        const request = result.current.requestId;
        expect(getLibrary().mock.calls).toEqual([
            [7, undefined, 'cached', 'submit', 0, 100],
            // A borrowed preview: with a challenge its re-check reads one batch, not the preview's extent.
            [7, undefined, 'fresh', 'submit', 0, 100],
        ]);
        expect(result.current.known.size).toBe(0);

        recheck.resolve(answer({ photos: [photo('a'), photo('b', { allowed: false, message: 'No' })] }));
        await waitFor(() => expect(result.current.revalidating).toBe(false));
        expect(result.current.state).toMatchObject({
            status: 'ready',
            listing: { preview: false, allowedKnown: true },
        });
        expect(result.current.requestId).toBe(request);
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
    });

    test('a listing answered without a member on the first read has none: the member is kept only across a replacement', async () => {
        getLibrary().mockResolvedValue(answer({ memberId: null }));
        const { result } = renderHook(() => useLibraryListing(7));
        await waitFor(() => expect(result.current.state.status).toBe('ready'));
        expect(result.current.state).toMatchObject({ listing: { memberId: null } });
    });

    test.each([
        [
            'a failure',
            () => Promise.resolve(failure('Failed to read your photo library')),
            'Failed to read your photo library',
        ],
        ['a superseded read', () => Promise.resolve(failure('superseded')), 'superseded'],
        ['no answer at all', () => Promise.reject(new Error('down')), null],
    ])(
        '%s of the re-check lands in the error state when the hook reads for a challenge',
        async (_name, recheck, error) => {
            getLibrary().mockResolvedValueOnce(previewAnswer()).mockImplementationOnce(recheck);
            const { result } = renderHook(() => useLibraryListing(7));
            await waitFor(() => expect(result.current.state).toEqual({ status: 'error', error }));
            expect(result.current.revalidating).toBe(false);
            expect(result.current.recheckFailed).toBe(false);
            // From the error state a Retry reads one batch, as after a failed cold read.
            getLibrary().mockResolvedValueOnce(answer());
            await act(async () => {
                result.current.retry();
            });
            await waitFor(() => expect(result.current.state.status).toBe('ready'));
            expect(getLibrary().mock.calls.at(-1)).toEqual([7, undefined, 'fresh', 'submit', 0, 100]);
        },
    );

    test.each([
        ['a failure', () => Promise.resolve(failure('Failed to read your photo library'))],
        ['a superseded read', () => Promise.resolve(failure('superseded'))],
        ['no answer at all', () => Promise.reject(new Error('down'))],
    ])(
        '%s of the re-check leaves a no-challenge preview on screen with recheckFailed, and a new load clears it',
        async (_name, recheck) => {
            getLibrary().mockResolvedValueOnce(previewAnswer()).mockImplementationOnce(recheck);
            const { result } = renderHook(() => useLibraryListing(null));
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

    test.each([['not-logged-in'], ['No authentication token found']])(
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

    test.each([['not-logged-in'], ['No authentication token found']])(
        'a signed-out answer (%s) to a challenge re-check clears what was known and lands in the error state',
        async (error) => {
            getLibrary()
                .mockResolvedValueOnce(answer({ photos: [photo('a')] }))
                .mockResolvedValueOnce(previewAnswer())
                .mockResolvedValueOnce(failure(error));
            const { result } = renderHook(() => useLibraryListing(7));
            await waitFor(() => expect([...result.current.known.keys()]).toEqual(['a']));
            // The next load is served a borrowed preview, whose re-check fails signed out.
            await act(async () => result.current.load(''));
            await waitFor(() => expect(result.current.state).toEqual({ status: 'error', error }));
            expect(result.current.known.size).toBe(0);
        },
    );

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
        act(() => unmount());
        recheck.resolve(answer({ memberId: 'late-member' }));
        await act(async () => undefined);
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

    test('a same-challenge cached entry is re-read to its own accepted extent', async () => {
        getLibrary()
            .mockResolvedValueOnce(
                answer({ photos: [photo('a'), photo('b'), photo('c', { allowed: false })], truncated: true }),
            )
            .mockResolvedValueOnce(answer({ photos: [photo('a'), photo('b')] }));
        const { result } = renderHook(() => useLibraryListing(7, { onDemand: true, alwaysFresh: true }));
        await act(async () => result.current.load(''));
        await waitFor(() => expect(result.current.revalidating).toBe(false));
        // The cached marks are distrusted, but the extent is this challenge's own: its 2 accepted
        // photos — not the 3 listed, and not one batch — so what Load more loaded stays on screen.
        expect(getLibrary().mock.calls[1]).toEqual([7, undefined, 'fresh', 'submit', 0, 2]);
        expect(result.current.state).toMatchObject({ listing: { preview: false, allowedKnown: true } });
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
        expect(getLibrary().mock.calls.at(-1)).toEqual([7, 'pink', 'fresh', 'submit', 0, 100]);
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
        expect(getLibrary().mock.calls.at(-1)).toEqual([7, undefined, 'fresh', 'submit', 0, 1]);
    });

    test('Retry starts a new request, with the loading state, and the exposed id moves when its listing lands', async () => {
        getLibrary().mockResolvedValue(answer());
        const { result } = renderHook(() => useLibraryListing(7));
        await waitFor(() => expect(result.current.state.status).toBe('ready'));
        const before = result.current.requestId;
        const retry = deferred();
        getLibrary().mockReturnValueOnce(retry.promise);
        let landsOn = 0;
        act(() => {
            landsOn = result.current.retry();
        });
        expect(landsOn).toBe(before + 1);
        // The read is a new request, but the listing on screen is still the old one: its id holds until
        // the new listing actually replaces it.
        expect(result.current.requestId).toBe(before);
        expect(result.current.state.status).toBe('loading');
        retry.resolve(answer());
        await waitFor(() => expect(result.current.state.status).toBe('ready'));
        expect(result.current.requestId).toBe(before + 1);
    });

    test.each([
        ['an error', failure('Failed to read your photo library'), 'Failed to read your photo library'],
        ['a superseded read', failure('superseded'), 'superseded'],
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
    test('reads the current search again, keeping the listing and its id on screen while it does; the landing listing brings the new id', async () => {
        getLibrary()
            .mockResolvedValueOnce(answer())
            .mockResolvedValueOnce(answer({ photos: [photo('p')] }));
        const { result } = renderHook(() => useLibraryListing(7));
        await waitFor(() => expect(result.current.state.status).toBe('ready'));
        await act(async () => result.current.load('pink'));
        const request = result.current.requestId;
        const read = deferred();
        getLibrary().mockReturnValueOnce(read.promise);
        let landsOn = 0;
        act(() => {
            landsOn = result.current.refresh();
        });
        expect(landsOn).toBe(request + 1);
        expect(result.current.revalidating).toBe(true);
        expect(result.current.requestId).toBe(request);
        expect(ids(result.current.state as never)).toEqual(['p']);
        expect(getLibrary().mock.calls.at(-1)).toEqual([7, 'pink', 'fresh', 'submit', 0, 1]);
        read.resolve(answer({ photos: [photo('p'), photo('q')], readAtMs: 1_700_000_100_000 }));
        await waitFor(() => expect(result.current.revalidating).toBe(false));
        expect(ids(result.current.state as never)).toEqual(['p', 'q']);
        expect(result.current.requestId).toBe(request + 1);
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

    test.each([['no-challenge-context', { status: 'no-context' }]])(
        '%s replaces the listing with that state',
        async (error, expected) => {
            getLibrary().mockResolvedValueOnce(answer()).mockResolvedValueOnce(failure(error));
            const { result } = renderHook(() => useLibraryListing(7));
            await waitFor(() => expect(result.current.state.status).toBe('ready'));
            await act(async () => {
                result.current.refresh();
            });
            await waitFor(() => expect(result.current.state).toEqual(expected));
            expect(result.current.revalidating).toBe(false);
        },
    );

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
        const request = result.current.requestId;
        read.resolve(answer({ photos: [photo('late')] }));
        await act(async () => undefined);
        expect(ids(result.current.state as never)).toEqual(['searched']);
        expect(result.current.requestId).toBe(request);
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

describe('onDemand', () => {
    test('starts idle and reads nothing until asked', async () => {
        const { result } = renderHook(() => useLibraryListing(7, { onDemand: true }));
        await act(async () => undefined);
        expect(result.current.state).toEqual({ status: 'idle' });
        expect(getLibrary()).not.toHaveBeenCalled();
    });

    test('load("") from idle reads the library', async () => {
        getLibrary().mockResolvedValue(answer());
        const { result } = renderHook(() => useLibraryListing(7, { onDemand: true }));
        await act(async () => result.current.load(''));
        expect(result.current.state).toMatchObject({ status: 'ready', listing: { preview: false } });
        expect(getLibrary()).toHaveBeenCalledWith(7, undefined, 'cached', 'submit', 0, 100);
    });

    test('retry() from idle is a fresh full read', async () => {
        getLibrary().mockResolvedValue(answer());
        const { result } = renderHook(() => useLibraryListing(7, { onDemand: true }));
        await act(async () => {
            result.current.retry();
        });
        await waitFor(() => expect(result.current.state.status).toBe('ready'));
        expect(getLibrary().mock.calls).toEqual([[7, undefined, 'fresh', 'submit', 0, 100]]);
    });

    test('a usage change reads nothing, and the next load and retry send the new usage', async () => {
        getLibrary().mockResolvedValue(answer());
        const { result, rerender } = renderHook(
            ({ usage }: { usage: 'submit' | 'swap' }) => useLibraryListing(7, { onDemand: true, usage }),
            { initialProps: { usage: 'submit' } },
        );
        rerender({ usage: 'swap' });
        await act(async () => undefined);
        expect(result.current.state).toEqual({ status: 'idle' });
        expect(getLibrary()).not.toHaveBeenCalled();
        await act(async () => result.current.load(''));
        expect(getLibrary().mock.calls).toEqual([[7, undefined, 'cached', 'swap', 0, 100]]);
        await act(async () => {
            result.current.retry();
        });
        expect(getLibrary().mock.calls.at(-1)).toEqual([7, undefined, 'fresh', 'swap', 0, 1]);
    });

    test('a preview that lands after unmounting starts no re-check', async () => {
        const pending = deferred();
        getLibrary().mockReturnValueOnce(pending.promise);
        const { result, unmount } = renderHook(() => useLibraryListing(7, { onDemand: true, alwaysFresh: true }));
        act(() => {
            void result.current.load('');
        });
        act(() => unmount());
        await act(async () => pending.resolve(previewAnswer()));
        expect(getLibrary()).toHaveBeenCalledTimes(1);
    });

    test('without it the library is read on mount, as before', async () => {
        getLibrary().mockResolvedValue(answer());
        const { result } = renderHook(() => useLibraryListing(7));
        expect(result.current.state).toEqual({ status: 'loading' });
        await waitFor(() => expect(result.current.state.status).toBe('ready'));
        expect(getLibrary()).toHaveBeenCalledTimes(1);
    });
});

describe('loadMore', () => {
    const batch = (ids: string[], over: Partial<Listing> = {}): Listing =>
        answer({ photos: ids.map((id) => photo(id)), ...over });
    const listingOf = (current: { status: string; listing?: Listing }) =>
        current.status === 'ready' ? current.listing : null;
    const photoIds = (current: { status: string; listing?: Listing }) => listingOf(current)?.photos.map((p) => p.id);

    test('appends a batch, keeping the records and order of photos already listed', async () => {
        getLibrary()
            .mockResolvedValueOnce(batch(['a', 'b'], { nextStart: 2, truncated: true }))
            .mockResolvedValueOnce(batch(['b', 'c'], { nextStart: 4, truncated: false }));
        const { result } = renderHook(() => useLibraryListing(7, { onDemand: true }));
        await act(async () => result.current.load(''));
        const before = listingOf(result.current.state);
        await act(async () => result.current.loadMore());
        expect(result.current.state.status).toBe('ready');
        const listing = listingOf(result.current.state);
        expect(listing?.photos.map((p) => p.id)).toEqual(['a', 'b', 'c']);
        expect(listing?.photos[0]).toBe(before?.photos[0]);
        expect(listing?.truncated).toBe(false);
        expect(listing?.nextStart).toBe(4);
        expect([...result.current.known.keys()]).toEqual(['a', 'b', 'c']);
        // Not a new request — the same listing, with the batch appended.
        expect(result.current.requestId).toBe(1);
        expect(result.current.loadingMore).toBe(false);
        expect(result.current.loadMoreFailed).toBeNull();
    });

    test('reads the batch fresh, from the listing’s nextStart and the last search, one batch kept', async () => {
        getLibrary()
            .mockResolvedValueOnce(batch(['a'], { nextStart: 7, truncated: true }))
            .mockResolvedValueOnce(batch(['b']));
        const { result } = renderHook(() => useLibraryListing(7, { onDemand: true }));
        await act(async () => result.current.load('pink'));
        await act(async () => result.current.loadMore());
        expect(getLibrary().mock.calls.at(-1)).toEqual([7, 'pink', 'fresh', 'submit', 7, 100]);
    });

    test('unions the won ids up to the cap and counts only the batch won ids not counted yet', async () => {
        const won = Array.from({ length: MAX_WON_IDS + 200 }, (_, i) => `w${i}`);
        getLibrary()
            .mockResolvedValueOnce(
                batch(['a'], { nextStart: 1, truncated: true, wonIds: won.slice(0, 600), wonCount: 600 }),
            )
            .mockResolvedValueOnce(
                batch(['b'], {
                    nextStart: 2,
                    truncated: false,
                    // 900 of the batch's 1400 ids are new; 500 were counted before, and 300 more overlap.
                    wonIds: [...won.slice(300, MAX_WON_IDS + 200), ...won.slice(0, 500)],
                    wonCount: MAX_WON_IDS + 100,
                }),
            );
        const { result } = renderHook(() => useLibraryListing(7, { onDemand: true }));
        await act(async () => result.current.load(''));
        await act(async () => result.current.loadMore());
        const listing = listingOf(result.current.state);
        expect(listing?.wonIds).toHaveLength(MAX_WON_IDS);
        expect(listing?.wonIds[0]).toBe('w0');
        expect(listing?.wonIds.at(-1)).toBe(`w${MAX_WON_IDS - 1}`);
        // 600 counted before; the batch counts 1100, of which 800 were already in the union.
        expect(listing?.wonCount).toBe(600 + 1100 - 800);
        expect(result.current.loadMoreFailed).toBeNull();
    });

    test('a load that starts after loadMore resets its flags and drops the append', async () => {
        const more = deferred();
        getLibrary()
            .mockResolvedValueOnce(batch(['a'], { nextStart: 1, truncated: true }))
            .mockResolvedValueOnce(failure('library-read-failed'))
            .mockReturnValueOnce(more.promise)
            .mockResolvedValueOnce(batch(['searched']));
        const { result } = renderHook(() => useLibraryListing(7, { onDemand: true }));
        await act(async () => result.current.load(''));
        await act(async () => result.current.loadMore());
        expect(result.current.loadMoreFailed).toBe('library-read-failed');
        await act(async () => {
            void result.current.loadMore();
        });
        expect(result.current.loadingMore).toBe(true);
        expect(result.current.loadMoreFailed).toBeNull();
        // The newer load resets both flags and takes the request slot.
        await act(async () => result.current.load('pink'));
        expect(result.current.loadingMore).toBe(false);
        expect(result.current.loadMoreFailed).toBeNull();
        await act(async () => more.resolve(batch(['late'])));
        await act(async () => undefined);
        expect(photoIds(result.current.state)).toEqual(['searched']);
    });

    test('an answer that landed on another request (a Refresh) is dropped silently too', async () => {
        const more = deferred();
        getLibrary()
            .mockResolvedValueOnce(batch(['a'], { nextStart: 1, truncated: true }))
            .mockReturnValueOnce(more.promise)
            .mockResolvedValueOnce(batch(['refreshed']));
        const { result } = renderHook(() => useLibraryListing(7, { onDemand: true }));
        await act(async () => result.current.load(''));
        await act(async () => {
            void result.current.loadMore();
        });
        await act(async () => {
            result.current.refresh();
        });
        await waitFor(() => expect(photoIds(result.current.state)).toEqual(['refreshed']));
        await act(async () => more.resolve(batch(['late'])));
        await act(async () => undefined);
        expect(photoIds(result.current.state)).toEqual(['refreshed']);
        expect(result.current.loadingMore).toBe(false);
        expect(result.current.loadMoreFailed).toBeNull();
    });

    test.each([['superseded'], ['library-read-failed'], ['Failed to read your photo library']])(
        'a %s answer keeps the listing and marks loadMoreFailed',
        async (error) => {
            getLibrary()
                .mockResolvedValueOnce(batch(['a'], { nextStart: 1, truncated: true }))
                .mockResolvedValueOnce(failure(error));
            const { result } = renderHook(() => useLibraryListing(7, { onDemand: true }));
            await act(async () => result.current.load(''));
            await act(async () => result.current.loadMore());
            expect(result.current.state).toMatchObject({ status: 'ready', listing: { photos: [{ id: 'a' }] } });
            expect(result.current.loadMoreFailed).toBe(error);
            expect(result.current.loadingMore).toBe(false);
        },
    );

    test('an unanswered batch read (a rejection) marks the sentinel failure', async () => {
        getLibrary()
            .mockResolvedValueOnce(batch(['a'], { nextStart: 1, truncated: true }))
            .mockRejectedValueOnce(new Error('down'));
        const { result } = renderHook(() => useLibraryListing(7, { onDemand: true }));
        await act(async () => result.current.load(''));
        await act(async () => result.current.loadMore());
        expect(result.current.loadMoreFailed).toBe('failed');
        expect(photoIds(result.current.state)).toEqual(['a']);
    });

    test.each([
        ['not-logged-in', { status: 'error', error: 'not-logged-in' }],
        ['no-challenge-context', { status: 'no-context' }],
    ])('%s replaces the listing, as for any read', async (error, expected) => {
        getLibrary()
            .mockResolvedValueOnce(batch(['a'], { nextStart: 1, truncated: true }))
            .mockResolvedValueOnce(failure(error));
        const { result } = renderHook(() => useLibraryListing(7, { onDemand: true }));
        await act(async () => result.current.load(''));
        await act(async () => result.current.loadMore());
        expect(result.current.state).toEqual(expected);
        expect(result.current.loadMoreFailed).toBeNull();
        if (error !== 'no-challenge-context') expect(result.current.known.size).toBe(0);
    });

    test('a batch naming a member the listing could not adopts it, as a read landing would', async () => {
        getLibrary()
            .mockResolvedValueOnce(batch(['a'], { nextStart: 1, truncated: true, memberId: null }))
            .mockResolvedValueOnce(batch(['b'], { memberId: 'member-9' }));
        const { result } = renderHook(() => useLibraryListing(7, { onDemand: true }));
        await act(async () => result.current.load(''));
        await act(async () => result.current.loadMore());
        expect(result.current.state).toMatchObject({ status: 'ready', listing: { memberId: 'member-9' } });
        expect(result.current.known.size).toBe(2);
        expect(result.current.loadMoreFailed).toBeNull();
        // The store is fed as well, so the chosen-photo chips can build their thumbnails from the batch.
        const { result: member } = renderHook(() => useCurrentMember());
        expect(member.current).toBe('member-9');
    });

    test('a new loadMore clears the failure of the last one while it reads', async () => {
        getLibrary()
            .mockResolvedValueOnce(batch(['a'], { nextStart: 1, truncated: true }))
            .mockResolvedValueOnce(failure('library-read-failed'));
        const { result } = renderHook(() => useLibraryListing(7, { onDemand: true }));
        await act(async () => result.current.load(''));
        await act(async () => result.current.loadMore());
        expect(result.current.loadMoreFailed).toBe('library-read-failed');
        const retry = deferred();
        getLibrary().mockReturnValueOnce(retry.promise);
        await act(async () => {
            void result.current.loadMore();
        });
        expect(result.current.loadMoreFailed).toBeNull();
        expect(result.current.loadingMore).toBe(true);
        await act(async () => retry.resolve(batch(['b'], { nextStart: 2, truncated: false })));
        await act(async () => undefined);
        expect(result.current.loadMoreFailed).toBeNull();
        expect(photoIds(result.current.state)).toEqual(['a', 'b']);
    });

    test('a second loadMore while one is in flight does nothing', async () => {
        const first = deferred();
        getLibrary()
            .mockResolvedValueOnce(batch(['a'], { nextStart: 1, truncated: true }))
            .mockReturnValueOnce(first.promise);
        const { result } = renderHook(() => useLibraryListing(7, { onDemand: true }));
        await act(async () => result.current.load(''));
        await act(async () => {
            void result.current.loadMore();
        });
        await act(async () => {
            void result.current.loadMore();
        });
        // One batch read in all: the second call returned at once and touched no flags.
        expect(getLibrary()).toHaveBeenCalledTimes(2);
        expect(result.current.loadingMore).toBe(true);
        expect(result.current.loadMoreFailed).toBeNull();
        first.resolve(batch(['b'], { nextStart: 2, truncated: false }));
        await act(async () => undefined);
        await act(async () => undefined);
        // The in-flight read appends once; nothing queued a second read behind it.
        expect(photoIds(result.current.state)).toEqual(['a', 'b']);
        expect(result.current.loadingMore).toBe(false);
    });

    test('a loadMore on a newer listing reads while an older one is still in flight', async () => {
        const stale = deferred();
        const fresh = deferred();
        getLibrary()
            .mockResolvedValueOnce(batch(['a'], { nextStart: 1, truncated: true }))
            .mockReturnValueOnce(stale.promise)
            .mockResolvedValueOnce(batch(['searched'], { nextStart: 1, truncated: true }))
            .mockReturnValueOnce(fresh.promise);
        const { result } = renderHook(() => useLibraryListing(7, { onDemand: true }));
        await act(async () => result.current.load(''));
        // The first listing's batch read is still on its way when a new load replaces the listing.
        await act(async () => {
            void result.current.loadMore();
        });
        await act(async () => result.current.load('pink'));
        expect(photoIds(result.current.state)).toEqual(['searched']);
        await act(async () => {
            void result.current.loadMore();
        });
        // The press on the new listing makes its own read: the in-flight older one does not hold the guard.
        expect(getLibrary()).toHaveBeenCalledTimes(4);
        expect(getLibrary().mock.calls.at(-1)).toEqual([7, 'pink', 'fresh', 'submit', 1, 100]);
        expect(result.current.loadingMore).toBe(true);
        await act(async () => {
            fresh.resolve(batch(['b'], { nextStart: 2, truncated: false }));
        });
        await act(async () => undefined);
        // The new append landed; the stale answer is dropped and leaves nothing behind.
        expect(photoIds(result.current.state)).toEqual(['searched', 'b']);
        expect(result.current.loadingMore).toBe(false);
        stale.resolve(batch(['late'], { nextStart: 2, truncated: false }));
        await act(async () => undefined);
        expect(photoIds(result.current.state)).toEqual(['searched', 'b']);
        expect(result.current.loadMoreFailed).toBeNull();
    });

    test('a last empty batch is not a failure and not a new listing', async () => {
        getLibrary()
            .mockResolvedValueOnce(batch(['a', 'b'], { nextStart: 2, truncated: true }))
            .mockResolvedValueOnce(batch([], { nextStart: 2, truncated: false }));
        const { result } = renderHook(() => useLibraryListing(7, { onDemand: true }));
        await act(async () => result.current.load(''));
        await act(async () => result.current.loadMore());
        expect(result.current.state).toMatchObject({ status: 'ready', listing: { truncated: false, nextStart: 2 } });
        expect(photoIds(result.current.state)).toEqual(['a', 'b']);
        expect(result.current.loadMoreFailed).toBeNull();
        expect(result.current.loadingMore).toBe(false);
        expect(result.current.requestId).toBe(1);
    });

    test('loadMore does nothing from idle and nothing on a preview', async () => {
        const { result } = renderHook(() => useLibraryListing(7, { onDemand: true }));
        await act(async () => result.current.loadMore());
        expect(getLibrary()).not.toHaveBeenCalled();
        getLibrary()
            .mockResolvedValueOnce(previewAnswer())
            .mockImplementation(() => new Promise(() => undefined));
        // The load is not awaited: its background re-check never lands in this case.
        await act(async () => {
            void result.current.load('');
        });
        await waitFor(() =>
            expect(result.current.state).toMatchObject({ status: 'ready', listing: { preview: true } }),
        );
        const reads = getLibrary().mock.calls.length;
        await act(async () => result.current.loadMore());
        expect(getLibrary().mock.calls.length).toBe(reads);
        expect(result.current.loadingMore).toBe(false);
    });
});

describe('re-reading the extent on screen', () => {
    const many = (n: number, prefix = 'p') => Array.from({ length: n }, (_, i) => photo(`${prefix}${i}`));

    test('Refresh re-counts what is on screen: the counted photos, with no batch floor, at most 1000', async () => {
        getLibrary()
            .mockResolvedValueOnce(answer({ photos: many(8) }))
            .mockResolvedValueOnce(answer({ photos: many(8), nextStart: 8, truncated: true }))
            .mockResolvedValueOnce(answer({ photos: many(3), nextStart: 3, truncated: true }))
            .mockResolvedValueOnce(answer({ photos: many(3, 'q'), nextStart: 3, truncated: true }))
            .mockResolvedValueOnce(answer({ photos: many(1500), nextStart: 1500, truncated: true }))
            .mockResolvedValueOnce(answer({ photos: many(1000, 'r'), nextStart: 1000, truncated: true }));
        const { result } = renderHook(() => useLibraryListing(7, { onDemand: true }));
        await act(async () => result.current.load(''));
        await act(async () => {
            result.current.refresh();
        });
        // Eight counted photos: that many — the number the handler/mock slice on.
        expect(getLibrary().mock.calls.at(-1)).toEqual([7, undefined, 'fresh', 'submit', 0, 8]);
        await act(async () => result.current.load('pink'));
        await act(async () => {
            result.current.refresh();
        });
        // A search listing of 3: that many too.
        expect(getLibrary().mock.calls.at(-1)).toEqual([7, 'pink', 'fresh', 'submit', 0, 3]);
        await act(async () => result.current.load(''));
        await act(async () => {
            result.current.refresh();
        });
        // 1500 counted: the 1000 cap.
        expect(getLibrary().mock.calls.at(-1)).toEqual([7, undefined, 'fresh', 'submit', 0, 1000]);
    });

    test('past the cap the older picks keep their last known marks', async () => {
        getLibrary()
            .mockResolvedValueOnce(answer({ photos: many(1500), nextStart: 1500, truncated: true }))
            .mockResolvedValueOnce(answer({ photos: many(1000, 'q'), nextStart: 1000, truncated: false }));
        const { result } = renderHook(() => useLibraryListing(7, { onDemand: true }));
        await act(async () => result.current.load(''));
        await act(async () => {
            result.current.refresh();
        });
        await waitFor(() => expect(result.current.revalidating).toBe(false));
        // The re-read counted at most 1000 of the 1500 on screen, and every photo ever listed stays known.
        expect(result.current.known.size).toBe(2500);
        expect([...result.current.known.keys()]).toContain('p0');
        expect([...result.current.known.keys()]).toContain('q999');
    });

    test('Retry re-reads the extent on screen too, and one batch from the error state', async () => {
        getLibrary()
            .mockResolvedValueOnce(answer({ photos: many(250), nextStart: 250, truncated: true }))
            .mockResolvedValueOnce(failure('library-read-failed'));
        const { result } = renderHook(() => useLibraryListing(7, { onDemand: true }));
        await act(async () => result.current.load(''));
        await act(async () => {
            result.current.retry();
        });
        expect(getLibrary().mock.calls.at(-1)).toEqual([7, undefined, 'fresh', 'submit', 0, 250]);
        // That read failed: no listing is on screen, so the next Retry asks for one batch.
        getLibrary().mockResolvedValueOnce(failure('Failed to read your photo library'));
        await act(async () => {
            result.current.retry();
        });
        getLibrary().mockResolvedValueOnce(answer({ photos: many(3) }));
        await act(async () => {
            result.current.retry();
        });
        expect(getLibrary().mock.calls.at(-1)).toEqual([7, undefined, 'fresh', 'submit', 0, 100]);
        await waitFor(() => expect(result.current.state.status).toBe('ready'));
    });

    test('an Order switch re-reads the extent on screen too', async () => {
        getLibrary()
            .mockResolvedValueOnce(answer({ photos: many(250), nextStart: 250, truncated: true }))
            .mockResolvedValueOnce(answer({ photos: many(250), nextStart: 250, truncated: true }));
        const { result } = renderHook(() => useLibraryListing(7, { onDemand: true }));
        await act(async () => result.current.load(''));
        await act(async () => result.current.setOrder('newest'));
        // The re-read starts from the top in the new order, and keeps the 250 on screen, not one batch.
        expect(getLibrary().mock.calls[1]).toEqual([7, undefined, 'fresh', 'submit', 0, 250, 'newest']);
    });

    test('a switch back to Votes reads fresh, past the narrower cached entry', async () => {
        getLibrary()
            // The cached vote-ordered entry: 100 wide, and a Load more never widens it.
            .mockResolvedValueOnce(answer({ photos: many(100), nextStart: 100, truncated: true }))
            .mockResolvedValueOnce(answer({ photos: many(150, 'q'), nextStart: 250, truncated: true }))
            .mockResolvedValueOnce(answer({ photos: many(250, 'q'), nextStart: 250, truncated: true }))
            .mockResolvedValueOnce(answer({ photos: many(250), nextStart: 250, truncated: true }));
        const { result } = renderHook(() => useLibraryListing(7, { onDemand: true }));
        await act(async () => result.current.load(''));
        await act(async () => result.current.loadMore());
        await act(async () => result.current.setOrder('newest'));
        await waitFor(() => expect(ids(result.current.state as never)).toHaveLength(250));
        await act(async () => result.current.setOrder('votes'));
        // A cached request would be answered by the stale 100-wide entry; the read goes out fresh.
        expect(getLibrary().mock.calls[3]).toEqual([7, undefined, 'fresh', 'submit', 0, 250]);
        await waitFor(() => expect(ids(result.current.state as never)).toHaveLength(250));
    });

    test('a listing with known marks counts only the allowed photos, not every one listed', async () => {
        const mixed = (allowed: number, refused = 0) => [
            ...Array.from({ length: allowed }, (_, i) => photo(`a${i}`)),
            ...Array.from({ length: refused }, (_, i) => photo(`r${i}`, { allowed: false })),
        ];
        getLibrary()
            .mockResolvedValueOnce(answer({ photos: mixed(100, 4), nextStart: 104, truncated: true }))
            .mockResolvedValueOnce(answer({ photos: mixed(1) }))
            .mockResolvedValueOnce(answer({ photos: mixed(120, 30), nextStart: 150, truncated: true }))
            .mockResolvedValueOnce(answer({ photos: mixed(1) }));
        const { result } = renderHook(() => useLibraryListing(7, { onDemand: true }));
        await act(async () => result.current.load(''));
        await act(async () => {
            result.current.refresh();
        });
        // 100 allowed of the 104 on screen: the counted photos, not the 104 listed.
        expect(getLibrary().mock.calls.at(-1)).toEqual([7, undefined, 'fresh', 'submit', 0, 100]);
        await act(async () => result.current.load(''));
        await act(async () => {
            result.current.refresh();
        });
        // 120 allowed of the 150 on screen: that many, not the 150 listed.
        expect(getLibrary().mock.calls.at(-1)).toEqual([7, undefined, 'fresh', 'submit', 0, 120]);
    });

    test('a listing with unknown marks counts every photo on screen', async () => {
        const unmarked = [
            ...Array.from({ length: 50 }, (_, i) => photo(`a${i}`)),
            ...Array.from({ length: 80 }, (_, i) => photo(`r${i}`, { allowed: false })),
        ];
        getLibrary()
            .mockResolvedValueOnce(answer({ photos: unmarked, nextStart: 130, truncated: true, allowedKnown: false }))
            .mockResolvedValueOnce(answer({ photos: [photo('a')] }));
        const { result } = renderHook(() => useLibraryListing(7, { onDemand: true }));
        await act(async () => result.current.load(''));
        await act(async () => {
            result.current.refresh();
        });
        // Without the marks, all 130 count — not the 50 allowed.
        expect(getLibrary().mock.calls.at(-1)).toEqual([7, undefined, 'fresh', 'submit', 0, 130]);
    });

    test('the re-check of a borrowed preview reads one batch, not the preview’s extent', async () => {
        getLibrary()
            .mockResolvedValueOnce(previewAnswer({ photos: many(130) }))
            .mockResolvedValueOnce(answer({ photos: many(100), nextStart: 100, truncated: true }));
        const { result } = renderHook(() => useLibraryListing(7, { onDemand: true }));
        await act(async () => result.current.load(''));
        await waitFor(() => expect(result.current.revalidating).toBe(false));
        // The 130 unmarked photos on screen would count 130; with a challenge the borrowed preview is
        // never shown, so its re-check reads exactly one batch instead.
        expect(getLibrary().mock.calls).toEqual([
            [7, undefined, 'cached', 'submit', 0, 100],
            [7, undefined, 'fresh', 'submit', 0, 100],
        ]);
    });

    test('without a challenge the re-check still re-reads the preview’s extent, not one batch', async () => {
        getLibrary()
            .mockResolvedValueOnce(previewAnswer({ photos: many(8) }))
            .mockResolvedValueOnce(answer({ photos: many(8), nextStart: 8, truncated: true }));
        const { result } = renderHook(() => useLibraryListing(null, { onDemand: true }));
        await act(async () => result.current.load(''));
        await waitFor(() => expect(result.current.revalidating).toBe(false));
        // The cached read keeps `load`'s batch; the re-check counts the preview's 8 photos (marks unknown).
        expect(getLibrary().mock.calls).toEqual([
            [null, undefined, 'cached', 'submit', 0, 100],
            [null, undefined, 'fresh', 'submit', 0, 8],
        ]);
    });
});

describe('isSearch', () => {
    test('a ready search listing is a search; loadMore keeps it, load("") clears it', async () => {
        getLibrary()
            .mockResolvedValueOnce(answer({ nextStart: 1, truncated: true }))
            .mockResolvedValueOnce(answer({ photos: [photo('b')] }))
            .mockResolvedValue(answer());
        const { result } = renderHook(() => useLibraryListing(7, { onDemand: true }));
        expect(result.current.isSearch).toBe(false);
        await act(async () => result.current.load('hat'));
        expect(result.current.state.status).toBe('ready');
        expect(result.current.isSearch).toBe(true);
        await act(async () => result.current.loadMore());
        // Still the search listing: the appended batch is not a new read.
        expect(result.current.isSearch).toBe(true);
        await act(async () => result.current.load(''));
        expect(result.current.isSearch).toBe(false);
    });

    test('a Refresh of the search keeps it; a failed read (the error state) is not a search', async () => {
        getLibrary()
            .mockResolvedValueOnce(answer())
            .mockResolvedValueOnce(failure('superseded'))
            .mockResolvedValueOnce(failure('Failed to read your photo library'));
        const { result } = renderHook(() => useLibraryListing(7, { onDemand: true }));
        await act(async () => result.current.load('hat'));
        expect(result.current.isSearch).toBe(true);
        // The refresh re-reads the same term: still a search listing, even when it failed and
        // the listing stays on screen.
        await act(async () => {
            result.current.refresh();
        });
        await waitFor(() => expect(result.current.recheckFailed).toBe(true));
        expect(result.current.isSearch).toBe(true);
        // A search whose read fails leaves the error state: not a search listing.
        await act(async () => result.current.load('dog'));
        await waitFor(() => expect(result.current.state.status).toBe('error'));
        expect(result.current.isSearch).toBe(false);
    });
});

describe('the request id', () => {
    test('a load is a new request; its re-check and an appended batch are not; another load is', async () => {
        getLibrary()
            .mockResolvedValueOnce(previewAnswer())
            .mockResolvedValueOnce(answer({ memberId: null, photos: [photo('a')], nextStart: 1, truncated: true }))
            .mockResolvedValueOnce(answer({ memberId: null, photos: [photo('b')], nextStart: 2, truncated: false }))
            .mockResolvedValueOnce(answer({ memberId: null, photos: [photo('c')] }));
        const { result } = renderHook(() => useLibraryListing(7, { onDemand: true }));
        expect(result.current.requestId).toBe(0);
        await act(async () => result.current.load(''));
        // The preview and the fresh re-check behind it are one request; the batch read is the same too.
        await waitFor(() => expect(result.current.revalidating).toBe(false));
        expect(result.current.requestId).toBe(1);
        await act(async () => result.current.loadMore());
        expect(result.current.requestId).toBe(1);
        await act(async () => result.current.load('pink'));
        expect(result.current.requestId).toBe(2);
    });
});

describe('the order', () => {
    test('the default is votes, which travels as no argument, and the listing carries it', async () => {
        getLibrary().mockResolvedValue(answer());
        const { result } = renderHook(() => useLibraryListing(7, { onDemand: true }));
        expect(result.current.order).toBe('votes');
        await act(async () => result.current.load(''));
        expect(getLibrary().mock.calls[0]).toEqual([7, undefined, 'cached', 'submit', 0, 100]);
        expect(result.current.state).toMatchObject({ status: 'ready', order: 'votes' });
    });

    test('when idle a change only arms the next read, which carries the order as the 7th argument', async () => {
        getLibrary().mockResolvedValue(answer());
        const { result } = renderHook(() => useLibraryListing(7, { onDemand: true }));
        await act(async () => result.current.setOrder('newest'));
        expect(result.current.order).toBe('newest');
        expect(getLibrary()).not.toHaveBeenCalled();
        await act(async () => result.current.load(''));
        // The handler walks a cached request with a non-votes order fresh; the renderer just names the order.
        expect(getLibrary().mock.calls[0]).toEqual([7, undefined, 'cached', 'submit', 0, 100, 'newest']);
        expect(result.current.state).toMatchObject({ status: 'ready', order: 'newest' });
    });

    test('while a listing is shown a change re-reads the term on screen from the top in that order', async () => {
        getLibrary()
            .mockResolvedValueOnce(answer({ photos: [photo('a')], nextStart: 1, truncated: true }))
            .mockResolvedValueOnce(answer({ photos: [photo('n')], nextStart: 1, truncated: true }));
        const { result } = renderHook(() => useLibraryListing(7, { onDemand: true }));
        await act(async () => result.current.load(''));
        expect(result.current.state).toMatchObject({ status: 'ready', order: 'votes' });
        await act(async () => result.current.setOrder('oldest'));
        // One photo on screen: the re-read keeps that extent.
        expect(getLibrary().mock.calls[1]).toEqual([7, undefined, 'fresh', 'submit', 0, 1, 'oldest']);
        expect(result.current.state).toMatchObject({ status: 'loading' });
        await waitFor(() => expect(ids(result.current.state as never)).toEqual(['n']));
        expect(result.current.state).toMatchObject({ order: 'oldest' });
        // A Load more of the new listing continues in it.
        getLibrary().mockResolvedValueOnce(
            answer({ photos: [photo('n'), photo('m')], nextStart: 2, truncated: false }),
        );
        await act(async () => result.current.loadMore());
        expect(getLibrary().mock.calls[2]).toEqual([7, undefined, 'fresh', 'submit', 1, 100, 'oldest']);
    });

    test('a change during the first read drops the older answer and re-reads from the top', async () => {
        const pending = deferred();
        getLibrary()
            .mockReturnValueOnce(pending.promise)
            .mockResolvedValueOnce(answer({ photos: [photo('newest')] }));
        const { result } = renderHook(() => useLibraryListing(7, { onDemand: true }));
        await act(async () => {
            void result.current.load('pink');
        });
        expect(getLibrary().mock.calls[0]).toEqual([7, 'pink', 'fresh', 'submit', 0, 100]);
        await act(async () => result.current.setOrder('newest'));
        expect(getLibrary().mock.calls[1]).toEqual([7, 'pink', 'fresh', 'submit', 0, 100, 'newest']);
        await waitFor(() => expect(ids(result.current.state as never)).toEqual(['newest']));
        // The vote-ordered answer of the read the change superseded never lands.
        await act(async () => pending.resolve(answer({ photos: [photo('votes')] })));
        await act(async () => undefined);
        expect(ids(result.current.state as never)).toEqual(['newest']);
    });

    test('a change during a Load more drops the batch and re-reads from the top', async () => {
        const more = deferred();
        getLibrary()
            .mockResolvedValueOnce(answer({ photos: [photo('a')], nextStart: 1, truncated: true }))
            .mockReturnValueOnce(more.promise)
            .mockResolvedValueOnce(answer({ photos: [photo('top')] }));
        const { result } = renderHook(() => useLibraryListing(7, { onDemand: true }));
        await act(async () => result.current.load(''));
        await act(async () => {
            void result.current.loadMore();
        });
        expect(result.current.loadingMore).toBe(true);
        await act(async () => result.current.setOrder('oldest'));
        await waitFor(() => expect(ids(result.current.state as never)).toEqual(['top']));
        expect(result.current.loadingMore).toBe(false);
        await act(async () => more.resolve(answer({ photos: [photo('late')], nextStart: 2, truncated: false })));
        await act(async () => undefined);
        expect(ids(result.current.state as never)).toEqual(['top']);
        expect(result.current.loadMoreFailed).toBeNull();
    });

    test('Refresh and Retry read in the order on screen', async () => {
        getLibrary().mockResolvedValue(answer());
        const { result } = renderHook(() => useLibraryListing(7, { onDemand: true }));
        await act(async () => result.current.load(''));
        await act(async () => result.current.setOrder('oldest'));
        await waitFor(() => expect(result.current.state.status).toBe('ready'));
        await act(async () => {
            result.current.refresh();
        });
        expect(getLibrary().mock.calls.at(-1)).toEqual([7, undefined, 'fresh', 'submit', 0, 1, 'oldest']);
        await waitFor(() => expect(result.current.revalidating).toBe(false));
        await act(async () => {
            result.current.retry();
        });
        expect(getLibrary().mock.calls.at(-1)).toEqual([7, undefined, 'fresh', 'submit', 0, 1, 'oldest']);
    });
    test('a change in the error state only arms the next read; Retry carries the order', async () => {
        getLibrary().mockResolvedValueOnce(failure('flaky')).mockResolvedValueOnce(answer());
        const { result } = renderHook(() => useLibraryListing(7, { onDemand: true }));
        await act(async () => result.current.load(''));
        expect(result.current.state).toMatchObject({ status: 'error' });
        await act(async () => result.current.setOrder('newest'));
        // No listing is on screen, so the change arms the next read instead of starting one.
        expect(getLibrary()).toHaveBeenCalledTimes(1);
        act(() => {
            result.current.retry();
        });
        expect(getLibrary().mock.calls[1]).toEqual([7, undefined, 'fresh', 'submit', 0, 100, 'newest']);
        await waitFor(() => expect(result.current.state).toMatchObject({ status: 'ready', order: 'newest' }));
    });

    test('a ready listing given the order it already holds reads nothing and stays ready', async () => {
        getLibrary().mockResolvedValue(answer());
        const { result } = renderHook(() => useLibraryListing(7, { onDemand: true }));
        await act(async () => result.current.load(''));
        expect(result.current.state).toMatchObject({ status: 'ready', order: 'votes' });
        await act(async () => result.current.setOrder('votes'));
        // The same value re-chosen: no fresh re-read goes out, so no loading flash.
        expect(getLibrary()).toHaveBeenCalledTimes(1);
        expect(result.current.state).toMatchObject({ status: 'ready', order: 'votes' });
    });

    test('the order it already holds re-chosen while the first read is in flight leaves that read alone', async () => {
        const pending = deferred();
        getLibrary().mockReturnValueOnce(pending.promise);
        const { result } = renderHook(() => useLibraryListing(7, { onDemand: true }));
        await act(async () => {
            void result.current.load('pink');
        });
        expect(getLibrary().mock.calls[0]).toEqual([7, 'pink', 'fresh', 'submit', 0, 100]);
        expect(result.current.state).toMatchObject({ status: 'loading' });
        await act(async () => result.current.setOrder('votes'));
        // No second read goes out and the in-flight request is not superseded: its answer still lands.
        expect(getLibrary()).toHaveBeenCalledTimes(1);
        await act(async () => pending.resolve(answer({ photos: [photo('a')] })));
        await act(async () => undefined);
        expect(result.current.state).toMatchObject({ status: 'ready', order: 'votes' });
        expect(ids(result.current.state as never)).toEqual(['a']);
        expect(getLibrary()).toHaveBeenCalledTimes(1);
    });
});
