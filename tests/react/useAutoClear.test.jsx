/**
 * Tests for the shared useAutoClear hook (hooks/useAutoClear) — the
 * clear-transient-error-after-a-delay effect extracted from EntryBadge
 * and ChallengeCard.
 */

import { renderHook, act } from '@testing-library/preact';
import { useAutoClear } from '@/hooks/useAutoClear';

describe('useAutoClear', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    test('calls clear after the delay once the value is truthy', () => {
        const clear = jest.fn();
        renderHook(() => useAutoClear('some error', clear, 5000));

        act(() => {
            jest.advanceTimersByTime(4999);
        });
        expect(clear).not.toHaveBeenCalled();

        act(() => {
            jest.advanceTimersByTime(1);
        });
        expect(clear).toHaveBeenCalledTimes(1);
    });

    test('schedules nothing while the value is falsy', () => {
        const clear = jest.fn();
        renderHook(() => useAutoClear(null, clear, 5000));

        act(() => {
            jest.advanceTimersByTime(10000);
        });
        expect(clear).not.toHaveBeenCalled();
    });

    test('restarts the timer when the value changes', () => {
        const clear = jest.fn();
        const { rerender } = renderHook(({ value }) => useAutoClear(value, clear, 5000), {
            initialProps: { value: 'first' },
        });

        act(() => {
            jest.advanceTimersByTime(3000);
        });
        rerender({ value: 'second' });
        act(() => {
            jest.advanceTimersByTime(3000);
        });
        expect(clear).not.toHaveBeenCalled(); // old timer was cancelled

        act(() => {
            jest.advanceTimersByTime(2000);
        });
        expect(clear).toHaveBeenCalledTimes(1);
    });

    test('cancels the pending timer on unmount', () => {
        const clear = jest.fn();
        const { unmount } = renderHook(() => useAutoClear('err', clear, 5000));
        unmount();

        act(() => {
            jest.advanceTimersByTime(10000);
        });
        expect(clear).not.toHaveBeenCalled();
    });
});
