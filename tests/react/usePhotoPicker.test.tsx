/**
 * usePhotoPicker at the hook level: the one invariant no component can reach — Auto never ranks,
 * whatever asks it to, without a challenge to rank for. The other Auto gate (a Discover row's
 * not-joined challenge) lives in the toolbar, tested at the component level in
 * PhotoChooserModal.test.tsx. The listing side is pass-through wiring: loadPhotos, loadMore and
 * the shown counter are the listing hook's own, exposed as they are.
 */

import { act, renderHook, waitFor } from '@testing-library/preact';
import { usePhotoPicker } from '@/hooks/usePhotoPicker';
import { mockApi } from './helpers/setup';

import type { WindowApi } from '../../src/ts/types/ipc';

type Listing = Extract<Awaited<ReturnType<WindowApi['getLibraryPhotos']>>, { success: true }>;
type Answer = Awaited<ReturnType<WindowApi['getLibraryPhotos']>>;

const photo = (id: string) => ({ id, labels: [`tag-${id}`], allowed: true, message: null, uploadDate: 1 });
const answer = (ids: string[], over: Partial<Listing> = {}): Listing => ({
    success: true,
    photos: ids.map(photo),
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
const failure = (error: string): Answer => ({ success: false, error });

const listingOf = (state: { status: string; listing?: Listing }) => (state.status === 'ready' ? state.listing : null);

test('a ranking asked for with no challenge to rank for is refused at the door', async () => {
    const { result } = renderHook(() =>
        usePhotoPicker({ challengeId: null, usage: 'submit', alwaysFresh: false, selected: [] }),
    );
    await act(async () => result.current.autoSuggest());
    expect(mockApi.suggestPhotos).not.toHaveBeenCalled();
    expect(result.current.suggested).toBeNull();
});

describe('the listing side, passed through', () => {
    beforeEach(() => {
        mockApi.getLibraryPhotos.mockReset();
    });

    test('loadPhotos reads one batch and marks the read as its own; shown counts the listing', async () => {
        mockApi.getLibraryPhotos.mockResolvedValueOnce(answer(['a'], { nextStart: 1, truncated: true }));
        const { result } = renderHook(() =>
            usePhotoPicker({ challengeId: 7, usage: 'submit', alwaysFresh: false, selected: [] }),
        );
        expect(result.current.shown).toBe(0);
        await act(async () => {
            result.current.loadPhotos();
        });
        expect(mockApi.getLibraryPhotos).toHaveBeenCalledWith(7, undefined, 'cached', 'submit', 0, 100);
        expect(result.current.loadPhotosReading).toBe(true);
        await waitFor(() => expect(result.current.state.status).toBe('ready'));
        expect(listingOf(result.current.state)?.photos.map((p) => p.id)).toEqual(['a']);
        expect(result.current.shown).toBe(1);
    });

    test('loadMore appends the next batch and clears; a failure lands in loadMoreFailed', async () => {
        mockApi.getLibraryPhotos
            .mockResolvedValueOnce(answer(['a'], { nextStart: 1, truncated: true }))
            .mockResolvedValueOnce(answer(['a', 'b'], { nextStart: 2, truncated: false }))
            .mockResolvedValueOnce(failure('superseded'));
        const { result } = renderHook(() =>
            usePhotoPicker({ challengeId: 7, usage: 'submit', alwaysFresh: false, selected: [] }),
        );
        await act(async () => {
            result.current.loadPhotos();
        });
        await waitFor(() => expect(result.current.state.status).toBe('ready'));
        await act(async () => result.current.loadMore());
        await waitFor(() => expect(listingOf(result.current.state)?.photos.map((p) => p.id)).toEqual(['a', 'b']));
        expect(mockApi.getLibraryPhotos).toHaveBeenLastCalledWith(7, undefined, 'fresh', 'submit', 1, 100);
        expect(result.current.loadingMore).toBe(false);
        expect(result.current.loadMoreFailed).toBeNull();
        expect(result.current.shown).toBe(1);
        await act(async () => result.current.loadMore());
        expect(result.current.loadMoreFailed).toBe('superseded');
        expect(listingOf(result.current.state)?.photos.map((p) => p.id)).toEqual(['a', 'b']);
    });

    test('search reads the term and stops showing Load photos as the read on screen', async () => {
        mockApi.getLibraryPhotos.mockResolvedValue(answer(['a']));
        const { result } = renderHook(() =>
            usePhotoPicker({ challengeId: 7, usage: 'submit', alwaysFresh: false, selected: [] }),
        );
        await act(async () => {
            result.current.loadPhotos();
        });
        await waitFor(() => expect(result.current.state.status).toBe('ready'));
        expect(result.current.loadPhotosReading).toBe(true);
        await act(async () => result.current.search('pink'));
        await waitFor(() => expect(result.current.shown).toBe(2));
        expect(mockApi.getLibraryPhotos).toHaveBeenLastCalledWith(7, 'pink', 'fresh', 'submit', 0, 100);
        expect(result.current.loadPhotosReading).toBe(false);
    });

    test('isSearch passes through: a search on screen is one, Load photos and an error are not', async () => {
        mockApi.getLibraryPhotos
            .mockResolvedValueOnce(answer(['a']))
            .mockResolvedValueOnce(answer(['a']))
            .mockResolvedValueOnce(failure('Failed to read your photo library'));
        const { result } = renderHook(() =>
            usePhotoPicker({ challengeId: 7, usage: 'submit', alwaysFresh: false, selected: [] }),
        );
        await act(async () => {
            result.current.loadPhotos();
        });
        await waitFor(() => expect(result.current.state.status).toBe('ready'));
        expect(result.current.isSearch).toBe(false);
        await act(async () => result.current.search('hat'));
        await waitFor(() => expect(result.current.shown).toBe(2));
        expect(result.current.isSearch).toBe(true);
        // A search whose read fails leaves the error state: not a search listing.
        await act(async () => result.current.search('dog'));
        await waitFor(() => expect(result.current.state.status).toBe('error'));
        expect(result.current.isSearch).toBe(false);
    });
});
