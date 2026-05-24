import { render, screen, act } from '@testing-library/preact';
import { useTimers } from '@/hooks/useTimers';

/**
 * Probe with NO re-render trigger of its own: it re-renders ONLY if a signal it
 * reads notifies it. This isolates the @preact/signals subscription from any
 * other tick (in the real app, ChallengeCard also has its own 1s `now` interval,
 * which would mask a broken subscription). A passing "text advances" assertion
 * therefore proves the signal-driven countdown updates the DOM under
 * preact/compat — i.e. reading `signal.value` in JSX really does subscribe.
 */
function TimerProbe({ challenges }) {
    const times = useTimers(challenges);
    const first = challenges[0];
    return (
        <div>
            <span data-testid="time">{first ? (times[first.id]?.value ?? 'none') : 'none'}</span>
            <span data-testid="ids">{Object.keys(times).join(',')}</span>
        </div>
    );
}

describe('useTimers (signals-backed countdown)', () => {
    const BASE_MS = 1_700_000_000_000;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(BASE_MS);
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('countdown text advances each second via the signal alone (no other re-render trigger)', () => {
        const closeSec = Math.floor(BASE_MS / 1000) + 120; // 2 minutes out
        render(<TimerProbe challenges={[{ id: 'c1', close_time: closeSec }]} />);
        expect(screen.getByTestId('time').textContent).toBe('2m 0s');

        act(() => {
            jest.advanceTimersByTime(1000);
        });
        expect(screen.getByTestId('time').textContent).toBe('1m 59s');

        act(() => {
            jest.advanceTimersByTime(5000);
        });
        expect(screen.getByTestId('time').textContent).toBe('1m 54s');
    });

    test('flips to "Ended" once the close time passes', () => {
        const closeSec = Math.floor(BASE_MS / 1000) + 2;
        render(<TimerProbe challenges={[{ id: 'c1', close_time: closeSec }]} />);
        expect(screen.getByTestId('time').textContent).toBe('2s');

        act(() => {
            jest.advanceTimersByTime(3000);
        });
        expect(screen.getByTestId('time').textContent).toBe('Ended');
    });

    test('prunes the signal map when a challenge leaves the list', () => {
        const closeSec = Math.floor(BASE_MS / 1000) + 3600;
        const two = [
            { id: 'c1', close_time: closeSec },
            { id: 'c2', close_time: closeSec },
        ];
        const { rerender } = render(<TimerProbe challenges={two} />);
        expect(screen.getByTestId('ids').textContent).toBe('c1,c2');

        rerender(<TimerProbe challenges={[{ id: 'c1', close_time: closeSec }]} />);
        expect(screen.getByTestId('ids').textContent).toBe('c1');
    });

    test('clears the interval on unmount (advancing time afterward does not throw)', () => {
        const closeSec = Math.floor(BASE_MS / 1000) + 120;
        const { unmount } = render(<TimerProbe challenges={[{ id: 'c1', close_time: closeSec }]} />);
        unmount();
        expect(() =>
            act(() => {
                jest.advanceTimersByTime(5000);
            }),
        ).not.toThrow();
    });
});
