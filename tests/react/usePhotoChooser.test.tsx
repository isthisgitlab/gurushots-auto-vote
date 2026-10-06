/**
 * useSavedListReread — the chooser's re-read of a saved list that came without its ids, at the hook
 * level: it asks once per attempt, a re-render with the same function never asks again, and only
 * Retry does.
 */

import { act, renderHook, waitFor } from '@testing-library/preact';
import { useLibraryListing, useSavedListReread } from '@/hooks/usePhotoChooser';
import { mockApi } from './helpers/setup';

import type { AccountCheck, ListState } from '@/hooks/usePhotoChooser';
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
    const confirmAccount = jest.fn<Promise<AccountCheck>, []>().mockResolvedValue({ memberId: OWNER });
    const hook = renderHook(
        (props: { reloadSaved: () => Promise<string[] | null>; state: ListState; generation: number }) =>
            useSavedListReread({
                withheld: true,
                owner: OWNER,
                onRead,
                onMember,
                retryListing,
                confirmAccount,
                ...props,
            }),
        { initialProps: { reloadSaved, state, generation: 1 } },
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
    rerender({ reloadSaved, state: listing, generation: 1 });
    rerender({ reloadSaved, state: listing, generation: 1 });
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
    ['says the check failed', () => Promise.resolve<AccountCheck>({ error: 'account-check-failed' })],
    ['rejects', () => Promise.reject(new Error('down'))],
])('a check that %s ends in check-failed, still unconfirmed, and can be pressed again', async (_name, answer) => {
    const { result, confirmAccount, onMember } = render(jest.fn(), ready(null));
    expect(result.current.failure).toBe('unconfirmed');
    confirmAccount.mockImplementationOnce(answer);
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.failure).toBe('check-failed'));
    expect(result.current.status).toBe('unconfirmed');
    expect(result.current.busy).toBe(false);
    expect(onMember).not.toHaveBeenCalled();
    // The next press clears the failure while it runs.
    act(() => result.current.retry());
    expect(result.current.failure).toBe('unconfirmed');
    await waitFor(() => expect(onMember).toHaveBeenCalledWith(OWNER));
});

test('signed out is its own failure', async () => {
    const { result, confirmAccount } = render(jest.fn(), ready(null));
    confirmAccount.mockResolvedValueOnce({ error: 'not-logged-in' });
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.failure).toBe('not-logged-in'));
    expect(result.current.status).toBe('unconfirmed');
});

test('a read that fails is read-failed, a second failure after Retry is read-failed-again, a success clears it', async () => {
    const reloadSaved = jest
        .fn<Promise<string[] | null>, []>()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(['a']);
    const { result } = render(reloadSaved);
    await waitFor(() => expect(result.current.failure).toBe('read-failed'));
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.failure).toBe('read-failed-again'));
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.status).toBe('ok'));
    expect(result.current.failure).toBeNull();
});

test('retrying covers the account check and the read after it; confirmed is true only once a pressed Retry has lifted the hold', async () => {
    const read = Promise.withResolvers<string[] | null>();
    const reloadSaved = jest.fn<Promise<string[] | null>, []>().mockReturnValue(read.promise);
    const { result, rerender, confirmAccount } = render(reloadSaved, ready(null));
    expect(result.current.retrying).toBe(false);
    act(() => result.current.retry());
    expect(result.current.retrying).toBe(true);
    await waitFor(() => expect(confirmAccount).toHaveBeenCalled());
    // The check answered: the listing now names the owner, and the chained read is pending.
    rerender({ reloadSaved, state: ready(OWNER), generation: 1 });
    await waitFor(() => expect(reloadSaved).toHaveBeenCalledTimes(1));
    expect(result.current.busy).toBe(false);
    expect(result.current.retrying).toBe(true);
    expect(result.current.confirmed).toBe(false);
    await act(async () => read.resolve(['a']));
    expect(result.current.status).toBe('ok');
    expect(result.current.retrying).toBe(false);
    expect(result.current.confirmed).toBe(true);
});

