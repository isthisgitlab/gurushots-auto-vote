import { render, screen, act } from '@testing-library/preact';
import { TranslationProvider } from '@/contexts/TranslationContext';
import { StatusHeader } from '@/components/app/StatusHeader';
import { openBoostWindows } from '../../src/js/voting/boostWindow';

/**
 * StatusHeader: the aggregate summary bar. Two things matter:
 *   1. the next-action countdown ticks each second, and
 *   2. that 1Hz tick stays ISOLATED in the countdown child — the header BODY
 *      (which computes the counts) must NOT re-render each second, or in the
 *      real app a shared ancestor would drag the challenge list into the churn.
 *
 * openBoostWindows is mocked so it's both controllable (for the count assertion)
 * AND a call-counter: the header body calls it once per header render, so its
 * call count is a direct probe of "did the body re-render?". If the tick ever
 * leaked into the header body, the count would climb with the clock.
 */
jest.mock('../../src/js/voting/boostWindow', () => ({
    openBoostWindows: jest.fn((challenges) =>
        (challenges || [])
            .filter((c) => {
                const s = c?.member?.boost?.state;
                return s === 'AVAILABLE_KEY' || s === 'AVAILABLE';
            })
            .map((c) => ({ id: c.id })),
    ),
}));

const BASE_MS = 1_700_000_000_000;

const wrap = (ui) => render(<TranslationProvider>{ui}</TranslationProvider>);

const oneChallenge = [{ id: 'c1', member: { boost: { state: 'NONE' }, turbo: { state: 'NONE' } } }];

describe('StatusHeader', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(BASE_MS);
        openBoostWindows.mockClear();
    });
    afterEach(() => {
        jest.useRealTimers();
    });

    test('next-action countdown ticks each second while running', () => {
        const nextRunAt = BASE_MS + 120_000; // 2 minutes out
        wrap(<StatusHeader challenges={oneChallenge} nextRunAt={nextRunAt} running={true} />);

        expect(screen.getByTestId('status-header').textContent).toContain('~2m 0s');
        act(() => jest.advanceTimersByTime(1000));
        expect(screen.getByTestId('status-header').textContent).toContain('~1m 59s');
        act(() => jest.advanceTimersByTime(5000));
        expect(screen.getByTestId('status-header').textContent).toContain('~1m 54s');
    });

    test('the 1Hz countdown does NOT re-render the header body (challenge-list guard)', () => {
        wrap(<StatusHeader challenges={oneChallenge} nextRunAt={BASE_MS + 120_000} running={true} />);
        // Let mount-time provider transitions (TranslationProvider's ready flip)
        // settle, then snapshot the body-render count.
        act(() => jest.advanceTimersByTime(1100));
        const baseline = openBoostWindows.mock.calls.length;
        // From here only the countdown's 1Hz tick fires. If the tick leaked into
        // the header body, openBoostWindows (called once per body render) would
        // climb by ~3 over these 3 seconds.
        act(() => jest.advanceTimersByTime(3000));
        expect(screen.getByTestId('status-header').textContent).toContain('~1m'); // still ticking down
        expect(openBoostWindows).toHaveBeenCalledTimes(baseline);
    });

    test('shows an explicit idle state when autovote is not running', () => {
        wrap(<StatusHeader challenges={oneChallenge} nextRunAt={null} running={false} />);
        // statusHeaderNotRunning key (no translationManager in test → key text).
        expect(screen.getByTestId('status-header').textContent).toContain('statusHeaderNotRunning');
    });

    test('renders nothing when there are no challenges and autovote is idle', () => {
        const { container } = wrap(<StatusHeader challenges={[]} nextRunAt={null} running={false} />);
        expect(container.querySelector('[data-testid="status-header"]')).toBeNull();
    });

    test('counts active challenges and available boosts/turbos', () => {
        const challenges = [
            { id: 'a', member: { boost: { state: 'AVAILABLE_KEY' }, turbo: { state: 'WON' } } },
            { id: 'b', member: { boost: { state: 'USED' }, turbo: { state: 'NONE' } } },
            { id: 'c', member: { boost: { state: 'AVAILABLE_KEY' }, turbo: { state: 'FREE' } } },
        ];
        wrap(<StatusHeader challenges={challenges} nextRunAt={null} running={true} />);
        const text = screen.getByTestId('status-header').textContent;
        expect(text).toContain('3'); // active
        expect(text).toContain('2'); // boosts (two AVAILABLE_KEY) and turbos (WON + FREE)
    });
});
