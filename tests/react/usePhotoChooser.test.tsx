/**
 * useSavedListReread — the chooser's member check and the re-read of a saved list that came without
 * its ids, at the hook level: the member is asked for once on open when a list is on record, the
 * read asks once per attempt, a re-render with the same function never asks again, and only Retry
 * does.
 */

import { act, renderHook, waitFor } from '@testing-library/preact';
import { useSavedListReread } from '@/hooks/usePhotoChooser';
import { useLibraryListing } from '@/hooks/useLibraryListing';
import { rememberCurrentMember } from '@/api/useChosenPhotosOwner';
import { mockApi } from './helpers/setup';

import type { AccountCheck } from '@/hooks/usePhotoChooser';
import type { ListState } from '@/hooks/useLibraryListing';
import type { WindowApi } from '../../src/ts/types/ipc';
import { invalid } from '../helpers/invalid';

const OWNER = 'c'.repeat(32);
type Listing = Extract<Awaited<ReturnType<WindowApi['getLibraryPhotos']>>, { success: true }>;
const ready = (memberId: string | null): ListState => ({
    status: 'ready',
    listing: invalid<Listing>({
        success: true,
        photos: [],
        memberId,
        truncated: false,
        wonIds: [],
        wonCount: 0,
        preview: false,
        readAtMs: 1_700_000_000_000,
        allowedKnown: true,
    }),
});
const idle: ListState = { status: 'idle' };

const render = (
    reloadSaved: () => Promise<string[] | null>,
    memberId: string | null = OWNER,
    state: ListState = ready(memberId ?? OWNER),
    owner = OWNER,
    // The chooser asks for the member on open whenever a list is on record, so that is the default.
    checkOnOpen = true,
    confirmImpl: () => Promise<AccountCheck> = () => Promise.resolve({ memberId: OWNER }),
) => {
    const onRead = jest.fn();
    const onMember = jest.fn();
    const retryListing = jest.fn();
    const confirmAccount = jest.fn<Promise<AccountCheck>, []>().mockImplementation(confirmImpl);
    const hook = renderHook(
        (props: {
            reloadSaved: () => Promise<string[] | null>;
            memberId: string | null;
            state: ListState;
            generation: number;
        }) =>
            useSavedListReread({
                withheld: true,
                owner,
                ownerKnown: true,
                ownerFailed: false,
                onRead,
                onMember,
                retryListing,
                confirmAccount,
                checkOnOpen,
                ...props,
            }),
        { initialProps: { reloadSaved, memberId, state, generation: 1 } },
    );
    return { ...hook, onRead, onMember, retryListing, confirmAccount };
};

describe('the member check on open', () => {
    test('asks once, without a press, while no member is known; its answer goes to onMember', async () => {
        const { result, confirmAccount, onMember } = render(jest.fn(), null, idle, OWNER, true);
        expect(result.current.busy).toBe(true);
        await waitFor(() => expect(onMember).toHaveBeenCalledWith(OWNER));
        expect(result.current.busy).toBe(false);
        expect(confirmAccount).toHaveBeenCalledTimes(1);
        // A re-render (the owner landing late, say) never asks a second time.
        await act(async () => undefined);
        expect(confirmAccount).toHaveBeenCalledTimes(1);
    });

    test('is not asked when a member is already known', () => {
        const { confirmAccount } = render(
            jest.fn(async () => ['a']),
            OWNER,
            ready(OWNER),
            OWNER,
            true,
        );
        expect(confirmAccount).not.toHaveBeenCalled();
    });
});

