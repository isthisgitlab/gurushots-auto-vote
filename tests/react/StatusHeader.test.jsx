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

    test('claim countdown is independent and its tick does not re-render the header', () => {
        wrap(
            <StatusHeader
                challenges={oneChallenge}
                running={true}
                nextRunAt={BASE_MS + 120_000}
                autoClaimStatus={{ enabled: true, nextClaimAt: BASE_MS + 3_600_000 }}
            />,
        );
        expect(screen.getByText('app.statusHeaderNextClaim:')).toBeTruthy();
        const claimCountdown = screen.getByTitle('app.statusHeaderNextClaimHint');
        const nextCountdown = screen.getByTitle('app.statusHeaderNextApprox');
        for (const countdown of [claimCountdown, nextCountdown]) {
            expect(countdown.parentElement.classList.contains('min-w-[11ch]')).toBe(true);
            expect(countdown.parentElement.classList.contains('tabular-nums')).toBe(true);
        }
        expect(claimCountdown.textContent).toBe('~1h 0m');
        act(() => jest.advanceTimersByTime(1000));
        const baseline = openBoostWindows.mock.calls.length;
        act(() => jest.advanceTimersByTime(1000));
        expect(claimCountdown.textContent).toBe('~59m 58s');
        expect(screen.getByTestId('status-header').textContent).toContain('~1m 58s');
        expect(openBoostWindows).toHaveBeenCalledTimes(baseline);
    });

    test('claim is due before the first pass and after the cooldown expires', () => {
        const { rerender } = wrap(
            <StatusHeader
                challenges={oneChallenge}
                running={true}
                autoClaimStatus={{ enabled: true, nextClaimAt: 0 }}
            />,
        );
        expect(screen.getByTitle('app.statusHeaderNextClaimHint').textContent).toBe('app.deadlineDue');
        rerender(
            <TranslationProvider>
                <StatusHeader
                    challenges={oneChallenge}
                    running={true}
                    autoClaimStatus={{ enabled: true, nextClaimAt: BASE_MS + 1000 }}
                />
            </TranslationProvider>,
        );
        act(() => jest.advanceTimersByTime(2000));
        expect(screen.getByTitle('app.statusHeaderNextClaimHint').textContent).toBe('app.deadlineDue');
    });

    test('claim status is hidden when disabled and paused when voting stops', () => {
        const { rerender } = wrap(
            <StatusHeader
                challenges={oneChallenge}
                running={true}
                autoClaimStatus={{ enabled: false, nextClaimAt: 0 }}
            />,
        );
        expect(screen.queryByText('app.statusHeaderNextClaim:')).toBeNull();
        rerender(
            <TranslationProvider>
                <StatusHeader
                    challenges={oneChallenge}
                    running={false}
                    autoClaimStatus={{ enabled: true, nextClaimAt: BASE_MS + 1000 }}
                />
            </TranslationProvider>,
        );
        const claim = screen.getByText('app.statusHeaderNextClaim:').parentElement;
        expect(claim.textContent).toContain('app.statusHeaderNotRunning');
        expect(claim.textContent).not.toContain('~');
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
        // statusHeaderNotRunning key (the test translator returns the key).
        expect(screen.getByTestId('status-header').textContent).toContain('statusHeaderNotRunning');
    });

    test('renders nothing when there are no challenges and autovote is idle', () => {
        const { container } = wrap(<StatusHeader challenges={[]} nextRunAt={null} running={false} />);
        expect(container.querySelector('[data-testid="status-header"]')).toBeNull();
    });

    test('bankroll renders as its own second row (separate block, not inline with the counts)', () => {
        const { container } = wrap(
            <StatusHeader
                challenges={oneChallenge}
                nextRunAt={BASE_MS + 60_000}
                running={true}
                bankroll={{ keys: 1, swaps: 2, fills: 3, coins: 4242 }}
            />,
        );
        const header = container.querySelector('[data-testid="status-header"]');
        const blocks = Array.from(header.children).filter((n) => n.tagName === 'DIV');
        expect(blocks).toHaveLength(2); // row 1 (counts/timer) + row 2 (bankroll)
        expect(blocks[1].textContent).toContain('4242'); // coin value on the second row
        expect(blocks[0].textContent).not.toContain('4242');
    });

    test('no bankroll block when no balance is passed (single row)', () => {
        const { container } = wrap(
            <StatusHeader challenges={oneChallenge} nextRunAt={BASE_MS + 60_000} running={true} />,
        );
        const header = container.querySelector('[data-testid="status-header"]');
        const blocks = Array.from(header.children).filter((n) => n.tagName === 'DIV');
        expect(blocks).toHaveLength(1);
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

    test('a TIMER turbo counts once its cooldown has elapsed, not before or without a time', () => {
        const nowSec = BASE_MS / 1000;
        const challenges = [
            { id: 'a', member: { turbo: { state: 'TIMER', time_to_open: nowSec - 1 } } },
            { id: 'b', member: { turbo: { state: 'TIMER', time_to_open: nowSec + 60 } } },
            { id: 'c', member: { turbo: { state: 'TIMER' } } },
            { id: 'd', member: {} },
        ];
        const { container } = wrap(<StatusHeader challenges={challenges} nextRunAt={null} running={true} />);
        const stats = Array.from(container.querySelectorAll('.font-semibold')).map((n) => n.textContent);
        // active, boosts, turbos
        expect(stats.slice(0, 3)).toEqual(['4', '0', '1']);
    });

    test('an overdue next run reads as due', () => {
        wrap(<StatusHeader challenges={oneChallenge} nextRunAt={BASE_MS - 5000} running={true} />);
        expect(screen.getByTestId('status-header').textContent).toContain('app.deadlineDue');
    });

    test('running without an armed time shows a dash', () => {
        wrap(<StatusHeader challenges={oneChallenge} nextRunAt={null} running={true} />);
        expect(screen.getByTestId('status-header').textContent).toContain('—');
    });

    test('an unreadable balance renders an em-dash, never 0', () => {
        const { container } = wrap(
            <StatusHeader
                challenges={[]}
                nextRunAt={null}
                running={false}
                bankroll={{ keys: 2, swaps: undefined, fills: NaN, coins: 7 }}
            />,
        );
        const stats = Array.from(container.querySelectorAll('[role="status"] .font-semibold')).map(
            (n) => n.textContent,
        );
        expect(stats).toEqual(['2', '—', '—', '7']);
    });
});
