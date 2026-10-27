/**
 * useTagSuggestions: the 300 ms debounce, the current-term rule (a reply for a
 * term that is no longer current is dropped, failure replies included), the
 * per-keystroke clear, the silent superseded reply, the once-per-mount failure
 * log, and the unmount cases `enabled: false` leaves to the hook.
 */

import { renderHook, act } from '@testing-library/preact';
import { useTagSuggestions } from '@/api/useTagSuggestions';
import { invalid } from '../helpers/invalid';

const DEBOUNCE_MS = 300;

type Reply = Awaited<ReturnType<typeof window.api.searchPhotoTags>>;

const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
};

const searchTags = () => jest.mocked(window.api.searchPhotoTags);
const logError = () => jest.mocked(window.api.logError);

const renderTags = (initial: string) =>
    renderHook((props: { term: string }) => useTagSuggestions(props.term), { initialProps: { term: initial } });

// Runs the debounce out and flushes the reply's own microtasks with it.
const settleDebounce = () => act(async () => void (await jest.advanceTimersByTimeAsync(DEBOUNCE_MS)));

describe('useTagSuggestions', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        searchTags().mockResolvedValue({ success: true, tags: [] });
    });
    afterEach(() => {
        jest.useRealTimers();
    });

    test('the debounce: nothing before 300 ms, one call for the trimmed term at it', async () => {
        searchTags().mockResolvedValue({ success: true, tags: ['flower'] });
        const { result, rerender } = renderTags('');
        rerender({ term: '  flo ' });
        expect(searchTags()).not.toHaveBeenCalled();
        await settleDebounce();
        expect(searchTags()).toHaveBeenCalledTimes(1);
        expect(searchTags()).toHaveBeenCalledWith('flo');
        await act(async () => {});
        expect(result.current).toEqual({ tags: ['flower'], replied: true });
    });

    test('a late stale reply is dropped: only the newest call’s answer lands', async () => {
        const first = deferred<Reply>();
        const second = deferred<Reply>();
        searchTags()
            .mockReturnValueOnce(first.promise as Promise<Reply>)
            .mockReturnValueOnce(second.promise);
        const { result, rerender } = renderTags('');
        rerender({ term: 'flo' });
        await settleDebounce();
        rerender({ term: 'flow' });
        // The term change clears the shown tags at once.
        expect(result.current).toEqual({ tags: [], replied: false });
        await settleDebounce();
        expect(searchTags()).toHaveBeenCalledTimes(2);
        await act(async () => {
            first.resolve({ success: true, tags: ['flower'] });
        });
        expect(result.current).toEqual({ tags: [], replied: false });
        await act(async () => {
            second.resolve({ success: true, tags: ['flowerbed'] });
        });
        expect(result.current).toEqual({ tags: ['flowerbed'], replied: true });
    });

    test('the term drops below the minimum while a request is in flight: no old tags land, nothing is logged', async () => {
        const reply = deferred<Reply>();
        searchTags().mockReturnValueOnce(reply.promise);
        const { result, rerender } = renderTags('');
        rerender({ term: 'flo' });
        await settleDebounce();
        rerender({ term: 'fl' });
        expect(searchTags()).toHaveBeenCalledTimes(1); // no new call below the minimum
        await act(async () => {
            reply.resolve({ success: true, tags: ['flower'] });
        });
        expect(result.current).toEqual({ tags: [], replied: false });
        expect(logError()).not.toHaveBeenCalled();
    });

    test('the term changes inside the debounce window: the old timer never fires', async () => {
        const { rerender } = renderTags('');
        rerender({ term: 'flo' });
        rerender({ term: 'flow' });
        await settleDebounce();
        expect(searchTags()).toHaveBeenCalledTimes(1);
        expect(searchTags()).toHaveBeenCalledWith('flow');
    });

    test('a superseded reply is silent: ignored, never logged, nothing shown', async () => {
        searchTags().mockResolvedValue({ success: false, error: 'superseded' });
        const { result, rerender } = renderTags('');
        rerender({ term: 'flo' });
        await settleDebounce();
        await act(async () => {});
        // Ignored whole: no reply is applied, so what the per-keystroke clear left stands.
        expect(result.current).toEqual({ tags: [], replied: false });
        expect(logError()).not.toHaveBeenCalled();
    });

    test('another failure shows no suggestions and is logged once per mount, reason only', async () => {
        searchTags()
            .mockResolvedValueOnce({ success: false, error: 'the read failed' })
            .mockResolvedValueOnce({ success: false, error: 'and again' });
        const { result, rerender } = renderTags('');
        rerender({ term: 'flo' });
        await settleDebounce();
        await act(async () => {});
        expect(result.current).toEqual({ tags: [], replied: true });
        expect(logError()).toHaveBeenCalledTimes(1);
        const line = String(logError().mock.calls[0][0]);
        expect(line).toContain('the read failed');
        expect(line).not.toContain('flo');
        rerender({ term: 'sta' });
        await settleDebounce();
        await act(async () => {});
        expect(logError()).toHaveBeenCalledTimes(1);
    });

    test('a reply that is not the envelope is a logged-once failure too, per mount', async () => {
        searchTags().mockResolvedValue(invalid<Reply>(undefined));
        const first = renderTags('');
        first.rerender({ term: 'flo' });
        await settleDebounce();
        await act(async () => {});
        expect(first.result.current).toEqual({ tags: [], replied: true });
        expect(logError()).toHaveBeenCalledTimes(1);
        expect(String(logError().mock.calls[0][0])).toContain('reply was not an object');
        // A fresh mount logs its own once: a null reply takes the envelope check's other arm.
        searchTags().mockResolvedValue(invalid<Reply>(null));
        const second = renderTags('');
        second.rerender({ term: 'sta' });
        await settleDebounce();
        await act(async () => {});
        expect(logError()).toHaveBeenCalledTimes(2);
    });

    test('unmount before the timer fires makes no call', async () => {
        const { rerender, unmount } = renderTags('');
        rerender({ term: 'flo' });
        unmount();
        await settleDebounce();
        expect(searchTags()).not.toHaveBeenCalled();
    });

    test('unmount before the reply: a late reply lands nowhere, and a late failure logs nothing', async () => {
        const reply = deferred<Reply>();
        searchTags().mockReturnValueOnce(reply.promise);
        const first = renderTags('');
        first.rerender({ term: 'flo' });
        await settleDebounce();
        first.unmount();
        // preact runs passive-effect cleanups on the next frame, which fake timers must run.
        await settleDebounce();
        await act(async () => {
            reply.resolve({ success: true, tags: ['flower'] });
        });
        // A failure reply after unmount logs nothing either.
        const late = deferred<Reply>();
        searchTags().mockReturnValueOnce(late.promise);
        const second = renderTags('');
        second.rerender({ term: 'sta' });
        await settleDebounce();
        second.unmount();
        await settleDebounce();
        await act(async () => {
            late.resolve({ success: false, error: 'the read failed' });
        });
        expect(logError()).not.toHaveBeenCalled();
        expect(searchTags()).toHaveBeenCalledTimes(2);
    });

    test('"flo " and "flo" are one current term: the reply for the trimmed value lands', async () => {
        searchTags().mockResolvedValue({ success: true, tags: ['flower'] });
        const { result, rerender } = renderTags('');
        rerender({ term: 'flo ' });
        await settleDebounce();
        expect(searchTags()).toHaveBeenCalledWith('flo');
        await act(async () => {});
        expect(result.current).toEqual({ tags: ['flower'], replied: true });
    });
});