test('a failed read is not repeated by re-renders with the same function; Retry asks again', async () => {
    const reloadSaved = jest
        .fn<Promise<string[] | null>, []>()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(['a']);
    const listing = ready(OWNER);
    const { result, rerender, onRead, retryListing } = render(reloadSaved, OWNER, listing);
    await waitFor(() => expect(result.current.status).toBe('unconfirmed'));
    // The same listing and the same function: re-rendering never asks again.
    rerender({ reloadSaved, memberId: OWNER, state: listing, generation: 1 });
    rerender({ reloadSaved, memberId: OWNER, state: listing, generation: 1 });
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

test('a failed open-time check is not dropped by a listing read that names no member', async () => {
    const confirmAccount = jest
        .fn<Promise<AccountCheck>, []>()
        .mockResolvedValueOnce({ error: 'account-check-failed' })
        .mockResolvedValue({ memberId: OWNER });
    const onRead = jest.fn();
    const onMember = jest.fn();
    const hook = renderHook(
        (props: { state: ListState; generation: number }) =>
            useSavedListReread({
                withheld: true,
                owner: OWNER,
                ownerKnown: true,
                ownerFailed: false,
                memberId: null,
                reloadSaved: jest.fn(async () => ['a']),
                confirmAccount,
                retryListing: jest.fn(),
                onMember,
                onRead,
                checkOnOpen: true,
                ...props,
            }),
        { initialProps: { state: ready(null), generation: 1 } },
    );
    await waitFor(() => expect(hook.result.current.failure).toBe('check-failed'));
    // A Load all whose listing names no member: the failure stays, unconfirmed with a Retry.
    hook.rerender({ state: ready(null), generation: 2 });
    expect(hook.result.current.failure).toBe('check-failed');
    expect(hook.result.current.status).toBe('unconfirmed');
    // That Retry re-asks the account.
    act(() => hook.result.current.retry());
    await waitFor(() => expect(onMember).toHaveBeenCalledWith(OWNER));
    expect(confirmAccount).toHaveBeenCalledTimes(2);
});

describe('the owner record the judgement needs', () => {
    const base = {
        withheld: true,
        owner: '',
        memberId: null as string | null,
        reloadSaved: jest.fn(),
        confirmAccount: jest.fn<Promise<AccountCheck>, []>().mockResolvedValue({ memberId: OWNER }),
        retryListing: jest.fn(),
        onMember: jest.fn(),
        onRead: jest.fn(),
        checkOnOpen: true,
        state: ready(null),
        generation: 1,
    };

    test('an owner read still on its way counts as waiting', () => {
        const { result } = renderHook(() => useSavedListReread({ ...base, ownerKnown: false, ownerFailed: false }));
        expect(result.current.status).toBe('pending');
    });

    test('a failed owner read is its own failure, and not a wait', async () => {
        const onMember = jest.fn();
        const { result, rerender } = renderHook(
            (props: { memberId: string | null }) =>
                useSavedListReread({
                    ...base,
                    onMember,
                    memberId: props.memberId,
                    ownerKnown: false,
                    ownerFailed: true,
                }),
            { initialProps: { memberId: null as string | null } },
        );
        // The check answered (the caller now knows the member); the owner read has failed.
        await waitFor(() => expect(onMember).toHaveBeenCalledWith(OWNER));
        rerender({ memberId: OWNER });
        expect(result.current.status).toBe('unconfirmed');
        expect(result.current.failure).toBe('owner-read-failed');
    });
});

test('a member nobody has named is pending, and Retry checks the account, not the listing or the read', async () => {
    const reloadSaved = jest.fn<Promise<string[] | null>, []>();
    const { result, retryListing, confirmAccount, onMember } = render(reloadSaved, null, ready(null));
    expect(result.current.status).toBe('pending');
    // The open-time check has settled; the press below is the exact second ask.
    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(confirmAccount).toHaveBeenCalledTimes(1);
    act(() => result.current.retry());
    await waitFor(() => expect(onMember).toHaveBeenCalledWith(OWNER));
    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(confirmAccount).toHaveBeenCalledTimes(2);
    expect(retryListing).not.toHaveBeenCalled();
    expect(reloadSaved).not.toHaveBeenCalled();
});

test.each([
    ['says the check failed', () => Promise.resolve<AccountCheck>({ error: 'account-check-failed' })],
    ['rejects', () => Promise.reject(new Error('down'))],
])('a check that %s ends in check-failed, still unconfirmed, and can be pressed again', async (_name, answer) => {
    const { result, confirmAccount, onMember } = render(jest.fn(), null, ready(null));
    // The open-time check runs first; the press is answered by the mock this test sets.
    await waitFor(() => expect(result.current.busy).toBe(false));
    confirmAccount.mockImplementationOnce(answer);
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.failure).toBe('check-failed'));
    expect(result.current.status).toBe('unconfirmed');
    expect(result.current.busy).toBe(false);
    // The next press clears the failure while it runs.
    act(() => result.current.retry());
    expect(result.current.failure).toBe(null);
    await waitFor(() => expect(onMember).toHaveBeenCalledWith(OWNER));
});

test('signed out is its own failure', async () => {
    const { result, confirmAccount } = render(jest.fn(), null, ready(null));
    await waitFor(() => expect(result.current.busy).toBe(false));
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
    const check = Promise.withResolvers<AccountCheck>();
    const reloadSaved = jest.fn<Promise<string[] | null>, []>().mockReturnValue(read.promise);
    const { result, rerender } = render(reloadSaved, null, ready(null), OWNER, false, () => check.promise);
    expect(result.current.retrying).toBe(false);
    act(() => result.current.retry());
    expect(result.current.retrying).toBe(true);
    // The check answered: the member now names the owner, and the chained read is pending.
    await act(async () => check.resolve({ memberId: OWNER }));
    rerender({ reloadSaved, memberId: OWNER, state: ready(OWNER), generation: 1 });
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
    const { result, confirmAccount } = render(
        jest.fn(),
        null,
        ready(null),
        OWNER,
        false,
        () => new Promise(() => undefined),
    );
    act(() => result.current.retry());
    act(() => result.current.retry());
    expect(confirmAccount).toHaveBeenCalledTimes(1);
});

