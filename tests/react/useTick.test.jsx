/**
 * Tests for the shared useTick hook (hooks/useTick) — the per-second
 * wall-clock tick extracted from ChallengeCard and BoostWindowBanner.
 */

import { renderHook, act } from '@testing-library/preact';
import { useTick } from '@/hooks/useTick';

describe('useTick', () => {
    const BASE_MS = 1_700_000_000_000;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(BASE_MS);
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('returns the current Unix seconds and advances every interval', () => {
        const { result } = renderHook(() => useTick(1000));
        expect(result.current).toBe(Math.floor(BASE_MS / 1000));

        act(() => {
            jest.advanceTimersByTime(3000);
        });
        expect(result.current).toBe(Math.floor(BASE_MS / 1000) + 3);
    });

    test('enabled=false runs no interval (value stays frozen)', () => {
        const { result } = renderHook(() => useTick(1000, false));
        const initial = result.current;

        act(() => {
            jest.advanceTimersByTime(5000);
        });
        expect(result.current).toBe(initial);
    });

    test('flipping enabled on starts ticking, flipping off freezes again', () => {
        const { result, rerender } = renderHook(({ enabled }) => useTick(1000, enabled), {
            initialProps: { enabled: false },
        });
        const initial = result.current;

        rerender({ enabled: true });
        act(() => {
            jest.advanceTimersByTime(2000);
        });
        expect(result.current).toBe(initial + 2);

        rerender({ enabled: false });
        const frozen = result.current;
        act(() => {
            jest.advanceTimersByTime(2000);
        });
        expect(result.current).toBe(frozen);
    });

    test('clears the interval on unmount', () => {
        const { unmount } = renderHook(() => useTick(1000));
        unmount();
        expect(() =>
            act(() => {
                jest.advanceTimersByTime(2000);
            }),
        ).not.toThrow();
        expect(jest.getTimerCount()).toBe(0);
    });
});