test('a read nobody pressed Retry for is not "retrying" and is never "confirmed"', async () => {
    const read = Promise.withResolvers<string[] | null>();
    const { result } = render(jest.fn().mockReturnValue(read.promise));
    expect(result.current.checking).toBe(true);
    expect(result.current.retrying).toBe(false);
    await act(async () => read.resolve(['a']));
    expect(result.current.status).toBe('ok');
    expect(result.current.confirmed).toBe(false);
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
    const confirmAccount = jest.fn<Promise<AccountCheck>, []>();
    const { result } = renderHook(() =>
        useSavedListReread({
            withheld: true,
            owner: '',
            state: ready(OWNER),
            generation: 1,
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
            generation: 1,
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

describe('what a Retry did belongs to the listing generation it was pressed on', () => {
    const next = { generation: 2 };

    test('confirmed is tied to the press that produced it: a Retry that failed, then a search whose read succeeds, is not "confirmed"', async () => {
        const reloadSaved = jest
            .fn<Promise<string[] | null>, []>()
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(['a']);
        const { result, rerender } = render(reloadSaved);
        await waitFor(() => expect(result.current.failure).toBe('read-failed'));
        act(() => result.current.retry());
        await waitFor(() => expect(result.current.failure).toBe('read-failed-again'));

        // A new search: its automatic read succeeds, and nothing is announced.
        rerender({ reloadSaved, state: ready(OWNER), ...next });
        await waitFor(() => expect(result.current.status).toBe('ok'));
        expect(result.current.confirmed).toBe(false);
    });

    test('a confirmed Retry stays confirmed on its own listing and not on the next', async () => {
        const reloadSaved = jest
            .fn<Promise<string[] | null>, []>()
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(['a']);
        const { result, rerender } = render(reloadSaved);
        await waitFor(() => expect(result.current.failure).toBe('read-failed'));
        act(() => result.current.retry());
        await waitFor(() => expect(result.current.confirmed).toBe(true));
        rerender({ reloadSaved, state: ready(OWNER), ...next });
        expect(result.current.confirmed).toBe(false);
    });

    test('an old check failure never labels a later failure on a new listing: a failed read is a read failure', async () => {
        const reloadSaved = jest.fn<Promise<string[] | null>, []>().mockResolvedValue(null);
        const { result, rerender, confirmAccount } = render(reloadSaved, ready(null));
        confirmAccount.mockResolvedValueOnce({ error: 'account-check-failed' });
        act(() => result.current.retry());
        await waitFor(() => expect(result.current.failure).toBe('check-failed'));

        // A new listing that names the owner, whose read fails.
        rerender({ reloadSaved, state: ready(OWNER), ...next });
        await waitFor(() => expect(result.current.failure).toBe('read-failed'));
    });

    test('"failed again" does not carry over to a new listing', async () => {
        const reloadSaved = jest.fn<Promise<string[] | null>, []>().mockResolvedValue(null);
        const { result, rerender } = render(reloadSaved);
        await waitFor(() => expect(result.current.failure).toBe('read-failed'));
        act(() => result.current.retry());
        await waitFor(() => expect(result.current.failure).toBe('read-failed-again'));

        rerender({ reloadSaved, state: ready(OWNER), ...next });
        await waitFor(() => expect(result.current.failure).toBe('read-failed'));
    });

    test('a check failure on one listing is not shown on the next while the member is still unknown', async () => {
        const { result, rerender, confirmAccount } = render(jest.fn(), ready(null));
        confirmAccount.mockResolvedValueOnce({ error: 'not-logged-in' });
        act(() => result.current.retry());
        await waitFor(() => expect(result.current.failure).toBe('not-logged-in'));
        rerender({ reloadSaved: jest.fn(), state: ready(null), ...next });
        expect(result.current.failure).toBe('unconfirmed');
    });
});