test('a member with no owner on record yet is retried through the listing', () => {
    const retryListing = jest.fn();
    const confirmAccount = jest.fn<Promise<AccountCheck>, []>();
    const { result } = renderHook(() =>
        useSavedListReread({
            withheld: true,
            owner: '',
            ownerKnown: true,
            ownerFailed: false,
            memberId: OWNER,
            state: ready(OWNER),
            generation: 1,
            reloadSaved: jest.fn(),
            confirmAccount,
            retryListing,
            onMember: jest.fn(),
            onRead: jest.fn(),
            checkOnOpen: true,
        }),
    );
    expect(result.current.status).toBe('unconfirmed');
    act(() => result.current.retry());
    expect(retryListing).toHaveBeenCalledTimes(1);
    expect(confirmAccount).not.toHaveBeenCalled();
    expect(result.current.busy).toBe(false);
});

test('with no way to read the list, a member naming the owner is unconfirmed too', () => {
    const onRead = jest.fn();
    const { result } = renderHook(() =>
        useSavedListReread({
            withheld: true,
            owner: OWNER,
            ownerKnown: true,
            ownerFailed: false,
            memberId: OWNER,
            state: ready(OWNER),
            generation: 1,
            confirmAccount: jest.fn(),
            retryListing: jest.fn(),
            onMember: jest.fn(),
            onRead,
            checkOnOpen: false,
        }),
    );
    expect(result.current.status).toBe('unconfirmed');
});

describe('useLibraryListing members', () => {
    const listingOf = (memberId: string | null) =>
        invalid<Promise<Listing>>({
            success: true,
            photos: [],
            memberId,
            truncated: false,
            wonIds: [],
            wonCount: 0,
            preview: false,
            readAtMs: 1_700_000_000_000,
            allowedKnown: true,
        });

    test('setMember goes into the listing on screen, without reading the library again', async () => {
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

    test('a later read that names no member keeps the member a check found', async () => {
        rememberCurrentMember(null);
        mockApi.getLibraryPhotos.mockReset().mockResolvedValue(listingOf(OWNER));
        const { result } = renderHook(() => useLibraryListing(7, { onDemand: true }));
        act(() => result.current.setMember(OWNER));
        await act(async () => void (await result.current.load('')));
        const { state } = result.current;
        expect(state.status === 'ready' && state.listing.memberId).toBe(OWNER);
        rememberCurrentMember(null);
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
        rerender({ reloadSaved, memberId: OWNER, state: ready(OWNER), ...next });
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
        rerender({ reloadSaved, memberId: OWNER, state: ready(OWNER), ...next });
        expect(result.current.confirmed).toBe(false);
    });

    test('an old check failure never labels a later failure on a new listing: a failed read is a read failure', async () => {
        const reloadSaved = jest.fn<Promise<string[] | null>, []>().mockResolvedValue(null);
        const { result, rerender, confirmAccount } = render(reloadSaved, null, ready(null));
        await waitFor(() => expect(result.current.busy).toBe(false));
        confirmAccount.mockResolvedValueOnce({ error: 'account-check-failed' });
        act(() => result.current.retry());
        await waitFor(() => expect(result.current.failure).toBe('check-failed'));

        // A new listing that names the owner, whose read fails.
        rerender({ reloadSaved, memberId: OWNER, state: ready(OWNER), ...next });
        await waitFor(() => expect(result.current.failure).toBe('read-failed'));
    });

    test('"failed again" does not carry over to a new listing', async () => {
        const reloadSaved = jest.fn<Promise<string[] | null>, []>().mockResolvedValue(null);
        const { result, rerender } = render(reloadSaved);
        await waitFor(() => expect(result.current.failure).toBe('read-failed'));
        act(() => result.current.retry());
        await waitFor(() => expect(result.current.failure).toBe('read-failed-again'));

        rerender({ reloadSaved, memberId: OWNER, state: ready(OWNER), ...next });
        await waitFor(() => expect(result.current.failure).toBe('read-failed'));
    });

    test('a check failure stays through a later listing read: only a new check or a member replaces it', async () => {
        const { result, rerender, confirmAccount } = render(jest.fn(), null, ready(null));
        await waitFor(() => expect(result.current.busy).toBe(false));
        confirmAccount.mockResolvedValueOnce({ error: 'not-logged-in' });
        act(() => result.current.retry());
        await waitFor(() => expect(result.current.failure).toBe('not-logged-in'));
        rerender({ reloadSaved: jest.fn(), memberId: null, state: ready(null), ...next });
        expect(result.current.failure).toBe('not-logged-in');
        expect(result.current.status).toBe('unconfirmed');
        // A member that lands (a listing names one) clears it.
        rerender({ reloadSaved: jest.fn(async () => ['a']), memberId: OWNER, state: ready(OWNER), ...next });
        expect(result.current.failure).toBeNull();
    });
});
