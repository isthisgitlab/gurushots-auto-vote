import { render } from '@testing-library/preact';
import { TranslationProvider } from '@/contexts/TranslationContext';
import { DeadlineTimeline } from '@/components/app/DeadlineTimeline';
import type { ComponentChildren } from 'preact';

/**
 * DeadlineTimeline turns the gated deadline-action list into the per-card UI.
 * Covers: empty → nothing; full-mode rows with ~advisory durations; compact
 * mode's single soonest-action line; the all-overdue fallback picking the
 * least-overdue action rather than an arbitrary list position; and the
 * Boost-pinned photo submit row shown at the boost row's time.
 */

const BASE_MS = 1_700_000_000_000;
const BASE_SEC = Math.floor(BASE_MS / 1000);

const wrap = (ui: ComponentChildren) => render(<TranslationProvider>{ui}</TranslationProvider>);

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

    test('renders nothing when no action carries a due time', () => {
        const { container } = wrap(<DeadlineTimeline actions={[{ action: 'boost', thresholdSec: 60, dueAt: null }]} />);
        expect(container.firstChild).toBeNull();
    });

    test('an action without a label mapping is shown by its raw key', () => {
        wrap(<DeadlineTimeline actions={[{ action: 'mysteryAction', thresholdSec: 60, dueAt: BASE_SEC + 60 }]} />);
        expect(document.body.textContent).toContain('mysteryAction');
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

    test('boostPinSubmits shows the pinned-photo submit row directly before Boost, at the same time', () => {
        const actions = [
            { action: 'boost', thresholdSec: 120, dueAt: BASE_SEC + 120 },
            { action: 'turbo', thresholdSec: 300, dueAt: BASE_SEC + 300 },
        ];
        const { container } = wrap(<DeadlineTimeline actions={actions} boostPinSubmits={true} />);
        const rows = Array.from(container.querySelectorAll('li')).map((li) => li.textContent ?? '');
        expect(rows).toHaveLength(3);
        expect(rows[0]).toMatch(/^app\.deadlineActionBoostPinSubmit/);
        expect(rows[1]).toMatch(/^app\.deadlineActionBoost(?!PinSubmit)/);
        // Shared dueAt: the submit row carries the same ~advisory time as Boost.
        expect(rows[0].replace('app.deadlineActionBoostPinSubmit', '')).toBe(
            rows[1].replace('app.deadlineActionBoost', ''),
        );
    });

    test('without boostPinSubmits there is no pinned-photo submit row', () => {
        const actions = [{ action: 'boost', thresholdSec: 120, dueAt: BASE_SEC + 120 }];
        wrap(<DeadlineTimeline actions={actions} boostPinSubmits={false} />);
        expect(document.body.textContent).not.toContain('deadlineActionBoostPinSubmit');
    });

    test('boostPinSubmits with no boost row adds no pinned-photo submit row', () => {
        const actions = [{ action: 'turbo', thresholdSec: 300, dueAt: BASE_SEC + 300 }];
        wrap(<DeadlineTimeline actions={actions} boostPinSubmits={true} />);
        expect(document.body.textContent).not.toContain('deadlineActionBoostPinSubmit');
    });

    test('compact mode with boostPinSubmits names the pinned-photo submit as Next, not Boost', () => {
        const actions = [
            { action: 'turbo', thresholdSec: 300, dueAt: BASE_SEC + 300 },
            { action: 'boost', thresholdSec: 120, dueAt: BASE_SEC + 120 },
        ];
        wrap(<DeadlineTimeline actions={actions} compact={true} boostPinSubmits={true} />);
        const text = document.body.textContent ?? '';
        expect(text).toContain('app.deadlineActionBoostPinSubmit');
        // The submit row shares Boost's dueAt and happens first, so it wins that slot.
        expect(text).not.toMatch(/app\.deadlineActionBoost(?!PinSubmit)/);
    });
});
