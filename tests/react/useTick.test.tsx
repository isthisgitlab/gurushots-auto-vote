/**
 * Tests for the shared useTick hook (hooks/useTick) — the per-second
 * wall-clock tick used by ChallengeCard and BoostWindowBanner.
 */

import { renderHook, act } from '@testing-library/preact';
import { useTick, useRerenderAt } from '@/hooks/useTick';

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

describe('useRerenderAt', () => {
    const BASE_MS = 1_700_000_000_000;
    const base = BASE_MS / 1000;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(BASE_MS);
    });
    afterEach(() => jest.useRealTimers());

    const renderCounted = (at: number | null) => {
        const renders = { count: 0 };
        const hook = renderHook(
            ({ moment }: { moment: number | null }) => {
                renders.count += 1;
                useRerenderAt(moment);
            },
            { initialProps: { moment: at } },
        );
        return { renders, ...hook };
    };

    test('re-renders once, when the moment is reached', () => {
        const { renders } = renderCounted(base + 30);
        const afterMount = renders.count;
        act(() => {
            jest.advanceTimersByTime(29_999);
        });
        expect(renders.count).toBe(afterMount);
        act(() => {
            jest.advanceTimersByTime(1);
        });
        expect(renders.count).toBe(afterMount + 1);
    });

    test('a null moment schedules nothing', () => {
        const { renders } = renderCounted(null);
        const afterMount = renders.count;
        act(() => {
            jest.advanceTimersByTime(86_400_000);
        });
        expect(renders.count).toBe(afterMount);
        expect(jest.getTimerCount()).toBe(0);
    });

    test('a moment already reached schedules nothing; the next one the caller passes does', () => {
        const { renders, rerender } = renderCounted(base - 5);
        const afterMount = renders.count;
        act(() => {
            jest.advanceTimersByTime(60_000);
        });
        expect(renders.count).toBe(afterMount);
        expect(jest.getTimerCount()).toBe(0);

        rerender({ moment: base + 70 });
        const afterRerender = renders.count;
        act(() => {
            jest.advanceTimersByTime(10_000);
        });
        expect(renders.count).toBe(afterRerender + 1);
    });

    test('a moment past the longest timer is waited for in steps', () => {
        const month = 30 * 86_400;
        const { renders } = renderCounted(base + month);
        const afterMount = renders.count;
        act(() => {
            jest.advanceTimersByTime(2_147_483_647);
        });
        // One step woke it; the next timer is the remainder.
        expect(renders.count).toBe(afterMount + 1);
        expect(jest.getTimerCount()).toBe(1);
        act(() => {
            jest.advanceTimersByTime(month * 1000 - 2_147_483_647);
        });
        expect(renders.count).toBe(afterMount + 2);
        // Reached: nothing is left to wait for.
        expect(jest.getTimerCount()).toBe(0);
    });

    test('unmounting clears the timer', () => {
        const { renders, unmount } = renderCounted(base + 30);
        unmount();
        const afterUnmount = renders.count;
        act(() => {
            jest.advanceTimersByTime(60_000);
        });
        expect(renders.count).toBe(afterUnmount);
    });
});
