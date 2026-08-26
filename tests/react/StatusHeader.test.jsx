import { render, screen, act } from '@testing-library/preact';
import { TranslationProvider } from '@/contexts/TranslationContext';
import { StatusHeader } from '@/components/app/StatusHeader';

/**
 * StatusHeader: the aggregate summary bar. Two things matter:
 *   1. the next-action countdown ticks each second, and
 *   2. that 1Hz tick stays ISOLATED — it must NOT re-render a sibling of the
 *      header (the challenge list), the regression the plan calls out as the
 *      headline risk. The Probe below stands in for ChallengesSection: if the
 *      tick ever escaped to a shared parent, the Probe's render count would
 *      climb with the clock.
 */

const BASE_MS = 1_700_000_000_000;

const wrap = (ui) => render(<TranslationProvider>{ui}</TranslationProvider>);

const oneChallenge = [{ id: 'c1', member: { boost: { state: 'NONE' }, turbo: { state: 'NONE' } } }];

describe('StatusHeader', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(BASE_MS);
    });
    afterEach(() => {
        jest.useRealTimers();
    });

    test('next-action countdown ticks each second while running', () => {
        const nextRunAt = BASE_MS + 120_000; // 2 minutes out
        wrap(<StatusHeader challenges={oneChallenge} nextRunAt={nextRunAt} running={true} />);

        expect(screen.getByRole('status').textContent).toContain('~2m 0s');
        act(() => jest.advanceTimersByTime(1000));
        expect(screen.getByRole('status').textContent).toContain('~1m 59s');
        act(() => jest.advanceTimersByTime(5000));
        expect(screen.getByRole('status').textContent).toContain('~1m 54s');
    });

    test('the 1Hz countdown does not re-render a sibling (challenge-list stand-in)', () => {
        let probeRenders = 0;
        function Probe() {
            probeRenders += 1;
            return null;
        }
        wrap(
            <div>
                <StatusHeader challenges={oneChallenge} nextRunAt={BASE_MS + 120_000} running={true} />
                <Probe />
            </div>,
        );
        expect(probeRenders).toBe(1);
        act(() => jest.advanceTimersByTime(3000));
        // Countdown advanced, but the sibling never re-rendered.
        expect(screen.getByRole('status').textContent).toContain('~1m 57s');
        expect(probeRenders).toBe(1);
    });

    test('shows an explicit idle state when autovote is not running', () => {
        wrap(<StatusHeader challenges={oneChallenge} nextRunAt={null} running={false} />);
        // statusHeaderNotRunning key (no translationManager in test → key text).
        expect(screen.getByRole('status').textContent).toContain('statusHeaderNotRunning');
    });

    test('renders nothing when there are no challenges and autovote is idle', () => {
        const { container } = wrap(<StatusHeader challenges={[]} nextRunAt={null} running={false} />);
        expect(container.querySelector('[role="status"]')).toBeNull();
    });

    test('counts active challenges and available boosts/turbos', () => {
        const challenges = [
            { id: 'a', member: { boost: { state: 'AVAILABLE_KEY' }, turbo: { state: 'WON' } } },
            { id: 'b', member: { boost: { state: 'USED' }, turbo: { state: 'NONE' } } },
            { id: 'c', member: { boost: { state: 'AVAILABLE_KEY' }, turbo: { state: 'FREE' } } },
        ];
        wrap(<StatusHeader challenges={challenges} nextRunAt={null} running={true} />);
        const text = screen.getByRole('status').textContent;
        expect(text).toContain('3'); // active
        expect(text).toContain('2'); // boosts (two AVAILABLE_KEY) and turbos (WON + FREE)
    });
});
