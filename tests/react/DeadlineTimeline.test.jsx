import { render } from '@testing-library/preact';
import { TranslationProvider } from '@/contexts/TranslationContext';
import { DeadlineTimeline } from '@/components/app/DeadlineTimeline';

/**
 * DeadlineTimeline turns the gated deadline-action list into the per-card UI.
 * Covers: empty → nothing; full-mode rows with ~advisory durations; compact
 * mode's single soonest-action line; and the all-overdue fallback picking the
 * least-overdue action rather than an arbitrary list position.
 */

const BASE_MS = 1_700_000_000_000;
const BASE_SEC = Math.floor(BASE_MS / 1000);

const wrap = (ui) => render(<TranslationProvider>{ui}</TranslationProvider>);

describe('DeadlineTimeline', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(BASE_MS);
    });
    afterEach(() => jest.useRealTimers());

    test('renders nothing for an empty action list', () => {
        const { container } = wrap(<DeadlineTimeline actions={[]} />);
        expect(container.firstChild).toBeNull();
    });

    test('full mode lists each action with a ~advisory duration', () => {
        const actions = [
            { action: 'boost', thresholdSec: 120, dueAt: BASE_SEC + 120 },
            { action: 'turbo', thresholdSec: 300, dueAt: BASE_SEC + 300 },
        ];
        wrap(<DeadlineTimeline actions={actions} />);
        const text = document.body.textContent;
        expect(text).toContain('deadlineActionBoost');
        expect(text).toContain('~2m 0s');
        expect(text).toContain('deadlineActionTurbo');
        expect(text).toContain('~5m 0s');
    });

    test('compact mode shows only the soonest upcoming action', () => {
        const actions = [
            { action: 'turbo', thresholdSec: 300, dueAt: BASE_SEC + 300 },
            { action: 'boost', thresholdSec: 120, dueAt: BASE_SEC + 120 },
        ];
        wrap(<DeadlineTimeline actions={actions} compact={true} />);
        const text = document.body.textContent;
        expect(text).toContain('deadlineNext');
        expect(text).toContain('deadlineActionBoost'); // soonest (120s < 300s)
        expect(text).not.toContain('deadlineActionTurbo');
    });

    test('compact mode with all actions overdue picks the least-overdue one', () => {
        const actions = [
            { action: 'boost', thresholdSec: 0, dueAt: BASE_SEC - 300 }, // 5m overdue
            { action: 'turbo', thresholdSec: 0, dueAt: BASE_SEC - 60 }, // 1m overdue (least)
        ];
        wrap(<DeadlineTimeline actions={actions} compact={true} />);
        const text = document.body.textContent;
        expect(text).toContain('deadlineActionTurbo'); // least overdue wins
        expect(text).toContain('deadlineDue'); // remaining <= 0 → "due now" key
    });
});
