/**
 * useSavedListReread — the chooser's re-read of a saved list that came without its ids, at the hook
 * level: it asks once per attempt, a re-render with the same function never asks again, and only
 * Retry does.
 */

import { act, renderHook, waitFor } from '@testing-library/preact';
import { useLibraryListing, useSavedListReread } from '@/hooks/usePhotoChooser';
import { mockApi } from './helpers/setup';

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
    const onMember = jest.fn();
    const retryListing = jest.fn();
    const confirmAccount = jest.fn<Promise<string | null>, []>().mockResolvedValue(OWNER);
    const hook = renderHook(
        (props: { reloadSaved: () => Promise<string[] | null>; state: ListState }) =>
            useSavedListReread({
                withheld: true,
                owner: OWNER,
                onRead,
                onMember,
                retryListing,
                confirmAccount,
                ...props,
            }),
        { initialProps: { reloadSaved, state } },
    );
    return { ...hook, onRead, onMember, retryListing, confirmAccount };
};

test('a failed read is not repeated by re-renders with the same function; Retry asks again', async () => {
    const reloadSaved = jest
        .fn<Promise<string[] | null>, []>()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(['a']);
    const listing = ready(OWNER);
    const { result, rerender, onRead, retryListing } = render(reloadSaved, listing);
    await waitFor(() => expect(result.current.status).toBe('unconfirmed'));
    // The same listing and the same function: re-rendering never asks again.
    rerender({ reloadSaved, state: listing });
    rerender({ reloadSaved, state: listing });
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

test('a listing that cannot say who is signed in is retried by checking the account, not the listing or the read', async () => {
    const reloadSaved = jest.fn<Promise<string[] | null>, []>();
    const { result, retryListing, confirmAccount, onMember } = render(reloadSaved, ready(null));
    expect(result.current.status).toBe('unconfirmed');
    act(() => result.current.retry());
    expect(result.current.busy).toBe(true);
    await waitFor(() => expect(onMember).toHaveBeenCalledWith(OWNER));
    expect(result.current.busy).toBe(false);
    expect(confirmAccount).toHaveBeenCalledTimes(1);
    expect(retryListing).not.toHaveBeenCalled();
    expect(reloadSaved).not.toHaveBeenCalled();
});

test.each([
    ['gives no member', () => Promise.resolve(null)],
    ['rejects', () => Promise.reject(new Error('down'))],
])('a check that %s ends in checkFailed, still unconfirmed, and can be pressed again', async (_name, answer) => {
    const { result, confirmAccount, onMember } = render(jest.fn(), ready(null));
    confirmAccount.mockImplementationOnce(answer);
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.checkFailed).toBe(true));
    expect(result.current.status).toBe('unconfirmed');
    expect(result.current.busy).toBe(false);
    expect(onMember).not.toHaveBeenCalled();
    // The next press clears the failure while it runs.
    act(() => result.current.retry());
    expect(result.current.checkFailed).toBe(false);
    await waitFor(() => expect(onMember).toHaveBeenCalledWith(OWNER));
});

test('a press while a retry is running does nothing', async () => {
    const { result, confirmAccount } = render(jest.fn(), ready(null));
    act(() => result.current.retry());
    act(() => result.current.retry());
    expect(confirmAccount).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(result.current.busy).toBe(false));
});

test('a listing that names a member while the owner is not loaded yet is retried through the listing', () => {
    const retryListing = jest.fn();
    const confirmAccount = jest.fn<Promise<string | null>, []>();
    const { result } = renderHook(() =>
        useSavedListReread({
            withheld: true,
            owner: '',
            state: ready(OWNER),
            reloadSaved: jest.fn(),
            confirmAccount,
            retryListing,
            onMember: jest.fn(),
            onRead: jest.fn(),
        }),
    );
    expect(result.current.status).toBe('unconfirmed');
    act(() => result.current.retry());
    expect(retryListing).toHaveBeenCalledTimes(1);
    expect(confirmAccount).not.toHaveBeenCalled();
    expect(result.current.busy).toBe(false);
});

test('with no way to read the list, a ready listing of the owner is unconfirmed too', () => {
    const onRead = jest.fn();
    const { result } = renderHook(() =>
        useSavedListReread({
            withheld: true,
            owner: OWNER,
            state: ready(OWNER),
            confirmAccount: jest.fn(),
            retryListing: jest.fn(),
            onMember: jest.fn(),
            onRead,
        }),
    );
    expect(result.current.status).toBe('unconfirmed');
});

describe('useLibraryListing.setMember — a member the listing could not name, found by a later check', () => {
    const listingOf = (memberId: string | null) =>
        invalid<Promise<Listing>>({ success: true, photos: [], memberId, truncated: false, allowedKnown: true });

    test('goes into the listing on screen, without reading the library again', async () => {
        mockApi.getLibraryPhotos.mockReset().mockResolvedValue(listingOf(null));
        const { result } = renderHook(() => useLibraryListing(7));
        await waitFor(() => expect(result.current.state.status).toBe('ready'));
        act(() => result.current.setMember(OWNER));
        const { state } = result.current;
        expect(state.status === 'ready' && state.listing.memberId).toBe(OWNER);
        expect(mockApi.getLibraryPhotos).toHaveBeenCalledTimes(1);
    });

    test('while there is no ready listing it changes nothing', async () => {
        mockApi.getLibraryPhotos.mockReset().mockReturnValue(new Promise(() => undefined));
        const { result } = renderHook(() => useLibraryListing(7));
        act(() => result.current.setMember(OWNER));
        expect(result.current.state.status).toBe('loading');
    });
});
