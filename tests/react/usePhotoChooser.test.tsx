/**
 * useSavedListReread — the chooser's re-read of a saved list that came without its ids, at the hook
 * level: it asks once per attempt, a re-render with the same function never asks again, and only
 * Retry does.
 */

import { act, renderHook, waitFor } from '@testing-library/preact';
import { useSavedListReread } from '@/hooks/usePhotoChooser';

import type { ListState } from '@/hooks/usePhotoChooser';
import type { WindowApi } from '../../src/ts/types/ipc';
import { invalid } from '../helpers/invalid';

const OWNER = 'c'.repeat(32);
type Listing = Extract<Awaited<ReturnType<WindowApi['getLibraryPhotos']>>, { success: true }>;
const ready = (memberId: string | null): ListState => ({
    status: 'ready',
    listing: invalid<Listing>({ success: true, photos: [], memberId, truncated: false, allowedKnown: true }),
});

const render = (reloadSaved: () => Promise<string[] | null>, state: ListState = ready(OWNER)) => {
    const onRead = jest.fn();
    const retryListing = jest.fn();
    const hook = renderHook(
        (props: { reloadSaved: () => Promise<string[] | null>; state: ListState }) =>
            useSavedListReread({ withheld: true, owner: OWNER, onRead, retryListing, ...props }),
        { initialProps: { reloadSaved, state } },
    );
    return { ...hook, onRead, retryListing };
};

test('a failed read is not repeated by re-renders with the same function; Retry asks again', async () => {
    const reloadSaved = jest
        .fn<Promise<string[] | null>, []>()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(['a']);
    const { result, rerender, onRead, retryListing } = render(reloadSaved);
    await waitFor(() => expect(result.current.status).toBe('unconfirmed'));
    rerender({ reloadSaved, state: ready(OWNER) });
    rerender({ reloadSaved, state: ready(OWNER) });
    expect(reloadSaved).toHaveBeenCalledTimes(1);

    act(() => result.current.retry());
    await waitFor(() => expect(result.current.status).toBe('ok'));
    expect(reloadSaved).toHaveBeenCalledTimes(2);
    expect(onRead).toHaveBeenCalledWith(['a']);
    // The read was retried, not the listing.
    expect(retryListing).not.toHaveBeenCalled();
});

test('a rejecting read ends in the retryable state instead of staying pending forever', async () => {
    const reloadSaved = jest.fn<Promise<string[] | null>, []>().mockRejectedValueOnce(new Error('down'));
    const { result } = render(reloadSaved);
    await waitFor(() => expect(result.current.status).toBe('unconfirmed'));
});

test('a listing that cannot say who is signed in is retried through the listing, not the read', async () => {
    const reloadSaved = jest.fn<Promise<string[] | null>, []>();
    const { result, retryListing } = render(reloadSaved, ready(null));
    expect(result.current.status).toBe('unconfirmed');
    act(() => result.current.retry());
    expect(retryListing).toHaveBeenCalledTimes(1);
    expect(reloadSaved).not.toHaveBeenCalled();
});

test('with no way to read the list, a ready listing of the owner is unconfirmed too', () => {
    const onRead = jest.fn();
    const { result } = renderHook(() =>
        useSavedListReread({ withheld: true, owner: OWNER, state: ready(OWNER), retryListing: jest.fn(), onRead }),
    );
    expect(result.current.status).toBe('unconfirmed');
});
