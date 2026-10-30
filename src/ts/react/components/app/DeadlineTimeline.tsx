import { useTranslation } from '@/contexts/TranslationContext';
import { formatDuration } from '@/utils/formatters';
import { useTick } from '@/hooks/useTick';
// Action key → translation-key map. Owned by the dependency-free notification
// decision module (Node-safe) so the CLI/headless notify path reuses the same
// mapping without pulling React in; the timeline imports it here.
import { ACTION_LABEL_KEY } from '../../../services/deadlineNotifications';

import type * as useDeadlineActionsModule from '@/api/useDeadlineActions';

/**
 * One upcoming deadline action, as useDeadlineActions returns it.
 */
export type DeadlineAction = ReturnType<typeof useDeadlineActionsModule.useDeadlineActions>['actions'][number];

/**
 * Per-card advisory timeline of the automation's upcoming deadline actions.
 * `actions` come from useDeadlineActions (get-deadline-actions IPC); each has an
 * absolute `dueAt` (epoch seconds) already gated to the actions that will really
 * fire. Renders nothing when the list is empty (matching BoostWindowBanner's
 * contract).
 *
 * The times are ADVISORY: the entry count is read at compute time and can drift
 * as auto-fill adds entries mid-cycle, so every duration is `~`-prefixed and the
 * header carries an "approximate" note. In compact mode this collapses to a
 * single "next action" line to respect the card's density control.
 */
export function DeadlineTimeline({
    actions,
    compact = false,
    boostPinSubmits = false,
}: {
    actions: DeadlineAction[];
    compact?: boolean;
    /** Show the Boost-pinned photo submit as its own row at the boost row's time. */
    boostPinSubmits?: boolean;
}) {
    const { t } = useTranslation();
    const hasRows = Array.isArray(actions) && actions.length > 0;
    // Only tick while there's something to count down.
    const now = useTick(1000, hasRows);
    if (!hasRows) return null;

    const rows = actions
        .filter((a): a is DeadlineAction & { dueAt: number } => typeof a.dueAt === 'number' && Number.isFinite(a.dueAt))
        .map((a) => ({ ...a, remaining: a.dueAt - now }));
    if (rows.length === 0) return null;

    // The Boost-pinned photo submit happens at the Boost row's due time, so its
    // row takes that time and sits just before Boost; Boost itself follows after
    // the fresh-photo wait, which the Boost row does not show. The label
    // resolves here, not through ACTION_LABEL_KEY: the Node notify path owns
    // that map and has no such action.
    const boostIndex = rows.findIndex((r) => r.action === 'boost');
    if (boostPinSubmits && boostIndex !== -1) {
        rows.splice(boostIndex, 0, { ...rows[boostIndex], action: 'boostPinSubmit' });
    }

    const labelFor = (action: string) =>
        t(action === 'boostPinSubmit' ? 'app.deadlineActionBoostPinSubmit' : ACTION_LABEL_KEY[action] || action);
    const remainingText = (remaining: number) =>
        remaining > 0 ? `~${formatDuration(remaining, { includeSeconds: true })}` : t('app.deadlineDue');

    if (compact) {
        // The soonest upcoming action; if every action is already overdue, the
        // least-overdue one (largest remaining, i.e. closest to now) rather than
        // an arbitrary list position. A shared dueAt is won by the pinned-submit
        // row: the sort puts it first among the tied rows and it happens first
        // at that instant. The find is total, so the assertion is safe: some row
        // is positive, or the largest remaining matches its own equality.
        const submitFirst = (r: (typeof rows)[number]) => (r.action === 'boostPinSubmit' ? 0 : 1);
        const sorted = [...rows].sort((a, b) => a.remaining - b.remaining || submitFirst(a) - submitFirst(b));
        const maxRemaining = sorted[sorted.length - 1].remaining;
        const next = sorted.find((r) => r.remaining > 0 || r.remaining === maxRemaining)!;
        return (
            <div className="text-xs text-base-content/70" title={t('app.deadlineTimelineApprox')}>
                <span aria-hidden="true">⏳</span> {t('app.deadlineNext')}: {labelFor(next.action)}{' '}
                {remainingText(next.remaining)}
            </div>
        );
    }

    return (
        <div className="bg-base-200 rounded p-2">
            <div className="text-xs font-medium mb-1">
                <span aria-hidden="true">⏳</span> {t('app.deadlineTimeline')}{' '}
                <span className="font-normal text-base-content/70">({t('app.deadlineTimelineApprox')})</span>
            </div>
            <ul className="text-xs space-y-0.5">
                {rows.map((r) => (
                    <li key={r.action} className="flex justify-between gap-2">
                        <span>{labelFor(r.action)}</span>
                        <span className="text-base-content/70">{remainingText(r.remaining)}</span>
                    </li>
                ))}
            </ul>
        </div>
    );
}
